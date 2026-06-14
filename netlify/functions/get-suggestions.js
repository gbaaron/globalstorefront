const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const { tierIncludes, normalizeTier } = require('./lib/tiers');

// Client-facing Smart Suggestions list for the owner app.
//   GET /api/get-suggestions             → this client's suggestions (newest first)
//   GET /api/get-suggestions?status=new  → filter by a single status
//
// Suggestions rows are written weekly by generate-suggestions.js. The owner acts
// on them via update-suggestion.js (Create This / Keep / Stop / Archive).
// Gated to Growth+ (tier includes 'smart_suggestions').

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

// Safe JSON parse for the metric snapshots stored as strings.
function parseMetric(raw) {
    try {
        return JSON.parse(raw || '{}');
    } catch (e) {
        return {};
    }
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const decoded = verifyToken(event);
    if (!decoded || decoded.role !== 'client') {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const tier = normalizeTier(decoded.tier);
    if (!tierIncludes(tier, 'smart_suggestions')) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: [], locked: true, message: 'Smart Suggestions are a Growth feature.' })
        };
    }

    try {
        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const params = event.queryStringParameters || {};
        const clientId = decoded.userId;

        // Build the filter — always scoped to this client; optional status filter.
        let formula = `{ClientID} = '${clientId}'`;
        if (params.status) {
            formula = `AND({ClientID} = '${clientId}', {Status} = '${params.status}')`;
        }

        const records = await base('Suggestions').select({
            filterByFormula: formula,
            sort: [{ field: 'CreatedAt', direction: 'desc' }],
            maxRecords: 200
        }).all();

        const data = records.map(r => ({
            id: r.id,
            suggestionId: r.get('SuggestionID') || '',
            title: r.get('Title') || '',
            body: r.get('Body') || '',
            category: r.get('Category') || 'general',
            status: r.get('Status') || 'new',
            baseline: parseMetric(r.get('BaselineMetric')),
            result: parseMetric(r.get('ResultMetric')),
            createdAt: r.get('CreatedAt') || '',
            reviewedAt: r.get('ReviewedAt') || ''
        }));

        // Light summary for the app header (counts by status).
        const counts = data.reduce((acc, s) => {
            acc[s.status] = (acc[s.status] || 0) + 1;
            return acc;
        }, {});

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data, counts })
        };

    } catch (error) {
        console.error('Get suggestions error:', error);
        // Suggestions table may not exist yet — return empty rather than 500.
        return { statusCode: 200, headers, body: JSON.stringify({ data: [], message: 'No suggestions available yet.' }) };
    }
};
