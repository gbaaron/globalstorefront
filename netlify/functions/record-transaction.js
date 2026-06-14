const Airtable = require('airtable');
const { splitTransaction } = require('./lib/tiers');

// Called by a client's own site when a customer completes a payment.
// CORS-open (like escalate.js) because it's invoked cross-origin from the
// client's storefront. Computes the 10/90 GS-cut / client-net split and writes
// a Transactions row. No live Stripe transfer happens here — the daily
// sweep-payouts job handles moving the 90% out.
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
        const { clientId, amount, stripePaymentId, customerEmail, description } = JSON.parse(event.body);

        if (!clientId || amount === undefined || amount === null) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'clientId and amount are required' }) };
        }

        const gross = Number(amount);
        if (!isFinite(gross) || gross <= 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'amount must be a positive number' }) };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        // Verify the client exists (clientId is the Clients record id).
        let client;
        try {
            client = await base('Clients').find(clientId);
        } catch (e) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: 'Unknown client' }) };
        }

        const { amount: grossRounded, gsCut, clientNet } = splitTransaction(gross);

        const record = await base('Transactions').create([{
            fields: {
                TransactionID: 'txn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                ClientID: clientId,
                Amount: grossRounded,
                GSCut: gsCut,
                ClientNet: clientNet,
                StripePaymentId: stripePaymentId || '',
                Status: 'succeeded',
                PayoutStatus: 'pending',
                CustomerEmail: customerEmail || '',
                Description: description || '',
                Date: new Date().toISOString()
            }
        }]);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                transaction: {
                    id: record[0].id,
                    amount: grossRounded,
                    gsCut,
                    clientNet,
                    client: client.get('Name')
                }
            })
        };

    } catch (error) {
        console.error('Record transaction error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to record transaction' }) };
    }
};
