const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const { tierIncludes, normalizeTier } = require('./lib/tiers');

// Client-facing social-post suggestions list for the owner app.
//   GET /api/get-social               → this client's suggested posts (newest first)
//   GET /api/get-social?status=new    → filter by a single status
//
// SocialPosts rows are written weekly by generate-social.js. The owner acts on
// them via update-social.js (Schedule / Mark Posted / Archive). Gated to
// Concierge (tier includes 'social_posts').

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

function serializePost(r) {
    return {
        id: r.id,
        postId: r.get('PostID') || '',
        platform: r.get('Platform') || 'instagram',
        caption: r.get('Caption') || '',
        hashtags: r.get('Hashtags') || '',
        category: r.get('Category') || 'promo',
        status: r.get('Status') || 'new',
        scheduledFor: r.get('ScheduledFor') || '',
        createdAt: r.get('CreatedAt') || ''
    };
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
    if (!tierIncludes(tier, 'social_posts')) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: [], locked: true, message: 'Social post suggestions are a Concierge feature.' })
        };
    }

    try {
        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const params = event.queryStringParameters || {};
        const clientId = decoded.userId;

        let formula = `{ClientID} = '${clientId}'`;
        if (params.status) {
            formula = `AND({ClientID} = '${clientId}', {Status} = '${params.status}')`;
        }

        const records = await base('SocialPosts').select({
            filterByFormula: formula,
            sort: [{ field: 'CreatedAt', direction: 'desc' }],
            maxRecords: 200
        }).all();

        const data = records.map(serializePost);
        const counts = data.reduce((acc, p) => {
            acc[p.status] = (acc[p.status] || 0) + 1;
            return acc;
        }, {});

        return { statusCode: 200, headers, body: JSON.stringify({ data, counts }) };

    } catch (error) {
        console.error('Get social error:', error);
        // SocialPosts table may not exist yet — return empty rather than 500.
        return { statusCode: 200, headers, body: JSON.stringify({ data: [], message: 'No social posts available yet.' }) };
    }
};
