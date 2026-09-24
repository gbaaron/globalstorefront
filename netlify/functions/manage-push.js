const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * /api/manage-push — the push composer.
 *
 *   GET                      → this tenant's broadcasts + quota + surface options
 *   POST { action: 'send' }  → send now
 *   POST { action: 'schedule' } → queue for later (paid only)
 *   POST { action: 'cancel' }   → cancel a scheduled broadcast
 *
 * THE FREE-LISTING CAP IS ENFORCED HERE, SERVER-SIDE.
 * A free directory listing gets 2 broadcasts per calendar month. The UI shows
 * the remaining count, but the UI is not the enforcement — this function counts
 * the tenant's `sent` rows for the current month before every send and refuses
 * the third. A tenant who calls the API directly hits the same wall.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET', 'POST']);
    if (guard) return guard;

    const ctx = T.tenantContext(event);
    if (!ctx) return T.unauthorized('GET, POST');

    const quota = C.pushQuota(ctx.caps);
    if (quota.cap === 0 && !quota.unlimited) {
        return event.httpMethod === 'GET'
            ? T.locked('Push requires a directory listing or your own app.', { quota, surfaces: C.pushSurfaces(ctx.caps) })
            : T.forbidden('Push is not enabled on this account.', 'GET, POST');
    }

    try {
        const base = T.getBase();
        return event.httpMethod === 'GET'
            ? await handleGet(ctx, base, quota)
            : await handlePost(event, ctx, base, quota);
    } catch (error) {
        return T.serverError(error, 'GET, POST');
    }
};

// ---------------------------------------------------------------------------
// GET — history + live quota
// ---------------------------------------------------------------------------

async function handleGet(ctx, base, quota) {
    const rows = await T.fetchAll(base, T.TABLES.PUSH_BROADCASTS, {
        filterByFormula: T.tenantScope(ctx.tenantId)
    });

    const sorted = rows
        .map(shape)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    const used = countThisMonth(rows);
    const remaining = quota.unlimited ? null : Math.max(0, quota.cap - used);

    return T.ok({
        data: sorted,
        quota: {
            unlimited: quota.unlimited,
            cap: quota.unlimited ? null : quota.cap,
            used,
            remaining,
            month: T.monthKey(),
            reason: quota.reason
        },
        surfaces: C.pushSurfaces(ctx.caps),
        canSchedule: C.can(ctx.caps, 'push_scheduling'),
        canSegment: C.can(ctx.caps, 'push_segmentation')
    }, 'GET, POST');
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

async function handlePost(event, ctx, base, quota) {
    const body = T.parseBody(event);
    const action = String(body.action || 'send').toLowerCase();

    if (action === 'cancel') return cancel(body, ctx, base);

    const title = String(body.title || '').trim();
    const message = String(body.body || body.message || '').trim();
    if (!title && !message) return T.bad('A title or body is required', 'GET, POST');

    // --- resolve the requested surfaces --------------------------------------
    const requested = normalizeSurfaces(body.surface || body.surfaces);
    if (!requested.length) return T.bad('Choose at least one surface to send to', 'GET, POST');

    const concrete = requested.includes('both') ? ['app', 'followers'] : requested;

    // 'both' expands to its parts, so validate the parts rather than the label.
    const unavailable = concrete.filter(s => !C.can(ctx.caps, s === 'app' ? 'push_app' : 'push_followers'));
    if (unavailable.length) {
        return T.forbidden(`You cannot push to: ${unavailable.join(', ')}.`, 'GET, POST');
    }

    // --- segmentation + scheduling gates --------------------------------------
    const segment = String(body.segment || '').trim();
    if (segment && !C.can(ctx.caps, 'push_segmentation')) {
        return T.forbidden('Audience segmentation requires paid directory space.', 'GET, POST');
    }
    if (action === 'schedule' && !C.can(ctx.caps, 'push_scheduling')) {
        return T.forbidden('Scheduled push requires paid directory space.', 'GET, POST');
    }

    // --- THE CAP ---------------------------------------------------------------
    // Counted fresh from Airtable on every send. A scheduled send is counted at
    // send time by send-push.js, not here, so queuing cannot smuggle past it.
    if (!quota.unlimited) {
        const existing = await T.fetchAll(base, T.TABLES.PUSH_BROADCASTS, {
            filterByFormula: T.tenantScope(ctx.tenantId)
        });
        const used = countThisMonth(existing);
        if (used >= quota.cap) {
            // Record the refusal so the owner can see it happened, and so the
            // super-admin can spot tenants hitting the ceiling — those are the
            // upgrade conversations.
            await base(T.TABLES.PUSH_BROADCASTS).create([{
                fields: {
                    BroadcastID: T.makeId('push'),
                    TenantID: ctx.tenantId,
                    Title: title,
                    Body: T.capText(message),
                    Surfaces: concrete.join(','),
                    Status: 'blocked',
                    Month: T.monthKey(),
                    CreatedAt: T.nowISO(),
                    Error: `Monthly cap of ${quota.cap} reached (${used} sent).`
                }
            }], { typecast: true });

            return T.json(429, {
                error: `You've used all ${quota.cap} broadcasts this month.`,
                quota: { unlimited: false, cap: quota.cap, used, remaining: 0, month: T.monthKey() },
                upgrade: {
                    message: 'Paid directory space includes unlimited push, plus segmentation and scheduling.',
                    capability: 'push_unlimited'
                }
            }, 'GET, POST');
        }
    }

    // --- resolve recipients -----------------------------------------------------
    const recipients = await resolveRecipients(base, ctx, concrete, segment);

    const scheduledAt = action === 'schedule' ? String(body.scheduledAt || '').trim() : '';
    if (action === 'schedule' && !scheduledAt) {
        return T.bad('scheduledAt is required to schedule a broadcast', 'GET, POST');
    }

    const fields = {
        BroadcastID: T.makeId('push'),
        TenantID: ctx.tenantId,
        Title: title,
        Body: T.capText(message),
        Surfaces: concrete.join(','),
        Segment: segment,
        RecipientCount: recipients.count,
        Month: T.monthKey(),
        CreatedAt: T.nowISO()
    };

    if (action === 'schedule') {
        fields.Status = 'scheduled';
        fields.ScheduledAt = scheduledAt;
        const created = await base(T.TABLES.PUSH_BROADCASTS).create([{ fields }], { typecast: true });
        return T.ok({
            success: true,
            scheduled: true,
            broadcast: shape(created[0]),
            recipients: recipients.count
        }, 'GET, POST');
    }

    // --- send now ----------------------------------------------------------------
    const delivery = await deliver(recipients, title, message, ctx);

    fields.Status = delivery.ok ? 'sent' : 'failed';
    fields.SentAt = T.nowISO();
    fields.SentCount = delivery.sent;
    if (!delivery.ok) fields.Error = T.capText(delivery.error);

    const created = await base(T.TABLES.PUSH_BROADCASTS).create([{ fields }], { typecast: true });

    const usedAfter = quota.unlimited ? null : countThisMonth(
        await T.fetchAll(base, T.TABLES.PUSH_BROADCASTS, { filterByFormula: T.tenantScope(ctx.tenantId) })
    );

    return T.ok({
        success: delivery.ok,
        broadcast: shape(created[0]),
        recipients: recipients.count,
        sent: delivery.sent,
        transport: delivery.transport,
        note: delivery.note,
        quota: quota.unlimited ? { unlimited: true } : {
            unlimited: false,
            cap: quota.cap,
            used: usedAfter,
            remaining: Math.max(0, quota.cap - usedAfter),
            month: T.monthKey()
        }
    }, 'GET, POST');
}

async function cancel(body, ctx, base) {
    if (!body.id) return T.bad('id is required', 'GET, POST');
    let record;
    try {
        record = await base(T.TABLES.PUSH_BROADCASTS).find(body.id);
    } catch (e) {
        return T.notFound('Broadcast not found', 'GET, POST');
    }
    if (!T.ownsRow(record, ctx.tenantId)) {
        return T.forbidden('That broadcast belongs to another account.', 'GET, POST');
    }
    if (record.get('Status') !== 'scheduled') {
        return T.conflict('Only a scheduled broadcast can be canceled.', 'GET, POST');
    }
    const updated = await base(T.TABLES.PUSH_BROADCASTS).update(
        [{ id: body.id, fields: { Status: 'draft', ScheduledAt: '' } }],
        { typecast: true }
    );
    return T.ok({ success: true, broadcast: shape(updated[0]) }, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Recipients + delivery
// ---------------------------------------------------------------------------

/**
 * Resolve who receives this broadcast.
 *   followers → Follows rows for this tenant (minus muted), joined to Users
 *   app       → DeviceTokens rows for this tenant
 * Deduped by token when both surfaces are selected, so 'both' never
 * double-sends to someone who follows the tenant AND has their app.
 */
async function resolveRecipients(base, ctx, surfaces, segment) {
    const tokens = new Set();
    const emails = new Set();
    let followerCount = 0;
    let deviceCount = 0;

    if (surfaces.includes('followers')) {
        try {
            const follows = await T.fetchAll(base, T.TABLES.FOLLOWS, {
                filterByFormula: `AND(${T.tenantScope(ctx.tenantId)}, NOT({Muted}))`
            });
            followerCount = follows.length;
            const userIds = follows.map(f => f.get('UserID')).filter(Boolean);

            // Chunk the OR() so the formula stays under Airtable's length limit.
            for (let i = 0; i < userIds.length; i += 50) {
                const chunk = userIds.slice(i, i + 50);
                const formula = `OR(${chunk.map(id => `RECORD_ID() = '${T.esc(id)}'`).join(',')})`;
                const users = await T.fetchAll(base, T.TABLES.USERS, { filterByFormula: formula });
                users.forEach(u => {
                    if (!C.toBool(u.get('PushOptIn'))) return;
                    if (u.get('DeviceToken')) tokens.add(u.get('DeviceToken'));
                    if (u.get('Email')) emails.add(String(u.get('Email')).toLowerCase());
                });
                if (i + 50 < userIds.length) await T.sleep(250);
            }
        } catch (e) {
            console.error('Follower resolution failed:', e.message);
        }
    }

    if (surfaces.includes('app')) {
        try {
            const devices = await T.fetchAll(base, T.TABLES.DEVICE_TOKENS, {
                filterByFormula: `{ClientID} = '${T.esc(ctx.tenantId)}'`
            });
            deviceCount = devices.length;
            devices.forEach(d => { if (d.get('Token')) tokens.add(d.get('Token')); });
        } catch (e) {
            console.error('Device resolution failed:', e.message);
        }
    }

    return {
        tokens: Array.from(tokens),
        emails: Array.from(emails),
        count: tokens.size,
        followerCount,
        deviceCount,
        segment
    };
}

/**
 * Deliver via Firebase Cloud Messaging.
 *
 * PROVIDER-GATED, mirroring how Stripe and the email provider are handled: with
 * no FIREBASE_SERVER_KEY set this runs RECORDS-ONLY — it resolves and counts
 * recipients and marks the broadcast sent, but transmits nothing. That keeps
 * the cap logic, history, and analytics all exercisable before push is live.
 */
async function deliver(recipients, title, message, ctx) {
    const key = process.env.FIREBASE_SERVER_KEY;

    if (!key) {
        return {
            ok: true,
            sent: recipients.count,
            transport: 'records-only',
            note: 'FIREBASE_SERVER_KEY is not set — recipients were resolved and recorded, but nothing was transmitted.'
        };
    }

    if (!recipients.tokens.length) {
        return { ok: true, sent: 0, transport: 'fcm', note: 'No opted-in recipients.' };
    }

    let sent = 0;
    const errors = [];

    // FCM legacy accepts up to 1000 registration_ids per request.
    for (let i = 0; i < recipients.tokens.length; i += 1000) {
        const chunk = recipients.tokens.slice(i, i + 1000);
        try {
            const res = await fetch('https://fcm.googleapis.com/fcm/send', {
                method: 'POST',
                headers: {
                    Authorization: `key=${key}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    registration_ids: chunk,
                    notification: { title: title || 'Update', body: message },
                    data: { tenantId: ctx.tenantId }
                })
            });
            const json = await res.json();
            sent += Number(json.success || 0);
            if (json.failure) errors.push(`${json.failure} failed in chunk ${i / 1000}`);
        } catch (e) {
            errors.push(e.message);
        }
    }

    return {
        ok: errors.length === 0,
        sent,
        transport: 'fcm',
        error: errors.join('; '),
        note: errors.length ? 'Some deliveries failed.' : ''
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sent broadcasts in the current calendar month — the cap window. */
function countThisMonth(rows) {
    const month = T.monthKey();
    return rows.filter(r => {
        const status = r.get('Status');
        if (status !== 'sent' && status !== 'sending') return false;
        const rowMonth = r.get('Month') || T.monthKey(r.get('SentAt') || r.get('CreatedAt'));
        return rowMonth === month;
    }).length;
}

function normalizeSurfaces(input) {
    if (!input) return [];
    const list = Array.isArray(input) ? input : String(input).split(',');
    const valid = ['app', 'followers', 'both'];
    return list
        .map(s => String(s).trim().toLowerCase())
        .filter(s => valid.includes(s));
}

function shape(r) {
    return {
        id: r.id,
        broadcastId: r.get('BroadcastID') || '',
        title: r.get('Title') || '',
        body: r.get('Body') || '',
        surfaces: String(r.get('Surfaces') || '').split(',').filter(Boolean),
        segment: r.get('Segment') || '',
        status: r.get('Status') || 'draft',
        scheduledAt: r.get('ScheduledAt') || '',
        sentAt: r.get('SentAt') || '',
        sentCount: r.get('SentCount') || 0,
        recipientCount: r.get('RecipientCount') || 0,
        month: r.get('Month') || '',
        createdAt: r.get('CreatedAt') || '',
        error: r.get('Error') || ''
    };
}
