const Airtable = require('airtable');
const { tierIncludes, normalizeTier, round2 } = require('./lib/tiers');

// Scheduled (monthly) — see netlify.toml [functions."generate-reports"] schedule.
// For each Growth+ client (tier includes 'monthly_reports'), computes the prior
// calendar month's metrics (page views from the GS PageViews table + orders/
// revenue from the tenant's own base) and writes one Reports row per client per
// period. Idempotent: skips a client+period that already has a Reports row.
//
// The binary PDF is NOT stored here (it would blow past Airtable's long-text
// cap); get-reports rebuilds it on demand from the stored summary fields.
//
// Also manually invokable (GET/POST) for testing; returns a JSON summary.

function priorMonthRange(now = new Date()) {
    // First day of this month, then step back to get the previous month.
    const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
    const start = new Date(firstThis.getFullYear(), firstThis.getMonth() - 1, 1);
    const end = firstThis; // exclusive upper bound
    const period = start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0');
    return { startISO: start.toISOString(), endISO: end.toISOString(), period };
}

async function runGenerate() {
    const apiKey = process.env.AIRTABLE_API_KEY;
    const base = new Airtable({ apiKey }).base(process.env.AIRTABLE_BASE_ID);
    const { startISO, endISO, period } = priorMonthRange();

    const clients = await base('Clients').select({ maxRecords: 500 }).all();

    // Existing reports for this period, to stay idempotent.
    let existing = [];
    try {
        existing = await base('Reports').select({
            filterByFormula: `{Period} = '${period}'`,
            maxRecords: 500
        }).all();
    } catch (e) {
        // Reports table may not exist yet.
        return { error: 'Reports table not found', period, generated: 0 };
    }
    const haveFor = new Set(existing.map(r => r.get('ClientID')));

    let generated = 0;
    let skipped = 0;
    const rows = [];

    for (const client of clients) {
        const tier = normalizeTier(client.get('Tier'));
        if (!tierIncludes(tier, 'monthly_reports')) { skipped++; continue; }
        if (haveFor.has(client.id)) { skipped++; continue; }

        const tenantBaseId = client.get('BaseID');

        // Page views for this client within the period.
        let views = 0;
        try {
            const pv = await base('PageViews').select({
                filterByFormula: `AND({ClientId} = '${client.id}', IS_AFTER({Timestamp}, '${startISO}'), IS_BEFORE({Timestamp}, '${endISO}'))`,
                maxRecords: 2000
            }).all();
            views = pv.length;
        } catch (e) {}

        // Orders + revenue from the tenant's own base within the period.
        let orders = 0;
        let revenue = 0;
        const ordersByStatus = {};
        if (tenantBaseId) {
            try {
                const tenantBase = new Airtable({ apiKey }).base(tenantBaseId);
                const recs = await tenantBase('Orders').select({ maxRecords: 1000 }).all();
                for (const o of recs) {
                    const dateRaw = o.get('OrderDate') || '';
                    if (!dateRaw) continue;
                    const iso = new Date(dateRaw).toISOString();
                    if (iso < startISO || iso >= endISO) continue;
                    orders++;
                    const total = parseFloat(o.get('Total') || o.get('TotalAmount') || 0);
                    if (!isNaN(total)) revenue += total;
                    const status = (o.get('Status') || 'unknown').toLowerCase();
                    ordersByStatus[status] = (ordersByStatus[status] || 0) + 1;
                }
            } catch (e) {}
        }

        revenue = round2(revenue);
        const avgOrder = orders > 0 ? round2(revenue / orders) : 0;

        rows.push({
            fields: {
                ReportID: 'rpt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                ClientID: client.id,
                Period: period,
                Views: views,
                Orders: orders,
                Revenue: revenue,
                AvgOrder: avgOrder,
                OrdersByStatus: JSON.stringify(ordersByStatus),
                PDFUrl: '', // populated when/if PDFs are uploaded to external storage
                GeneratedAt: new Date().toISOString(),
                Status: 'ready'
            }
        });
        generated++;
    }

    // Write in chunks of 10 (Airtable cap), throttled.
    for (let i = 0; i < rows.length; i += 10) {
        await base('Reports').create(rows.slice(i, i + 10));
        await new Promise(r => setTimeout(r, 250));
    }

    return { period, generated, skipped, total: clients.length };
}

exports.handler = async () => {
    try {
        const result = await runGenerate();
        console.log('Report generation complete:', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ success: true, ...result }) };
    } catch (error) {
        console.error('Generate reports error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Report generation failed' }) };
    }
};
