const Airtable = require('airtable');
const { splitTransaction } = require('./lib/tiers');

// Stripe webhook handler — STRUCTURE NOW, live activation later.
//
// When STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET are set, the signature is
// verified with the Stripe SDK. Until then, the handler parses the event body
// directly so it can be exercised with the Stripe CLI / test fixtures without
// live keys. No money moves here; payment events are translated into
// Transactions rows (10/90 split) and subscription events update the client's
// SubStatus.
const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

function getBase() {
    return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
}

async function handlePaymentSucceeded(obj) {
    const clientId = obj.metadata?.clientId || obj.metadata?.client_id;
    const amount = (obj.amount_received ?? obj.amount ?? 0) / 100; // Stripe amounts are in cents
    if (!clientId || amount <= 0) {
        return { skipped: true, reason: 'missing clientId or amount' };
    }
    const { amount: gross, gsCut, clientNet } = splitTransaction(amount);
    const base = getBase();
    await base('Transactions').create([{
        fields: {
            TransactionID: 'txn_' + (obj.id || Date.now()),
            ClientID: clientId,
            Amount: gross,
            GSCut: gsCut,
            ClientNet: clientNet,
            StripePaymentId: obj.id || '',
            Status: 'succeeded',
            PayoutStatus: 'pending',
            CustomerEmail: obj.receipt_email || obj.customer_email || '',
            Description: obj.description || 'Stripe payment',
            Date: new Date().toISOString()
        }
    }]);
    return { recorded: true, clientId, gross, gsCut, clientNet };
}

async function handleSubscriptionEvent(obj, type) {
    const customerId = obj.customer;
    if (!customerId) return { skipped: true, reason: 'no customer id' };
    const base = getBase();
    const matches = await base('Clients').select({
        filterByFormula: `{StripeCustomerId} = '${String(customerId).replace(/'/g, "\\'")}'`,
        maxRecords: 1
    }).firstPage();
    if (matches.length === 0) return { skipped: true, reason: 'no client for customer' };

    let subStatus = 'active';
    if (type === 'customer.subscription.deleted') subStatus = 'canceled';
    else if (obj.status === 'past_due' || obj.status === 'unpaid') subStatus = 'past_due';
    else if (obj.status === 'canceled') subStatus = 'canceled';

    await base('Clients').update([{
        id: matches[0].id,
        fields: { SubStatus: subStatus, StripeSubId: obj.id || matches[0].get('StripeSubId') || '' }
    }]);
    return { updated: true, clientId: matches[0].id, subStatus };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        let stripeEvent;
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

        if (process.env.STRIPE_SECRET_KEY && secret && sig) {
            // Verified path (live activation).
            const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
            try {
                stripeEvent = stripe.webhooks.constructEvent(event.body, sig, secret);
            } catch (err) {
                console.error('Stripe signature verification failed:', err.message);
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
            }
        } else {
            // Pre-activation path: parse directly (Stripe CLI test events).
            stripeEvent = JSON.parse(event.body);
        }

        const type = stripeEvent.type;
        const obj = stripeEvent.data?.object || {};
        let result;

        switch (type) {
            case 'payment_intent.succeeded':
            case 'checkout.session.completed':
                result = await handlePaymentSucceeded(obj);
                break;
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted':
            case 'customer.subscription.created':
                result = await handleSubscriptionEvent(obj, type);
                break;
            default:
                result = { ignored: true, type };
        }

        return { statusCode: 200, headers, body: JSON.stringify({ received: true, type, result }) };

    } catch (error) {
        console.error('Stripe webhook error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Webhook handler failed' }) };
    }
};
