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
    if (!decoded || decoded.role !== 'client') {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    try {
        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const tenantId = decoded.userId;

        // Get query params for filtering
        const params = event.queryStringParameters || {};
        const status = params.status; // optional filter: active, waiting_for_owner, resolved

        let filterFormula = `{TenantID} = '${tenantId}'`;
        if (status) {
            filterFormula = `AND({TenantID} = '${tenantId}', {Status} = '${status}')`;
        }

        const records = await base('Conversations').select({
            filterByFormula: filterFormula,
            sort: [{ field: 'LastMessageAt', direction: 'desc' }],
            maxRecords: 50
        }).firstPage();

        const conversations = records.map(rec => ({
            id: rec.id,
            customerName: rec.get('CustomerName') || 'Website Visitor',
            customerEmail: rec.get('CustomerEmail') || '',
            status: rec.get('Status') || 'active',
            channel: rec.get('Channel') || 'website_chat',
            escalatedAt: rec.get('EscalatedAt') || '',
            lastMessageAt: rec.get('LastMessageAt') || '',
            resolvedAt: rec.get('ResolvedAt') || '',
            sessionId: rec.get('SessionID') || ''
        }));

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ conversations })
        };

    } catch (error) {
        console.error('Get conversations error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to fetch conversations' })
        };
    }
};
