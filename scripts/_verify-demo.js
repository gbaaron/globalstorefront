const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const t = line.trim();
  if (t && !t.startsWith('#') && t.includes('=')) {
    const [k, ...v] = t.split('=');
    if (!process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
  }
}

const KEY = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_BASE_ID;

async function sel(table, formula) {
  const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
  if (formula) url.searchParams.set('filterByFormula', formula);
  url.searchParams.set('maxRecords', '500');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  if (j.error) throw new Error(`${table}: ${JSON.stringify(j.error)}`);
  return j.records || [];
}

(async () => {
  // Find demo client
  const clients = await sel('Clients', `{Username} = 'demo'`);
  if (!clients.length) { console.log('NO DEMO CLIENT'); return; }
  const c = clients[0];
  const id = c.id;
  const f = c.fields;
  console.log('=== DEMO CLIENT ===');
  console.log(`id=${id}  Tier=${f.Tier}  Cycle=${f.BillingCycle}  Site=${f.SiteType}  BaseID=${f.BaseID}`);
  console.log(`Login: Password=${f.Password || '(none)'} PasswordHash=${f.PasswordHash || '(none)'}`);

  // Exactly the filters the live endpoints use
  const orders = await sel('Orders', `{ClientID} = '${id}'`);
  const menu = await sel('MenuItems', `{ClientID} = '${id}'`);
  const views = await sel('PageViews', `{ClientId} = '${id}'`);   // lowercase d
  const convos = await sel('Conversations', `{TenantID} = '${id}'`);
  let msgCount = 0;
  for (const cv of convos) {
    const msgs = await sel('Messages', `{ConversationID} = '${cv.id}'`);
    msgCount += msgs.length;
  }
  const suggestions = await sel('Suggestions', `{ClientID} = '${id}'`);
  const social = await sel('SocialPosts', `{ClientID} = '${id}'`);
  const reports = await sel('Reports', `{ClientID} = '${id}'`);
  const camps = await sel('EmailCampaigns', `{ClientID} = '${id}'`);
  const calls = await sel('StrategyCalls', `{ClientID} = '${id}'`);
  const dev = await sel('DevHours', `{ClientID} = '${id}'`);
  const txns = await sel('Transactions', `{ClientID} = '${id}'`);

  console.log('\n=== READBACK VIA LIVE-ENDPOINT FILTERS ===');
  console.log(`Orders (ClientID):        ${orders.length}`);
  console.log(`MenuItems (ClientID):     ${menu.length}`);
  console.log(`PageViews (ClientId):     ${views.length}`);
  console.log(`Conversations (TenantID): ${convos.length}`);
  console.log(`Messages (ConversationID):${msgCount}`);
  console.log(`Suggestions:              ${suggestions.length}`);
  console.log(`SocialPosts:              ${social.length}`);
  console.log(`Reports:                  ${reports.length}`);
  console.log(`EmailCampaigns:           ${camps.length}`);
  console.log(`StrategyCalls:            ${calls.length}`);
  console.log(`DevHours:                 ${dev.length}`);
  console.log(`Transactions:             ${txns.length}`);

  // Analytics sanity: today vs total
  const todayISO = new Date().toISOString().split('T')[0];
  const todayOrders = orders.filter(o => (o.fields.OrderDate || '').startsWith(todayISO));
  const revenue = orders
    .filter(o => (o.fields.Status || '').toLowerCase() !== 'cancelled')
    .reduce((s, o) => s + (parseFloat(o.fields.Total || o.fields.TotalAmount || 0) || 0), 0);
  const todayViews = views.filter(v => (v.fields.Timestamp || '').startsWith(todayISO));
  console.log('\n=== ANALYTICS SANITY ===');
  console.log(`Orders today:   ${todayOrders.length}`);
  console.log(`Views today:    ${todayViews.length}`);
  console.log(`Lifetime revenue (non-cancelled): $${revenue.toFixed(2)}`);
  const pending = orders.filter(o => (o.fields.Status || '').toLowerCase() === 'pending').length;
  console.log(`Pending orders: ${pending}`);

  // Waiting-for-owner inbox count (what the Inbox badge shows)
  const waiting = convos.filter(cv => cv.fields.Status === 'waiting_for_owner').length;
  console.log(`Conversations waiting_for_owner: ${waiting}`);

  // Order status breakdown + today's orders
  const breakdown = {};
  for (const o of orders) {
    const s = (o.fields.Status || '').toLowerCase();
    breakdown[s] = (breakdown[s] || 0) + 1;
  }
  console.log('\n=== ORDER STATUS BREAKDOWN ===');
  console.log(breakdown);
  console.log('Today orders:');
  for (const o of todayOrders) {
    console.log(`  ${o.fields.OrderID}  ${o.fields.Status}  $${o.fields.Total}  ${o.fields.OrderDate}`);
  }
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
