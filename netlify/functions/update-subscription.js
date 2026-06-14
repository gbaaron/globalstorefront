const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const {
    normalizeTier,
    normalizeCycle,
    computeSubscriptionChange,
    monthlyPrice
} = require('./lib/tiers');

// Admin-only. Sets a client's subscription tier and/or billing cycle, runs the
// upgrade-proration / downgrade-refund math, and persists the new state on the
// Clients record. Returns the computed financial effect so the admin UI can
// show what was charged/refunded. No live Stripe charge happens here — that is
// gated behind STRIPE_SECRET_KEY presence (wired at activation).
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const token = event.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return { statusCode: 401, body: JSON.stringify({ error: 'No authorization token' }) };
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production');
        if (decoded.role !== 'admin') {
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
        }

        const { clientId, tier, billingCycle } = JSON.parse(event.body);
        if (!clientId || !tier) {
            return { statusCode: 400, body: JSON.stringify({ error: 'clientId and tier are required' }) };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        let client;
        try {
            client = await base('Clients').find(clientId);
        } catch (e) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Unknown client' }) };
        }

        const fromTier = normalizeTier(client.get('Tier'));
        const fromCycle = normalizeCycle(client.get('BillingCycle'));
        const toTier = normalizeTier(tier);
        const toCycle = normalizeCycle(billingCycle || fromCycle);

        // Days remaining in the current billing period.
        const periodDays = toCycle === 'annual' ? 365 : 30;
        let daysRemaining = periodDays;
        const nextBilling = client.get('NextBillingDate');
        if (nextBilling) {
            const ms = new Date(nextBilling).getTime() - Date.now();
            daysRemaining = Math.max(0, Math.min(periodDays, Math.round(ms / 86400000)));
        }

        const change = computeSubscriptionChange({
            fromTier, toTier, fromCycle, toCycle, daysRemaining, periodDays
        });

        // Compute the next billing date based on the new cycle (preserve existing
        // anchor if present, otherwise start now).
        const start = client.get('SubStartDate') ? new Date(client.get('SubStartDate')) : new Date();
        const next = new Date();
        if (toCycle === 'annual') {
            next.setFullYear(next.getFullYear() + 1);
        } else {
            next.setMonth(next.getMonth() + 1);
        }

        const updateFields = {
            Tier: toTier,
            BillingCycle: toCycle,
            SubStatus: 'active',
            NextBillingDate: next.toISOString().split('T')[0]
        };
        if (!client.get('SubStartDate')) {
            updateFields.SubStartDate = start.toISOString().split('T')[0];
        }

        await base('Clients').update([{ id: clientId, fields: updateFields }]);

        // Stripe activation placeholder: when STRIPE_SECRET_KEY is present, this
        // is where the prorated charge / refund would be issued.
        const stripeReady = !!process.env.STRIPE_SECRET_KEY;

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                clientId,
                from: { tier: fromTier, cycle: fromCycle },
                to: { tier: toTier, cycle: toCycle, monthly: monthlyPrice(toTier, toCycle) },
                change,
                nextBillingDate: updateFields.NextBillingDate,
                stripeProcessed: false,
                stripeReady,
                note: stripeReady
                    ? change.note + ' (Stripe charge/refund pending activation hook.)'
                    : change.note + ' (No live Stripe key set — recorded only.)'
            })
        };

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
        }
        console.error('Update subscription error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update subscription' }) };
    }
};
