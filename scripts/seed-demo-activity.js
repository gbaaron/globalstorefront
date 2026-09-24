#!/usr/bin/env node
/**
 * scripts/seed-demo-activity.js — give the demo tenants a busy week.
 *
 * The demo businesses existed but had no customers, so every dashboard tab
 * screenshotted as an empty state. Empty states are honest but they sell
 * nothing, and a landing page showing "No members yet" is worse than no
 * screenshot at all.
 *
 * This creates shoppers, follows, loyalty history, bookings and page views for
 * the demo tenants only (identified by their @demo.globalstorefront.test
 * email). Safe to re-run; --clean removes just the activity, leaving the
 * businesses in place.
 *
 *   node scripts/seed-demo-activity.js
 *   node scripts/seed-demo-activity.js --clean
 */

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const t = line.trim();
        if (t && !t.startsWith('#') && t.includes('=')) {
            const [k, ...v] = t.split('=');
            if (!process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
        }
    }
}

const Airtable = require('airtable');
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const CLEAN = process.argv.includes('--clean');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mk = p => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const DEMO_DOMAIN = '@demo.globalstorefront.test';
const SHOPPER_DOMAIN = '@demo-shopper.globalstorefront.test';

// Ordinary Holland names. Weighted so balances look earned, not generated:
// a few regulars far ahead of a long tail, which is how loyalty actually lands.
const SHOPPERS = [
    { name: 'Marta Vos',        weight: 9 },
    { name: 'Dale Hoekstra',    weight: 7 },
    { name: 'Priya Raman',      weight: 6 },
    { name: 'Tom Bakker',       weight: 5 },
    { name: 'Erin Dykstra',     weight: 4 },
    { name: 'Luis Ortega',      weight: 3 },
    { name: 'Hannah Boer',      weight: 3 },
    { name: 'Chris Nagy',       weight: 2 },
    { name: 'Sam Achterberg',   weight: 2 },
    { name: 'Nina Kowalski',    weight: 1 }
];

const REASONS = [
    ['Online order', 'order'], ['In-store visit', 'visit'],
    ['Left a review', 'manual'], ['Referred a friend', 'referral'],
    ['Completed booking', 'booking']
];

const BOOKING_SERVICES = ['Coffee tasting', 'Private baking class', 'Cake consultation', 'Catering pickup'];

async function fetchAll(table, formula) {
    const out = [];
    await base(table).select(formula ? { filterByFormula: formula, pageSize: 100 } : { pageSize: 100 })
        .eachPage((r, n) => { r.forEach(x => out.push(x)); n(); });
    return out;
}

async function destroyAll(table, ids) {
    for (let i = 0; i < ids.length; i += 10) {
        try { await base(table).destroy(ids.slice(i, i + 10)); } catch (e) { /* gone */ }
        await sleep(220);
    }
}

async function createAll(table, rows) {
    const made = [];
    for (let i = 0; i < rows.length; i += 10) {
        const r = await base(table).create(rows.slice(i, i + 10), { typecast: true });
        r.forEach(x => made.push(x));
        await sleep(240);
    }
    return made;
}

async function clean() {
    console.log('\nRemoving demo activity…\n');
    const shoppers = await fetchAll('Users', `FIND('${SHOPPER_DOMAIN}', {Email}) > 0`);
    const ids = new Set(shoppers.map(s => s.id));
    console.log(`  ${shoppers.length} demo shoppers`);

    for (const table of ['Follows', 'PointsLedger']) {
        const rows = await fetchAll(table);
        const mine = rows.filter(r => ids.has(r.get('UserID'))).map(r => r.id);
        if (mine.length) { await destroyAll(table, mine); console.log(`  ${mine.length} ${table}`); }
    }

    const tenants = await fetchAll('Clients', `FIND('${DEMO_DOMAIN}', {Email}) > 0`);
    const tIds = new Set(tenants.map(t => t.id));
    const bookings = (await fetchAll('Bookings')).filter(b => tIds.has(b.get('TenantID'))).map(b => b.id);
    if (bookings.length) { await destroyAll('Bookings', bookings); console.log(`  ${bookings.length} Bookings`); }

    const orders = (await fetchAll('Orders')).filter(o => tIds.has(o.get('TenantID'))).map(o => o.id);
    if (orders.length) { await destroyAll('Orders', orders); console.log(`  ${orders.length} Orders`); }

    const views = (await fetchAll('PageViews')).filter(v => tIds.has(v.get('ClientId'))).map(v => v.id);
    if (views.length) { await destroyAll('PageViews', views); console.log(`  ${views.length} PageViews`); }

    await destroyAll('Users', [...ids]);
    console.log('\nDone.\n');
}

async function main() {
    if (CLEAN) return clean();

    const tenants = await fetchAll('Clients', `FIND('${DEMO_DOMAIN}', {Email}) > 0`);
    if (!tenants.length) {
        console.error('No demo tenants. Run seed-demo-directory.js first.');
        process.exit(1);
    }
    const bakery = tenants.find(t => t.get('Slug') === 'dutch-oven-bakery') || tenants[0];
    console.log(`\nSeeding activity. Headline tenant: ${bakery.get('Company')}\n`);

    // --- shoppers ---------------------------------------------------------
    const existing = await fetchAll('Users', `FIND('${SHOPPER_DOMAIN}', {Email}) > 0`);
    let shoppers = existing;
    if (!existing.length) {
        shoppers = await createAll('Users', SHOPPERS.map(s => ({
            fields: {
                Email: s.name.toLowerCase().replace(/[^a-z]+/g, '.') + SHOPPER_DOMAIN,
                Name: s.name,
                PasswordHash: 'demo1234',
                HomeRegionID: bakery.get('RegionID') || '',
                PushOptIn: true,
                CreatedAt: new Date(Date.now() - Math.random() * 90 * 86400000).toISOString(),
                LastLogin: new Date().toISOString()
            }
        })));
        console.log(`  + ${shoppers.length} shoppers`);
    } else {
        console.log(`  = ${shoppers.length} shoppers (exist)`);
    }
    const byName = new Map(shoppers.map(s => [s.get('Name'), s]));

    // --- follows ----------------------------------------------------------
    const haveFollows = await fetchAll('Follows');
    const followKey = new Set(haveFollows.map(f => `${f.get('UserID')}|${f.get('TenantID')}`));
    const newFollows = [];
    for (const t of tenants) {
        if (String(t.get('DirectoryStatus')) === 'none') continue;
        // More popular businesses get more followers, so the numbers vary.
        const take = t.id === bakery.id ? shoppers.length : 3 + Math.floor(Math.random() * 5);
        for (const s of shoppers.slice(0, take)) {
            if (followKey.has(`${s.id}|${t.id}`)) continue;
            newFollows.push({ fields: {
                FollowID: mk('fol'), UserID: s.id, TenantID: t.id,
                RegionID: t.get('RegionID') || '',
                CreatedAt: new Date(Date.now() - Math.random() * 60 * 86400000).toISOString(),
                Muted: false
            }});
        }
    }
    if (newFollows.length) { await createAll('Follows', newFollows); console.log(`  + ${newFollows.length} follows`); }

    // --- loyalty ----------------------------------------------------------
    const havePoints = (await fetchAll('PointsLedger')).filter(p => p.get('TenantID') === bakery.id);
    if (!havePoints.length) {
        const entries = [];
        for (const s of SHOPPERS) {
            const rec = byName.get(s.name);
            if (!rec) continue;
            for (let i = 0; i < s.weight; i++) {
                const [reason, source] = REASONS[Math.floor(Math.random() * REASONS.length)];
                entries.push({ fields: {
                    EntryID: mk('pts'), UserID: rec.id, TenantID: bakery.id,
                    RegionID: bakery.get('RegionID') || '',
                    Delta: [25, 50, 50, 75, 100][Math.floor(Math.random() * 5)],
                    Reason: reason, Source: source,
                    Timestamp: new Date(Date.now() - Math.random() * 75 * 86400000).toISOString()
                }});
            }
            // The regulars have actually spent some, so balances aren't just sums.
            if (s.weight >= 6) {
                entries.push({ fields: {
                    EntryID: mk('pts'), UserID: rec.id, TenantID: bakery.id,
                    Delta: -200, Reason: 'Redeemed — free dozen', Source: 'redemption',
                    Timestamp: new Date(Date.now() - Math.random() * 20 * 86400000).toISOString()
                }});
            }
        }
        await createAll('PointsLedger', entries);
        console.log(`  + ${entries.length} loyalty entries`);
    } else {
        console.log(`  = loyalty history exists`);
    }

    // --- bookings ---------------------------------------------------------
    const haveBookings = (await fetchAll('Bookings')).filter(b => b.get('TenantID') === bakery.id);
    if (!haveBookings.length) {
        const rows = [];
        const statuses = ['requested', 'requested', 'confirmed', 'confirmed', 'confirmed', 'completed', 'completed'];
        for (let i = 0; i < statuses.length; i++) {
            const s = SHOPPERS[i % SHOPPERS.length];
            const rec = byName.get(s.name);
            const past = statuses[i] === 'completed';
            const when = new Date(Date.now() + (past ? -1 : 1) * (1 + Math.random() * 9) * 86400000);
            when.setHours(9 + Math.floor(Math.random() * 7), [0, 30][Math.floor(Math.random() * 2)], 0, 0);
            rows.push({ fields: {
                BookingID: mk('bkg'), TenantID: bakery.id,
                UserID: rec ? rec.id : '',
                CustomerName: s.name,
                CustomerEmail: rec ? rec.get('Email') : '',
                Service: BOOKING_SERVICES[i % BOOKING_SERVICES.length],
                StartsAt: when.toISOString(),
                DurationMins: [30, 45, 60][Math.floor(Math.random() * 3)],
                Status: statuses[i],
                Price: [0, 25, 40, 65][Math.floor(Math.random() * 4)],
                CreatedAt: new Date(Date.now() - Math.random() * 14 * 86400000).toISOString()
            }});
        }
        await createAll('Bookings', rows);
        console.log(`  + ${rows.length} bookings`);
    } else {
        console.log(`  = bookings exist`);
    }

    // --- page views, so the analytics chart has a shape --------------------
    const haveViews = (await fetchAll('PageViews')).filter(v => v.get('ClientId') === bakery.id);
    if (haveViews.length < 50) {
        const rows = [];
        const surfaces = ['space', 'website', 'directory', 'app'];
        for (let d = 29; d >= 0; d--) {
            // A weekly rhythm with a weekend lift, rather than uniform noise.
            const day = new Date(Date.now() - d * 86400000);
            const weekend = [0, 6].includes(day.getDay());
            const n = Math.round((weekend ? 14 : 8) + Math.random() * 9);
            for (let i = 0; i < n; i++) {
                day.setHours(7 + Math.floor(Math.random() * 12), Math.floor(Math.random() * 60));
                rows.push({ fields: {
                    Page: `space:${surfaces[Math.floor(Math.random() * surfaces.length)]}`,
                    Referrer: '', Timestamp: day.toISOString(), ClientId: bakery.id
                }});
            }
        }
        await createAll('PageViews', rows);
        console.log(`  + ${rows.length} page views`);
    } else {
        console.log(`  = page views exist`);
    }

    // --- orders, so the dashboard shows revenue rather than $0.00 ----------
    const haveOrders = (await fetchAll('Orders')).filter(o => o.get('TenantID') === bakery.id);
    if (!haveOrders.length) {
        const items = await fetchAll('Items', `{TenantID} = '${bakery.id}'`);
        const menu = items.length
            ? items.map(i => ({ name: i.get('Name'), price: Number(i.get('Price')) || 4 }))
            : [{ name: 'Country sourdough', price: 7.5 }, { name: 'Drip coffee', price: 3 }];
        const statuses = ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'ready', 'preparing', 'paid', 'pending'];
        const rows = [];
        for (let d = 27; d >= 0; d--) {
            const day = new Date(Date.now() - d * 86400000);
            const weekend = [0, 6].includes(day.getDay());
            const n = Math.round((weekend ? 5 : 3) + Math.random() * 3);
            for (let i = 0; i < n; i++) {
                const line = [];
                const picks = 1 + Math.floor(Math.random() * 3);
                for (let k = 0; k < picks; k++) {
                    const m = menu[Math.floor(Math.random() * menu.length)];
                    line.push({ name: m.name, price: m.price, quantity: 1 + Math.floor(Math.random() * 2) });
                }
                const subtotal = Math.round(line.reduce((x, l) => x + l.price * l.quantity, 0) * 100) / 100;
                const shopper = SHOPPERS[Math.floor(Math.random() * SHOPPERS.length)];
                const rec = byName.get(shopper.name);
                day.setHours(7 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60));
                rows.push({ fields: {
                    OrderID: mk('ord'), TenantID: bakery.id, ClientID: bakery.id,
                    UserID: rec ? rec.id : '',
                    CustomerName: shopper.name,
                    CustomerEmail: rec ? rec.get('Email') : '',
                    Items: JSON.stringify(line),
                    ItemsList: line.map(l => `${l.quantity}x ${l.name}`).join(', '),
                    Subtotal: subtotal,
                    Total: subtotal,
                    Status: d < 2 ? statuses[4 + Math.floor(Math.random() * 4)] : 'fulfilled',
                    PaymentChannel: 'us',
                    CreatedAt: day.toISOString(),
                    OrderDate: day.toISOString()
                }});
            }
        }
        await createAll('Orders', rows);
        const rev = rows.reduce((x, r) => x + r.fields.Total, 0);
        console.log(`  + ${rows.length} orders ($${rev.toFixed(2)})`);
    } else {
        console.log(`  = orders exist`);
    }

    console.log('\nDone.\n');
}

main().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
