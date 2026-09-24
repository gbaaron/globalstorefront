/**
 * lib/tenants.js — Global Storefront tenant access + shared function plumbing.
 *
 * One place that knows:
 *   - which Airtable table holds what (so a later rename is a one-line change)
 *   - how to read a tenant and resolve its capabilities
 *   - how to verify a tenant token, an end-user token, or an admin token
 *   - the CORS / response helpers every function repeats
 *
 * NOTE ON TABLE NAMING: the live base calls the tenant table `Clients`. The
 * revamp calls the concept a Tenant. Rather than rename the table (which would
 * break ~20 functions at once), every reference routes through TABLES.TENANTS.
 * Renaming the Airtable table later is a single edit here.
 */

const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const caps = require('./capabilities');
const tiers = require('./tiers');

// ---------------------------------------------------------------------------
// Table registry
// ---------------------------------------------------------------------------

const TABLES = {
    // Existing
    TENANTS: 'Clients',            // the tenant / business / account record
    ADMINS: 'AdminUsers',
    PAGE_VIEWS: 'PageViews',
    CONVERSATIONS: 'Conversations',
    MESSAGES: 'Messages',
    DEVICE_TOKENS: 'DeviceTokens',
    BOT_KB: 'BotKnowledgeBase',
    BOT_CONVERSATIONS: 'BotConversations',
    TRANSACTIONS: 'Transactions',
    PAYOUTS: 'Payouts',
    REPORTS: 'Reports',
    SUGGESTIONS: 'Suggestions',
    EMAIL_CAMPAIGNS: 'EmailCampaigns',
    SOCIAL_POSTS: 'SocialPosts',
    STRATEGY_CALLS: 'StrategyCalls',
    DEV_HOURS: 'DevHours',

    // Revamp
    REGIONS: 'Regions',
    USERS: 'Users',                // directory end-users (NOT tenants)
    FOLLOWS: 'Follows',
    PUSH_BROADCASTS: 'PushBroadcasts',
    POINTS_LEDGER: 'PointsLedger',
    CONTENT: 'TenantContent',
    HOURS: 'TenantHours',
    BOOKINGS: 'Bookings',
    ITEMS: 'Items',
    ORDERS: 'Orders',
    EVENTS: 'Events',
    EVENT_SIGNUPS: 'EventSignups',
    WISHLISTS: 'Wishlists',
    WISHLIST_ITEMS: 'WishlistItems',
    RESTOCK_SUBS: 'RestockSubscriptions',
    INVOICES: 'Invoices',
    SUBSCRIPTIONS: 'Subscriptions'
};

const JWT_SECRET = () => process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function corsHeaders(methods) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': `${methods || 'GET, POST'}, OPTIONS`,
        'Content-Type': 'application/json'
    };
}

function json(statusCode, body, methods) {
    return { statusCode, headers: corsHeaders(methods), body: JSON.stringify(body) };
}

const ok = (body, methods) => json(200, body, methods);
const bad = (msg, methods) => json(400, { error: msg }, methods);
const unauthorized = (methods) => json(401, { error: 'Unauthorized' }, methods);
const forbidden = (msg, methods) => json(403, { error: msg || 'Forbidden' }, methods);
const notFound = (msg, methods) => json(404, { error: msg || 'Not found' }, methods);
const conflict = (msg, methods) => json(409, { error: msg }, methods);
const serverError = (err, methods) => {
    console.error('Function error:', err);
    return json(500, { error: 'Server error. Please try again.' }, methods);
};

/**
 * `locked` is the house convention for a capability the caller lacks on a READ.
 * The owner app hides the block instead of erroring. Mutations return 403.
 */
const locked = (message, extra) => ok(Object.assign({ data: [], locked: true, message }, extra || {}));

/** Standard preflight + method guard. Returns a response to short-circuit, or null to continue. */
function guardMethod(event, allowed) {
    const methods = Array.isArray(allowed) ? allowed : [allowed];
    const methodList = methods.join(', ');
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders(methodList), body: '' };
    }
    if (!methods.includes(event.httpMethod)) {
        return json(405, { error: 'Method not allowed' }, methodList);
    }
    return null;
}

function parseBody(event) {
    try {
        return JSON.parse(event.body || '{}');
    } catch (e) {
        return {};
    }
}

// ---------------------------------------------------------------------------
// Airtable helpers
// ---------------------------------------------------------------------------

function getBase(baseId) {
    return new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
        .base(baseId || process.env.AIRTABLE_BASE_ID);
}

/** Escape a value for safe interpolation into a filterByFormula string literal. */
function esc(value) {
    return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Page through every record matching a select() config. */
async function fetchAll(base, table, options) {
    const out = [];
    await base(table).select(Object.assign({ pageSize: 100 }, options || {})).eachPage((records, next) => {
        records.forEach(r => out.push(r));
        next();
    });
    return out;
}

/** Airtable allows 10 records per create/update call. Chunk and throttle (5 req/s per base). */
async function batchWrite(base, table, rows, mode) {
    const op = mode === 'update' ? 'update' : 'create';
    const results = [];
    for (let i = 0; i < rows.length; i += 10) {
        const chunk = rows.slice(i, i + 10);
        const written = await base(table)[op](chunk, { typecast: true });
        written.forEach(r => results.push(r));
        if (i + 10 < rows.length) await sleep(250);
    }
    return results;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Airtable long-text fields cap at 100k. Stay under it. */
const capText = (v) => String(v == null ? '' : v).substring(0, 99000);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function decodeToken(event) {
    const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    if (!authHeader.startsWith('Bearer ')) return null;
    try {
        return jwt.verify(authHeader.split(' ')[1], JWT_SECRET());
    } catch (e) {
        return null;
    }
}

/**
 * Verify a TENANT (business owner) token.
 * Returns a context object carrying the resolved capability array, so every
 * downstream gate is `can(ctx, 'feature')` with no extra fetch.
 */
function tenantContext(event) {
    const decoded = decodeToken(event);
    if (!decoded || decoded.role !== 'client') return null;
    return {
        tenantId: decoded.userId,
        userId: decoded.userId,          // legacy alias
        email: decoded.email,
        tier: tiers.normalizeTier(decoded.tier),
        billingCycle: tiers.normalizeCycle(decoded.billingCycle),
        baseId: decoded.baseId || '',
        regionId: decoded.regionId || null,
        subStatus: decoded.subStatus || 'active',
        // Tokens issued before the revamp carry no caps — fall back to the tier
        // preset so old sessions keep working until they expire.
        caps: Array.isArray(decoded.caps) && decoded.caps.length
            ? decoded.caps
            : caps.resolveCapabilities({ Tier: decoded.tier })
    };
}

/** Verify an END-USER (directory shopper) token. */
function userContext(event) {
    const decoded = decodeToken(event);
    if (!decoded || decoded.role !== 'user') return null;
    return {
        userId: decoded.userId,
        email: decoded.email,
        name: decoded.name || '',
        regionId: decoded.regionId || null
    };
}

/** Verify an ADMIN (Aaron) token. */
function adminContext(event) {
    const decoded = decodeToken(event);
    if (!decoded || decoded.role !== 'admin') return null;
    return { adminId: decoded.userId, email: decoded.email };
}

/** Header-password admin auth, kept for the legacy admin-api style callers. */
function headerAdminOk(event) {
    const h = event.headers || {};
    const pw = h['x-admin-password'] || h['X-Admin-Password'];
    const em = h['x-admin-email'] || h['X-Admin-Email'];
    if (!process.env.ADMIN_PASSWORD) return false;
    return pw === process.env.ADMIN_PASSWORD && em === (process.env.ADMIN_EMAIL || em);
}

// ---------------------------------------------------------------------------
// Tenant access
// ---------------------------------------------------------------------------

/** Load a tenant record and attach its resolved description + capabilities. */
async function getTenant(tenantId, base) {
    const b = base || getBase();
    let record;
    try {
        record = await b(TABLES.TENANTS).find(tenantId);
    } catch (e) {
        return null;
    }
    return hydrateTenant(record);
}

/** Load a tenant by email (the canonical identity key). */
async function getTenantByEmail(email, base) {
    const b = base || getBase();
    const records = await b(TABLES.TENANTS).select({
        filterByFormula: `LOWER({Email}) = '${esc(String(email).toLowerCase())}'`,
        maxRecords: 1
    }).firstPage();
    return records.length ? hydrateTenant(records[0]) : null;
}

/** Turn an Airtable tenant record into the shape the rest of the system uses. */
function hydrateTenant(record) {
    const described = caps.describeTenant(record);
    return {
        id: record.id,
        name: record.get('Name') || '',
        company: record.get('Company') || '',
        email: record.get('Email') || '',
        username: record.get('Username') || '',
        projectUrl: record.get('ProjectURL') || '',
        baseId: record.get('BaseID') || '',
        siteType: record.get('SiteType') || '',
        slug: record.get('Slug') || slugify(record.get('Company') || record.get('Name') || record.id),
        botPersona: record.get('BotPersona') || '',
        botVoice: record.get('BotVoice') || '',
        pushEnabled: caps.toBool(record.get('PushEnabled')),
        subStatus: record.get('SubStatus') || 'active',
        billingCycle: tiers.normalizeCycle(record.get('BillingCycle')),
        nextBillingDate: record.get('NextBillingDate') || '',
        logoUrl: record.get('LogoURL') || '',
        brandColor: record.get('BrandColor') || '',
        tagline: record.get('Tagline') || '',
        address: record.get('Address') || '',
        phone: record.get('Phone') || '',
        websiteUrl: record.get('WebsiteURL') || record.get('ProjectURL') || '',
        // the reframe
        tier: described.tier,
        regionId: described.regionId,
        surfaces: described.surfaces,
        directoryStatus: described.directoryStatus,
        paymentChannel: described.paymentChannel,
        monetizationMode: described.monetizationMode,
        posSystem: described.posSystem,
        caps: described.capabilities,
        record
    };
}

function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60);
}

/**
 * Ownership check for a tenant-scoped row. Every tenant-owned table carries a
 * tenant id in either ClientID (legacy tables) or TenantID (revamp tables).
 */
function ownsRow(record, tenantId) {
    const owner = record.get('TenantID') || record.get('ClientID') || record.get('ClientId') || '';
    return String(owner) === String(tenantId);
}

/** Formula fragment scoping a query to one tenant, tolerating both field names. */
function tenantScope(tenantId, fieldName) {
    return `{${fieldName || 'TenantID'}} = '${esc(tenantId)}'`;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

const nowISO = () => new Date().toISOString();
const todayISO = () => new Date().toISOString().split('T')[0];
const monthKey = (d) => (d ? new Date(d) : new Date()).toISOString().substring(0, 7); // YYYY-MM

function quarterKey(d) {
    const dt = d ? new Date(d) : new Date();
    return `${dt.getUTCFullYear()}-Q${Math.floor(dt.getUTCMonth() / 3) + 1}`;
}

/** Short prefixed id, matching the existing txn_/rpt_/sug_ convention. */
function makeId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
    TABLES,
    // http
    corsHeaders, json, ok, bad, unauthorized, forbidden, notFound, conflict,
    serverError, locked, guardMethod, parseBody,
    // airtable
    getBase, esc, fetchAll, batchWrite, sleep, capText,
    // auth
    decodeToken, tenantContext, userContext, adminContext, headerAdminOk, JWT_SECRET,
    // tenants
    getTenant, getTenantByEmail, hydrateTenant, ownsRow, tenantScope, slugify,
    // misc
    nowISO, todayISO, monthKey, quarterKey, makeId
};
