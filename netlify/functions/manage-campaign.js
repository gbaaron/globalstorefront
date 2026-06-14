const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const { tierIncludes, normalizeTier } = require('./lib/tiers');
const { sendCampaign } = require('./lib/campaign-send');

// Client-facing email marketing management for the owner app. Management lives
// in GS; the actual recipient list stays on the client's own base (read at
// send time by lib/campaign-send.js).
//
//   GET  /api/manage-campaign            → this client's campaigns (newest first)
//   POST /api/manage-campaign  { action, ... }
//     action: 'create'  { type, subject, body, schedule? }   → new draft/scheduled row
//             'update'  { id, subject?, body?, type?, schedule?, status? }
//             'delete'  { id }                                 → archive (soft delete)
//             'send'    { id }                                 → send now via provider
//
// Gated to Growth+ ('email_marketing') with an ownership check on every row.

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
};

const VALID_TYPES = ['cart_abandon', 'seasonal', 'blast'];

function verifyToken(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    try {
        return jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production');
    } catch (e) {
        return null;
    }
}

function serializeCampaign(r) {
    return {
        id: r.id,
        campaignId: r.get('CampaignID') || '',
        type: r.get('Type') || 'blast',
        subject: r.get('Subject') || '',
        body: r.get('Body') || '',
        status: r.get('Status') || 'draft',
        schedule: r.get('Schedule') || '',
        recipientCount: r.get('RecipientCount') || 0,
        sentCount: r.get('SentCount') || 0,
        lastSentAt: r.get('LastSentAt') || '',
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
    if (!tierIncludes(tier, 'email_marketing')) {
        // List endpoint returns a soft lock so the app can show an upgrade gate.
        if (event.httpMethod === 'GET') {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ data: [], locked: true, message: 'Email marketing is a Growth feature.' })
            };
        }
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Email marketing is a Growth feature.' }) };
    }

    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
    const clientId = decoded.userId;

    try {
        // ---- LIST ----
        if (event.httpMethod === 'GET') {
            let records = [];
            try {
                records = await base('EmailCampaigns').select({
                    filterByFormula: `{ClientID} = '${clientId}'`,
                    sort: [{ field: 'CreatedAt', direction: 'desc' }],
                    maxRecords: 200
                }).all();
            } catch (e) {
                // Table may not exist yet — return empty rather than 500.
                return { statusCode: 200, headers, body: JSON.stringify({ data: [] }) };
            }

            const data = records.map(serializeCampaign);
            const counts = data.reduce((acc, c) => {
                acc[c.status] = (acc[c.status] || 0) + 1;
                return acc;
            }, {});
            return { statusCode: 200, headers, body: JSON.stringify({ data, counts }) };
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

        // ---- CREATE ----
        if (action === 'create') {
            const type = VALID_TYPES.includes(payload.type) ? payload.type : 'blast';
            const subject = (payload.subject || '').trim();
            const body = (payload.body || '').trim();
            if (!subject || !body) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Subject and body are required' }) };
            }
            const schedule = (payload.schedule || '').trim();
            const status = schedule ? 'scheduled' : 'draft';

            const created = await base('EmailCampaigns').create([{
                fields: {
                    CampaignID: 'camp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    ClientID: clientId,
                    Type: type,
                    Subject: subject,
                    Body: body,
                    Status: status,
                    Schedule: schedule,
                    RecipientCount: 0,
                    SentCount: 0,
                    LastSentAt: '',
                    CreatedAt: new Date().toISOString()
                }
            }]);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, campaign: serializeCampaign(created[0]) }) };
        }

        // All remaining actions operate on a specific row — fetch + ownership check.
        const { id } = payload;
        if (!id) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'id is required' }) };
        }

        let campaign;
        try {
            campaign = await base('EmailCampaigns').find(id);
        } catch (e) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: 'Campaign not found' }) };
        }
        if (campaign.get('ClientID') !== clientId) {
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
        }

        // ---- UPDATE ----
        if (action === 'update') {
            const fields = {};
            if (typeof payload.subject === 'string') fields.Subject = payload.subject.trim();
            if (typeof payload.body === 'string') fields.Body = payload.body.trim();
            if (VALID_TYPES.includes(payload.type)) fields.Type = payload.type;
            if (typeof payload.schedule === 'string') {
                fields.Schedule = payload.schedule.trim();
                // Re-derive status only while still editable (draft/scheduled).
                const current = campaign.get('Status') || 'draft';
                if (current === 'draft' || current === 'scheduled') {
                    fields.Status = fields.Schedule ? 'scheduled' : 'draft';
                }
            }
            if (typeof payload.status === 'string' && ['draft', 'scheduled', 'archived'].includes(payload.status)) {
                fields.Status = payload.status;
            }
            const updated = await base('EmailCampaigns').update([{ id, fields }]);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, campaign: serializeCampaign(updated[0]) }) };
        }

        // ---- DELETE (soft) ----
        if (action === 'delete') {
            const updated = await base('EmailCampaigns').update([{ id, fields: { Status: 'archived' } }]);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, campaign: serializeCampaign(updated[0]) }) };
        }

        // ---- SEND NOW ----
        if (action === 'send') {
            let client;
            try {
                client = await base('Clients').find(clientId);
            } catch (e) {
                return { statusCode: 404, headers, body: JSON.stringify({ error: 'Client not found' }) };
            }
            const result = await sendCampaign(base, campaign, client);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, result }) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

    } catch (error) {
        console.error('Manage campaign error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to manage campaign' }) };
    }
};
