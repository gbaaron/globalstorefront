#!/usr/bin/env node
/**
 * scripts/_e2e.js — end-to-end exercise of the revamp against the LIVE base.
 *
 * Invokes the Netlify handlers directly with synthetic events, so it tests the
 * real functions and the real Airtable, with no server running.
 *
 * Creates test rows prefixed `[E2E]` and deletes them at the end. Run with
 * --keep to leave them in place for inspection.
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

const jwt = require('jsonwebtoken');
const Airtable = require('airtable');
const F = (n) => require(path.join(__dirname, '..', 'netlify', 'functions', n));
const C = require('../netlify/functions/lib/capabilities');

const KEEP = process.argv.includes('--keep');
const SECRET = process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production';
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

let pass = 0, fail = 0;
const cleanup = [];

function check(label, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? '  → ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
}

const call = async (fnName, event) => {
    const res = await F(fnName).handler(event);
    let body = {};
    try { body = JSON.parse(res.body || '{}'); } catch (e) { body = { raw: res.body }; }
    return { status: res.statusCode, body };
};

const GET = (q, token) => ({
    httpMethod: 'GET',
    queryStringParameters: q || {},
    headers: token ? { authorization: `Bearer ${token}` } : {}
});
const POST = (b, token) => ({
    httpMethod: 'POST',
    body: JSON.stringify(b || {}),
    queryStringParameters: {},
    headers: token ? { authorization: `Bearer ${token}` } : {}
});

const tenantToken = (t) => jwt.sign({
    userId: t.id, email: t.email, role: 'client', tier: t.tier,
    billingCycle: 'annual', baseId: '', caps: t.caps, regionId: t.regionId
}, SECRET, { expiresIn: '1h' });

async function main() {
    console.log('\n=== Global Storefront E2E ===\n');

    // ---------------------------------------------------------------
    console.log('SETUP — a FREE-listing tenant in Shop Holland');
    const regions = await base('Regions').select({ filterByFormula: `{Slug} = 'holland'`, maxRecords: 1 }).firstPage();
    const holland = regions[0];
    check('Shop Holland region exists', !!holland);
    if (!holland) return finish();

    const created = await base('Clients').create([{
        fields: {
            Name: '[E2E] Tester', Email: `e2e-${Date.now()}@example.com`,
            Username: `e2e${Date.now()}`, PasswordHash: 'e2epass123',
            Company: '[E2E] Corner Coffee', Slug: `e2e-corner-coffee-${Date.now()}`,
            Tier: 'Essentials', BillingCycle: 'annual', SubStatus: 'active',
            RegionID: holland.id, DirectoryStatus: 'free',
            HasWebsite: true, WebsiteMode: 'built', HasApp: false,
            PaymentChannel: 'none', MonetizationMode: 'flat_monthly',
            Tagline: 'Test tenant — safe to delete', CreatedAt: new Date().toISOString()
        }
    }], { typecast: true });
    const tenantRec = created[0];
    cleanup.push(['Clients', tenantRec.id]);

    const tenant = {
        id: tenantRec.id, email: tenantRec.get('Email'), tier: 'Essentials',
        caps: C.resolveCapabilities(tenantRec), regionId: holland.id,
        slug: tenantRec.get('Slug')
    };
    const tToken = tenantToken(tenant);
    console.log(`  tenant ${tenant.id} — ${tenant.caps.length} capabilities\n`);

    // ---------------------------------------------------------------
    console.log('PHASE 1 — capability gating');
    check('free listing grants push_followers', C.can(tenant.caps, 'push_followers'));
    check('free listing does NOT grant push_unlimited', !C.can(tenant.caps, 'push_unlimited'));
    check('free listing does NOT grant bookings', !C.can(tenant.caps, 'bookings'));
    check('quota is 2/month', C.pushQuota(tenant.caps).cap === 2);

    const gated = await call('manage-bookings.js', GET({}, tToken));
    check('bookings endpoint returns locked, not 500', gated.status === 200 && gated.body.locked === true, gated.body);

    // ---------------------------------------------------------------
    console.log('\nPHASE 3 — content & hours, edited once');
    const madeContent = await call('manage-content.js', POST({
        resource: 'content', action: 'create', kind: 'about',
        title: '[E2E] About us', body: 'We sell coffee.', publish: true
    }, tToken));
    check('content created', madeContent.status === 200 && madeContent.body.success, madeContent.body);
    if (madeContent.body.item) cleanup.push(['TenantContent', madeContent.body.item.id]);

    const hoursSet = await call('manage-content.js', POST({
        resource: 'hours', action: 'set',
        hours: [
            { day: 'monday', open: '07:00', close: '18:00' },
            { day: 'tuesday', open: '07:00', close: '18:00' },
            { day: 'sunday', closed: true }
        ]
    }, tToken));
    check('hours set for the week', hoursSet.status === 200 && hoursSet.body.hours.length === 7, hoursSet.body);
    (hoursSet.body.hours || []).forEach(h => { if (h.id) cleanup.push(['TenantHours', h.id]); });

    const contentGet = await call('manage-content.js', GET({ resource: 'all' }, tToken));
    const surfaceLabels = (contentGet.body.surfaces || []).map(s => s.key);
    check('edit reaches space + website + directory',
        surfaceLabels.includes('space') && surfaceLabels.includes('website') && surfaceLabels.includes('directory'),
        surfaceLabels);

    // ---------------------------------------------------------------
    console.log('\nPHASE 2 — the surfaces engine renders one space');
    const space = await call('get-space.js', GET({ slug: tenant.slug, surface: 'space' }));
    check('space renders', space.status === 200 && space.body.mode === 'space', space.body);
    check('space carries the content', (space.body.content || []).some(c => c.title === '[E2E] About us'));
    check('space carries 7 days of hours', (space.body.hours || []).length === 7);
    check('space says ordering is OFF (no pay_in_app)', space.body.features && space.body.features.ordering === false);
    check('space says follow is ON (free listing)', space.body.features && space.body.features.follow === true);

    const asApp = await call('get-space.js', GET({ slug: tenant.slug, surface: 'app' }));
    check('app surface refused — tenant has no app', asApp.status === 403, asApp.body);

    // ---------------------------------------------------------------
    console.log('\nPHASE 4 — directory + a real follower');
    const dir = await call('get-directory.js', GET({ region: 'holland' }));
    check('Shop Holland is live', dir.status === 200 && dir.body.live === true, dir.body);
    check('our tenant appears in the directory',
        (dir.body.tenants || []).some(t => t.id === tenant.id), (dir.body.tenants || []).map(t => t.name));

    const signup = await call('user-auth.js', POST({
        action: 'signup', email: `e2e-shopper-${Date.now()}@example.com`,
        password: 'shopper123', name: '[E2E] Shopper', regionSlug: 'holland', pushOptIn: true
    }));
    check('shopper account created', signup.status === 200 && !!signup.body.token, signup.body);
    if (signup.body.user) cleanup.push(['Users', signup.body.user.id]);
    const uToken = signup.body.token;

    const followed = await call('manage-follow.js', POST({ action: 'follow', tenantId: tenant.id }, uToken));
    check('shopper follows the business', followed.status === 200 && followed.body.success, followed.body);
    if (followed.body.follow) cleanup.push(['Follows', followed.body.follow.id]);

    const userToken = jwt.decode(uToken);
    check('user token role is "user", not "client"', userToken.role === 'user');
    const crossRole = await call('manage-content.js', GET({}, uToken));
    check('a user token CANNOT reach a tenant endpoint', crossRole.status === 401, crossRole.body);

    // ---------------------------------------------------------------
    console.log('\nPHASE 4 — THE 2/MONTH CAP (the thing that has to be right)');
    const p1 = await call('manage-push.js', POST({
        action: 'send', title: '[E2E] Broadcast 1', body: 'Fresh beans.', surface: 'followers'
    }, tToken));
    check('broadcast 1 sends', p1.status === 200 && p1.body.success, p1.body);
    if (p1.body.broadcast) cleanup.push(['PushBroadcasts', p1.body.broadcast.id]);
    check('1 of 2 used', p1.body.quota && p1.body.quota.used === 1 && p1.body.quota.remaining === 1, p1.body.quota);

    const p2 = await call('manage-push.js', POST({
        action: 'send', title: '[E2E] Broadcast 2', body: 'Half off.', surface: 'followers'
    }, tToken));
    check('broadcast 2 sends', p2.status === 200 && p2.body.success, p2.body);
    if (p2.body.broadcast) cleanup.push(['PushBroadcasts', p2.body.broadcast.id]);
    check('2 of 2 used, 0 remaining', p2.body.quota && p2.body.quota.remaining === 0, p2.body.quota);

    const p3 = await call('manage-push.js', POST({
        action: 'send', title: '[E2E] Broadcast 3', body: 'Should be refused.', surface: 'followers'
    }, tToken));
    check('>>> broadcast 3 is REFUSED with 429 <<<', p3.status === 429, p3.body);
    check('refusal names the upgrade', p3.body.upgrade && p3.body.upgrade.capability === 'push_unlimited', p3.body);

    const blockedRows = await base('PushBroadcasts').select({
        filterByFormula: `AND({TenantID} = '${tenant.id}', {Status} = 'blocked')`
    }).firstPage();
    check('the refusal was recorded for the admin to see', blockedRows.length === 1);
    blockedRows.forEach(r => cleanup.push(['PushBroadcasts', r.id]));

    const pushToApp = await call('manage-push.js', POST({
        action: 'send', title: '[E2E] To app', body: 'x', surface: 'app'
    }, tToken));
    check('pushing to a non-existent app surface is refused', pushToApp.status === 403, pushToApp.body);

    // ---------------------------------------------------------------
    console.log('\nUPGRADE — flip to PAID directory space, same tenant');
    await base('Clients').update([{ id: tenant.id, fields: { DirectoryStatus: 'paid' } }], { typecast: true });
    const upgradedRec = await base('Clients').find(tenant.id);
    const upgraded = { ...tenant, caps: C.resolveCapabilities(upgradedRec) };
    const upToken = tenantToken(upgraded);

    check('paid now grants push_unlimited', C.can(upgraded.caps, 'push_unlimited'));
    check('paid now grants bookings', C.can(upgraded.caps, 'bookings'));
    check('paid now grants loyalty', C.can(upgraded.caps, 'loyalty'));
    check('still NOT monthly_reports (that is a Growth module, not a directory one)',
        !C.can(upgraded.caps, 'monthly_reports'));

    const p4 = await call('manage-push.js', POST({
        action: 'send', title: '[E2E] Broadcast 4', body: 'Now unlimited.', surface: 'followers'
    }, upToken));
    check('>>> the SAME tenant can now send past the old cap <<<', p4.status === 200 && p4.body.success, p4.body);
    if (p4.body.broadcast) cleanup.push(['PushBroadcasts', p4.body.broadcast.id]);

    const bookingsNow = await call('manage-bookings.js', GET({}, upToken));
    check('bookings endpoint is no longer locked', bookingsNow.status === 200 && !bookingsNow.body.locked, bookingsNow.body);

    // ---------------------------------------------------------------
    console.log('\nPHASE 3 — bookings + loyalty on the upgraded tenant');
    const avail = await call('manage-bookings.js', POST({
        action: 'availability', tenantId: tenant.id,
        date: nextMonday(), durationMins: 30
    }));
    check('availability derives slots from the tenant\'s own hours',
        avail.status === 200 && avail.body.open === true && avail.body.slots.length > 0,
        { open: avail.body.open, slots: (avail.body.slots || []).length });

    const slot = (avail.body.slots || [])[0];
    if (slot) {
        const booked = await call('manage-bookings.js', POST({
            action: 'request', tenantId: tenant.id, startsAt: slot.startsAt,
            customerName: '[E2E] Walk-in', customerEmail: 'walkin@example.com',
            service: 'Coffee tasting', durationMins: 30
        }));
        check('a guest can request a slot without an account', booked.status === 200 && booked.body.success, booked.body);
        if (booked.body.booking) cleanup.push(['Bookings', booked.body.booking.id]);

        const clash = await call('manage-bookings.js', POST({
            action: 'request', tenantId: tenant.id, startsAt: slot.startsAt,
            customerName: '[E2E] Second', durationMins: 30
        }));
        check('a double-booking of the same slot is refused', clash.status === 409, clash.body);
    }

    const award = await call('manage-loyalty.js', POST({
        action: 'award', userId: signup.body.user.id, amount: 50, reason: '[E2E] Test award'
    }, upToken));
    check('loyalty points awarded', award.status === 200 && award.body.balance === 50, award.body);
    if (award.body.entry) cleanup.push(['PointsLedger', award.body.entry.id]);

    const overdraw = await call('manage-loyalty.js', POST({
        action: 'redeem', userId: signup.body.user.id, amount: 500
    }, upToken));
    check('redeeming more than the balance is refused', overdraw.status === 409, overdraw.body);

    // ---------------------------------------------------------------
    console.log('\nPHASE 5 — payment channel decides whether money is touched');
    await base('Clients').update([{ id: tenant.id, fields: { PaymentChannel: 'theirs' } }], { typecast: true });
    const theirsRec = await base('Clients').find(tenant.id);
    const theirsToken = tenantToken({ ...tenant, caps: C.resolveCapabilities(theirsRec) });

    const inv = await call('manage-invoices.js', POST({
        action: 'create', customerName: '[E2E] Client', customerEmail: 'client@example.com',
        lineItems: [{ name: 'Catering', price: 200, quantity: 1 }]
    }, theirsToken));
    check('invoice created under payment_channel = theirs', inv.status === 200 && inv.body.success, inv.body);
    if (inv.body.invoice) cleanup.push(['Invoices', inv.body.invoice.id]);
    check('we tell them we do not touch their money',
        inv.body.payment && inv.body.payment.canCollect === false, inv.body.payment);

    if (inv.body.invoice) {
        await call('manage-invoices.js', POST({ action: 'send', id: inv.body.invoice.id }, theirsToken));
        const paid = await call('manage-invoices.js', POST({
            action: 'pay', id: inv.body.invoice.id, amount: 200
        }, theirsToken));
        check('payment recorded', paid.status === 200 && paid.body.invoice.status === 'paid', paid.body);
        check('>>> NO transaction row written — not our money <<<', paid.body.transaction === null, paid.body.transaction);
    }

    // now flip to us
    await base('Clients').update([{ id: tenant.id, fields: { PaymentChannel: 'us' } }], { typecast: true });
    const usRec = await base('Clients').find(tenant.id);
    const usToken = tenantToken({ ...tenant, caps: C.resolveCapabilities(usRec) });

    const inv2 = await call('manage-invoices.js', POST({
        action: 'create', customerName: '[E2E] Client 2',
        lineItems: [{ name: 'Catering', price: 200, quantity: 1 }]
    }, usToken));
    if (inv2.body.invoice) {
        cleanup.push(['Invoices', inv2.body.invoice.id]);
        await call('manage-invoices.js', POST({ action: 'send', id: inv2.body.invoice.id }, usToken));
        const paid2 = await call('manage-invoices.js', POST({
            action: 'pay', id: inv2.body.invoice.id, amount: 200
        }, usToken));
        check('>>> transaction row IS written when we are the channel <<<', !!paid2.body.transaction, paid2.body);
        check('10/90 split is correct (200 → 20 / 180)',
            paid2.body.transaction && paid2.body.transaction.gsCut === 20 && paid2.body.transaction.clientNet === 180,
            paid2.body.transaction);
        if (paid2.body.transaction) cleanup.push(['Transactions', paid2.body.transaction.id]);
    }

    // ---------------------------------------------------------------
    console.log('\nPHASE 6 — value modules');
    const ev = await call('manage-modules.js', POST({
        resource: 'events', action: 'create', title: '[E2E] Cupping night',
        startsAt: nextMonday() + 'T18:00:00', capacity: 2, publish: true
    }, usToken));
    check('event created', ev.status === 200 && ev.body.success, ev.body);
    if (ev.body.event) {
        cleanup.push(['Events', ev.body.event.id]);
        const s1 = await call('manage-modules.js', POST({
            resource: 'events', action: 'signup', tenantId: tenant.id,
            eventId: ev.body.event.id, name: '[E2E] A', email: 'a@example.com', guests: 1
        }));
        check('signup fills the 2 seats', s1.status === 200 && s1.body.waitlisted === false, s1.body);
        if (s1.body.signup) cleanup.push(['EventSignups', s1.body.signup.id]);

        const s2 = await call('manage-modules.js', POST({
            resource: 'events', action: 'signup', tenantId: tenant.id,
            eventId: ev.body.event.id, name: '[E2E] B', email: 'b@example.com'
        }));
        check('>>> the 3rd seat goes to the WAITLIST, not refused <<<', s2.body.waitlisted === true, s2.body);
        if (s2.body.signup) cleanup.push(['EventSignups', s2.body.signup.id]);
    }

    const item = await call('manage-items.js', POST({
        action: 'create', name: '[E2E] Ethiopia single origin', price: 18, stockCount: 0, status: 'sold_out'
    }, usToken));
    check('item created out of stock', item.status === 200 && item.body.success, item.body);
    if (item.body.item) {
        cleanup.push(['Items', item.body.item.id]);
        const sub = await call('manage-modules.js', POST({
            resource: 'restock', action: 'subscribe', tenantId: tenant.id,
            itemId: item.body.item.id, email: 'waiting@example.com'
        }));
        check('customer subscribes to a restock alert', sub.status === 200 && sub.body.success, sub.body);
        if (sub.body.subscription) cleanup.push(['RestockSubscriptions', sub.body.subscription.id]);

        const restocked = await call('manage-items.js', POST({
            action: 'update', id: item.body.item.id, stockCount: 12, status: 'active'
        }, usToken));
        check('>>> restocking zero→positive notifies the waiter <<<',
            restocked.body.restockNotified === 1, restocked.body);
    }

    // ---------------------------------------------------------------
    console.log('\nPHASE 3 — unified analytics across surfaces');
    const an = await call('get-unified-analytics.js', GET({ days: 30 }, usToken));
    check('analytics returns', an.status === 200, an.body);
    check('surfaces listed are only the ones owned',
        (an.body.surfaces || []).every(s => s.owned), an.body.surfaces);
    check('push quota surfaced as unlimited (paid)', an.body.push && an.body.push.quota.unlimited === true, an.body.push);
    check('follower count reflects the real follow', an.body.totals && an.body.totals.followers === 1, an.body.totals);

    // ---------------------------------------------------------------
    console.log('\nPHASE 7 — super-admin control room');
    const aToken = jwt.sign({ userId: 'admin', email: 'aaron@test', role: 'admin' }, SECRET, { expiresIn: '1h' });
    const ov = await call('admin-tenants.js', GET({ view: 'overview' }, aToken));
    check('overview returns', ov.status === 200, ov.body);
    check('the tenant who hit the cap is surfaced for follow-up',
        (ov.body.hittingPushCap || []).some(x => x.tenantId === tenant.id), ov.body.hittingPushCap);

    const tv = await call('admin-tenants.js', GET({ view: 'tenants' }, aToken));
    check('every tenant listed with axes', tv.status === 200 && tv.body.tenants.length > 0);
    check('capability toggle grid is served from the registry',
        (tv.body.capabilityGroups || []).length === 7, (tv.body.capabilityGroups || []).length);

    const toggled = await call('admin-tenants.js', POST({
        action: 'toggle_directory', tenantId: tenant.id, directoryStatus: 'none'
    }, aToken));
    check('admin can toggle a tenant OUT of the directory',
        toggled.status === 200 && toggled.body.tenant.directoryStatus === 'none', toggled.body);
    check('removing the listing removes push entirely',
        toggled.body.pushQuota && toggled.body.pushQuota.cap === 0, toggled.body.pushQuota);

    const revoked = await call('admin-tenants.js', POST({
        action: 'grant', tenantId: tenant.id, capability: 'bookings'
    }, aToken));
    check('admin can hand-grant one capability with no tier change',
        revoked.status === 200 && revoked.body.has === true, revoked.body);

    const noAuth = await call('admin-tenants.js', GET({ view: 'billing' }, uToken));
    check('a shopper token cannot reach the control room', noAuth.status === 403, noAuth.body);

    finish();
}

function nextMonday() {
    const d = new Date();
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    return d.toISOString().split('T')[0];
}

async function finish() {
    if (!KEEP && cleanup.length) {
        console.log(`\nCleaning up ${cleanup.length} test rows...`);
        const byTable = new Map();
        cleanup.forEach(([t, id]) => {
            if (!byTable.has(t)) byTable.set(t, []);
            byTable.get(t).push(id);
        });
        for (const [table, ids] of byTable) {
            for (let i = 0; i < ids.length; i += 10) {
                try { await base(table).destroy(ids.slice(i, i + 10)); } catch (e) { /* already gone */ }
                await new Promise(r => setTimeout(r, 220));
            }
        }
        console.log('Cleanup done.');
    } else if (KEEP) {
        console.log('\n--keep: test rows left in place.');
    }

    console.log(`\n${'='.repeat(46)}`);
    console.log(`  PASS ${pass}    FAIL ${fail}`);
    console.log(`${'='.repeat(46)}\n`);
    process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
    console.error('\nE2E crashed:', e.message);
    console.error(e.stack);
    fail++;
    await finish();
});
