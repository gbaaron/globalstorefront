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
        const { conversationId, content } = JSON.parse(event.body);

        if (!conversationId || !content) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'conversationId and content required' }) };
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

        // Create the message
        const now = new Date().toISOString();
        await base('Messages').create([{
            fields: {
                ConversationID: conversationId,
                Sender: 'owner',
                Content: content,
                Timestamp: now,
                ReadByOwner: true,
                ReadByCustomer: false
            }
        }]);

        // Update conversation status and last message time
        await base('Conversations').update([{
            id: conversationId,
            fields: {
                Status: 'active',
                LastMessageAt: now
            }
        }]);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, sentAt: now })
        };

    } catch (error) {
        console.error('Send message error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to send message' })
        };
    }
};
