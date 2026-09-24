const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * GET /api/get-directory — a region's directory. PUBLIC.
 *
 *   ?region=holland            → that region's live listing
 *   (no region)                → every live region, for the chooser
 *   ?q= &category= &open=true  → filters
 *
 * A DIRECTORY IS A CHANNEL, NOT AN ADMIN PANEL. Nothing here logs a business
 * in. A tenant appears because Aaron toggled their DirectoryStatus to free or
 * paid and their RegionID points at this region — that is the whole mechanism.
 *
 * Paid tenants sort above free ones, which is the actual product difference a
 * visitor sees. Free listings are deliberately complete (name, hours, photos,
 * map, link-out, followable) because the free listing is the hook.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET']);
    if (guard) return guard;

    try {
        const params = event.queryStringParameters || {};
        const base = T.getBase();

        // --- no region: list the regions themselves -------------------------
        if (!params.region && !params.regionId) {
            return listRegions(base);
        }

        // --- resolve the region ----------------------------------------------
        let region;
        if (params.regionId) {
            try { region = await base(T.TABLES.REGIONS).find(params.regionId); } catch (e) { region = null; }
        } else {
            const rows = await base(T.TABLES.REGIONS).select({
                filterByFormula: `{Slug} = '${T.esc(params.region)}'`,
                maxRecords: 1
            }).firstPage();
            region = rows[0] || null;
        }

        if (!region) return T.notFound('No directory for that place yet.', 'GET');

        const status = region.get('Status');
        if (status !== 'live') {
            // A planned region is a real answer, not an error — it's the
            // "coming soon, want to be notified?" surface.
            return T.ok({
                region: shapeRegion(region),
                live: false,
                tenants: [],
                message: `${region.get('Name')} hasn't launched yet.`
            }, 'GET');
        }

        // --- tenants toggled into this region ---------------------------------
        const all = await T.fetchAll(base, T.TABLES.TENANTS, {
            filterByFormula: `AND({RegionID} = '${T.esc(region.id)}', OR({DirectoryStatus} = 'free', {DirectoryStatus} = 'paid'))`
        });

        let tenants = all
            .map(T.hydrateTenant)
            // Belt and braces: the formula already filtered, but resolve the
            // capability too so an override that revokes the listing wins.
            .filter(t => C.can(t.caps, 'directory_listing'))
            .map(t => shapeListing(t));

        // --- filters -------------------------------------------------------------
        if (params.q) {
            const q = String(params.q).toLowerCase();
            tenants = tenants.filter(t =>
                t.name.toLowerCase().includes(q) ||
                t.tagline.toLowerCase().includes(q) ||
                t.category.toLowerCase().includes(q)
            );
        }
        if (params.category) {
            const cat = String(params.category).toLowerCase();
            tenants = tenants.filter(t => t.category.toLowerCase() === cat);
        }

        // --- hours, for the "open now" badge and filter -----------------------
        const hoursByTenant = await loadHoursFor(base, tenants.map(t => t.id));
        tenants.forEach(t => {
            t.openNow = computeOpenNow(hoursByTenant.get(t.id) || []);
            t.hours = hoursByTenant.get(t.id) || [];
        });
        if (params.open === 'true') {
            tenants = tenants.filter(t => t.openNow && t.openNow.open);
        }

        // --- follower counts ------------------------------------------------------
        const followCounts = await loadFollowCounts(base, region.id);
        tenants.forEach(t => { t.followers = followCounts.get(t.id) || 0; });

        // Paid space sorts first — that is what the money buys. Within a band,
        // alphabetical, so free listings are never randomly buried.
        tenants.sort((a, b) => {
            if (a.paid !== b.paid) return a.paid ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        const categories = Array.from(new Set(tenants.map(t => t.category).filter(Boolean))).sort();

        return T.ok({
            region: shapeRegion(region),
            live: true,
            tenants,
            categories,
            counts: {
                total: tenants.length,
                paid: tenants.filter(t => t.paid).length,
                free: tenants.filter(t => !t.paid).length,
                openNow: tenants.filter(t => t.openNow && t.openNow.open).length
            }
        }, 'GET');

    } catch (error) {
        return T.serverError(error, 'GET');
    }
};

// ---------------------------------------------------------------------------

async function listRegions(base) {
    const rows = await T.fetchAll(base, T.TABLES.REGIONS, {});
    const regions = rows.map(shapeRegion);
    return T.ok({
        regions: regions.sort((a, b) => {
            if (a.status !== b.status) return a.status === 'live' ? -1 : 1;
            return a.name.localeCompare(b.name);
        }),
        live: regions.filter(r => r.status === 'live').length
    }, 'GET');
}

async function loadHoursFor(base, tenantIds) {
    const map = new Map();
    if (!tenantIds.length) return map;
    try {
        // Chunk the OR() so the formula stays under Airtable's length limit.
        for (let i = 0; i < tenantIds.length; i += 40) {
            const chunk = tenantIds.slice(i, i + 40);
            const formula = `OR(${chunk.map(id => `{TenantID} = '${T.esc(id)}'`).join(',')})`;
            const rows = await T.fetchAll(base, T.TABLES.HOURS, { filterByFormula: formula });
            rows.forEach(r => {
                const tid = r.get('TenantID');
                if (!map.has(tid)) map.set(tid, []);
                map.get(tid).push({
                    day: String(r.get('Day') || '').toLowerCase(),
                    open: r.get('OpenTime') || '',
                    close: r.get('CloseTime') || '',
                    closed: C.toBool(r.get('Closed')),
                    note: r.get('Note') || ''
                });
            });
            if (i + 40 < tenantIds.length) await T.sleep(220);
        }
    } catch (e) { /* the directory renders without hours */ }
    return map;
}

async function loadFollowCounts(base, regionId) {
    const map = new Map();
    try {
        const rows = await T.fetchAll(base, T.TABLES.FOLLOWS, {
            filterByFormula: `{RegionID} = '${T.esc(regionId)}'`
        });
        rows.forEach(r => {
            const tid = r.get('TenantID');
            map.set(tid, (map.get(tid) || 0) + 1);
        });
    } catch (e) { /* counts are a nicety */ }
    return map;
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function shapeRegion(r) {
    return {
        id: r.id,
        regionId: r.get('RegionID') || '',
        name: r.get('Name') || '',
        slug: r.get('Slug') || '',
        city: r.get('City') || '',
        state: r.get('State') || '',
        kind: r.get('Kind') || 'shop',
        status: r.get('Status') || 'planned',
        accentColor: r.get('AccentColor') || '#d4af37',
        blurb: r.get('Blurb') || '',
        launchedAt: r.get('LaunchedAt') || '',
        tenantCount: r.get('TenantCount') || 0
    };
}

/**
 * A directory card. Free and paid listings carry the SAME public fields — the
 * difference is `paid` (sort position + branded presentation) and what the
 * tenant can do from their side, not what the visitor is allowed to see.
 */
function shapeListing(t) {
    const paid = t.directoryStatus === 'paid';
    return {
        id: t.id,
        slug: t.slug,
        name: t.company || t.name,
        tagline: t.tagline,
        category: t.siteType || '',
        logoUrl: t.logoUrl,
        brandColor: t.brandColor || '#d4af37',
        address: t.address,
        phone: t.phone,
        lat: t.record.get('Lat') || '',
        lng: t.record.get('Lng') || '',
        paid,
        branded: paid,
        // Where the card sends you. A link-out tenant goes to their own site;
        // everyone else gets their space inside the directory.
        linkOut: C.can(t.caps, 'website_link_out') && !C.can(t.caps, 'website')
            ? (t.websiteUrl || t.projectUrl || '')
            : '',
        followable: C.can(t.caps, 'followable'),
        features: {
            bookings: C.can(t.caps, 'bookings'),
            ordering: C.can(t.caps, 'pay_in_app'),
            loyalty: C.can(t.caps, 'loyalty'),
            events: C.can(t.caps, 'value_modules')
        }
    };
}

function computeOpenNow(hours) {
    if (!hours || !hours.length) return null;
    const now = new Date();
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = hours.find(h => h.day === days[now.getDay()]);
    if (!today || today.closed || !today.open || !today.close) return { open: false, today: today || null };
    const mins = now.getHours() * 60 + now.getMinutes();
    const toMins = (s) => {
        const [h, m] = String(s).split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
    };
    const openM = toMins(today.open);
    let closeM = toMins(today.close);
    if (closeM <= openM) closeM += 1440;
    return { open: mins >= openM && mins < closeM, today };
}
