const Airtable = require('airtable');
const fetch = require('node-fetch');

// Shared email-campaign delivery logic, reused by:
//   - manage-campaign.js  (owner clicks "Send now")
//   - send-campaign.js    (scheduled sweep of due campaigns)
//
// Recipient data stays on the CLIENT's own base (their customer list); GS only
// orchestrates the send and logs the result on the GS EmailCampaigns row.
//
// Live delivery is gated behind an email-provider env key (RESEND_API_KEY or
// SENDGRID_API_KEY). When absent, this runs in "records-only" mode: it counts
// recipients and marks the campaign sent, but does not actually transmit email.
// Mirrors the Stripe approach (build the pipeline now, flip live keys later).

// Pull the customer email list from the tenant's own base. Tenant retail bases
// keep customers in a `Users` table with an `Email` field; we also fall back to
// guest emails on the `Orders` table so a brand-new store without registered
// users can still reach the people who actually bought something.
async function fetchRecipients(tenantBaseId) {
    const emails = new Set();
    if (!tenantBaseId) return [];

    const tenantBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(tenantBaseId);

    // Registered customers (Users table).
    try {
        const users = await tenantBase('Users').select({ maxRecords: 5000 }).all();
        for (const u of users) {
            const e = (u.get('Email') || '').trim().toLowerCase();
            if (e && e.includes('@')) emails.add(e);
        }
    } catch (e) { /* tenant may not have a Users table */ }

    // Guest checkouts (Orders table) — covers stores with no registered users.
    try {
        const orders = await tenantBase('Orders').select({ maxRecords: 5000 }).all();
        for (const o of orders) {
            const e = (o.get('GuestEmail') || o.get('Email') || o.get('CustomerEmail') || '').trim().toLowerCase();
            if (e && e.includes('@')) emails.add(e);
        }
    } catch (e) { /* tenant may not have an Orders table */ }

    return Array.from(emails);
}

// Send one campaign to a list of recipients via whichever provider is configured.
// Returns { delivered, provider, liveSend }.
async function deliverEmails(recipients, subject, body, fromEmail) {
    const resendKey = process.env.RESEND_API_KEY;
    const sendgridKey = process.env.SENDGRID_API_KEY;
    const from = fromEmail || process.env.CAMPAIGN_FROM_EMAIL || 'no-reply@globalstorefront.app';

    // Records-only mode — no provider key present.
    if (!resendKey && !sendgridKey) {
        return { delivered: recipients.length, provider: 'records-only', liveSend: false };
    }

    let delivered = 0;
    let provider = 'unknown';

    // Resend (preferred — simplest REST API). Sent individually so one bad
    // address never sinks the whole batch.
    if (resendKey) {
        provider = 'resend';
        for (const to of recipients) {
            try {
                const res = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${resendKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ from, to, subject, html: body })
                });
                if (res.ok) delivered++;
            } catch (e) { /* skip this recipient */ }
            await new Promise(r => setTimeout(r, 60));
        }
        return { delivered, provider, liveSend: true };
    }

    // SendGrid fallback.
    provider = 'sendgrid';
    for (const to of recipients) {
        try {
            const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${sendgridKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    personalizations: [{ to: [{ email: to }] }],
                    from: { email: from },
                    subject,
                    content: [{ type: 'text/html', value: body }]
                })
            });
            if (res.ok || res.status === 202) delivered++;
        } catch (e) { /* skip this recipient */ }
        await new Promise(r => setTimeout(r, 60));
    }
    return { delivered, provider, liveSend: true };
}

// Orchestrate a full send for one EmailCampaigns row and write the result back.
// `gsBase` is the GS base instance; `campaign` is the Airtable record; `client`
// is the matching Clients record (for the tenant base id).
async function sendCampaign(gsBase, campaign, client) {
    const tenantBaseId = client.get('BaseID');
    const subject = campaign.get('Subject') || '';
    const body = campaign.get('Body') || '';

    let recipients = [];
    try {
        recipients = await fetchRecipients(tenantBaseId);
    } catch (e) {
        recipients = [];
    }

    // Mark the row as sending while we work.
    try {
        await gsBase('EmailCampaigns').update([{ id: campaign.id, fields: { Status: 'sending' } }]);
    } catch (e) {}

    let result;
    try {
        result = await deliverEmails(recipients, subject, body, client.get('FromEmail'));
    } catch (e) {
        result = { delivered: 0, provider: 'error', liveSend: false };
    }

    const finalStatus = result.provider === 'error' ? 'failed' : 'sent';
    const fields = {
        Status: finalStatus,
        RecipientCount: recipients.length,
        SentCount: result.delivered,
        LastSentAt: new Date().toISOString()
    };

    try {
        await gsBase('EmailCampaigns').update([{ id: campaign.id, fields }]);
    } catch (e) {}

    return {
        id: campaign.id,
        status: finalStatus,
        recipientCount: recipients.length,
        sentCount: result.delivered,
        provider: result.provider,
        liveSend: result.liveSend
    };
}

module.exports = { fetchRecipients, deliverEmails, sendCampaign };
