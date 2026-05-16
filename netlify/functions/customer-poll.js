const Airtable = require('airtable');

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const params = event.queryStringParameters || {};
        const { conversationId, after } = params;

        if (!conversationId) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'conversationId required' }) };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        // Fetch owner replies for this conversation that the customer hasn't seen
        let filterFormula = `AND({ConversationID} = '${conversationId}', {Sender} = 'owner')`;
        if (after) {
            filterFormula = `AND({ConversationID} = '${conversationId}', {Sender} = 'owner', IS_AFTER({Timestamp}, '${after}'))`;
        }

        const records = await base('Messages').select({
            filterByFormula: `AND({ConversationID} = '${conversationId}', {Sender} = 'owner', {ReadByCustomer} = FALSE())`,
            sort: [{ field: 'Timestamp', direction: 'asc' }]
        }).firstPage();

        const messages = records.map(rec => ({
            id: rec.id,
            content: rec.get('Content') || '',
            timestamp: rec.get('Timestamp') || ''
        }));

        // Mark as read by customer
        if (records.length > 0) {
            const batch = records.slice(0, 10).map(r => ({
                id: r.id,
                fields: { ReadByCustomer: true }
            }));
            base('Messages').update(batch).catch(() => {});
        }

        // Also check conversation status
        let status = 'active';
        try {
            const conv = await base('Conversations').find(conversationId);
            status = conv.get('Status') || 'active';
        } catch (e) {}

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ messages, status })
        };

    } catch (error) {
        console.error('Customer poll error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to poll messages' })
        };
    }
};
