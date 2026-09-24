/**
 * lib/capabilities.js — Global Storefront capability resolution.
 *
 * THE REFRAME LIVES HERE.
 *
 * Global Storefront is not a tier ladder. A tenant's abilities are the union of
 * TWO INDEPENDENT AXES plus an explicit override layer:
 *
 *   Axis 1 — SURFACES  : what the tenant owns   (space / website / app)
 *   Axis 2 — DISTRIBUTION: where the tenant is listed (none / free / paid directory)
 *   Overrides          : per-tenant grants+revokes Aaron sets by hand
 *
 * `Tier` (Essentials / Growth / Concierge) survives as a PRESET — a named bundle
 * that seeds module capabilities at signup and drives billing. It is NOT a gate.
 * Any combination of axes is valid: "Essentials + paid directory space" and
 * "Concierge, no directory" are both coherent tenants.
 *
 * ---------------------------------------------------------------------------
 * ZERO-DOWNTIME CONTRACT
 * ---------------------------------------------------------------------------
 * resolveCapabilities() falls back to the tier preset whenever the axis fields
 * are absent. Every Clients row that exists today therefore resolves to exactly
 * the capability set it had under tierIncludes(), BEFORE the migration script
 * ever runs. Nothing breaks at any point during the rollout.
 *
 * Pure JS, no dependencies — require() in functions, or <script> in the browser.
 */

const { TIERS, TIER_ORDER, normalizeTier, FEATURE_LABELS } = require('./tiers');

// ---------------------------------------------------------------------------
// Axis 1 — Surfaces (what the tenant owns)
// ---------------------------------------------------------------------------

const WEBSITE_MODES = ['none', 'built', 'linked'];

/**
 * Capabilities granted by owning a surface.
 * `space` is unconditional — every tenant has a Global Storefront space, which
 * is the whole point of "build the tenant space once, wrap it many ways".
 */
const SURFACE_CAPABILITIES = {
    space: ['space', 'content_hours', 'basic_analytics'],
    website_built: ['website', 'custom_domain', 'website_analytics'],
    website_linked: ['website_link_out'],
    app: ['app_surface', 'push_app', 'app_analytics', 'own_icon']
};

// ---------------------------------------------------------------------------
// Axis 2 — Distribution (where the tenant is listed)
// ---------------------------------------------------------------------------

const DIRECTORY_STATUSES = ['none', 'free', 'paid'];

/**
 * The free listing is the HOOK, not a crippled trial. It is deliberately
 * useful: real presence, real followers, real (capped) reach.
 */
const DIRECTORY_CAPABILITIES = {
    none: [],
    free: [
        'directory_listing',     // name, hours, photos, map
        'directory_link_out',    // link to their own site
        'followable',            // users can follow them
        'push_followers',        // capped — see PUSH_FREE_MONTHLY_CAP
        'directory_analytics'
    ],
    paid: [
        'directory_listing',
        'directory_link_out',
        'followable',
        'push_followers',
        'directory_analytics',
        // paid additions
        'directory_branded',     // branded space + optional own icon
        'push_unlimited',
        'push_segmentation',
        'push_scheduling',
        'bookings',
        'loyalty',
        'pay_in_app',
        'value_modules',         // registry / restock / events
        'data_export',
        'advanced_analytics'
    ]
};

/** Free directory listings get 2 push broadcasts per calendar month. Enforced server-side. */
const PUSH_FREE_MONTHLY_CAP = 2;

// ---------------------------------------------------------------------------
// Payment channel — a tenant FLAG, never an assumption
// ---------------------------------------------------------------------------

const PAYMENT_CHANNELS = ['us', 'theirs', 'none'];
const MONETIZATION_MODES = ['percent_of_sale', 'flat_monthly', 'free'];

/**
 * Only `payment_channel = us` grants the in-app payment capabilities. When the
 * tenant already takes payment on their own site we sell reach/booking/loyalty
 * instead and never touch their money.
 */
const PAYMENT_CAPABILITIES = {
    us: ['invoicing', 'pay_in_app', 'transaction_split'],
    theirs: ['invoicing'],
    none: []
};

// ---------------------------------------------------------------------------
// Capability catalog (human-readable, for admin toggles + upgrade prompts)
// ---------------------------------------------------------------------------

const CAPABILITY_LABELS = Object.assign({}, FEATURE_LABELS, {
    space: 'Global Storefront space',
    content_hours: 'Content & hours management',
    website: 'Website (built by us)',
    custom_domain: 'Custom domain pointed at their space',
    website_link_out: 'Link out to their own website',
    website_analytics: 'Website analytics',
    app_surface: 'Standalone app (own icon)',
    own_icon: 'Own app icon',
    push_app: 'Push to their own app',
    app_analytics: 'App analytics',
    directory_listing: 'Directory listing',
    directory_link_out: 'Directory link-out',
    directory_branded: 'Branded directory space',
    directory_analytics: 'Directory analytics',
    followable: 'Followable by directory users',
    push_followers: 'Push to directory followers',
    push_unlimited: 'Unlimited push broadcasts',
    push_segmentation: 'Push audience segmentation',
    push_scheduling: 'Scheduled push',
    bookings: 'Bookings & appointments',
    loyalty: 'Loyalty points',
    invoicing: 'Invoices',
    pay_in_app: 'Pay in app',
    transaction_split: '10/90 transaction split',
    value_modules: 'Registry, restock alerts, events',
    data_export: 'Data export'
});

/** Grouped for the super-admin toggle grid. */
const CAPABILITY_GROUPS = [
    { key: 'surfaces', label: 'Surfaces', caps: ['space', 'website', 'custom_domain', 'website_link_out', 'app_surface', 'own_icon'] },
    { key: 'directory', label: 'Directory', caps: ['directory_listing', 'directory_branded', 'followable', 'directory_link_out'] },
    { key: 'reach', label: 'Reach', caps: ['push_app', 'push_followers', 'push_unlimited', 'push_segmentation', 'push_scheduling', 'email_marketing', 'social_posts'] },
    { key: 'commerce', label: 'Commerce', caps: ['bookings', 'loyalty', 'invoicing', 'pay_in_app', 'transaction_split', 'recurring_orders'] },
    { key: 'modules', label: 'Value modules', caps: ['value_modules', 'rewards', 'reviews', 'cosmetic_skin'] },
    { key: 'intelligence', label: 'Intelligence', caps: ['basic_analytics', 'advanced_analytics', 'monthly_reports', 'smart_suggestions', 'ai_chatbot', 'data_export'] },
    { key: 'service', label: 'Service', caps: ['strategy_calls', 'dev_hours'] }
];

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeWebsiteMode(mode) {
    const m = String(mode || 'none').toLowerCase();
    return WEBSITE_MODES.includes(m) ? m : 'none';
}

function normalizeDirectoryStatus(status) {
    const s = String(status || 'none').toLowerCase();
    return DIRECTORY_STATUSES.includes(s) ? s : 'none';
}

function normalizePaymentChannel(channel) {
    const c = String(channel || 'none').toLowerCase();
    return PAYMENT_CHANNELS.includes(c) ? c : 'none';
}

function normalizeMonetizationMode(mode) {
    const m = String(mode || 'free').toLowerCase();
    return MONETIZATION_MODES.includes(m) ? m : 'free';
}

/**
 * Parse the Capabilities override field.
 * Accepts a JSON array, or a comma/newline separated string. Entries prefixed
 * with '-' are REVOKES; everything else is a GRANT. Revokes always win, so Aaron
 * can hand-strip a capability a preset would otherwise hand out.
 */
function parseOverrides(raw) {
    const grants = [];
    const revokes = [];
    if (!raw) return { grants, revokes };

    let list = [];
    if (Array.isArray(raw)) {
        list = raw;
    } else {
        const str = String(raw).trim();
        if (!str) return { grants, revokes };
        if (str.startsWith('[')) {
            try {
                const parsed = JSON.parse(str);
                if (Array.isArray(parsed)) list = parsed;
            } catch (e) {
                list = str.replace(/[[\]"]/g, '').split(/[,\n]/);
            }
        } else {
            list = str.split(/[,\n]/);
        }
    }

    for (const entry of list) {
        const item = String(entry || '').trim();
        if (!item) continue;
        if (item.startsWith('-') || item.startsWith('!')) {
            revokes.push(item.slice(1).trim());
        } else {
            grants.push(item.replace(/^\+/, '').trim());
        }
    }
    return { grants, revokes };
}

// ---------------------------------------------------------------------------
// Resolution — the one function that decides what a tenant can do
// ---------------------------------------------------------------------------

/**
 * Read a field off either a raw Airtable record (has .get) or a plain object,
 * tolerating both PascalCase (the live base) and snake_case (the brief).
 */
function field(record, ...names) {
    if (!record) return undefined;
    const getter = typeof record.get === 'function' ? (n) => record.get(n) : (n) => record[n];
    for (const n of names) {
        const v = getter(n);
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
}

/**
 * Resolve a tenant record into a flat, deduped capability array.
 *
 * @param {object} record Airtable record or plain tenant object
 * @returns {string[]} sorted capability keys
 */
function resolveCapabilities(record) {
    const set = new Set();

    // --- Tier preset (module capabilities + the legacy fallback) -----------
    const tier = normalizeTier(field(record, 'Tier', 'tier'));
    const preset = TIERS[tier];
    if (preset) preset.features.forEach(f => set.add(f));

    // --- Axis 1: surfaces --------------------------------------------------
    // Every tenant has a space, unconditionally.
    SURFACE_CAPABILITIES.space.forEach(c => set.add(c));

    const websiteMode = normalizeWebsiteMode(field(record, 'WebsiteMode', 'website_mode'));
    const hasWebsite = toBool(field(record, 'HasWebsite', 'has_website')) || websiteMode !== 'none';
    if (hasWebsite) {
        if (websiteMode === 'linked') {
            SURFACE_CAPABILITIES.website_linked.forEach(c => set.add(c));
        } else {
            SURFACE_CAPABILITIES.website_built.forEach(c => set.add(c));
        }
    }

    if (toBool(field(record, 'HasApp', 'has_app'))) {
        SURFACE_CAPABILITIES.app.forEach(c => set.add(c));
    }

    // --- Axis 2: distribution ---------------------------------------------
    const directoryStatus = normalizeDirectoryStatus(field(record, 'DirectoryStatus', 'directory_status'));
    (DIRECTORY_CAPABILITIES[directoryStatus] || []).forEach(c => set.add(c));

    // --- Payment channel ---------------------------------------------------
    const paymentChannel = normalizePaymentChannel(field(record, 'PaymentChannel', 'payment_channel'));
    (PAYMENT_CAPABILITIES[paymentChannel] || []).forEach(c => set.add(c));

    // --- Explicit overrides (revokes win) ----------------------------------
    const { grants, revokes } = parseOverrides(field(record, 'Capabilities', 'capabilities'));
    grants.forEach(c => set.add(c));
    revokes.forEach(c => set.delete(c));

    return Array.from(set).sort();
}

function toBool(v) {
    if (v === true) return true;
    if (v === false || v === undefined || v === null) return false;
    const s = String(v).toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'checked';
}

/**
 * THE GATE. Replaces tierIncludes() at every callsite.
 *
 * Accepts whatever's convenient at the callsite:
 *   - a resolved caps array (from the JWT)          → can(caps, 'bookings')
 *   - a tenant record / plain object                → can(tenantRecord, 'bookings')
 *   - a bare tier string (legacy compatibility)     → can('Growth', 'monthly_reports')
 */
function can(subject, capability) {
    if (!capability) return false;
    if (Array.isArray(subject)) return subject.includes(capability);
    if (typeof subject === 'string') {
        // Legacy: a bare tier string. Resolve through the preset only.
        return resolveCapabilities({ Tier: subject }).includes(capability);
    }
    if (subject && typeof subject === 'object') {
        if (Array.isArray(subject.caps)) return subject.caps.includes(capability);
        return resolveCapabilities(subject).includes(capability);
    }
    return false;
}

/**
 * Capabilities for a decoded JWT. Tokens issued before the revamp carry no
 * `caps`, so they fall back to the tier preset and keep working until expiry.
 */
function capsFromToken(decoded) {
    if (decoded && Array.isArray(decoded.caps) && decoded.caps.length) return decoded.caps;
    return resolveCapabilities({ Tier: decoded && decoded.tier });
}

/** Every capability the subject is missing, from a required list. */
function missing(subject, required) {
    return (required || []).filter(c => !can(subject, c));
}

// ---------------------------------------------------------------------------
// Push quota — the free-listing cap, enforced server-side
// ---------------------------------------------------------------------------

/**
 * How many push broadcasts this tenant may send this calendar month.
 * @returns {{ unlimited:boolean, cap:number, reason:string }}
 */
function pushQuota(subject) {
    if (can(subject, 'push_unlimited')) {
        return { unlimited: true, cap: Infinity, reason: 'Paid directory space — unlimited push.' };
    }
    if (can(subject, 'push_followers')) {
        return {
            unlimited: false,
            cap: PUSH_FREE_MONTHLY_CAP,
            reason: `Free listing — ${PUSH_FREE_MONTHLY_CAP} broadcasts per month to followers.`
        };
    }
    if (can(subject, 'push_app')) {
        return { unlimited: true, cap: Infinity, reason: 'Own app — unlimited push to app installs.' };
    }
    return { unlimited: false, cap: 0, reason: 'No push capability on this account.' };
}

/**
 * Which surfaces may this tenant push TO? Drives the push composer's surface selector.
 * @returns {Array<{key:string,label:string,available:boolean,note:string}>}
 */
function pushSurfaces(subject) {
    const appOk = can(subject, 'push_app');
    const followersOk = can(subject, 'push_followers');
    const quota = pushQuota(subject);
    return [
        {
            key: 'app',
            label: 'My app',
            available: appOk,
            note: appOk ? 'Everyone with your app installed.' : 'Requires a standalone app.'
        },
        {
            key: 'followers',
            label: 'Directory followers',
            available: followersOk,
            note: followersOk
                ? (quota.unlimited ? 'Everyone following you.' : `Everyone following you — ${quota.cap}/month.`)
                : 'Requires a directory listing.'
        },
        {
            key: 'both',
            label: 'Both',
            available: appOk && followersOk,
            note: 'App installs and directory followers, deduped.'
        }
    ];
}

// ---------------------------------------------------------------------------
// Presets — what a tier hands a NEW tenant at signup
// ---------------------------------------------------------------------------

/**
 * Seed axis fields for a new tenant from a tier choice. Tiers are bundles; the
 * resulting record is then free to diverge on either axis.
 */
function presetForTier(tier) {
    const t = normalizeTier(tier);
    return {
        Tier: t,
        HasWebsite: true,
        WebsiteMode: 'built',
        HasApp: t === 'Concierge',
        DirectoryStatus: t === 'Essentials' ? 'free' : 'paid',
        PaymentChannel: 'none',
        MonetizationMode: t === 'Essentials' ? 'flat_monthly' : 'percent_of_sale'
    };
}

/** A tenant's axis snapshot — what the dashboard and admin grid render. */
function describeTenant(record) {
    const websiteMode = normalizeWebsiteMode(field(record, 'WebsiteMode', 'website_mode'));
    const hasWebsite = toBool(field(record, 'HasWebsite', 'has_website')) || websiteMode !== 'none';
    return {
        tier: normalizeTier(field(record, 'Tier', 'tier')),
        regionId: field(record, 'RegionID', 'region_id') || null,
        surfaces: {
            space: true,
            website: hasWebsite,
            websiteMode: hasWebsite ? (websiteMode === 'none' ? 'built' : websiteMode) : 'none',
            app: toBool(field(record, 'HasApp', 'has_app'))
        },
        directoryStatus: normalizeDirectoryStatus(field(record, 'DirectoryStatus', 'directory_status')),
        paymentChannel: normalizePaymentChannel(field(record, 'PaymentChannel', 'payment_channel')),
        monetizationMode: normalizeMonetizationMode(field(record, 'MonetizationMode', 'monetization_mode')),
        posSystem: field(record, 'POSSystem', 'pos_system') || null,
        capabilities: resolveCapabilities(record)
    };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const api = {
    // constants
    WEBSITE_MODES,
    DIRECTORY_STATUSES,
    PAYMENT_CHANNELS,
    MONETIZATION_MODES,
    PUSH_FREE_MONTHLY_CAP,
    SURFACE_CAPABILITIES,
    DIRECTORY_CAPABILITIES,
    PAYMENT_CAPABILITIES,
    CAPABILITY_LABELS,
    CAPABILITY_GROUPS,
    TIER_ORDER,
    // normalizers
    normalizeWebsiteMode,
    normalizeDirectoryStatus,
    normalizePaymentChannel,
    normalizeMonetizationMode,
    parseOverrides,
    toBool,
    // the gate
    resolveCapabilities,
    can,
    capsFromToken,
    missing,
    pushQuota,
    pushSurfaces,
    presetForTier,
    describeTenant
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof window !== 'undefined') {
    window.GSCapabilities = api;
}
