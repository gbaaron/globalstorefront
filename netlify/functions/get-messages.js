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
        const params = event.queryStringParameters || {};
        const conversationId = params.conversationId;

        if (!conversationId) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'conversationId required' }) };
        }

        // Verify this conversation belongs to the logged-in tenant
        let conversation;
        try {
            conversation = await base('Conversations').find(conversationId);
        } catch (e) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: 'Conversation not found' }) };
        }

        if (conversation.get('TenantID') !== decoded.userId) {
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'Access denied' }) };
        }

        // Fetch messages for this conversation
        const records = await base('Messages').select({
            filterByFormula: `{ConversationID} = '${conversationId}'`,
            sort: [{ field: 'Timestamp', direction: 'asc' }]
        }).firstPage();

        const messages = records.map(rec => ({
            id: rec.id,
            sender: rec.get('Sender') || 'customer',
            content: rec.get('Content') || '',
            timestamp: rec.get('Timestamp') || '',
            readByOwner: !!rec.get('ReadByOwner'),
            readByCustomer: !!rec.get('ReadByCustomer')
        }));

        // Mark all unread messages as read by owner
        const unread = records.filter(r => !r.get('ReadByOwner') && r.get('Sender') === 'customer');
        if (unread.length > 0) {
            const batch = unread.slice(0, 10).map(r => ({
                id: r.id,
                fields: { ReadByOwner: true }
            }));
            base('Messages').update(batch).catch(() => {});
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                conversation: {
                    id: conversation.id,
                    customerName: conversation.get('CustomerName'),
                    status: conversation.get('Status')
                },
                messages
            })
        };

    } catch (error) {
        console.error('Get messages error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to fetch messages' })
        };
    }
};
