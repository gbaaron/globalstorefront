const Airtable = require('airtable');
const jwt = require('jsonwebtoken');

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

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const decoded = verifyToken(event);
    if (!decoded || decoded.role !== 'admin') {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    try {
        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const params = event.queryStringParameters || {};
        const tenantId = params.tenantId;

        if (!tenantId) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'tenantId required' }) };
        }

        const records = await base('BotKnowledgeBase').select({
            filterByFormula: `{TenantID} = '${tenantId}'`,
            sort: [{ field: 'Category', direction: 'asc' }, { field: 'Priority', direction: 'desc' }]
        }).firstPage();

        const entries = records.map(rec => ({
            id: rec.id,
            category: rec.get('Category') || 'general',
            key: rec.get('Key') || '',
            value: rec.get('Value') || '',
            priority: rec.get('Priority') || 0
        }));

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ entries })
        };

    } catch (error) {
        console.error('Get bot KB error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to fetch knowledge base' })
        };
    }
};
