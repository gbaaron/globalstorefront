const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * /api/manage-follow — a user follows a business.
 *
 *   POST { action: 'follow',   tenantId }
 *   POST { action: 'unfollow', tenantId }
 *   POST { action: 'mute',     tenantId, muted }
 *   GET                        → who this user follows
 *   GET ?tenantId=             → follower count for a tenant (public)
 *
 * The follow is the unit of directory reach — the thing a free listing gets
 * that a flyer never does, and the thing push broadcasts are addressed to.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET', 'POST']);
    if (guard) return guard;

    try {
        const base = T.getBase();

        if (event.httpMethod === 'GET') {
            const params = event.queryStringParameters || {};
            // Public: a follower count for a business card.
            if (params.tenantId) return followerCount(params.tenantId, base);
            return listFollows(event, base);
        }

        const ctx = T.userContext(event);
        if (!ctx) return T.unauthorized('GET, POST');

        const body = T.parseBody(event);
        const action = String(body.action || 'follow').toLowerCase();
        const tenantId = String(body.tenantId || '').trim();
        if (!tenantId) return T.bad('tenantId is required', 'GET, POST');

        const tenant = await T.getTenant(tenantId, base);
        if (!tenant) return T.notFound('Business not found', 'GET, POST');

        // A business must actually be followable — a tenant with no directory
        // listing has no followers, by construction.
        if (!C.can(tenant.caps, 'followable')) {
            return T.forbidden('This business is not in a directory yet.', 'GET, POST');
        }

        const existing = await base(T.TABLES.FOLLOWS).select({
            filterByFormula: `AND({UserID} = '${T.esc(ctx.userId)}', {TenantID} = '${T.esc(tenantId)}')`,
            maxRecords: 1
        }).firstPage();

        if (action === 'follow') {
            if (existing.length) {
                return T.ok({ success: true, already: true, follow: shape(existing[0]) }, 'GET, POST');
            }
            const created = await base(T.TABLES.FOLLOWS).create([{
                fields: {
                    FollowID: T.makeId('fol'),
                    UserID: ctx.userId,
                    TenantID: tenantId,
                    RegionID: tenant.regionId || '',
                    CreatedAt: T.nowISO(),
                    Muted: false
                }
            }], { typecast: true });
            const count = await countFollowers(base, tenantId);
            return T.ok({
                success: true,
                follow: shape(created[0]),
                followers: count,
                message: `You'll hear from ${tenant.company || tenant.name} first.`
            }, 'GET, POST');
        }

        if (action === 'unfollow') {
            if (!existing.length) return T.ok({ success: true, already: true }, 'GET, POST');
            await base(T.TABLES.FOLLOWS).destroy([existing[0].id]);
            const count = await countFollowers(base, tenantId);
            return T.ok({ success: true, unfollowed: true, followers: count }, 'GET, POST');
        }

        if (action === 'mute') {
            if (!existing.length) return T.notFound('You do not follow that business.', 'GET, POST');
            const updated = await base(T.TABLES.FOLLOWS).update(
                [{ id: existing[0].id, fields: { Muted: !!body.muted } }],
                { typecast: true }
            );
            return T.ok({ success: true, follow: shape(updated[0]) }, 'GET, POST');
        }

        return T.bad(`Unknown action "${action}"`, 'GET, POST');

    } catch (error) {
        return T.serverError(error, 'GET, POST');
    }
};

// ---------------------------------------------------------------------------

async function listFollows(event, base) {
    const ctx = T.userContext(event);
    if (!ctx) return T.unauthorized('GET, POST');

    const rows = await T.fetchAll(base, T.TABLES.FOLLOWS, {
        filterByFormula: `{UserID} = '${T.esc(ctx.userId)}'`
    });
    if (!rows.length) return T.ok({ data: [] }, 'GET, POST');

    const ids = rows.map(r => r.get('TenantID')).filter(Boolean);
    const byId = new Map();
    for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const formula = `OR(${chunk.map(id => `RECORD_ID() = '${T.esc(id)}'`).join(',')})`;
        const tenants = await T.fetchAll(base, T.TABLES.TENANTS, { filterByFormula: formula });
        tenants.forEach(t => byId.set(t.id, T.hydrateTenant(t)));
        if (i + 40 < ids.length) await T.sleep(220);
    }

    const data = rows.map(r => {
        const t = byId.get(r.get('TenantID'));
        if (!t) return null;
        return {
            followId: r.id,
            tenantId: t.id,
            slug: t.slug,
            name: t.company || t.name,
            tagline: t.tagline,
            logoUrl: t.logoUrl,
            brandColor: t.brandColor || '#d4af37',
            muted: !!r.get('Muted'),
            since: r.get('CreatedAt') || '',
            regionId: t.regionId
        };
    }).filter(Boolean);

    return T.ok({ data: data.sort((a, b) => a.name.localeCompare(b.name)) }, 'GET, POST');
}

async function followerCount(tenantId, base) {
    const count = await countFollowers(base, tenantId);
    return T.ok({ tenantId, followers: count }, 'GET, POST');
}

async function countFollowers(base, tenantId) {
    try {
        const rows = await T.fetchAll(base, T.TABLES.FOLLOWS, {
            filterByFormula: T.tenantScope(tenantId)
        });
        return rows.length;
    } catch (e) {
        return 0;
    }
}

function shape(r) {
    return {
        id: r.id,
        followId: r.get('FollowID') || '',
        userId: r.get('UserID') || '',
        tenantId: r.get('TenantID') || '',
        regionId: r.get('RegionID') || '',
        muted: !!r.get('Muted'),
        since: r.get('CreatedAt') || ''
    };
}
