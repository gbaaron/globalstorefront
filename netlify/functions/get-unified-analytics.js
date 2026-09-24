const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * GET /api/get-unified-analytics — ONE number per thing, across every surface.
 *
 * The old get-tenant-admin analytics answered "how is your site doing". That
 * question no longer makes sense: a tenant may have a space, a website, an app
 * AND a directory listing, and they want to know how the BUSINESS is doing.
 *
 * So every metric here is summed across surfaces and then broken down by
 * surface, rather than being scoped to one. The breakdown is the interesting
 * part — "half your traffic came from Shop Holland" is the argument for paid
 * directory space, made with the tenant's own numbers.
 *
 * Basic stats for everyone; trend series and per-surface splits require
 * `advanced_analytics`.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET']);
    if (guard) return guard;

    const ctx = T.tenantContext(event);
    if (!ctx) return T.unauthorized('GET');

    try {
        const base = T.getBase();
        const params = event.queryStringParameters || {};
        const days = Math.min(90, Math.max(1, Number(params.days) || 30));
        const since = new Date(Date.now() - days * 86400000);

        const advanced = C.can(ctx.caps, 'advanced_analytics');

        const [views, orders, bookings, follows, broadcasts, points] = await Promise.all([
            T.fetchAll(base, T.TABLES.PAGE_VIEWS, {
                filterByFormula: `OR({ClientId} = '${T.esc(ctx.tenantId)}', {ClientID} = '${T.esc(ctx.tenantId)}')`
            }).catch(() => []),
            T.fetchAll(base, T.TABLES.ORDERS, {
                filterByFormula: `OR({TenantID} = '${T.esc(ctx.tenantId)}', {ClientID} = '${T.esc(ctx.tenantId)}')`
            }).catch(() => []),
            C.can(ctx.caps, 'bookings')
                ? T.fetchAll(base, T.TABLES.BOOKINGS, { filterByFormula: T.tenantScope(ctx.tenantId) }).catch(() => [])
                : [],
            C.can(ctx.caps, 'followable')
                ? T.fetchAll(base, T.TABLES.FOLLOWS, { filterByFormula: T.tenantScope(ctx.tenantId) }).catch(() => [])
                : [],
            T.fetchAll(base, T.TABLES.PUSH_BROADCASTS, { filterByFormula: T.tenantScope(ctx.tenantId) }).catch(() => []),
            C.can(ctx.caps, 'loyalty')
                ? T.fetchAll(base, T.TABLES.POINTS_LEDGER, { filterByFormula: T.tenantScope(ctx.tenantId) }).catch(() => [])
                : []
        ]);

        // --- traffic, split by the surface it arrived on ----------------------
        const recentViews = views.filter(v => tsOf(v.get('Timestamp')) >= since.getTime());
        const bySurface = { space: 0, website: 0, app: 0, directory: 0, other: 0 };
        recentViews.forEach(v => {
            const page = String(v.get('Page') || '');
            const key = page.startsWith('space:') ? page.split(':')[1] : 'other';
            if (bySurface[key] === undefined) bySurface.other++;
            else bySurface[key]++;
        });

        // --- revenue -----------------------------------------------------------
        const recentOrders = orders.filter(o => tsOf(o.get('CreatedAt') || o.get('OrderDate')) >= since.getTime());
        const revenue = recentOrders.reduce((s, o) => s + (Number(o.get('Total')) || 0), 0);

        // --- headline numbers ---------------------------------------------------
        const result = {
            period: { days, since: since.toISOString() },
            advanced,
            totals: {
                views: recentViews.length,
                allTimeViews: views.length,
                orders: recentOrders.length,
                revenue: round2(revenue),
                avgOrder: recentOrders.length ? round2(revenue / recentOrders.length) : 0,
                bookings: bookings.filter(b => tsOf(b.get('CreatedAt')) >= since.getTime()).length,
                followers: follows.length,
                loyaltyMembers: new Set(points.map(p => p.get('UserID')).filter(Boolean)).size,
                pointsOutstanding: points.reduce((s, p) => s + (Number(p.get('Delta')) || 0), 0)
            },
            // Which surfaces this tenant actually owns — the front end renders
            // only these columns rather than showing empty ones.
            surfaces: C.can(ctx.caps, 'website') || C.can(ctx.caps, 'app_surface') || C.can(ctx.caps, 'directory_listing')
                ? surfaceSummary(ctx.caps, bySurface)
                : [{ key: 'space', label: 'Your space', views: bySurface.space, owned: true }]
        };

        // --- push performance -----------------------------------------------------
        const quota = C.pushQuota(ctx.caps);
        const sent = broadcasts.filter(b => b.get('Status') === 'sent');
        result.push = {
            sentAllTime: sent.length,
            sentThisMonth: sent.filter(b => (b.get('Month') || '') === T.monthKey()).length,
            reached: sent.reduce((s, b) => s + (Number(b.get('SentCount')) || 0), 0),
            quota: quota.unlimited
                ? { unlimited: true }
                : {
                    unlimited: false,
                    cap: quota.cap,
                    remaining: Math.max(0, quota.cap - sent.filter(b => (b.get('Month') || '') === T.monthKey()).length)
                },
            blocked: broadcasts.filter(b => b.get('Status') === 'blocked').length
        };

        if (!advanced) {
            result.upgrade = {
                message: 'Trends, per-surface breakdowns and exports come with advanced analytics.',
                capability: 'advanced_analytics'
            };
            return T.ok(result, 'GET');
        }

        // --- advanced: daily series ------------------------------------------------
        result.series = {
            views: dailySeries(recentViews, v => v.get('Timestamp'), days),
            revenue: dailySeries(recentOrders, o => o.get('CreatedAt') || o.get('OrderDate'), days,
                o => Number(o.get('Total')) || 0),
            followers: dailySeries(
                follows.filter(f => tsOf(f.get('CreatedAt')) >= since.getTime()),
                f => f.get('CreatedAt'), days
            )
        };

        result.breakdown = {
            viewsBySurface: bySurface,
            ordersByStatus: countBy(recentOrders, o => o.get('Status') || 'unknown'),
            bookingsByStatus: countBy(bookings, b => b.get('Status') || 'unknown')
        };

        // Follower growth is the directory's own argument for itself.
        const followsSince = follows.filter(f => tsOf(f.get('CreatedAt')) >= since.getTime()).length;
        result.growth = {
            newFollowers: followsSince,
            followerGrowthPct: follows.length > followsSince && follows.length
                ? round2((followsSince / (follows.length - followsSince)) * 100)
                : null,
            directoryShare: recentViews.length
                ? round2((bySurface.directory / recentViews.length) * 100)
                : 0
        };

        result.canExport = C.can(ctx.caps, 'data_export');

        return T.ok(result, 'GET');

    } catch (error) {
        return T.serverError(error, 'GET');
    }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function surfaceSummary(caps, bySurface) {
    const all = [
        { key: 'space', label: 'Your space', owned: true },
        { key: 'website', label: 'Your website', owned: C.can(caps, 'website') },
        { key: 'app', label: 'Your app', owned: C.can(caps, 'app_surface') },
        { key: 'directory', label: 'Directory listing', owned: C.can(caps, 'directory_listing') }
    ];
    return all
        .filter(s => s.owned)
        .map(s => Object.assign({}, s, { views: bySurface[s.key] || 0 }));
}

function dailySeries(rows, getDate, days, valueFn) {
    const buckets = new Map();
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
        buckets.set(d, 0);
    }
    rows.forEach(r => {
        const raw = getDate(r);
        if (!raw) return;
        const day = String(raw).split('T')[0];
        if (buckets.has(day)) {
            buckets.set(day, buckets.get(day) + (valueFn ? valueFn(r) : 1));
        }
    });
    return Array.from(buckets.entries()).map(([date, value]) => ({ date, value: round2(value) }));
}

function countBy(rows, keyFn) {
    return rows.reduce((acc, r) => {
        const k = String(keyFn(r));
        acc[k] = (acc[k] || 0) + 1;
        return acc;
    }, {});
}

function tsOf(v) {
    const t = new Date(v || 0).getTime();
    return isNaN(t) ? 0 : t;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
