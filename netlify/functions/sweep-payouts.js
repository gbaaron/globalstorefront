const Airtable = require('airtable');
const { round2 } = require('./lib/tiers');

// Scheduled (daily) — see netlify.toml [functions."sweep-payouts"] schedule.
// Aggregates all pending Transactions per client, creates one Payouts row per
// client for the summed ClientNet (the 90%), and marks those transactions as
// swept. The actual Stripe transfer is gated behind STRIPE_SECRET_KEY presence;
// until keys are set this only records the payout intent (Status: pending).
//
// Also manually invokable (GET/POST) for testing. When invoked over HTTP by an
// admin, returns a JSON summary.

async function runSweep() {
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
    const stripeReady = !!process.env.STRIPE_SECRET_KEY;

    // Gather pending, succeeded transactions.
    const pending = await base('Transactions').select({
        filterByFormula: "AND({PayoutStatus} = 'pending', {Status} = 'succeeded')"
    }).all();

    if (pending.length === 0) {
        return { swept: 0, payouts: 0, totalNet: 0, stripeReady };
    }

    // Bucket by client.
    const byClient = {};
    for (const t of pending) {
        const cid = t.get('ClientID');
        if (!cid) continue;
        if (!byClient[cid]) byClient[cid] = { net: 0, ids: [] };
        byClient[cid].net += Number(t.get('ClientNet') || 0);
        byClient[cid].ids.push(t.id);
    }

    const now = new Date().toISOString();
    let payoutCount = 0;
    let totalNet = 0;
    let sweptCount = 0;

    for (const [clientId, bucket] of Object.entries(byClient)) {
        const amount = round2(bucket.net);
        if (amount <= 0) continue;

        // Create the payout record.
        await base('Payouts').create([{
            fields: {
                PayoutID: 'po_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                ClientID: clientId,
                Amount: amount,
                TransactionCount: bucket.ids.length,
                Status: stripeReady ? 'paid' : 'pending',
                StripeTransferId: '', // populated by the Stripe transfer at activation
                Date: now
            }
        }]);
        payoutCount += 1;
        totalNet += amount;

        // Mark each transaction swept (Airtable updates max 10 per call).
        for (let i = 0; i < bucket.ids.length; i += 10) {
            const chunk = bucket.ids.slice(i, i + 10).map(id => ({ id, fields: { PayoutStatus: 'swept' } }));
            await base('Transactions').update(chunk);
            sweptCount += chunk.length;
            await new Promise(r => setTimeout(r, 250)); // respect 5 req/sec
        }
    }

    return { swept: sweptCount, payouts: payoutCount, totalNet: round2(totalNet), stripeReady };
}

exports.handler = async (event) => {
    try {
        const result = await runSweep();
        console.log('Payout sweep complete:', JSON.stringify(result));
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, ...result })
        };
    } catch (error) {
        console.error('Sweep payouts error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Sweep failed' }) };
    }
};
