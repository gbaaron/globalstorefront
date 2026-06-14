const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const { tierIncludes, normalizeTier, round2 } = require('./lib/tiers');

// Client-facing Smart Suggestions action endpoint for the owner app.
//   POST /api/update-suggestion  { id, action }
//     action: 'create' → owner acted on it       (Status: created)
//             'keep'   → keep the change running  (Status: kept)
//             'stop'   → roll it back / stop       (Status: stopped)
//             'archive'→ dismiss without acting    (Status: archived)
//
// On 'keep' / 'stop' we snapshot the *current* metric (ResultMetric) alongside
// the BaselineMetric captured at generation time, so the app can show whether
// the suggestion moved the needle. Gated to Growth+ ('smart_suggestions') with
// an ownership check (a client may only act on their own suggestions).

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

// action → resulting Status value
const ACTION_STATUS = {
    create: 'created',
    keep: 'kept',
    stop: 'stopped',
    archive: 'archived'
};

function verifyToken(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    try {
        return jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production');
    } catch (e) {
        return null;
    }
}

function parseMetric(raw) {
    try {
        return JSON.parse(raw || '{}');
    } catch (e) {
        return {};
    }
}

// Pull a numeric order total from whatever field the tenant happens to use.
function orderTotal(order) {
    const t = parseFloat(order.get('Total') || order.get('TotalAmount') || 0);
    return isNaN(t) ? 0 : t;
}

function isoDaysAgo(days) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
    return d.toISOString();
}

// Recompute the same metric family that was captured at generation time so the
// owner can see movement vs baseline. Mirrors generate-suggestions/computeMetrics
// but only fills the keys present in the baseline (keeps the snapshot comparable).
async function snapshotResult(base, client, baseline) {
    const result = {};
    const keys = Object.keys(baseline || {});
    if (!keys.length) return result;

    const clientId = client.id;
    const tenantBaseId = client.get('BaseID');
    const weekAgo = isoDaysAgo(7);
    const twoWeeksAgo = isoDaysAgo(14);

    // Page views (GS base) — only if a view metric is in the baseline.
    if (keys.some(k => k.startsWith('views'))) {
        let viewsThisWeek = 0, viewsPrevWeek = 0;
        try {
            const pv = await base('PageViews').select({
                filterByFormula: `AND({ClientId} = '${clientId}', IS_AFTER({Timestamp}, '${twoWeeksAgo}'))`,
                maxRecords: 2000
            }).all();
            for (const v of pv) {
                const ts = v.get('Timestamp') || '';
                if (ts >= weekAgo) viewsThisWeek++;
                else if (ts >= twoWeeksAgo) viewsPrevWeek++;
            }
        } catch (e) {}
        if ('viewsThisWeek' in baseline) result.viewsThisWeek = viewsThisWeek;
        if ('viewsPrevWeek' in baseline) result.viewsPrevWeek = viewsPrevWeek;
    }

    // Orders / revenue (tenant base) — only if an order/revenue metric is present.
    const needsOrders = keys.some(k => k.startsWith('orders') || k.startsWith('revenue') || k.startsWith('avgOrder') || k === 'pendingOrders');
    if (needsOrders && tenantBaseId) {
        let ordersThisWeek = 0, revenueThisWeek = 0, pendingOrders = 0;
        try {
            const tenantBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(tenantBaseId);
            const orders = await tenantBase('Orders').select({ maxRecords: 1000 }).all();
            for (const o of orders) {
                const dateRaw = o.get('OrderDate') || '';
                const iso = dateRaw ? new Date(dateRaw).toISOString() : '';
                if ((o.get('Status') || '').toLowerCase() === 'pending') pendingOrders++;
                if (iso && iso >= weekAgo) {
                    ordersThisWeek++;
                    revenueThisWeek += orderTotal(o);
                }
            }
        } catch (e) {}
        revenueThisWeek = round2(revenueThisWeek);
        if ('ordersThisWeek' in baseline) result.ordersThisWeek = ordersThisWeek;
        if ('revenueThisWeek' in baseline) result.revenueThisWeek = revenueThisWeek;
        if ('avgOrderThisWeek' in baseline) result.avgOrderThisWeek = ordersThisWeek > 0 ? round2(revenueThisWeek / ordersThisWeek) : 0;
        if ('pendingOrders' in baseline) result.pendingOrders = pendingOrders;
    }

    return result;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const decoded = verifyToken(event);
    if (!decoded || decoded.role !== 'client') {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const tier = normalizeTier(decoded.tier);
    if (!tierIncludes(tier, 'smart_suggestions')) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Smart Suggestions are a Growth feature.' }) };
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { id, action } = payload;
    const newStatus = ACTION_STATUS[action];
    if (!id || !newStatus) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'id and a valid action are required' }) };
    }

    try {
        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const clientId = decoded.userId;

        // Fetch + ownership check.
        let suggestion;
        try {
            suggestion = await base('Suggestions').find(id);
        } catch (e) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: 'Suggestion not found' }) };
        }
        if (suggestion.get('ClientID') !== clientId) {
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
        }

        const fields = {
            Status: newStatus,
            ReviewedAt: new Date().toISOString()
        };

        // For keep/stop, capture a result snapshot vs the original baseline so the
        // owner can see whether acting on the suggestion moved the metric.
        let result = parseMetric(suggestion.get('ResultMetric'));
        if (action === 'keep' || action === 'stop') {
            const baseline = parseMetric(suggestion.get('BaselineMetric'));
            try {
                const client = await base('Clients').find(clientId);
                result = await snapshotResult(base, client, baseline);
                fields.ResultMetric = JSON.stringify(result);
            } catch (e) {
                // Non-fatal — still record the status change.
            }
        }

        await base('Suggestions').update([{ id, fields }]);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                id,
                status: newStatus,
                result,
                reviewedAt: fields.ReviewedAt
            })
        };

    } catch (error) {
        console.error('Update suggestion error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update suggestion' }) };
    }
};
