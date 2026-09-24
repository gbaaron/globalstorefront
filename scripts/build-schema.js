#!/usr/bin/env node
/**
 * scripts/build-schema.js — create the revamp's Airtable tables and fields.
 *
 * IDEMPOTENT AND ADDITIVE. It only ever creates what is missing:
 *   - never deletes a table, field, or row
 *   - never changes an existing field's type
 *   - safe to re-run after a partial failure
 *
 * Usage:
 *   node scripts/build-schema.js          # create missing tables + fields
 *   node scripts/build-schema.js --dry    # print the plan, change nothing
 */

const fs = require('fs');
const path = require('path');

// --- .env loader (no dotenv dependency) ------------------------------------
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

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const DRY = process.argv.includes('--dry');

if (!API_KEY || !BASE_ID) {
    console.error('Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID');
    process.exit(1);
}

const META = `https://api.airtable.com/v0/meta/bases/${BASE_ID}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(url, options) {
    const res = await fetch(url, Object.assign({
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        }
    }, options || {}));
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
    if (!res.ok) {
        const err = new Error(`${res.status} ${(json.error && (json.error.message || json.error.type)) || text}`);
        err.status = res.status;
        err.body = json;
        throw err;
    }
    return json;
}

// --- Field shorthands -------------------------------------------------------
const txt = (name, description) => ({ name, type: 'singleLineText', description });
const long = (name, description) => ({ name, type: 'multilineText', description });
const check = (name, description) => ({ name, type: 'checkbox', description, options: { icon: 'check', color: 'greenBright' } });
const num = (name, precision, description) => ({ name, type: 'number', description, options: { precision: precision || 0 } });
const sel = (name, choices, description) => ({
    name, type: 'singleSelect', description,
    options: { choices: choices.map(c => (typeof c === 'string' ? { name: c } : c)) }
});

// ---------------------------------------------------------------------------
// New fields on the existing tenant table (Clients)
// ---------------------------------------------------------------------------

const TENANT_FIELDS = [
    txt('Slug', 'URL-safe tenant identifier used by the space + directory'),
    txt('RegionID', 'Regions record ID. Empty until the tenant\'s city launches.'),
    check('HasWebsite', 'Axis 1 — does this tenant have a website surface?'),
    sel('WebsiteMode', ['none', 'built', 'linked'], 'built = domain points at their space; linked = they keep their own site'),
    check('HasApp', 'Axis 1 — does this tenant have a standalone app?'),
    sel('DirectoryStatus', ['none', 'free', 'paid'], 'Axis 2 — distribution. free = 2 pushes/month cap.'),
    sel('PaymentChannel', ['us', 'theirs', 'none'], 'Who is the payment channel. Never assumed.'),
    sel('MonetizationMode', ['percent_of_sale', 'flat_monthly', 'free'], 'How this tenant is billed'),
    txt('POSSystem', 'Point-of-sale system in use, if any'),
    long('Capabilities', 'JSON override array. Bare key grants, "-key" revokes. Revokes win.'),
    txt('LogoURL', 'Tenant logo (Cloudinary)'),
    txt('BrandColor', 'Hex brand colour used to skin the space'),
    txt('Tagline', 'One-line description shown on directory cards'),
    txt('Address', 'Street address for the directory map'),
    txt('Phone', 'Public phone number'),
    txt('WebsiteURL', 'External website, for link-out listings'),
    txt('Lat', 'Latitude for the directory map'),
    txt('Lng', 'Longitude for the directory map'),
    txt('LastLogin', 'ISO timestamp of the tenant\'s last dashboard login')
];

// ---------------------------------------------------------------------------
// New tables
// ---------------------------------------------------------------------------

const TABLES = [
    {
        name: 'Regions',
        description: 'A directory instance — Shop [City], Vote [State]. Nothing is hardcoded to one city.',
        fields: [
            txt('RegionID', 'Internal ID (reg_...)'),
            txt('Name', 'Display name, e.g. "Shop Holland"'),
            txt('Slug', 'URL segment, e.g. "holland"'),
            txt('City', ''),
            txt('State', ''),
            sel('Kind', ['shop', 'vote'], 'Which directory product this region is an instance of'),
            sel('Status', ['planned', 'live', 'paused'], 'Only live regions are publicly browsable'),
            txt('LaunchedAt', 'ISO date the region went live'),
            txt('AccentColor', 'Hex accent used to skin this directory'),
            long('Blurb', 'Directory landing copy'),
            num('TenantCount', 0, 'Denormalised count of tenants toggled in')
        ]
    },
    {
        name: 'Users',
        description: 'Directory END USERS (shoppers / constituents). NOT tenants. One account follows many tenants across regions.',
        fields: [
            txt('Email', 'Canonical identity key, lowercase'),
            txt('Name', ''),
            txt('PasswordHash', 'Plain text while HASH_PASSWORDS is off; bcrypt once on'),
            txt('HomeRegionID', 'Region they browse by default — not a restriction'),
            txt('CreatedAt', 'ISO timestamp'),
            txt('LastLogin', 'ISO timestamp'),
            check('PushOptIn', 'Whether they accept push broadcasts'),
            txt('DeviceToken', 'FCM token for this user, if any'),
            check('IsAdmin', 'Reserved — directory moderation')
        ]
    },
    {
        name: 'Follows',
        description: 'A user follows a tenant. The unit of directory reach.',
        fields: [
            txt('FollowID', 'Internal ID (fol_...)'),
            txt('UserID', 'Users record ID'),
            txt('TenantID', 'Clients record ID'),
            txt('RegionID', 'Region the follow happened in (for per-region analytics)'),
            txt('CreatedAt', 'ISO timestamp'),
            check('Muted', 'User still follows but has silenced broadcasts')
        ]
    },
    {
        name: 'PushBroadcasts',
        description: 'One row per broadcast. The 2/month free cap is counted off this table.',
        fields: [
            txt('BroadcastID', 'Internal ID (push_...)'),
            txt('TenantID', 'Clients record ID'),
            txt('Title', ''),
            long('Body', ''),
            txt('Surfaces', 'Comma list: app, followers'),
            txt('Segment', 'Audience segment key; empty = everyone'),
            sel('Status', ['draft', 'scheduled', 'sending', 'sent', 'failed', 'blocked'], 'blocked = refused by the monthly cap'),
            txt('ScheduledAt', 'ISO timestamp for scheduled sends'),
            txt('SentAt', 'ISO timestamp actually sent'),
            num('SentCount', 0, 'Recipients actually delivered to'),
            num('RecipientCount', 0, 'Recipients resolved at send time'),
            txt('Month', 'YYYY-MM the send counts against (cap window)'),
            txt('CreatedAt', 'ISO timestamp'),
            long('Error', 'Failure detail, if any')
        ]
    },
    {
        name: 'PointsLedger',
        description: 'Tenant-scoped loyalty points. One ledger, with a seam left for a future directory-wide layer.',
        fields: [
            txt('EntryID', 'Internal ID (pts_...)'),
            txt('UserID', 'Users record ID'),
            txt('TenantID', 'Clients record ID — the scope of these points'),
            txt('RegionID', 'Seam for a future directory-wide points layer'),
            num('Delta', 0, 'Positive = earned, negative = spent'),
            txt('Reason', 'Human-readable reason'),
            sel('Source', ['order', 'visit', 'signup', 'referral', 'manual', 'redemption', 'event', 'booking'], ''),
            txt('RefID', 'Related order / booking / event record ID'),
            txt('Timestamp', 'ISO timestamp')
        ]
    },
    {
        name: 'TenantContent',
        description: 'Content edited ONCE and rendered on every surface the tenant owns.',
        fields: [
            txt('ContentID', 'Internal ID (cnt_...)'),
            txt('TenantID', 'Clients record ID'),
            sel('Kind', ['about', 'announcement', 'photo', 'menu_note', 'policy', 'faq', 'hero'], ''),
            txt('Title', ''),
            long('Body', ''),
            txt('ImageURL', 'Cloudinary URL'),
            num('SortOrder', 0, ''),
            sel('Status', ['draft', 'published', 'archived'], ''),
            txt('UpdatedAt', 'ISO timestamp'),
            txt('CreatedAt', 'ISO timestamp')
        ]
    },
    {
        name: 'TenantHours',
        description: 'Opening hours, edited once, rendered on space + website + directory card.',
        fields: [
            txt('HoursID', 'Internal ID (hrs_...)'),
            txt('TenantID', 'Clients record ID'),
            sel('Day', ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], ''),
            txt('OpenTime', 'HH:MM 24h'),
            txt('CloseTime', 'HH:MM 24h'),
            check('Closed', 'Closed all day'),
            txt('Note', 'e.g. "kitchen closes at 9"')
        ]
    },
    {
        name: 'Bookings',
        description: 'Slots / appointments / jobs, tenant-scoped.',
        fields: [
            txt('BookingID', 'Internal ID (bkg_...)'),
            txt('TenantID', 'Clients record ID'),
            txt('UserID', 'Users record ID — empty for guest bookings'),
            txt('CustomerName', ''),
            txt('CustomerEmail', ''),
            txt('CustomerPhone', ''),
            txt('Service', 'What was booked'),
            txt('StartsAt', 'ISO timestamp'),
            num('DurationMins', 0, ''),
            sel('Status', ['requested', 'confirmed', 'completed', 'canceled', 'no_show'], ''),
            long('Notes', ''),
            num('Price', 2, ''),
            txt('CreatedAt', 'ISO timestamp')
        ]
    },
    {
        name: 'Items',
        description: 'Tenant-scoped catalog — products, menu items, services.',
        fields: [
            txt('ItemID', 'Internal ID (itm_...)'),
            txt('TenantID', 'Clients record ID'),
            txt('Name', ''),
            long('Description', ''),
            num('Price', 2, ''),
            txt('Category', ''),
            txt('ImageURL', 'Cloudinary URL'),
            sel('Status', ['active', 'sold_out', 'coming_soon', 'archived'], ''),
            num('SortOrder', 0, ''),
            num('StockCount', 0, 'Drives restock alerts when it returns above zero'),
            txt('CreatedAt', 'ISO timestamp')
        ]
    },
    {
        name: 'Orders',
        description: 'Tenant-scoped orders placed through a GS surface.',
        fields: [
            txt('OrderID', 'Internal ID (ord_...)'),
            txt('TenantID', 'Clients record ID'),
            txt('UserID', 'Users record ID — empty for guest checkout'),
            txt('CustomerName', ''),
            txt('CustomerEmail', ''),
            long('Items', 'JSON line items'),
            num('Subtotal', 2, ''),
            num('Total', 2, ''),
            sel('Status', ['pending', 'paid', 'preparing', 'ready', 'fulfilled', 'canceled', 'refunded'], ''),
            sel('PaymentChannel', ['us', 'theirs', 'none'], 'Which channel took the money'),
            txt('TransactionID', 'Transactions record, when we were the channel'),
            txt('CreatedAt', 'ISO timestamp')
        ]
    },
    {
        name: 'Events',
        description: 'Tenant events with signups — a value module.',
        fields: [
            txt('EventID', 'Internal ID (evt_...)'),
            txt('TenantID', 'Clients record ID'),
            txt('Title', ''),
            long('Description', ''),
            txt('StartsAt', 'ISO timestamp'),
            txt('EndsAt', 'ISO timestamp'),
            txt('Location', ''),
            num('Capacity', 0, '0 = unlimited'),
            num('SignupCount', 0, 'Denormalised count'),
            num('Price', 2, '0 = free'),
            txt('ImageURL', ''),
            sel('Status', ['draft', 'published', 'full', 'canceled', 'past'], ''),
            txt('CreatedAt', 'ISO timestamp')
        ]
    },
    {
        name: 'EventSignups',
        description: 'One row per person signed up for an event.',
        fields: [
            txt('SignupID', 'Internal ID (sgn_...)'),
            txt('EventID', 'Events record ID'),
            txt('TenantID', 'Clients record ID'),
            txt('UserID', 'Users record ID'),
            txt('Name', ''),
            txt('Email', ''),
            num('Guests', 0, 'Additional guests beyond the signer'),
            sel('Status', ['going', 'waitlist', 'canceled', 'attended'], ''),
            txt('CreatedAt', 'ISO timestamp')
        ]
    },
    {
        name: 'Wishlists',
        description: 'Wishlist / gift registry — a value module.',
        fields: [
            txt('WishlistID', 'Internal ID (wsh_...)'),
            txt('TenantID', 'Clients record ID'),
            txt('UserID', 'Users record ID'),
            txt('Title', 'e.g. "Emma & Ryan\'s Registry"'),
            sel('Kind', ['wishlist', 'registry'], ''),
            txt('ShareCode', 'Public share token'),
            txt('EventDate', 'ISO date, for registries'),
            sel('Status', ['active', 'fulfilled', 'archived'], ''),
            txt('CreatedAt', 'ISO timestamp')
        ]
    },
    {
        name: 'WishlistItems',
        description: 'Items on a wishlist, with claim state so two people do not buy the same thing.',
        fields: [
            txt('WishlistItemID', 'Internal ID (wsi_...)'),
            txt('WishlistID', 'Wishlists record ID'),
            txt('TenantID', 'Clients record ID'),
            txt('ItemID', 'Items record ID, when it is a catalog item'),
            txt('Name', 'Free-text name when not a catalog item'),
            num('Quantity', 0, ''),
            num('ClaimedCount', 0, ''),
            txt('ClaimedBy', 'Comma list of user IDs who claimed'),
            sel('Status', ['open', 'partial', 'claimed', 'purchased'], ''),
            long('Note', ''),
            txt('CreatedAt', 'ISO timestamp')
        ]
    },
    {
        name: 'RestockSubscriptions',
        description: 'Notify me when this is back in stock.',
        fields: [
            txt('SubID', 'Internal ID (rst_...)'),
            txt('TenantID', 'Clients record ID'),
            txt('ItemID', 'Items record ID'),
            txt('UserID', 'Users record ID'),
            txt('Email', 'Denormalised for guest subscriptions'),
            sel('Status', ['waiting', 'notified', 'canceled'], ''),
            txt('NotifiedAt', 'ISO timestamp'),
            txt('CreatedAt', 'ISO timestamp')
        ]
    },
    {
        name: 'Invoices',
        description: 'Invoices a tenant issues to their own customers (payment_channel = us or theirs).',
        fields: [
            txt('InvoiceID', 'Internal ID (inv_...)'),
            txt('TenantID', 'Clients record ID'),
            txt('UserID', 'Users record ID, if the payer has an account'),
            txt('Number', 'Human invoice number'),
            txt('CustomerName', ''),
            txt('CustomerEmail', ''),
            long('LineItems', 'JSON line items'),
            num('Subtotal', 2, ''),
            num('Tax', 2, ''),
            num('Total', 2, ''),
            num('AmountPaid', 2, ''),
            sel('Status', ['draft', 'sent', 'partial', 'paid', 'void', 'overdue'], ''),
            sel('PaymentChannel', ['us', 'theirs', 'none'], ''),
            txt('DueDate', 'ISO date'),
            txt('PaidAt', 'ISO timestamp'),
            txt('StripePaymentId', ''),
            txt('CreatedAt', 'ISO timestamp')
        ]
    },
    {
        name: 'Subscriptions',
        description: 'Module-level billing. What each tenant actually pays for, one row per module.',
        fields: [
            txt('SubscriptionID', 'Internal ID (sub_...)'),
            txt('TenantID', 'Clients record ID'),
            sel('Module', [
                'tier_essentials', 'tier_growth', 'tier_concierge',
                'website_built', 'website_linked', 'app_surface',
                'directory_free', 'directory_paid',
                'value_modules', 'extra_dev_hours'
            ], 'Which add-on this row bills for'),
            txt('Label', 'Display label on the invoice'),
            num('MonthlyPrice', 2, ''),
            sel('BillingCycle', ['annual', 'm2m'], ''),
            sel('Status', ['active', 'past_due', 'canceled', 'pending'], ''),
            txt('StartedAt', 'ISO date'),
            txt('EndsAt', 'ISO date, when canceled'),
            txt('NextBillingDate', 'ISO date'),
            txt('StripeSubId', ''),
            txt('CreatedAt', 'ISO timestamp')
        ]
    }
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
    console.log(`\nGlobal Storefront — schema build${DRY ? ' (DRY RUN)' : ''}`);
    console.log(`Base: ${BASE_ID}\n`);

    const meta = await api(`${META}/tables`);
    const existing = new Map(meta.tables.map(t => [t.name, t]));
    console.log(`Found ${existing.size} existing tables.\n`);

    let tablesCreated = 0, fieldsCreated = 0, skipped = 0, errors = 0;

    // --- 1. New fields on the tenant table ---------------------------------
    const tenantTable = existing.get('Clients');
    if (!tenantTable) {
        console.error('FATAL: Clients table not found. Nothing was changed.');
        process.exit(1);
    }
    const tenantFieldNames = new Set(tenantTable.fields.map(f => f.name));
    console.log('Clients (tenant record)');
    for (const field of TENANT_FIELDS) {
        if (tenantFieldNames.has(field.name)) {
            console.log(`   = ${field.name} (exists)`);
            skipped++;
            continue;
        }
        if (DRY) {
            console.log(`   + ${field.name} [${field.type}]`);
            fieldsCreated++;
            continue;
        }
        try {
            await api(`${META}/tables/${tenantTable.id}/fields`, {
                method: 'POST',
                body: JSON.stringify(field)
            });
            console.log(`   + ${field.name} [${field.type}]`);
            fieldsCreated++;
            await sleep(250);
        } catch (e) {
            console.log(`   ! ${field.name} — ${e.message}`);
            errors++;
        }
    }

    // --- 2. New tables ------------------------------------------------------
    for (const def of TABLES) {
        const found = existing.get(def.name);
        if (found) {
            console.log(`\n${def.name} (exists — checking fields)`);
            const have = new Set(found.fields.map(f => f.name));
            for (const field of def.fields) {
                if (have.has(field.name)) { skipped++; continue; }
                if (DRY) { console.log(`   + ${field.name} [${field.type}]`); fieldsCreated++; continue; }
                try {
                    await api(`${META}/tables/${found.id}/fields`, {
                        method: 'POST',
                        body: JSON.stringify(field)
                    });
                    console.log(`   + ${field.name} [${field.type}]`);
                    fieldsCreated++;
                    await sleep(250);
                } catch (e) {
                    console.log(`   ! ${field.name} — ${e.message}`);
                    errors++;
                }
            }
            continue;
        }

        if (DRY) {
            console.log(`\n${def.name} — WOULD CREATE with ${def.fields.length} fields`);
            tablesCreated++;
            continue;
        }

        try {
            const created = await api(`${META}/tables`, {
                method: 'POST',
                body: JSON.stringify({
                    name: def.name,
                    description: def.description,
                    fields: def.fields
                })
            });
            console.log(`\n${def.name} — CREATED (${created.fields.length} fields)`);
            tablesCreated++;
            await sleep(400);
        } catch (e) {
            console.log(`\n${def.name} — FAILED: ${e.message}`);
            errors++;
        }
    }

    console.log(`\n${'-'.repeat(52)}`);
    console.log(`Tables created: ${tablesCreated}`);
    console.log(`Fields created: ${fieldsCreated}`);
    console.log(`Already present: ${skipped}`);
    console.log(`Errors: ${errors}`);
    console.log(`${'-'.repeat(52)}\n`);
    if (DRY) console.log('Dry run — nothing was changed.\n');
}

main().catch(e => {
    console.error('\nSchema build failed:', e.message);
    if (e.body) console.error(JSON.stringify(e.body, null, 2));
    process.exit(1);
});
