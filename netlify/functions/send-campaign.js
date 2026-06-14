const Airtable = require('airtable');
const { tierIncludes, normalizeTier } = require('./lib/tiers');
const { sendCampaign } = require('./lib/campaign-send');

// Scheduled (daily) — see netlify.toml [functions."send-campaign"] schedule.
// Sweeps every EmailCampaigns row in 'scheduled' status whose Schedule time is
// now due (ISO timestamp <= now), and sends it via the configured provider
// (records-only if no provider key is present). Each client is re-checked for
// the 'email_marketing' entitlement so a downgrade pauses pending sends.
//
// Also manually invokable (GET/POST) for testing; returns a JSON summary.

async function runSend() {
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

    const nowIso = new Date().toISOString();

    let due = [];
    try {
        due = await base('EmailCampaigns').select({
            filterByFormula: `{Status} = 'scheduled'`,
            maxRecords: 200
        }).all();
    } catch (e) {
        return { error: 'EmailCampaigns table not found', sent: 0 };
    }

    // Cache client lookups + entitlement per ClientID across the run.
    const clientCache = {};
    async function getClient(clientId) {
        if (clientId in clientCache) return clientCache[clientId];
        let client = null;
        try {
            client = await base('Clients').find(clientId);
        } catch (e) {}
        clientCache[clientId] = client;
        return client;
    }

    let sent = 0;
    let skipped = 0;
    const results = [];

    for (const campaign of due) {
        const schedule = campaign.get('Schedule') || '';
        // Only fire once the scheduled time has arrived.
        if (schedule && schedule > nowIso) { skipped++; continue; }

        const clientId = campaign.get('ClientID');
        const client = await getClient(clientId);
        if (!client) { skipped++; continue; }

        const tier = normalizeTier(client.get('Tier'));
        if (!tierIncludes(tier, 'email_marketing')) { skipped++; continue; }

        try {
            const result = await sendCampaign(base, campaign, client);
            results.push(result);
            sent++;
        } catch (e) {
            skipped++;
        }
        await new Promise(r => setTimeout(r, 250));
    }

    return { sent, skipped, total: due.length, results };
}

exports.handler = async () => {
    try {
        const result = await runSend();
        console.log('Campaign send complete:', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ success: true, ...result }) };
    } catch (error) {
        console.error('Send campaign error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Campaign send failed' }) };
    }
};
