/**
 * lib/tiers.js — Global Storefront shared tier / pricing / gating module.
 *
 * Single source of truth for:
 *   - Tier pricing (annual vs month-to-month)
 *   - Feature inclusion per tier (tierIncludes)
 *   - The 10/90 GS-cut / client-net transaction split
 *   - Subscription change math (upgrade proration, downgrade refund at m2m rate)
 *
 * Reused by Netlify functions (server) AND surfaced to the front-end for gating.
 * Pure JS, no dependencies — safe to require() in functions or inline in the browser.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// GS takes 10% of every client-site transaction immediately; 90% swept to client.
const GS_CUT_RATE = 0.10;

const TIER_ORDER = ['Essentials', 'Growth', 'Concierge'];

const BILLING_CYCLES = ['annual', 'm2m'];

/**
 * Tier definitions.
 *   priceAnnual  = effective monthly price when billed annually
 *   priceM2M     = monthly price on month-to-month
 *   features     = flat list of feature keys this tier includes (cumulative is
 *                  expressed explicitly so the lists are self-contained)
 */
const TIERS = {
    Essentials: {
        key: 'Essentials',
        label: 'Essentials',
        priceAnnual: 50,
        priceM2M: 65,
        blurb: 'Everything a small business needs to get online and start earning loyalty.',
        features: [
            'rewards',
            'recurring_orders',
            'reviews',
            'cosmetic_skin',
            'basic_analytics'
        ]
    },
    Growth: {
        key: 'Growth',
        label: 'Growth',
        priceAnnual: 100,
        priceM2M: 130,
        blurb: 'Adds intelligence: monthly reports, email marketing, AI chatbot, and Smart Suggestions.',
        features: [
            // inherits Essentials
            'rewards',
            'recurring_orders',
            'reviews',
            'cosmetic_skin',
            'basic_analytics',
            // Growth additions
            'advanced_analytics',
            'monthly_reports',
            'email_marketing',
            'ai_chatbot',
            'smart_suggestions'
        ]
    },
    Concierge: {
        key: 'Concierge',
        label: 'Concierge',
        priceAnnual: 175,
        priceM2M: 225,
        blurb: 'White-glove: social posts, quarterly strategy calls, and a free dev hour every month.',
        features: [
            // inherits Growth
            'rewards',
            'recurring_orders',
            'reviews',
            'cosmetic_skin',
            'basic_analytics',
            'advanced_analytics',
            'monthly_reports',
            'email_marketing',
            'ai_chatbot',
            'smart_suggestions',
            // Concierge additions
            'social_posts',
            'strategy_calls',
            'dev_hours'
        ]
    }
};

// Human-readable feature catalog (for tier-comparison UIs / upgrade prompts).
const FEATURE_LABELS = {
    rewards: 'Loyalty rewards program',
    recurring_orders: 'Recurring / repeat orders',
    reviews: 'Product & service reviews',
    cosmetic_skin: 'Custom storefront theme',
    basic_analytics: 'Basic analytics',
    advanced_analytics: 'Advanced analytics',
    monthly_reports: 'Monthly PDF reports',
    email_marketing: 'Email marketing management',
    ai_chatbot: 'AI customer chatbot',
    smart_suggestions: 'Smart Suggestions engine',
    social_posts: 'Social post suggestions',
    strategy_calls: 'Quarterly strategy calls',
    dev_hours: '1 free dev hour / month'
};

const DEV_HOUR_OVERAGE_RATE = 50; // $/hr beyond the included Concierge hour

// ---------------------------------------------------------------------------
// Tier / feature helpers
// ---------------------------------------------------------------------------

function normalizeTier(tier) {
    if (!tier) return 'Essentials';
    const match = TIER_ORDER.find(t => t.toLowerCase() === String(tier).toLowerCase());
    return match || 'Essentials';
}

function normalizeCycle(cycle) {
    if (!cycle) return 'annual';
    const c = String(cycle).toLowerCase();
    return BILLING_CYCLES.includes(c) ? c : 'annual';
}

/** Does the given tier include the given feature? */
function tierIncludes(tier, feature) {
    const def = TIERS[normalizeTier(tier)];
    return !!def && def.features.includes(feature);
}

/** Numeric rank of a tier (0 = Essentials … 2 = Concierge). */
function tierRank(tier) {
    return TIER_ORDER.indexOf(normalizeTier(tier));
}

/** Monthly price for a tier on a given billing cycle. */
function monthlyPrice(tier, cycle) {
    const def = TIERS[normalizeTier(tier)];
    return normalizeCycle(cycle) === 'annual' ? def.priceAnnual : def.priceM2M;
}

// ---------------------------------------------------------------------------
// Transaction split (10 / 90)
// ---------------------------------------------------------------------------

/** Round to cents. */
function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Split a client-site sale into GS's cut and the client's net.
 * @param {number} amount gross sale amount
 * @returns {{ amount:number, gsCut:number, clientNet:number }}
 */
function splitTransaction(amount) {
    const gross = round2(amount);
    const gsCut = round2(gross * GS_CUT_RATE);
    const clientNet = round2(gross - gsCut);
    return { amount: gross, gsCut, clientNet };
}

// ---------------------------------------------------------------------------
// Subscription change math
// ---------------------------------------------------------------------------

/**
 * Compute the financial effect of changing a client's subscription.
 *
 * Rules:
 *   - Upgrades are PRORATED: client is charged the price difference for the
 *     unused portion of the current billing period.
 *   - Downgrades are REFUNDED at the MONTH-TO-MONTH rate of the *new* (lower)
 *     tier — never the annual rate — to prevent gaming (subscribe annual,
 *     downgrade immediately for a big refund).
 *   - Lateral cycle changes (same tier) prorate the difference.
 *
 * @param {object} opts
 * @param {string} opts.fromTier
 * @param {string} opts.toTier
 * @param {string} opts.fromCycle  'annual' | 'm2m'
 * @param {string} opts.toCycle    'annual' | 'm2m'
 * @param {number} opts.daysRemaining days left in the current billing period
 * @param {number} [opts.periodDays=30] length of the current billing period
 * @returns {{ direction:string, prorationCharge:number, refund:number, newMonthly:number, note:string }}
 */
function computeSubscriptionChange(opts) {
    const fromTier = normalizeTier(opts.fromTier);
    const toTier = normalizeTier(opts.toTier);
    const fromCycle = normalizeCycle(opts.fromCycle);
    const toCycle = normalizeCycle(opts.toCycle);
    const periodDays = opts.periodDays > 0 ? opts.periodDays : 30;
    const daysRemaining = Math.max(0, Math.min(opts.daysRemaining || 0, periodDays));
    const fraction = daysRemaining / periodDays; // unused portion of period

    const fromRank = tierRank(fromTier);
    const toRank = tierRank(toTier);
    const newMonthly = monthlyPrice(toTier, toCycle);

    let direction = 'lateral';
    let prorationCharge = 0;
    let refund = 0;
    let note = '';

    if (toRank > fromRank) {
        // UPGRADE — prorate the price difference for the unused portion.
        direction = 'upgrade';
        const fromMonthly = monthlyPrice(fromTier, fromCycle);
        const toMonthly = monthlyPrice(toTier, fromCycle); // compare at same cycle
        const diff = Math.max(0, toMonthly - fromMonthly);
        prorationCharge = round2(diff * fraction);
        note = `Prorated upgrade: $${prorationCharge} for ${daysRemaining} remaining day(s).`;
    } else if (toRank < fromRank) {
        // DOWNGRADE — refund unused portion at the NEW tier's M2M rate (anti-gaming).
        direction = 'downgrade';
        const refundRate = monthlyPrice(toTier, 'm2m');
        const currentRate = monthlyPrice(fromTier, fromCycle);
        const refundable = Math.max(0, currentRate - refundRate);
        refund = round2(refundable * fraction);
        note = `Downgrade refund at month-to-month rate: $${refund} for ${daysRemaining} remaining day(s).`;
    } else {
        // Same tier — possibly a cycle change. Prorate the difference if any.
        const fromMonthly = monthlyPrice(fromTier, fromCycle);
        const toMonthly = monthlyPrice(toTier, toCycle);
        const diff = toMonthly - fromMonthly;
        if (diff > 0) {
            prorationCharge = round2(diff * fraction);
            note = `Cycle change: $${prorationCharge} prorated difference.`;
        } else if (diff < 0) {
            refund = round2(-diff * fraction);
            note = `Cycle change: $${refund} prorated refund.`;
        } else {
            note = 'No change.';
        }
    }

    return { direction, prorationCharge, refund, newMonthly, note };
}

// ---------------------------------------------------------------------------
// Exports (CommonJS for functions; also attach to window in the browser)
// ---------------------------------------------------------------------------

const api = {
    GS_CUT_RATE,
    TIER_ORDER,
    BILLING_CYCLES,
    TIERS,
    FEATURE_LABELS,
    DEV_HOUR_OVERAGE_RATE,
    normalizeTier,
    normalizeCycle,
    tierIncludes,
    tierRank,
    monthlyPrice,
    round2,
    splitTransaction,
    computeSubscriptionChange
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof window !== 'undefined') {
    window.GSTiers = api;
}
