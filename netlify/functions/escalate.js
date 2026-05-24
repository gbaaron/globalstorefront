const Airtable = require('airtable');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

// Get OAuth2 access token from Firebase service account (FCM v1 API)
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && now < tokenExpiry - 60) {
        return cachedToken;
    }

    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const jwtPayload = {
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: serviceAccount.token_uri,
        iat: now,
        exp: now + 3600
    };

    const signed = jwt.sign(jwtPayload, serviceAccount.private_key, { algorithm: 'RS256' });

    const res = await fetch(serviceAccount.token_uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signed}`
    });

    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiry = now + (data.expires_in || 3600);
    return cachedToken;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const { tenantId, customerName, customerEmail, message, sessionId } = JSON.parse(event.body);

        if (!tenantId || !message) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'tenantId and message required' }) };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        // Create conversation record
        const conversationRecords = await base('Conversations').create([{
            fields: {
                TenantID: tenantId,
                CustomerName: customerName || 'Website Visitor',
                CustomerEmail: customerEmail || '',
                Status: 'waiting_for_owner',
                Channel: 'website_chat',
                SessionID: sessionId || '',
                EscalatedAt: new Date().toISOString(),
                LastMessageAt: new Date().toISOString()
            }
        }]);

        const conversation = conversationRecords[0];
        const conversationId = conversation.id;

        // Create the first message in this conversation
        await base('Messages').create([{
            fields: {
                ConversationID: conversationId,
                Sender: 'customer',
                Content: message,
                Timestamp: new Date().toISOString(),
                ReadByOwner: false,
                ReadByCustomer: true
            }
        }]);

        // Send push notification via FCM v1 API
        const deviceRecords = await base('DeviceTokens').select({
            filterByFormula: `{ClientID} = '${tenantId}'`
        }).firstPage();

        if (deviceRecords.length > 0 && process.env.FIREBASE_SERVICE_ACCOUNT) {
            const tokens = deviceRecords.map(r => r.get('Token')).filter(Boolean);
            const accessToken = await getAccessToken();
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            const projectId = serviceAccount.project_id;

            for (const token of tokens) {
                try {
                    await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            message: {
                                token: token,
                                notification: {
                                    title: `New message from ${customerName || 'a customer'}`,
                                    body: message.substring(0, 100) + (message.length > 100 ? '...' : '')
                                },
                                apns: {
                                    payload: {
                                        aps: {
                                            sound: 'default',
                                            badge: 1
                                        }
                                    }
                                },
                                data: {
                                    conversationId,
                                    type: 'new_escalation'
                                }
                            }
                        })
                    });
                } catch (pushErr) {
                    console.error('Push notification failed for token:', pushErr.message);
                }
            }
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                conversationId,
                message: 'Escalated to store owner'
            })
        };

    } catch (error) {
        console.error('Escalation error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to escalate message' })
        };
    }
};
