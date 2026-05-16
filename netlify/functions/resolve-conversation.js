const Airtable = require('airtable');
const jwt = require('jsonwebtoken');

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const decoded = verifyToken(event);
    if (!decoded || decoded.role !== 'client') {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    try {
        const { conversationId } = JSON.parse(event.body);

        if (!conversationId) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'conversationId required' }) };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        // Verify conversation belongs to this tenant
        let conversation;
        try {
            conversation = await base('Conversations').find(conversationId);
        } catch (e) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: 'Conversation not found' }) };
        }

        if (conversation.get('TenantID') !== decoded.userId) {
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'Access denied' }) };
        }

        await base('Conversations').update([{
            id: conversationId,
            fields: {
                Status: 'resolved',
                ResolvedAt: new Date().toISOString()
            }
        }]);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true })
        };

    } catch (error) {
        console.error('Resolve conversation error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to resolve conversation' })
        };
    }
};
