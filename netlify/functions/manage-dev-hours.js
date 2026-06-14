const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const { tierIncludes, normalizeTier, round2, DEV_HOUR_OVERAGE_RATE } = require('./lib/tiers');

// Client-facing dev-hours tracker for the owner app.
//
//   GET  /api/manage-dev-hours            → this client's entries + this-month usage summary
//   POST /api/manage-dev-hours  { action, ... }
//     action: 'request' { description, hours } → new 'requested' entry (computes overage)
//             'cancel'  { id }                 → cancel an entry
//
// Concierge clients get 1 free dev hour per calendar month; hours beyond that
// are billable at $50/hr (DEV_HOUR_OVERAGE_RATE). The free hour resets monthly.
// Aaron does the actual work and flips Status (requested → in_progress →
// completed) from the admin side; this endpoint lets the owner request and
// cancel. Gated to Concierge ('dev_hours') with an ownership check on
// row-specific actions.

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
};

const FREE_HOURS_PER_MONTH = 1; // included with Concierge

function verifyToken(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    try {
        return jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production');
    } catch (e) {
        return null;
    }
}

// Derive the current calendar month label, e.g. "2026-06".
function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function serializeEntry(r) {
    return {
        id: r.id,
        entryId: r.get('EntryID') || '',
        month: r.get('Month') || '',
        description: r.get('Description') || '',
        hours: r.get('Hours') || 0,
        status: r.get('Status') || 'requested',
        billable: !!r.get('Billable'),
        overageAmount: r.get('OverageAmount') || 0,
        createdAt: r.get('CreatedAt') || ''
    };
}

// Given hours already used this month and a new request, compute how much of the
// new request falls outside the free allowance and the resulting overage charge.
function computeOverage(hoursUsedThisMonth, requestedHours) {
    const freeRemaining = Math.max(0, FREE_HOURS_PER_MONTH - hoursUsedThisMonth);
    const billableHours = Math.max(0, round2(requestedHours - freeRemaining));
    const overageAmount = round2(billableHours * DEV_HOUR_OVERAGE_RATE);
    return { freeRemaining: round2(freeRemaining), billableHours, overageAmount };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    const decoded = verifyToken(event);
    if (!decoded || decoded.role !== 'client') {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const tier = normalizeTier(decoded.tier);
    if (!tierIncludes(tier, 'dev_hours')) {
        if (event.httpMethod === 'GET') {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ data: [], locked: true, message: 'Dev hours are a Concierge feature.' })
            };
        }
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Dev hours are a Concierge feature.' }) };
    }

    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
    const clientId = decoded.userId;
    const thisMonth = currentMonth();

    // Sum non-canceled hours already logged for this client in a given month.
    function usedHours(entries, month) {
        return round2(entries
            .filter(c => c.month === month && c.status !== 'canceled')
            .reduce((sum, c) => sum + (Number(c.hours) || 0), 0));
    }

    try {
        // ---- LIST ----
        if (event.httpMethod === 'GET') {
            let records = [];
            try {
                records = await base('DevHours').select({
                    filterByFormula: `{ClientID} = '${clientId}'`,
                    sort: [{ field: 'CreatedAt', direction: 'desc' }],
                    maxRecords: 200
                }).all();
            } catch (e) {
                return { statusCode: 200, headers, body: JSON.stringify({ data: [], month: thisMonth }) };
            }
            const data = records.map(serializeEntry);
            const hoursUsed = usedHours(data, thisMonth);
            const summary = {
                month: thisMonth,
                freeHours: FREE_HOURS_PER_MONTH,
                hoursUsed,
                freeRemaining: round2(Math.max(0, FREE_HOURS_PER_MONTH - hoursUsed)),
                overageRate: DEV_HOUR_OVERAGE_RATE,
                overageHours: round2(Math.max(0, hoursUsed - FREE_HOURS_PER_MONTH)),
                overageOwed: round2(Math.max(0, hoursUsed - FREE_HOURS_PER_MONTH) * DEV_HOUR_OVERAGE_RATE)
            };
            return { statusCode: 200, headers, body: JSON.stringify({ data, summary }) };
        }

        if (event.httpMethod !== 'POST') {
            return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
        }

        let payload;
        try {
            payload = JSON.parse(event.body || '{}');
        } catch (e) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
        }

        const action = payload.action;

        // ---- REQUEST dev hours ----
        if (action === 'request') {
            const description = (payload.description || '').trim();
            if (!description) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'A description is required' }) };
            }
            const hours = Number(payload.hours);
            if (!hours || hours <= 0) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Hours must be a positive number' }) };
            }

            // Compute overage against hours already used this month.
            let existing = [];
            try {
                existing = await base('DevHours').select({
                    filterByFormula: `{ClientID} = '${clientId}'`,
                    maxRecords: 200
                }).all();
            } catch (e) {}
            const hoursUsed = usedHours(existing.map(serializeEntry), thisMonth);
            const { billableHours, overageAmount } = computeOverage(hoursUsed, hours);

            const created = await base('DevHours').create([{
                fields: {
                    EntryID: 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    ClientID: clientId,
                    Month: thisMonth,
                    Description: description,
                    Hours: round2(hours),
                    Status: 'requested',
                    Billable: billableHours > 0,
                    OverageAmount: overageAmount,
                    CreatedAt: new Date().toISOString()
                }
            }]);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, entry: serializeEntry(created[0]) }) };
        }

        // ---- CANCEL an entry ----
        if (action === 'cancel') {
            const { id } = payload;
            if (!id) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'id is required' }) };
            }
            let entry;
            try {
                entry = await base('DevHours').find(id);
            } catch (e) {
                return { statusCode: 404, headers, body: JSON.stringify({ error: 'Entry not found' }) };
            }
            if (entry.get('ClientID') !== clientId) {
                return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
            }
            // Only requested entries can be canceled by the owner; in-progress/completed
            // are locked (Aaron is already working / done).
            if ((entry.get('Status') || '') !== 'requested') {
                return { statusCode: 409, headers, body: JSON.stringify({ error: 'Only pending requests can be canceled.' }) };
            }
            const updated = await base('DevHours').update([{ id, fields: { Status: 'canceled' } }], { typecast: true });
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, entry: serializeEntry(updated[0]) }) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

    } catch (error) {
        console.error('Manage dev hours error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to manage dev hours' }) };
    }
};
