const Airtable = require('airtable');
const fetch = require('node-fetch');

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

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

        // Send push notification to store owner
        const deviceRecords = await base('DeviceTokens').select({
            filterByFormula: `{ClientID} = '${tenantId}'`
        }).firstPage();

        if (deviceRecords.length > 0 && process.env.FIREBASE_SERVER_KEY) {
            const tokens = deviceRecords.map(r => r.get('Token')).filter(Boolean);

            for (const token of tokens) {
                try {
                    await fetch('https://fcm.googleapis.com/fcm/send', {
                        method: 'POST',
                        headers: {
                            'Authorization': `key=${process.env.FIREBASE_SERVER_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            to: token,
                            notification: {
                                title: `New message from ${customerName || 'a customer'}`,
                                body: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
                                sound: 'default',
                                badge: '1'
                            },
                            data: {
                                conversationId,
                                type: 'new_escalation'
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
