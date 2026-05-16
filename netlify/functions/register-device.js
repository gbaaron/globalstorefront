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
        const { token, platform } = JSON.parse(event.body);

        if (!token) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'token required' }) };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const clientId = decoded.userId;

        // Check if this token already exists for this client
        const existing = await base('DeviceTokens').select({
            filterByFormula: `AND({ClientID} = '${clientId}', {Token} = '${token}')`,
            maxRecords: 1
        }).firstPage();

        if (existing.length > 0) {
            // Update LastUsedAt
            await base('DeviceTokens').update([{
                id: existing[0].id,
                fields: { LastUsedAt: new Date().toISOString() }
            }]);
        } else {
            // Create new device token record
            await base('DeviceTokens').create([{
                fields: {
                    ClientID: clientId,
                    Token: token,
                    Platform: platform || 'web',
                    CreatedAt: new Date().toISOString(),
                    LastUsedAt: new Date().toISOString()
                }
            }]);
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true })
        };

    } catch (error) {
        console.error('Register device error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to register device' })
        };
    }
};
