const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// seed-demo.js — provisions and seeds a realistic-but-fake demo business
// ("Harbor & Vine Cafe") on the Global Storefront platform.
//
// Two purposes:
//   1. Aaron logs in as this account to demo the owner app during sales pitches.
//   2. Apple App Store reviewers log into the SAME account (Guideline 2.1
//      demo-account requirement) and see everything a paying owner would see.
//
// It is idempotent / re-runnable: it reuses the demo Clients record if present
// and wipes prior demo-owned rows in each feature table before re-seeding.
//
// Demo login:  username "demo"  /  password "demo2026"  (Concierge tier)
//
// Architecture: the demo client's BaseID points back at the GS base itself, so
// get-tenant-admin reads its Orders + MenuItems from the same base we seed here.
// We add a ClientId field to PageViews and create Orders + MenuItems tables via
// the Airtable Meta API (additive + reversible — GS base has none of these).
// ---------------------------------------------------------------------------

// ---- load .env (no dotenv dependency) -------------------------------------
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
if (!KEY || !BASE) { console.error('Missing AIRTABLE_API_KEY / AIRTABLE_BASE_ID'); process.exit(1); }

const AUTH = { Authorization: `Bearer ${KEY}` };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- demo identity ---------------------------------------------------------
const DEMO = {
  Name: 'Harbor & Vine Cafe',
  Company: 'Harbor & Vine Cafe',
  Username: 'demo',
  Email: 'demo@globalstorefront.app',
  Password: 'demo2026',
  ProjectURL: 'https://harborandvine.netlify.app/',
  SiteType: 'restaurant',
  Tier: 'Concierge',
  BillingCycle: 'annual',
  BaseID: BASE // point tenant reads back at the GS base
};

// ---- low-level Airtable helpers -------------------------------------------
async function metaGet(url) {
  const r = await fetch(url, { headers: AUTH });
  if (!r.ok) throw new Error(`meta GET ${url} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function metaPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`meta POST ${url} -> ${r.status} ${txt}`);
  return JSON.parse(txt);
}
async function selectAll(table, formula) {
  const out = [];
  let offset;
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    u.searchParams.set('pageSize', '100');
    if (formula) u.searchParams.set('filterByFormula', formula);
    if (offset) u.searchParams.set('offset', offset);
    const r = await fetch(u, { headers: AUTH });
    if (!r.ok) throw new Error(`select ${table} -> ${r.status} ${await r.text()}`);
    const j = await r.json();
    out.push(...j.records);
    offset = j.offset;
  } while (offset);
  return out;
}
async function createRecords(table, records) {
  let made = 0;
  const ids = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(fields => ({ fields }));
    const r = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ records: batch, typecast: true })
    });
    if (!r.ok) throw new Error(`create ${table} -> ${r.status} ${await r.text()}`);
    const j = await r.json();
    made += j.records.length;
    ids.push(...j.records.map(x => x.id));
    await sleep(220);
  }
  return ids;
}
async function deleteRecords(table, ids) {
  for (let i = 0; i < ids.length; i += 10) {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    ids.slice(i, i + 10).forEach(id => u.searchParams.append('records[]', id));
    const r = await fetch(u, { method: 'DELETE', headers: AUTH });
    if (!r.ok) throw new Error(`delete ${table} -> ${r.status} ${await r.text()}`);
    await sleep(220);
  }
}
async function wipe(table, formula) {
  const recs = await selectAll(table, formula);
  if (recs.length) { await deleteRecords(table, recs.map(r => r.id)); }
  return recs.length;
}

// ---- date helpers ----------------------------------------------------------
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// ISO at ~local noon for `offset` days ago (avoids day-boundary drift in charts)
function dayISO(offset, hour) {
  const n = new Date();
  const h = hour == null ? randInt(8, 19) : hour;
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - offset, h, randInt(0, 59)).toISOString();
}
const nowISO = () => new Date().toISOString();
const monthLabel = (offset) => {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth() - offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
function quarterLabel(offset) {
  const n = new Date();
  let q = Math.floor(n.getMonth() / 3) + 1 - offset, y = n.getFullYear();
  while (q < 1) { q += 4; y -= 1; }
  return `${y}-Q${q}`;
}

// ===========================================================================
//  STEP 1 — Meta API: provision schema (PageViews.ClientId, Orders, MenuItems)
// ===========================================================================
async function provisionSchema() {
  const meta = await metaGet(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`);
  const byName = Object.fromEntries(meta.tables.map(t => [t.name, t]));

  // 1a. add ClientId to PageViews (note lowercase 'd' — analytics filters {ClientId})
  const pv = byName['PageViews'];
  if (pv && !pv.fields.some(f => f.name === 'ClientId')) {
    await metaPost(`https://api.airtable.com/v0/meta/bases/${BASE}/tables/${pv.id}/fields`,
      { name: 'ClientId', type: 'singleLineText' });
    console.log('  + PageViews.ClientId field created');
  } else { console.log('  = PageViews.ClientId already present'); }

  // 1b. Orders table (read by get-tenant-admin when BaseID == GS base)
  if (!byName['Orders']) {
    await metaPost(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
      name: 'Orders',
      fields: [
        { name: 'OrderID', type: 'singleLineText' },
        { name: 'CustomerName', type: 'singleLineText' },
        { name: 'ItemsList', type: 'multilineText' },
        { name: 'Total', type: 'number', options: { precision: 2 } },
        { name: 'Status', type: 'singleSelect', options: { choices: [
          { name: 'pending' }, { name: 'preparing' }, { name: 'completed' }, { name: 'cancelled' }
        ] } },
        { name: 'ClientID', type: 'singleLineText' },
        { name: 'OrderDate', type: 'dateTime', options: {
          dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' } }
      ]
    });
    console.log('  + Orders table created');
  } else { console.log('  = Orders table already present'); }

  // 1c. MenuItems table (restaurant "products")
  if (!byName['MenuItems']) {
    await metaPost(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
      name: 'MenuItems',
      fields: [
        { name: 'Name', type: 'singleLineText' },
        { name: 'Category', type: 'singleSelect', options: { choices: [
          { name: 'Coffee' }, { name: 'Breakfast' }, { name: 'Lunch' }, { name: 'Pastries' }, { name: 'Drinks' }
        ] } },
        { name: 'Price', type: 'number', options: { precision: 2 } },
        { name: 'Description', type: 'multilineText' },
        { name: 'ClientID', type: 'singleLineText' },
        { name: 'Available', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } }
      ]
    });
    console.log('  + MenuItems table created');
  } else { console.log('  = MenuItems table already present'); }
}

// ===========================================================================
//  STEP 2 — demo Clients record (idempotent)
// ===========================================================================
async function ensureClient() {
  const existing = await selectAll('Clients', `{Username} = '${DEMO.Username}'`);
  const today = new Date();
  const next = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate());
  const fields = {
    Name: DEMO.Name, Email: DEMO.Email, Username: DEMO.Username,
    PasswordHash: DEMO.Password, Company: DEMO.Company, ProjectURL: DEMO.ProjectURL,
    BaseID: DEMO.BaseID, SiteType: DEMO.SiteType, Tier: DEMO.Tier, BillingCycle: DEMO.BillingCycle,
    SubStatus: 'active', SubStartDate: today.toISOString().split('T')[0],
    NextBillingDate: next.toISOString().split('T')[0],
    BotPersona: 'Harbor', BotVoice: 'Warm, neighborly cafe host', PushEnabled: true,
    CreatedAt: nowISO()
  };
  if (existing.length) {
    const id = existing[0].id;
    await fetch(`https://api.airtable.com/v0/${BASE}/Clients/${id}`, {
      method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ fields, typecast: true })
    });
    console.log(`  = reused demo client ${id}`);
    return id;
  }
  const ids = await createRecords('Clients', [fields]);
  console.log(`  + created demo client ${ids[0]}`);
  return ids[0];
}

// ===========================================================================
//  STEP 3 — seed all surfaces
// ===========================================================================
const MENU = [
  ['Harbor Blend Drip', 'Coffee', 3.75, 'House dark roast, bottomless refills'],
  ['Oat Milk Latte', 'Coffee', 5.25, 'Double shot with steamed oat milk'],
  ['Cold Brew', 'Coffee', 4.75, 'Slow-steeped 18 hours, served over ice'],
  ['Cappuccino', 'Coffee', 4.50, 'Equal parts espresso, steamed milk, foam'],
  ['Avocado Toast', 'Breakfast', 11.00, 'Sourdough, smashed avocado, chili flake, lime'],
  ['Farmhouse Scramble', 'Breakfast', 12.50, 'Three eggs, cheddar, herbs, breakfast potatoes'],
  ['Vine Granola Bowl', 'Breakfast', 9.50, 'House granola, Greek yogurt, seasonal berries'],
  ['Turkey & Brie Panini', 'Lunch', 13.50, 'Roast turkey, brie, fig jam, arugula'],
  ['Harvest Grain Bowl', 'Lunch', 13.00, 'Farro, roasted veg, tahini, pepitas'],
  ['Tomato Basil Soup', 'Lunch', 7.50, 'Cup of slow-simmered tomato basil'],
  ['Butter Croissant', 'Pastries', 4.25, 'Laminated 27 layers, baked daily'],
  ['Almond Danish', 'Pastries', 4.75, 'Frangipane filling, toasted almonds'],
  ['Blueberry Muffin', 'Pastries', 3.95, 'Wild blueberries, lemon-sugar top'],
  ['Sea Salt Cookie', 'Pastries', 3.25, 'Brown butter, flaky sea salt'],
  ['Fresh Mint Lemonade', 'Drinks', 4.50, 'Hand-pressed lemon, muddled mint'],
  ['Spiced Chai', 'Drinks', 4.95, 'House masala chai, steamed milk']
];

async function seedMenu(clientId) {
  await wipe('MenuItems', `{ClientID} = '${clientId}'`);
  const rows = MENU.map(([Name, Category, Price, Description], i) => ({
    Name, Category, Price, Description, ClientID: clientId, Available: i % 11 !== 0
  }));
  const ids = await createRecords('MenuItems', rows);
  console.log(`  MenuItems: ${ids.length}`);
}

async function seedOrders(clientId) {
  await wipe('Orders', `{ClientID} = '${clientId}'`);
  const names = ['Maria Chen', 'James Okafor', 'Sofia Rossi', 'Liam Patel', 'Emma Johansson',
    'Noah Kim', 'Olivia Brooks', 'Ethan Vargas', 'Ava Nguyen', 'Lucas Moreau',
    'Mia Hernandez', 'Henry Walsh', 'Isla Romano', 'Mason Reed', 'Zoe Adler'];
  const rows = [];
  let n = 1042;
  // ~3-5 orders/day across trailing 14 days
  for (let d = 13; d >= 0; d--) {
    // Today gets a deterministic, actionable spread so the owner dashboard
    // always shows fresh pending/preparing orders to handle.
    const todayStatuses = ['pending', 'pending', 'preparing', 'completed', 'completed'];
    const count = d === 0 ? todayStatuses.length : randInt(2, 5);
    for (let k = 0; k < count; k++) {
      const items = [];
      const lineCount = randInt(1, 3);
      let total = 0;
      for (let li = 0; li < lineCount; li++) {
        const [Name, , Price] = pick(MENU);
        const qty = randInt(1, 2);
        total += Price * qty;
        items.push(`${qty}x ${Name}`);
      }
      // status: older = mostly completed; today = guaranteed actionable mix
      let status;
      if (d === 0) status = todayStatuses[k];
      else if (d <= 1) status = pick(['preparing', 'completed', 'completed']);
      else status = pick(['completed', 'completed', 'completed', 'cancelled']);
      rows.push({
        OrderID: String(n++),
        CustomerName: pick(names),
        ItemsList: items.join(', '),
        Total: Math.round(total * 100) / 100,
        Status: status,
        ClientID: clientId,
        OrderDate: d === 0 ? nowISO() : dayISO(d)
      });
    }
  }
  const ids = await createRecords('Orders', rows);
  console.log(`  Orders: ${ids.length}`);
  return rows;
}

async function seedPageViews(clientId) {
  await wipe('PageViews', `{ClientId} = '${clientId}'`);
  const pages = ['/', '/', '/', '/menu', '/menu', '/order-ahead', '/about', '/contact', '/rewards'];
  const refs = ['google.com', 'instagram.com', 'facebook.com', 'direct', 'direct', 'maps.google.com'];
  const rows = [];
  for (let d = 13; d >= 0; d--) {
    // ramp views upward toward today for a nice trend
    const base = 8 + (13 - d) * 1.2;
    const count = Math.round(base + rand(-3, 4));
    for (let k = 0; k < count; k++) {
      rows.push({
        Page: pick(pages),
        Timestamp: d === 0 ? nowISO() : dayISO(d),
        Referrer: pick(refs),
        ClientId: clientId // lowercase 'd' — matches analytics filter
      });
    }
  }
  const ids = await createRecords('PageViews', rows);
  console.log(`  PageViews: ${ids.length}`);
}

async function seedConversations(clientId) {
  // wipe prior demo conversations + their messages
  const priorConvos = await selectAll('Conversations', `{TenantID} = '${clientId}'`);
  for (const c of priorConvos) {
    await wipe('Messages', `{ConversationID} = '${c.id}'`);
  }
  if (priorConvos.length) await deleteRecords('Conversations', priorConvos.map(c => c.id));

  const convos = [
    { CustomerName: 'Rachel Summers', CustomerEmail: 'rachel.s@gmail.com', Status: 'waiting_for_owner', dayAgo: 0,
      thread: [
        ['customer', 'Hi! Do you have any gluten-free pastry options?'],
        ['bot', 'We do! Our Sea Salt Cookie can be made gluten-free, and the Vine Granola Bowl is naturally GF. Would you like me to flag your order?'],
        ['customer', 'Yes please, and can I pre-order 6 cookies for Saturday morning pickup?']
      ] },
    { CustomerName: 'Daniel Mwangi', CustomerEmail: 'dmwangi@outlook.com', Status: 'waiting_for_owner', dayAgo: 0,
      thread: [
        ['customer', 'Is the patio open for groups of 8 this weekend?'],
        ['bot', 'The patio seats up to 10 and is first-come, but we can hold a section with a heads-up.'],
        ['customer', 'Great — can you reserve it for Sunday 10am? Name is Daniel.']
      ] },
    { CustomerName: 'Priya Nair', CustomerEmail: 'priya.nair@gmail.com', Status: 'active', dayAgo: 1,
      thread: [
        ['customer', 'What time does the kitchen close on weekdays?'],
        ['bot', 'The kitchen runs 7am–3pm weekdays, with coffee and pastries until 5pm.'],
        ['customer', 'Perfect, thank you!'],
        ['owner', "You're welcome, Priya — see you soon!"]
      ] },
    { CustomerName: 'Marcus Bell', CustomerEmail: 'mbell@yahoo.com', Status: 'resolved', dayAgo: 3,
      thread: [
        ['customer', 'My online order #1031 was missing the chai. Can that be fixed?'],
        ['bot', "I'm sorry about that — let me get an owner to help."],
        ['owner', 'Hi Marcus, so sorry! I added a credit for a free chai on your next visit. It’s under your email.'],
        ['customer', 'Awesome, appreciate the quick help!']
      ] },
    { CustomerName: 'Grace Liu', CustomerEmail: 'grace.liu@gmail.com', Status: 'resolved', dayAgo: 5,
      thread: [
        ['customer', 'Do you offer catering for office breakfasts?'],
        ['owner', 'We do! Boxed breakfast bundles start at $9/person with 48 hours notice. Want me to email the catering menu?'],
        ['customer', 'Yes please, sending to this email is perfect.'],
        ['owner', 'Sent! Looking forward to it.']
      ] },
    { CustomerName: 'Tom Becker', CustomerEmail: 'tbecker@gmail.com', Status: 'archived', dayAgo: 9,
      thread: [
        ['customer', 'Are dogs allowed on the patio?'],
        ['bot', 'Absolutely — leashed pups are welcome on the patio, and we keep a water bowl out front.']
      ] }
  ];

  let totalMsgs = 0;
  for (const c of convos) {
    const escalated = dayISO(c.dayAgo, 9);
    const last = dayISO(c.dayAgo, 11);
    const convFields = {
      TenantID: clientId, CustomerName: c.CustomerName, CustomerEmail: c.CustomerEmail,
      Status: c.Status, Channel: 'web', SessionID: 'sess_' + Math.random().toString(36).slice(2, 10),
      EscalatedAt: escalated, LastMessageAt: last,
      ResolvedAt: (c.Status === 'resolved' || c.Status === 'archived') ? last : ''
    };
    const [convId] = await createRecords('Conversations', [convFields]);
    const msgRows = c.thread.map(([Sender, Content], i) => ({
      ConversationID: convId, Sender, Content,
      Timestamp: dayISO(c.dayAgo, 9 + i),
      ReadByOwner: c.Status !== 'waiting_for_owner',
      ReadByCustomer: Sender !== 'owner' || c.Status === 'resolved' || c.Status === 'archived'
    }));
    totalMsgs += (await createRecords('Messages', msgRows)).length;
  }
  console.log(`  Conversations: ${convos.length}, Messages: ${totalMsgs}`);
}

async function seedSuggestions(clientId) {
  await wipe('Suggestions', `{ClientID} = '${clientId}'`);
  const rows = [
    { Title: 'Promote the Oat Milk Latte on Instagram Stories',
      Body: 'Your Oat Milk Latte is your #2 seller but gets little social mention. A 3-day Stories push with a "tag a friend" offer historically lifts afternoon traffic 12–18%.',
      Category: 'traffic', Status: 'new', BaselineMetric: 'Avg 41 daily views', ReviewedAt: '' },
    { Title: 'Add a "Build-Your-Own Grain Bowl" lunch upsell',
      Body: 'Lunch orders average 1.4 items. A $3 add-protein option on the Harvest Grain Bowl could raise average order value without new inventory.',
      Category: 'revenue', Status: 'new', BaselineMetric: 'AOV $14.20', ReviewedAt: '' },
    { Title: 'Open online pre-orders 30 minutes earlier',
      Body: 'You have a cluster of 7am walk-ins but online ordering opens at 7:30. Opening pre-orders at 6:30 captures the commuter rush.',
      Category: 'orders', Status: 'created', BaselineMetric: '3.4 orders/day', ResultMetric: '4.6 orders/day (+35%)', ReviewedAt: dayISO(6, 12) },
    { Title: 'Launch a punch-card style rewards tier',
      Body: 'Repeat customers are 58% of revenue but have no loyalty incentive. A simple "buy 9 get 1" coffee reward improves return frequency.',
      Category: 'retention', Status: 'kept', BaselineMetric: '2.1 visits/mo', ResultMetric: '2.7 visits/mo', ReviewedAt: dayISO(10, 12) },
    { Title: 'Reply to the 4 unanswered Google reviews',
      Body: 'Responding to recent Google reviews (even positive ones) boosts local search ranking. Four reviews from the last month are unanswered.',
      Category: 'engagement', Status: 'new', BaselineMetric: '4.6 star avg', ReviewedAt: '' }
  ];
  rows.forEach((r, i) => { r.SuggestionID = 'sug_' + Date.now() + '_' + i; r.ClientID = clientId; r.CreatedAt = dayISO(randInt(1, 12), 9); });
  const ids = await createRecords('Suggestions', rows);
  console.log(`  Suggestions: ${ids.length}`);
}

async function seedSocial(clientId) {
  await wipe('SocialPosts', `{ClientID} = '${clientId}'`);
  const rows = [
    { Platform: 'instagram', Caption: 'Cold brew season is officially open. 18 hours of patience in every glass. ☕', Hashtags: '#coldbrew #cafe #harborandvine #slowcoffee', Category: 'promo', Status: 'posted', ScheduledFor: dayISO(4, 9) },
    { Platform: 'instagram', Caption: 'New on the lunch menu: the Harvest Grain Bowl. Farro, roasted veg, tahini, and a little crunch from pepitas.', Hashtags: '#lunch #grainbowl #eatlocal #healthyeats', Category: 'announcement', Status: 'scheduled', ScheduledFor: dayISO(-2, 11) },
    { Platform: 'facebook', Caption: 'Weekend plans? The patio is open, the pups are welcome, and the croissants are fresh out of the oven.', Hashtags: '#weekend #patio #dogfriendly', Category: 'engagement', Status: 'scheduled', ScheduledFor: dayISO(-1, 10) },
    { Platform: 'instagram', Caption: 'Behind every Harbor Blend is a 5am start and a lot of love. Thank you for making us part of your morning.', Hashtags: '#smallbusiness #morningritual #coffeelover', Category: 'engagement', Status: 'new', ScheduledFor: '' },
    { Platform: 'twitter', Caption: 'Rainy day = tomato basil soup + a warm panini kind of day. We got you. 🍅', Hashtags: '#soupseason #lunch #cozy', Category: 'seasonal', Status: 'new', ScheduledFor: '' }
  ];
  rows.forEach((r, i) => { r.PostID = 'post_' + Date.now() + '_' + i; r.ClientID = clientId; r.CreatedAt = dayISO(randInt(1, 12), 8); });
  const ids = await createRecords('SocialPosts', rows);
  console.log(`  SocialPosts: ${ids.length}`);
}

async function seedReports(clientId) {
  await wipe('Reports', `{ClientID} = '${clientId}'`);
  const rows = [];
  for (let m = 2; m >= 0; m--) {
    const views = randInt(540, 980);
    const orders = randInt(74, 138);
    const revenue = Math.round(orders * rand(13, 17) * 100) / 100;
    rows.push({
      ReportID: 'rep_' + monthLabel(m), ClientID: clientId, Period: monthLabel(m),
      Views: views, Orders: orders, Revenue: revenue,
      AvgOrder: Math.round((revenue / orders) * 100) / 100,
      OrdersByStatus: JSON.stringify({ completed: Math.round(orders * 0.86), cancelled: Math.round(orders * 0.05), pending: Math.round(orders * 0.09) }),
      PDFUrl: '', GeneratedAt: dayISO(m * 28 + 1, 6), Status: 'ready'
    });
  }
  const ids = await createRecords('Reports', rows);
  console.log(`  Reports: ${ids.length}`);
}

async function seedCampaigns(clientId) {
  await wipe('EmailCampaigns', `{ClientID} = '${clientId}'`);
  const rows = [
    { Type: 'seasonal', Subject: 'Cold Brew Season Is Here ☀️', Body: 'Our 18-hour cold brew is back. Show this email for $1 off any size through Sunday.', Status: 'sent', Schedule: dayISO(6, 9), RecipientCount: 612, SentCount: 612, LastSentAt: dayISO(6, 9) },
    { Type: 'blast', Subject: 'New Lunch Menu at Harbor & Vine', Body: 'Say hello to the Harvest Grain Bowl and Turkey & Brie Panini — now serving 11am–3pm.', Status: 'sent', Schedule: dayISO(12, 10), RecipientCount: 598, SentCount: 596, LastSentAt: dayISO(12, 10) },
    { Type: 'cart_abandon', Subject: 'You left something in your cart 🛒', Body: 'Your order is still waiting! Complete it in the next hour and skip the line at pickup.', Status: 'scheduled', Schedule: dayISO(-1, 8), RecipientCount: 0, SentCount: 0, LastSentAt: '' },
    { Type: 'seasonal', Subject: 'Patio weather + fresh croissants', Body: 'The sun is out and so are our pastries. Come grab a table this weekend.', Status: 'draft', Schedule: '', RecipientCount: 0, SentCount: 0, LastSentAt: '' }
  ];
  rows.forEach((r, i) => { r.CampaignID = 'camp_' + Date.now() + '_' + i; r.ClientID = clientId; r.CreatedAt = dayISO(randInt(2, 13), 8); });
  const ids = await createRecords('EmailCampaigns', rows);
  console.log(`  EmailCampaigns: ${ids.length}`);
}

async function seedStrategyCalls(clientId) {
  await wipe('StrategyCalls', `{ClientID} = '${clientId}'`);
  const rows = [
    { Quarter: quarterLabel(0), Topic: 'Planning a summer iced-drink menu and a loyalty launch', RequestedSlot: 'Weekday mornings before 9am', ScheduledAt: '', Status: 'requested', Notes: '' },
    { Quarter: quarterLabel(1), Topic: 'Review Q1 traffic dip and rebuild the weekend brunch push', RequestedSlot: 'Tuesday 8am', ScheduledAt: dayISO(40, 8), Status: 'completed', Notes: 'Agreed to add brunch bundles + Instagram cadence of 3x/week. Traffic recovered 14% by end of quarter.' }
  ];
  rows.forEach((r, i) => { r.CallID = 'call_' + Date.now() + '_' + i; r.ClientID = clientId; r.CreatedAt = dayISO(i === 0 ? 5 : 50, 9); });
  const ids = await createRecords('StrategyCalls', rows);
  console.log(`  StrategyCalls: ${ids.length}`);
}

async function seedDevHours(clientId) {
  await wipe('DevHours', `{ClientID} = '${clientId}'`);
  const rows = [
    { Month: monthLabel(0), Description: 'Add an online gift-card purchase page', Hours: 2, Status: 'requested', Billable: true, OverageAmount: 50 },
    { Month: monthLabel(0), Description: 'Swap homepage hero photo to the new patio shot', Hours: 0.5, Status: 'in_progress', Billable: false, OverageAmount: 0 },
    { Month: monthLabel(1), Description: 'Build the seasonal menu landing section + mobile fixes', Hours: 1, Status: 'completed', Billable: false, OverageAmount: 0 }
  ];
  rows.forEach((r, i) => { r.EntryID = 'dev_' + Date.now() + '_' + i; r.ClientID = clientId; r.CreatedAt = dayISO(i === 2 ? 35 : 4, 10); });
  const ids = await createRecords('DevHours', rows);
  console.log(`  DevHours: ${ids.length}`);
}

async function seedTransactions(clientId, orders) {
  await wipe('Transactions', `{ClientID} = '${clientId}'`);
  // one succeeded transaction per non-cancelled order
  const rows = orders.filter(o => o.Status !== 'cancelled').map((o, i) => {
    const amount = o.Total;
    const gsCut = Math.round(amount * 0.10 * 100) / 100;
    return {
      TransactionID: 'txn_' + Date.now() + '_' + i,
      ClientID: clientId, Amount: amount, GSCut: gsCut,
      ClientNet: Math.round((amount - gsCut) * 100) / 100,
      StripePaymentId: 'pi_demo_' + Math.random().toString(36).slice(2, 12),
      Status: 'succeeded',
      PayoutStatus: i % 4 === 0 ? 'pending' : 'swept',
      CustomerEmail: o.CustomerName.toLowerCase().replace(/[^a-z]/g, '.') + '@example.com',
      Description: o.ItemsList, Date: o.OrderDate
    };
  });
  const ids = await createRecords('Transactions', rows);
  console.log(`  Transactions: ${ids.length}`);
}

// ===========================================================================
(async () => {
  console.log('STEP 1 — provisioning schema (Meta API)…');
  await provisionSchema();

  console.log('STEP 2 — demo client…');
  const clientId = await ensureClient();

  console.log('STEP 3 — seeding surfaces…');
  await seedMenu(clientId);
  const orders = await seedOrders(clientId);
  await seedPageViews(clientId);
  await seedConversations(clientId);
  await seedSuggestions(clientId);
  await seedSocial(clientId);
  await seedReports(clientId);
  await seedCampaigns(clientId);
  await seedStrategyCalls(clientId);
  await seedDevHours(clientId);
  await seedTransactions(clientId, orders);

  console.log('\nDONE. Demo login →  username: demo   password: demo2026   (Concierge)');
  console.log(`Client record id: ${clientId}`);
})().catch(e => { console.error('SEED ERROR:', e.message); process.exit(1); });
