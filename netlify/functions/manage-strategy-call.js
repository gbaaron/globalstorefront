const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const { tierIncludes, normalizeTier } = require('./lib/tiers');

// Client-facing quarterly strategy-call management for the owner app.
//
//   GET  /api/manage-strategy-call            → this client's calls (newest first)
//   POST /api/manage-strategy-call  { action, ... }
//     action: 'request' { quarter, topic, requestedSlot? } → new 'requested' row
//             'cancel'  { id }                              → cancel a call
//
// Concierge clients get one strategy call per quarter. The actual scheduling
// (Status → scheduled, ScheduledAt) is done by Aaron from the admin side; this
// endpoint lets the owner request and cancel. Gated to Concierge
// ('strategy_calls') with an ownership check on row-specific actions.

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
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

// Derive the current calendar quarter label, e.g. "2026-Q2".
function currentQuarter() {
    const now = new Date();
    const q = Math.floor(now.getMonth() / 3) + 1;
    return `${now.getFullYear()}-Q${q}`;
}

function serializeCall(r) {
    return {
        id: r.id,
        callId: r.get('CallID') || '',
        quarter: r.get('Quarter') || '',
        topic: r.get('Topic') || '',
        requestedSlot: r.get('RequestedSlot') || '',
        scheduledAt: r.get('ScheduledAt') || '',
        status: r.get('Status') || 'requested',
        notes: r.get('Notes') || '',
        createdAt: r.get('CreatedAt') || ''
    };
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
    if (!tierIncludes(tier, 'strategy_calls')) {
        if (event.httpMethod === 'GET') {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ data: [], locked: true, message: 'Strategy calls are a Concierge feature.' })
            };
        }
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Strategy calls are a Concierge feature.' }) };
    }

    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
    const clientId = decoded.userId;
    const thisQuarter = currentQuarter();

    try {
        // ---- LIST ----
        if (event.httpMethod === 'GET') {
            let records = [];
            try {
                records = await base('StrategyCalls').select({
                    filterByFormula: `{ClientID} = '${clientId}'`,
                    sort: [{ field: 'CreatedAt', direction: 'desc' }],
                    maxRecords: 100
                }).all();
            } catch (e) {
                return { statusCode: 200, headers, body: JSON.stringify({ data: [], quarter: thisQuarter }) };
            }
            const data = records.map(serializeCall);
            // Has the owner already used their call this quarter?
            const usedThisQuarter = data.some(c =>
                c.quarter === thisQuarter && c.status !== 'canceled'
            );
            return { statusCode: 200, headers, body: JSON.stringify({ data, quarter: thisQuarter, usedThisQuarter }) };
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

        // ---- REQUEST a call ----
        if (action === 'request') {
            const topic = (payload.topic || '').trim();
            if (!topic) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'A topic is required' }) };
            }
            const quarter = (payload.quarter || thisQuarter).trim();

            // One active call per quarter.
            const existing = await base('StrategyCalls').select({
                filterByFormula: `AND({ClientID} = '${clientId}', {Quarter} = '${quarter}')`,
                maxRecords: 10
            }).all();
            const active = existing.find(r => (r.get('Status') || '') !== 'canceled');
            if (active) {
                return { statusCode: 409, headers, body: JSON.stringify({ error: `You already have a strategy call for ${quarter}.` }) };
            }

            const created = await base('StrategyCalls').create([{
                fields: {
                    CallID: 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    ClientID: clientId,
                    Quarter: quarter,
                    Topic: topic,
                    RequestedSlot: (payload.requestedSlot || '').trim(),
                    ScheduledAt: '',
                    Status: 'requested',
                    Notes: '',
                    CreatedAt: new Date().toISOString()
                }
            }]);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, call: serializeCall(created[0]) }) };
        }

        // ---- CANCEL a call ----
        if (action === 'cancel') {
            const { id } = payload;
            if (!id) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'id is required' }) };
            }
            let call;
            try {
                call = await base('StrategyCalls').find(id);
            } catch (e) {
                return { statusCode: 404, headers, body: JSON.stringify({ error: 'Call not found' }) };
            }
            if (call.get('ClientID') !== clientId) {
                return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
            }
            const updated = await base('StrategyCalls').update([{ id, fields: { Status: 'canceled' } }]);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, call: serializeCall(updated[0]) }) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

    } catch (error) {
        console.error('Manage strategy call error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to manage strategy call' }) };
    }
};
