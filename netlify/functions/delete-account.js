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

// Delete every record in a table matching a formula, in batches of 10.
// Swallows errors (e.g. table doesn't exist) so one failure can't block deletion.
async function destroyWhere(base, table, filterByFormula) {
    try {
        const recs = await base(table).select({ filterByFormula }).all();
        for (let i = 0; i < recs.length; i += 10) {
            const ids = recs.slice(i, i + 10).map(r => r.id);
            await base(table).destroy(ids);
        }
        return recs.length;
    } catch (e) {
        return 0;
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

    // Require an explicit confirmation so this can never fire by accident.
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) {}
    if (body.confirm !== 'DELETE') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Confirmation required' }) };
    }

    try {
        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const tenantId = decoded.userId;

        // 1. Delete the messages inside this tenant's conversations.
        try {
            const convs = await base('Conversations').select({
                filterByFormula: `{TenantID} = '${tenantId}'`
            }).all();
            for (const conv of convs) {
                await destroyWhere(base, 'Messages', `{ConversationID} = '${conv.id}'`);
            }
        } catch (e) {}

        // 2. Delete this tenant's conversations, push tokens, and bot logs.
        await destroyWhere(base, 'Conversations', `{TenantID} = '${tenantId}'`);
        await destroyWhere(base, 'DeviceTokens', `{ClientID} = '${tenantId}'`);
        await destroyWhere(base, 'BotConversations', `{TenantID} = '${tenantId}'`);
        await destroyWhere(base, 'BotKnowledgeBase', `{TenantID} = '${tenantId}'`);

        // 3. Finally delete the account record itself.
        await base('Clients').destroy([tenantId]);

        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

    } catch (error) {
        console.error('Delete account error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to delete account' }) };
    }
};
