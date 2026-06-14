#!/usr/bin/env node
/**
 * seed-demo.js — Populate a DEMO client account with realistic data so the
 * Apple/Google reviewer sees a fully working app (App Store Guideline 2.1 /
 * "no placeholder content").
 *
 * It is ADD-ONLY. It never deletes or overwrites anything.
 *
 * Usage:
 *   # 1. See your clients and pick the demo one:
 *   AIRTABLE_API_KEY=patXXXX node scripts/seed-demo.js
 *
 *   # 2. Seed that client by record id, email, username, or company name:
 *   AIRTABLE_API_KEY=patXXXX node scripts/seed-demo.js "Zeeland Bakery"
 *
 * Requires Node 18+ (uses built-in fetch). No npm install needed.
 */

const KEY = process.env.AIRTABLE_API_KEY;
const GS_BASE = process.env.AIRTABLE_BASE_ID || 'appFruyJCRi9Fj6qX';
const target = process.argv[2];

if (!KEY) {
    console.error('❌ Set AIRTABLE_API_KEY first.  e.g.\n   AIRTABLE_API_KEY=patXXXX node scripts/seed-demo.js');
    process.exit(1);
}

const iso = (d) => new Date(d).toISOString();
const now = Date.now();
const daysAgo = (n) => iso(now - n * 86400000);
const hoursAgo = (n) => iso(now - n * 3600000);

async function air(base, table, method = 'GET', payload) {
    const url = `https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}` +
        (method === 'GET' && payload ? '?' + payload : '');
    const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = data?.error?.message || data?.error?.type || res.statusText;
        const err = new Error(`${table} ${method} → ${res.status} ${msg}`);
        err.airtable = data?.error;
        throw err;
    }
    return data;
}

// Create up to 10 records at a time; returns created records.
async function create(base, table, records) {
    const out = [];
    for (let i = 0; i < records.length; i += 10) {
        const chunk = records.slice(i, i + 10).map(fields => ({ fields }));
        const data = await air(base, table, 'POST', { records: chunk, typecast: true });
        out.push(...data.records);
    }
    return out;
}

function pickClient(records) {
    if (!target) return null;
    const t = target.toLowerCase();
    return records.find(r => r.id === target) ||
        records.find(r => (r.fields.Email || '').toLowerCase() === t) ||
        records.find(r => (r.fields.Username || '').toLowerCase() === t) ||
        records.find(r => (r.fields.Company || '').toLowerCase().includes(t)) ||
        records.find(r => (r.fields.Name || '').toLowerCase().includes(t));
}

(async () => {
    console.log(`\nConnecting to Global Storefront base ${GS_BASE} ...`);
    const clientsResp = await air(GS_BASE, 'Clients', 'GET', 'maxRecords=100');
    const clients = clientsResp.records || [];
    if (!clients.length) { console.error('No clients found.'); process.exit(1); }

    const client = pickClient(clients);

    if (!client) {
        console.log('\nNo target given (or no match). Your clients:\n');
        for (const c of clients) {
            console.log(`  • ${c.fields.Company || c.fields.Name || '(no name)'}` +
                `  | id=${c.id}` +
                `  | user=${c.fields.Username || c.fields.Email || '-'}` +
                `  | BaseID=${c.fields.BaseID || '⚠ none'}` +
                `  | SiteType=${c.fields.SiteType || '-'}`);
        }
        console.log('\nRe-run with one of the above, e.g.:\n   AIRTABLE_API_KEY=$KEY node scripts/seed-demo.js "<company or id>"\n');
        console.log('TIP: pick a DEMO account, not a real client — this adds sample data.\n');
        process.exit(0);
    }

    const tenantId = client.id;
    const company = client.fields.Company || client.fields.Name || 'Demo Store';
    const baseId = client.fields.BaseID;
    const siteType = (client.fields.SiteType || 'product').toLowerCase();
    console.log(`\n➤ Seeding demo data for: ${company}`);
    console.log(`   tenantId=${tenantId}  BaseID=${baseId || '(none)'}  SiteType=${siteType}\n`);

    // ---- 1. Knowledge base (so the bot has something to answer with) ----
    try {
        await create(GS_BASE, 'BotKnowledgeBase', [
            { TenantID: tenantId, Category: 'hours', Key: 'weekday_hours', Value: 'Open Monday–Friday 7am–6pm, Saturday 8am–4pm. Closed Sundays.', Priority: 10 },
            { TenantID: tenantId, Category: 'policies', Key: 'returns', Value: 'Fresh items are final sale, but if anything is wrong we will make it right — just reach out.', Priority: 5 },
            { TenantID: tenantId, Category: 'faq', Key: 'gluten_free', Value: 'Yes! We carry several gluten-free options daily. Availability varies, so call ahead for large orders.', Priority: 7 }
        ]);
        console.log('   ✓ Knowledge base: 3 entries');
    } catch (e) { console.log('   ⚠ Knowledge base skipped:', e.message); }

    // ---- 2. An UNREAD escalated conversation (shows up in Inbox) ----
    try {
        const [conv] = await create(GS_BASE, 'Conversations', [{
            TenantID: tenantId, CustomerName: 'Jordan M.', CustomerEmail: 'jordan@example.com',
            Status: 'waiting_for_owner', Channel: 'website_chat', SessionID: `demo_${now}`,
            EscalatedAt: hoursAgo(1), LastMessageAt: hoursAgo(1)
        }]);
        await create(GS_BASE, 'Messages', [
            { ConversationID: conv.id, Sender: 'customer', Content: 'Hi! Do you do custom birthday cakes with 3 days notice?', Timestamp: hoursAgo(1), ReadByOwner: false, ReadByCustomer: true },
            { ConversationID: conv.id, Sender: 'bot', Content: "I'll check with the team and get right back to you on that!", Timestamp: hoursAgo(1), ReadByOwner: false, ReadByCustomer: true }
        ]);
        console.log('   ✓ Open conversation (unread in Inbox)');
    } catch (e) { console.log('   ⚠ Open conversation skipped:', e.message); }

    // ---- 3. A RESOLVED conversation with a full exchange (history) ----
    try {
        const [conv] = await create(GS_BASE, 'Conversations', [{
            TenantID: tenantId, CustomerName: 'Priya S.', CustomerEmail: '',
            Status: 'resolved', Channel: 'website_chat', SessionID: `demo_${now}_2`,
            EscalatedAt: daysAgo(2), LastMessageAt: daysAgo(2), ResolvedAt: daysAgo(2)
        }]);
        await create(GS_BASE, 'Messages', [
            { ConversationID: conv.id, Sender: 'customer', Content: 'What time do you close today?', Timestamp: daysAgo(2), ReadByOwner: true, ReadByCustomer: true },
            { ConversationID: conv.id, Sender: 'bot', Content: "We're open until 6pm today. See you soon!", Timestamp: daysAgo(2), ReadByOwner: true, ReadByCustomer: true },
            { ConversationID: conv.id, Sender: 'customer', Content: 'Perfect, thank you!', Timestamp: daysAgo(2), ReadByOwner: true, ReadByCustomer: true }
        ]);
        console.log('   ✓ Resolved conversation (history)');
    } catch (e) { console.log('   ⚠ Resolved conversation skipped:', e.message); }

    // ---- 4. Orders in the client's OWN base (Dashboard + Orders tab) ----
    if (baseId) {
        const orders = [
            { OrderDate: hoursAgo(3), Status: 'pending',   Total: 24.50, CustomerName: 'Jordan M.', Items: '2x Sourdough, 1x Croissant box' },
            { OrderDate: hoursAgo(20), Status: 'pending',  Total: 58.00, CustomerName: 'Priya S.',  Items: 'Custom cake deposit' },
            { OrderDate: daysAgo(1),  Status: 'completed', Total: 12.75, CustomerName: 'Walk-in',   Items: '1x Dozen bagels' },
            { OrderDate: daysAgo(2),  Status: 'completed', Total: 41.20, CustomerName: 'Marcus T.', Items: 'Catering tray (small)' },
            { OrderDate: daysAgo(4),  Status: 'completed', Total: 9.00,  CustomerName: 'Walk-in',   Items: '3x Muffins' }
        ];
        try {
            await create(baseId, 'Orders', orders);
            console.log(`   ✓ Orders: ${orders.length} added to client base ${baseId}`);
        } catch (e) {
            console.log('   ⚠ Orders skipped:', e.message);
            console.log('     (The client base likely needs an "Orders" table with fields:');
            console.log('      OrderDate [date], Status [single select], Total [number], CustomerName [text], Items [text])');
        }
    } else {
        console.log('   ⚠ Orders skipped: this client has no BaseID set in the Clients table.');
        console.log('     Set BaseID (their own Airtable base) so the Orders/Dashboard tabs show data.');
    }

    console.log('\n✅ Done. Log into the app as this demo account to verify Inbox + Orders show content.');
    console.log('   Then hand those same login credentials to Apple in App Store Connect → App Review Information.\n');
})().catch(e => {
    console.error('\n❌ Failed:', e.message);
    if (e.airtable) console.error('   Airtable:', JSON.stringify(e.airtable));
    process.exit(1);
});
