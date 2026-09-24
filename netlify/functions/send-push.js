const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * send-push — scheduled sweep for queued broadcasts. Runs hourly.
 *
 * Sends every PushBroadcasts row in `scheduled` status whose ScheduledAt has
 * come due.
 *
 * THE CAP IS RE-CHECKED AT SEND TIME, NOT AT QUEUE TIME.
 * That closes the obvious hole: a tenant on a free listing could otherwise
 * queue ten broadcasts in a month where they had quota left and have them all
 * fire later. It also means a DOWNGRADE pauses pending sends — the same
 * behaviour send-campaign.js already has for email, kept deliberately
 * consistent so there is one rule to remember, not two.
 *
 * Also manually invokable for testing.
 */

exports.handler = async () => {
    const started = Date.now();
    let sent = 0, skipped = 0, blocked = 0, failed = 0;

    try {
        const base = T.getBase();

        const due = await T.fetchAll(base, T.TABLES.PUSH_BROADCASTS, {
            filterByFormula: `{Status} = 'scheduled'`
        });

        const now = Date.now();
        const ready = due.filter(b => {
            const at = new Date(b.get('ScheduledAt') || 0).getTime();
            return !isNaN(at) && at <= now;
        });

        console.log(`send-push: ${ready.length} of ${due.length} scheduled broadcasts are due.`);

        // Cache tenants and their month's usage so a tenant with several due
        // broadcasts is only read once, and the cap counts them cumulatively.
        const tenantCache = new Map();
        const usageCache = new Map();

        for (const broadcast of ready) {
            const tenantId = broadcast.get('TenantID');

            try {
                if (!tenantCache.has(tenantId)) {
                    tenantCache.set(tenantId, await T.getTenant(tenantId, base));
                }
                const tenant = tenantCache.get(tenantId);

                if (!tenant) {
                    await mark(base, broadcast.id, 'failed', { Error: 'Tenant no longer exists.' });
                    failed++;
                    continue;
                }

                // Re-check entitlement — a downgrade since queuing pauses this.
                const quota = C.pushQuota(tenant.caps);
                if (quota.cap === 0 && !quota.unlimited) {
                    await mark(base, broadcast.id, 'blocked', {
                        Error: 'Push is no longer enabled on this account.'
                    });
                    blocked++;
                    continue;
                }

                // Re-check the monthly cap against THIS month, not the month
                // the broadcast was composed in.
                if (!quota.unlimited) {
                    if (!usageCache.has(tenantId)) {
                        const rows = await T.fetchAll(base, T.TABLES.PUSH_BROADCASTS, {
                            filterByFormula: T.tenantScope(tenantId)
                        });
                        usageCache.set(tenantId, countThisMonth(rows));
                    }
                    const used = usageCache.get(tenantId);
                    if (used >= quota.cap) {
                        await mark(base, broadcast.id, 'blocked', {
                            Month: T.monthKey(),
                            Error: `Monthly cap of ${quota.cap} reached (${used} sent).`
                        });
                        blocked++;
                        continue;
                    }
                    usageCache.set(tenantId, used + 1);
                }

                const surfaces = String(broadcast.get('Surfaces') || '').split(',').filter(Boolean);
                const recipients = await resolveRecipients(base, tenant, surfaces);
                const delivery = await deliver(recipients, broadcast.get('Title'), broadcast.get('Body'), tenantId);

                await mark(base, broadcast.id, delivery.ok ? 'sent' : 'failed', {
                    SentAt: T.nowISO(),
                    SentCount: delivery.sent,
                    RecipientCount: recipients.count,
                    // Stamp the month it ACTUALLY sent in, so the cap count is
                    // honest even if it was composed last month.
                    Month: T.monthKey(),
                    Error: delivery.ok ? '' : T.capText(delivery.error)
                });

                if (delivery.ok) sent++; else failed++;
                await T.sleep(250);

            } catch (e) {
                console.error(`send-push: broadcast ${broadcast.id} failed:`, e.message);
                await mark(base, broadcast.id, 'failed', { Error: T.capText(e.message) }).catch(() => {});
                failed++;
            }
        }

        skipped = due.length - ready.length;
        const summary = { sent, blocked, failed, skipped, ms: Date.now() - started };
        console.log('send-push:', JSON.stringify(summary));
        return T.ok(summary, 'GET, POST');

    } catch (error) {
        console.error('send-push sweep failed:', error);
        return T.serverError(error, 'GET, POST');
    }
};

// ---------------------------------------------------------------------------

async function mark(base, id, status, extra) {
    return base(T.TABLES.PUSH_BROADCASTS).update(
        [{ id, fields: Object.assign({ Status: status }, extra || {}) }],
        { typecast: true }
    );
}

function countThisMonth(rows) {
    const month = T.monthKey();
    return rows.filter(r => {
        const status = r.get('Status');
        if (status !== 'sent' && status !== 'sending') return false;
        return (r.get('Month') || T.monthKey(r.get('SentAt') || r.get('CreatedAt'))) === month;
    }).length;
}

async function resolveRecipients(base, tenant, surfaces) {
    const tokens = new Set();

    if (surfaces.includes('followers')) {
        try {
            const follows = await T.fetchAll(base, T.TABLES.FOLLOWS, {
                filterByFormula: `AND(${T.tenantScope(tenant.id)}, NOT({Muted}))`
            });
            const userIds = follows.map(f => f.get('UserID')).filter(Boolean);
            for (let i = 0; i < userIds.length; i += 50) {
                const chunk = userIds.slice(i, i + 50);
                const formula = `OR(${chunk.map(id => `RECORD_ID() = '${T.esc(id)}'`).join(',')})`;
                const users = await T.fetchAll(base, T.TABLES.USERS, { filterByFormula: formula });
                users.forEach(u => {
                    if (C.toBool(u.get('PushOptIn')) && u.get('DeviceToken')) {
                        tokens.add(u.get('DeviceToken'));
                    }
                });
                if (i + 50 < userIds.length) await T.sleep(250);
            }
        } catch (e) {
            console.error('send-push: follower resolution failed:', e.message);
        }
    }

    if (surfaces.includes('app')) {
        try {
            const devices = await T.fetchAll(base, T.TABLES.DEVICE_TOKENS, {
                filterByFormula: `{ClientID} = '${T.esc(tenant.id)}'`
            });
            devices.forEach(d => { if (d.get('Token')) tokens.add(d.get('Token')); });
        } catch (e) {
            console.error('send-push: device resolution failed:', e.message);
        }
    }

    return { tokens: Array.from(tokens), count: tokens.size };
}

/** Provider-gated, exactly as manage-push.js is. No key → records-only. */
async function deliver(recipients, title, body, tenantId) {
    const key = process.env.FIREBASE_SERVER_KEY;
    if (!key) {
        return { ok: true, sent: recipients.count, transport: 'records-only' };
    }
    if (!recipients.tokens.length) {
        return { ok: true, sent: 0, transport: 'fcm' };
    }

    let sent = 0;
    const errors = [];
    for (let i = 0; i < recipients.tokens.length; i += 1000) {
        const chunk = recipients.tokens.slice(i, i + 1000);
        try {
            const res = await fetch('https://fcm.googleapis.com/fcm/send', {
                method: 'POST',
                headers: { Authorization: `key=${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    registration_ids: chunk,
                    notification: { title: title || 'Update', body: body || '' },
                    data: { tenantId }
                })
            });
            const json = await res.json();
            sent += Number(json.success || 0);
            if (json.failure) errors.push(`${json.failure} failed`);
        } catch (e) {
            errors.push(e.message);
        }
    }
    return { ok: errors.length === 0, sent, transport: 'fcm', error: errors.join('; ') };
}
