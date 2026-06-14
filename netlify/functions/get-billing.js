const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const { monthlyPrice, normalizeTier, normalizeCycle, round2 } = require('./lib/tiers');

// Admin-only. Returns a per-client billing summary: subscription tier/cycle,
// gross sales flowing through GS, GS's 10% cut, client net, and how much is
// still pending payout vs already swept. Optionally filter by ?clientId=.
exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') {
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

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const filterClientId = event.queryStringParameters?.clientId || null;

        // Pull clients (all, or one).
        const clientRecords = await base('Clients').select().all();
        const clients = clientRecords
            .filter(c => !filterClientId || c.id === filterClientId)
            .map(c => ({
                id: c.id,
                name: c.get('Name') || '',
                email: c.get('Email') || '',
                company: c.get('Company') || '',
                tier: normalizeTier(c.get('Tier')),
                billingCycle: normalizeCycle(c.get('BillingCycle')),
                subStatus: c.get('SubStatus') || 'active',
                nextBillingDate: c.get('NextBillingDate') || ''
            }));

        // Pull all transactions once, bucket by client.
        const txnRecords = await base('Transactions').select().all();
        const byClient = {};
        for (const t of txnRecords) {
            const cid = t.get('ClientID');
            if (!cid) continue;
            if (filterClientId && cid !== filterClientId) continue;
            if (!byClient[cid]) {
                byClient[cid] = { gross: 0, gsCut: 0, clientNet: 0, pendingNet: 0, sweptNet: 0, count: 0 };
            }
            const b = byClient[cid];
            b.gross += Number(t.get('Amount') || 0);
            b.gsCut += Number(t.get('GSCut') || 0);
            b.clientNet += Number(t.get('ClientNet') || 0);
            b.count += 1;
            if (t.get('PayoutStatus') === 'swept') {
                b.sweptNet += Number(t.get('ClientNet') || 0);
            } else {
                b.pendingNet += Number(t.get('ClientNet') || 0);
            }
        }

        const summaries = clients.map(c => {
            const b = byClient[c.id] || { gross: 0, gsCut: 0, clientNet: 0, pendingNet: 0, sweptNet: 0, count: 0 };
            return {
                ...c,
                subscriptionMonthly: monthlyPrice(c.tier, c.billingCycle),
                sales: {
                    gross: round2(b.gross),
                    gsCut: round2(b.gsCut),
                    clientNet: round2(b.clientNet),
                    pendingPayout: round2(b.pendingNet),
                    sweptPayout: round2(b.sweptNet),
                    transactionCount: b.count
                }
            };
        });

        // Platform totals across the returned set.
        const totals = summaries.reduce((acc, s) => {
            acc.gross += s.sales.gross;
            acc.gsCut += s.sales.gsCut;
            acc.clientNet += s.sales.clientNet;
            acc.pendingPayout += s.sales.pendingPayout;
            acc.mrr += s.subscriptionMonthly;
            return acc;
        }, { gross: 0, gsCut: 0, clientNet: 0, pendingPayout: 0, mrr: 0 });

        Object.keys(totals).forEach(k => { totals[k] = round2(totals[k]); });

        return {
            statusCode: 200,
            body: JSON.stringify({ clients: summaries, totals })
        };

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
        }
        console.error('Get billing error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch billing' }) };
    }
};
