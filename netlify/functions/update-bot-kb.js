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
    if (!decoded || decoded.role !== 'admin') {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    try {
        const { action, tenantId, entryId, category, key, value, priority } = JSON.parse(event.body);

        if (!tenantId) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'tenantId required' }) };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        switch (action) {
            case 'create': {
                if (!key || !value) {
                    return { statusCode: 400, headers, body: JSON.stringify({ error: 'key and value required' }) };
                }
                const created = await base('BotKnowledgeBase').create([{
                    fields: {
                        TenantID: tenantId,
                        Category: category || 'general',
                        Key: key,
                        Value: value,
                        Priority: priority || 0
                    }
                }]);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: true, id: created[0].id })
                };
            }

            case 'update': {
                if (!entryId) {
                    return { statusCode: 400, headers, body: JSON.stringify({ error: 'entryId required for update' }) };
                }
                const fields = {};
                if (category !== undefined) fields.Category = category;
                if (key !== undefined) fields.Key = key;
                if (value !== undefined) fields.Value = value;
                if (priority !== undefined) fields.Priority = priority;

                await base('BotKnowledgeBase').update([{ id: entryId, fields }]);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: true })
                };
            }

            case 'delete': {
                if (!entryId) {
                    return { statusCode: 400, headers, body: JSON.stringify({ error: 'entryId required for delete' }) };
                }
                await base('BotKnowledgeBase').destroy([entryId]);
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: true })
                };
            }

            default:
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'action must be create, update, or delete' }) };
        }

    } catch (error) {
        console.error('Update bot KB error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to update knowledge base' })
        };
    }
};
