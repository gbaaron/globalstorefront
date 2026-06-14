const Airtable = require('airtable');
const { tierIncludes, normalizeTier, round2 } = require('./lib/tiers');

// Scheduled (weekly) — see netlify.toml [functions."generate-suggestions"] schedule.
// For each Growth+ client (tier includes 'smart_suggestions'), analyze the last
// 7 days of traffic (GS PageViews) + orders/revenue (the tenant's own base) vs the
// prior 7 days, and emit rule-based Smart Suggestions rows. If OPENAI_API_KEY is
// present, each suggestion's body is polished into owner-friendly copy; otherwise
// the deterministic template text is used.
//
// Idempotent within a run: a client won't get a second copy of a suggestion whose
// Title is already sitting in 'new' status for them.
//
// Also manually invokable (GET/POST) for testing; returns a JSON summary.

function isoDaysAgo(days, base = new Date()) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - days);
    return d.toISOString();
}

// Pull a numeric order total from whatever field the tenant happens to use.
function orderTotal(order) {
    const t = parseFloat(order.get('Total') || order.get('TotalAmount') || 0);
    return isNaN(t) ? 0 : t;
}

// Compute the analysis window metrics for one client.
async function computeMetrics(base, client) {
    const clientId = client.id;
    const tenantBaseId = client.get('BaseID');

    const now = new Date();
    const weekAgo = isoDaysAgo(7, now);
    const twoWeeksAgo = isoDaysAgo(14, now);

    const m = {
        viewsThisWeek: 0,
        viewsPrevWeek: 0,
        ordersThisWeek: 0,
        ordersPrevWeek: 0,
        revenueThisWeek: 0,
        revenuePrevWeek: 0,
        avgOrderThisWeek: 0,
        pendingOrders: 0,
        totalOrders: 0,
        hasBase: !!tenantBaseId
    };

    // Page views (GS base)
    try {
        const pv = await base('PageViews').select({
            filterByFormula: `AND({ClientId} = '${clientId}', IS_AFTER({Timestamp}, '${twoWeeksAgo}'))`,
            maxRecords: 2000
        }).all();
        for (const v of pv) {
            const ts = v.get('Timestamp') || '';
            if (ts >= weekAgo) m.viewsThisWeek++;
            else if (ts >= twoWeeksAgo) m.viewsPrevWeek++;
        }
    } catch (e) {}

    // Orders / revenue (tenant base)
    if (tenantBaseId) {
        try {
            const tenantBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(tenantBaseId);
            const orders = await tenantBase('Orders').select({ maxRecords: 1000 }).all();
            m.totalOrders = orders.length;
            for (const o of orders) {
                const dateRaw = o.get('OrderDate') || '';
                const iso = dateRaw ? new Date(dateRaw).toISOString() : '';
                const total = orderTotal(o);
                if ((o.get('Status') || '').toLowerCase() === 'pending') m.pendingOrders++;
                if (iso && iso >= weekAgo) {
                    m.ordersThisWeek++;
                    m.revenueThisWeek += total;
                } else if (iso && iso >= twoWeeksAgo) {
                    m.ordersPrevWeek++;
                    m.revenuePrevWeek += total;
                }
            }
        } catch (e) {}
    }

    m.revenueThisWeek = round2(m.revenueThisWeek);
    m.revenuePrevWeek = round2(m.revenuePrevWeek);
    m.avgOrderThisWeek = m.ordersThisWeek > 0 ? round2(m.revenueThisWeek / m.ordersThisWeek) : 0;
    return m;
}

// Percent change helper that tolerates a zero baseline.
function pctChange(now, prev) {
    if (prev <= 0) return now > 0 ? 100 : 0;
    return Math.round(((now - prev) / prev) * 100);
}

// Deterministic rule engine → array of { title, body, category, baseline }.
function buildSuggestions(m) {
    const out = [];

    // Traffic trend
    const viewDelta = pctChange(m.viewsThisWeek, m.viewsPrevWeek);
    if (m.viewsThisWeek === 0 && m.viewsPrevWeek === 0) {
        out.push({
            title: 'Drive your first wave of traffic',
            category: 'traffic',
            body: 'No site visits were recorded this week. Share your storefront link on your social channels and in your email signature to start building a baseline of traffic.',
            baseline: { viewsThisWeek: m.viewsThisWeek }
        });
    } else if (viewDelta <= -25) {
        out.push({
            title: `Traffic dropped ${Math.abs(viewDelta)}% this week`,
            category: 'traffic',
            body: `Visits fell from ${m.viewsPrevWeek} to ${m.viewsThisWeek} week-over-week. Consider a fresh social post or a limited-time promo to re-engage customers and recover traffic.`,
            baseline: { viewsThisWeek: m.viewsThisWeek, viewsPrevWeek: m.viewsPrevWeek }
        });
    } else if (viewDelta >= 25) {
        out.push({
            title: `Traffic is up ${viewDelta}% — capitalize on it`,
            category: 'traffic',
            body: `Visits climbed from ${m.viewsPrevWeek} to ${m.viewsThisWeek}. Now is a great time to feature a best-seller or launch a loyalty push while interest is high.`,
            baseline: { viewsThisWeek: m.viewsThisWeek, viewsPrevWeek: m.viewsPrevWeek }
        });
    }

    // Conversion: traffic but no orders
    if (m.viewsThisWeek >= 20 && m.ordersThisWeek === 0 && m.hasBase) {
        out.push({
            title: 'Visitors aren\'t converting to orders',
            category: 'orders',
            body: `You had ${m.viewsThisWeek} visits but no orders this week. Review your menu/product pricing and make sure your checkout flow is obvious — a first-order discount often unblocks this.`,
            baseline: { viewsThisWeek: m.viewsThisWeek, ordersThisWeek: m.ordersThisWeek }
        });
    }

    // Revenue trend
    const revDelta = pctChange(m.revenueThisWeek, m.revenuePrevWeek);
    if (m.revenuePrevWeek > 0 && revDelta <= -20) {
        out.push({
            title: `Revenue down ${Math.abs(revDelta)}% week-over-week`,
            category: 'revenue',
            body: `Revenue slipped from $${m.revenuePrevWeek} to $${m.revenueThisWeek}. A bundle deal or a "we miss you" email to past customers can help recover the gap.`,
            baseline: { revenueThisWeek: m.revenueThisWeek, revenuePrevWeek: m.revenuePrevWeek }
        });
    } else if (m.revenueThisWeek > 0 && revDelta >= 20) {
        out.push({
            title: `Revenue grew ${revDelta}% — keep the momentum`,
            category: 'revenue',
            body: `Revenue rose from $${m.revenuePrevWeek} to $${m.revenueThisWeek}. Thank your repeat customers and consider raising your average order value with an add-on suggestion at checkout.`,
            baseline: { revenueThisWeek: m.revenueThisWeek, revenuePrevWeek: m.revenuePrevWeek }
        });
    }

    // Operational: pending orders piling up
    if (m.pendingOrders >= 5) {
        out.push({
            title: `${m.pendingOrders} orders are still pending`,
            category: 'orders',
            body: `You have ${m.pendingOrders} pending orders. Clearing them promptly improves customer satisfaction and unlocks repeat business — set aside time to work through the queue.`,
            baseline: { pendingOrders: m.pendingOrders }
        });
    }

    // Retention nudge for healthy stores
    if (m.ordersThisWeek >= 5 && m.avgOrderThisWeek > 0) {
        out.push({
            title: 'Launch a loyalty reward to retain buyers',
            category: 'retention',
            body: `With ${m.ordersThisWeek} orders this week at an average of $${m.avgOrderThisWeek}, a points-based reward (e.g. a free item after 10 orders) can turn one-time buyers into regulars.`,
            baseline: { ordersThisWeek: m.ordersThisWeek, avgOrderThisWeek: m.avgOrderThisWeek }
        });
    }

    // Always-on engagement suggestion if nothing else fired
    if (!out.length) {
        out.push({
            title: 'Keep your storefront fresh',
            category: 'engagement',
            body: 'Things are steady. Post a behind-the-scenes update or a customer testimonial this week to keep your storefront feeling active and trustworthy.',
            baseline: {}
        });
    }

    return out;
}

// Optional OpenAI polish — rewrites bodies into warmer owner-facing copy.
async function polishSuggestions(company, suggestions) {
    if (!process.env.OPENAI_API_KEY) return suggestions;
    try {
        const { OpenAI } = require('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const list = suggestions.map((s, i) => `${i + 1}. ${s.title} :: ${s.body}`).join('\n');
        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: 'You are a concise small-business growth advisor. Rewrite each suggestion body to be warm, specific, and under 45 words. Keep the same meaning and numbers. Return ONLY a JSON array of strings, one rewritten body per suggestion, in order.' },
                { role: 'user', content: `Business: ${company || 'a small business'}\n\nSuggestions:\n${list}` }
            ],
            temperature: 0.6,
            max_tokens: 500
        });
        let raw = completion.choices[0].message.content || '';
        raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const bodies = JSON.parse(raw);
        if (Array.isArray(bodies)) {
            suggestions.forEach((s, i) => { if (bodies[i]) s.body = String(bodies[i]); });
        }
    } catch (e) {
        // Fall back to template copy on any parse/API error.
    }
    return suggestions;
}

async function runGenerate() {
    const apiKey = process.env.AIRTABLE_API_KEY;
    const base = new Airtable({ apiKey }).base(process.env.AIRTABLE_BASE_ID);

    const clients = await base('Clients').select({ maxRecords: 500 }).all();

    let generated = 0;
    let skipped = 0;
    const rows = [];

    for (const client of clients) {
        const tier = normalizeTier(client.get('Tier'));
        if (!tierIncludes(tier, 'smart_suggestions')) { skipped++; continue; }

        const company = client.get('Company') || client.get('Name') || '';

        // Existing open suggestions for this client (dedupe by Title).
        let openTitles = new Set();
        try {
            const existing = await base('Suggestions').select({
                filterByFormula: `AND({ClientID} = '${client.id}', {Status} = 'new')`,
                maxRecords: 100
            }).all();
            openTitles = new Set(existing.map(r => r.get('Title')));
        } catch (e) {
            return { error: 'Suggestions table not found', generated: 0 };
        }

        const metrics = await computeMetrics(base, client);
        let suggestions = buildSuggestions(metrics);
        suggestions = suggestions.filter(s => !openTitles.has(s.title));
        if (!suggestions.length) { skipped++; continue; }

        suggestions = await polishSuggestions(company, suggestions);

        const nowIso = new Date().toISOString();
        for (const s of suggestions) {
            rows.push({
                fields: {
                    SuggestionID: 'sug_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    ClientID: client.id,
                    Title: s.title,
                    Body: s.body,
                    Category: s.category,
                    Status: 'new',
                    BaselineMetric: JSON.stringify(s.baseline || {}),
                    ResultMetric: '',
                    CreatedAt: nowIso,
                    ReviewedAt: ''
                }
            });
            generated++;
        }
    }

    // Write in chunks of 10 (Airtable cap), throttled.
    for (let i = 0; i < rows.length; i += 10) {
        await base('Suggestions').create(rows.slice(i, i + 10));
        await new Promise(r => setTimeout(r, 250));
    }

    return { generated, skipped, total: clients.length };
}

exports.handler = async () => {
    try {
        const result = await runGenerate();
        console.log('Suggestion generation complete:', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ success: true, ...result }) };
    } catch (error) {
        console.error('Generate suggestions error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Suggestion generation failed' }) };
    }
};
