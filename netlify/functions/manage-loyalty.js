const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * /api/manage-loyalty — tenant-scoped loyalty points.
 *
 *   GET                           → this tenant's ledger + top members
 *   GET  ?userId=                 → one member's balance + history
 *   POST { action: 'award' }      → owner grants points
 *   POST { action: 'redeem' }     → owner deducts points
 *   POST { action: 'balance' }    → PUBLIC: a customer checks their own balance
 *
 * ONE LEDGER, TENANT-SCOPED. Points earned at the bakery are the bakery's
 * points. `RegionID` is written on every row but nothing reads it yet — that is
 * the deliberate seam for a future directory-wide loyalty layer (Phase 8), so
 * the history is already there when that ships rather than starting from zero.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET', 'POST']);
    if (guard) return guard;

    try {
        const base = T.getBase();
        const body = event.httpMethod === 'POST' ? T.parseBody(event) : {};
        const action = String(body.action || '').toLowerCase();

        // Public: a customer checking their own balance at a business.
        if (event.httpMethod === 'POST' && action === 'balance') {
            return publicBalance(body, base);
        }

        const ctx = T.tenantContext(event);
        if (!ctx) return T.unauthorized('GET, POST');

        if (!C.can(ctx.caps, 'loyalty') && !C.can(ctx.caps, 'rewards')) {
            return event.httpMethod === 'GET'
                ? T.locked('Loyalty is included with paid directory space.')
                : T.forbidden('Loyalty is not enabled on this account.', 'GET, POST');
        }

        return event.httpMethod === 'GET'
            ? handleGet(event, ctx, base)
            : handlePost(body, action, ctx, base);

    } catch (error) {
        return T.serverError(error, 'GET, POST');
    }
};

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

async function handleGet(event, ctx, base) {
    const params = event.queryStringParameters || {};

    const rows = await T.fetchAll(base, T.TABLES.POINTS_LEDGER, {
        filterByFormula: params.userId
            ? `AND(${T.tenantScope(ctx.tenantId)}, {UserID} = '${T.esc(params.userId)}')`
            : T.tenantScope(ctx.tenantId)
    });

    const entries = rows.map(shape).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

    // Roll the ledger into per-member balances.
    const balances = new Map();
    for (const e of entries) {
        if (!e.userId) continue;
        const cur = balances.get(e.userId) || { userId: e.userId, balance: 0, earned: 0, spent: 0, entries: 0, lastAt: '' };
        cur.balance += e.delta;
        if (e.delta > 0) cur.earned += e.delta; else cur.spent += Math.abs(e.delta);
        cur.entries++;
        if (e.timestamp > cur.lastAt) cur.lastAt = e.timestamp;
        balances.set(e.userId, cur);
    }

    const members = Array.from(balances.values()).sort((a, b) => b.balance - a.balance);

    // Attach names for the top members only — one lookup, not N.
    const topIds = members.slice(0, 25).map(m => m.userId);
    if (topIds.length) {
        try {
            const formula = `OR(${topIds.map(id => `RECORD_ID() = '${T.esc(id)}'`).join(',')})`;
            const users = await T.fetchAll(base, T.TABLES.USERS, { filterByFormula: formula });
            const nameById = new Map(users.map(u => [u.id, { name: u.get('Name') || '', email: u.get('Email') || '' }]));
            members.forEach(m => {
                const u = nameById.get(m.userId);
                if (u) { m.name = u.name; m.email = u.email; }
            });
        } catch (e) { /* names are a nicety, not a requirement */ }
    }

    if (params.userId) {
        const member = members[0] || { userId: params.userId, balance: 0, earned: 0, spent: 0, entries: 0 };
        return T.ok({ member, history: entries }, 'GET, POST');
    }

    return T.ok({
        data: entries.slice(0, 200),
        members,
        summary: {
            membersCount: members.length,
            outstanding: members.reduce((s, m) => s + m.balance, 0),
            totalEarned: entries.filter(e => e.delta > 0).reduce((s, e) => s + e.delta, 0),
            totalSpent: entries.filter(e => e.delta < 0).reduce((s, e) => s + Math.abs(e.delta), 0)
        }
    }, 'GET, POST');
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

async function handlePost(body, action, ctx, base) {
    if (action !== 'award' && action !== 'redeem') {
        return T.bad(`Unknown action "${action}"`, 'GET, POST');
    }

    const userId = String(body.userId || '').trim();
    const amount = Math.abs(Number(body.amount) || 0);
    if (!userId) return T.bad('userId is required', 'GET, POST');
    if (!amount) return T.bad('amount must be greater than zero', 'GET, POST');

    // A redemption may not overdraw the member's balance.
    if (action === 'redeem') {
        const balance = await balanceFor(base, ctx.tenantId, userId);
        if (amount > balance) {
            return T.conflict(`That member only has ${balance} points.`, 'GET, POST');
        }
    }

    const delta = action === 'award' ? amount : -amount;

    const created = await base(T.TABLES.POINTS_LEDGER).create([{
        fields: {
            EntryID: T.makeId('pts'),
            UserID: userId,
            TenantID: ctx.tenantId,
            // Written but not yet read — the seam for directory-wide points.
            RegionID: ctx.regionId || '',
            Delta: delta,
            Reason: String(body.reason || (action === 'award' ? 'Awarded by owner' : 'Redeemed')).trim(),
            Source: String(body.source || (action === 'award' ? 'manual' : 'redemption')),
            RefID: String(body.refId || ''),
            Timestamp: T.nowISO()
        }
    }], { typecast: true });

    const balance = await balanceFor(base, ctx.tenantId, userId);

    return T.ok({ success: true, entry: shape(created[0]), balance }, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** A customer checks their own balance. Requires their own user token. */
async function publicBalance(body, base) {
    const tenantId = String(body.tenantId || '').trim();
    const userId = String(body.userId || '').trim();
    if (!tenantId || !userId) return T.bad('tenantId and userId are required', 'GET, POST');

    const balance = await balanceFor(base, tenantId, userId);
    const rows = await T.fetchAll(base, T.TABLES.POINTS_LEDGER, {
        filterByFormula: `AND(${T.tenantScope(tenantId)}, {UserID} = '${T.esc(userId)}')`
    });
    const history = rows.map(shape)
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
        .slice(0, 20);

    return T.ok({ balance, history }, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function balanceFor(base, tenantId, userId) {
    const rows = await T.fetchAll(base, T.TABLES.POINTS_LEDGER, {
        filterByFormula: `AND(${T.tenantScope(tenantId)}, {UserID} = '${T.esc(userId)}')`
    });
    return rows.reduce((sum, r) => sum + (Number(r.get('Delta')) || 0), 0);
}

function shape(r) {
    return {
        id: r.id,
        entryId: r.get('EntryID') || '',
        userId: r.get('UserID') || '',
        delta: Number(r.get('Delta')) || 0,
        reason: r.get('Reason') || '',
        source: r.get('Source') || '',
        refId: r.get('RefID') || '',
        timestamp: r.get('Timestamp') || ''
    };
}
