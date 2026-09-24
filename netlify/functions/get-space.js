const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * GET /api/get-space?slug=zeeland-bakery  — THE SURFACES ENGINE.
 *
 * This is the one endpoint that renders a tenant, and it is deliberately the
 * ONLY one. The same payload backs all three wrappers:
 *
 *   - space only   → globalstorefront.../s/zeeland-bakery is their homepage
 *   - website      → their domain points at the same space
 *   - app          → the same space wrapped as its own icon
 *   - directory    → the card + detail view inside Shop Holland
 *
 * There is never a second version of a tenant to keep in sync, because there is
 * never a second renderer. A surface is a wrapper around this response.
 *
 * Public — no auth. Returns only published content, and only for tenants whose
 * space is actually reachable on the requested surface.
 *
 * Query:
 *   slug     tenant slug (or `id` for a record ID)
 *   surface  space | website | app | directory   (default: space)
 *   region   region slug, when rendered inside a directory
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET']);
    if (guard) return guard;

    try {
        const params = event.queryStringParameters || {};
        const surface = String(params.surface || 'space').toLowerCase();
        const base = T.getBase();

        // --- resolve the tenant ------------------------------------------
        let record = null;
        if (params.id) {
            try { record = await base(T.TABLES.TENANTS).find(params.id); } catch (e) { record = null; }
        } else if (params.slug) {
            const slug = T.slugify(params.slug);
            const rows = await base(T.TABLES.TENANTS).select({
                filterByFormula: `OR({Slug} = '${T.esc(slug)}', LOWER({Company}) = '${T.esc(String(params.slug).toLowerCase())}')`,
                maxRecords: 1
            }).firstPage();
            record = rows[0] || null;
        } else {
            return T.bad('slug or id is required', 'GET');
        }

        if (!record) return T.notFound('No space found for that address', 'GET');

        const tenant = T.hydrateTenant(record);

        // --- surface reachability ------------------------------------------
        // A tenant is only renderable on a surface they actually own. This is
        // what stops a directory-only tenant being served as a full website.
        const reachable = {
            space: true,                                        // always
            website: C.can(tenant.caps, 'website'),
            app: C.can(tenant.caps, 'app_surface'),
            directory: C.can(tenant.caps, 'directory_listing')
        };
        if (!reachable[surface]) {
            return T.forbidden(`This business does not have a ${surface} surface.`, 'GET');
        }

        // A link-out tenant has no space to render — the directory card just
        // points at their own site. Say so explicitly rather than 404ing.
        if (C.can(tenant.caps, 'website_link_out') && !C.can(tenant.caps, 'website')) {
            return T.ok({
                mode: 'link_out',
                tenant: publicTenant(tenant, surface),
                hours: await loadHours(base, tenant.id),
                redirect: tenant.websiteUrl || tenant.projectUrl || null
            }, 'GET');
        }

        // --- load the space in parallel -------------------------------------
        const wantsCommerce = C.can(tenant.caps, 'pay_in_app') || C.can(tenant.caps, 'bookings');
        const [content, hours, items, events] = await Promise.all([
            loadContent(base, tenant.id),
            loadHours(base, tenant.id),
            wantsCommerce || surface !== 'directory' ? loadItems(base, tenant.id) : [],
            C.can(tenant.caps, 'value_modules') ? loadEvents(base, tenant.id) : []
        ]);

        // --- fire-and-forget visit tracking ---------------------------------
        trackVisit(base, tenant.id, surface, params.region).catch(() => {});

        return T.ok({
            mode: 'space',
            surface,
            tenant: publicTenant(tenant, surface),
            content,
            hours,
            openNow: computeOpenNow(hours),
            items,
            events,
            // What the wrapper should offer the visitor, derived from caps —
            // the wrapper never decides this for itself.
            features: {
                ordering: C.can(tenant.caps, 'pay_in_app'),
                bookings: C.can(tenant.caps, 'bookings'),
                loyalty: C.can(tenant.caps, 'loyalty'),
                follow: C.can(tenant.caps, 'followable'),
                events: C.can(tenant.caps, 'value_modules'),
                wishlist: C.can(tenant.caps, 'value_modules'),
                restock: C.can(tenant.caps, 'value_modules'),
                chat: C.can(tenant.caps, 'ai_chatbot')
            }
        }, 'GET');

    } catch (error) {
        return T.serverError(error, 'GET');
    }
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadContent(base, tenantId) {
    try {
        const rows = await T.fetchAll(base, T.TABLES.CONTENT, {
            filterByFormula: `AND(${T.tenantScope(tenantId)}, {Status} = 'published')`,
            sort: [{ field: 'SortOrder', direction: 'asc' }]
        });
        return rows.map(r => ({
            id: r.id,
            kind: r.get('Kind') || 'about',
            title: r.get('Title') || '',
            body: r.get('Body') || '',
            imageUrl: r.get('ImageURL') || '',
            sortOrder: r.get('SortOrder') || 0
        }));
    } catch (e) { return []; }
}

async function loadHours(base, tenantId) {
    try {
        const rows = await T.fetchAll(base, T.TABLES.HOURS, {
            filterByFormula: T.tenantScope(tenantId)
        });
        const order = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const byDay = new Map(rows.map(r => [String(r.get('Day') || '').toLowerCase(), r]));
        // Always return the full week. A day with no row is a day they are
        // CLOSED, and a storefront that silently omits it reads as broken —
        // "no Sunday listed" is not the same as "closed Sunday".
        return order.map(day => {
            const r = byDay.get(day);
            if (!r) return { id: null, day, open: '', close: '', closed: true, note: '' };
            return {
                id: r.id,
                day,
                open: r.get('OpenTime') || '',
                close: r.get('CloseTime') || '',
                closed: C.toBool(r.get('Closed')),
                note: r.get('Note') || ''
            };
        });
    } catch (e) { return []; }
}

async function loadItems(base, tenantId) {
    try {
        const rows = await T.fetchAll(base, T.TABLES.ITEMS, {
            filterByFormula: `AND(${T.tenantScope(tenantId)}, {Status} != 'archived')`,
            sort: [{ field: 'SortOrder', direction: 'asc' }]
        });
        return rows.map(r => ({
            id: r.id,
            name: r.get('Name') || '',
            description: r.get('Description') || '',
            price: r.get('Price') || 0,
            category: r.get('Category') || '',
            imageUrl: r.get('ImageURL') || '',
            status: r.get('Status') || 'active',
            stockCount: r.get('StockCount') || 0
        }));
    } catch (e) { return []; }
}

async function loadEvents(base, tenantId) {
    try {
        const rows = await T.fetchAll(base, T.TABLES.EVENTS, {
            filterByFormula: `AND(${T.tenantScope(tenantId)}, {Status} = 'published')`
        });
        const now = Date.now();
        return rows
            .map(r => ({
                id: r.id,
                title: r.get('Title') || '',
                description: r.get('Description') || '',
                startsAt: r.get('StartsAt') || '',
                endsAt: r.get('EndsAt') || '',
                location: r.get('Location') || '',
                capacity: r.get('Capacity') || 0,
                signupCount: r.get('SignupCount') || 0,
                price: r.get('Price') || 0,
                imageUrl: r.get('ImageURL') || ''
            }))
            .filter(e => !e.startsAt || new Date(e.startsAt).getTime() > now - 86400000)
            .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
    } catch (e) { return []; }
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/** The tenant fields a PUBLIC surface may see. Never leaks billing or auth. */
function publicTenant(tenant, surface) {
    return {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.company || tenant.name,
        tagline: tenant.tagline,
        logoUrl: tenant.logoUrl,
        brandColor: tenant.brandColor || '#d4af37',
        address: tenant.address,
        phone: tenant.phone,
        websiteUrl: tenant.websiteUrl,
        siteType: tenant.siteType,
        regionId: tenant.regionId,
        botPersona: tenant.botPersona,
        // Branded presentation is a paid-directory capability; a free listing
        // renders in the directory's own skin.
        branded: C.can(tenant.caps, 'directory_branded') || surface !== 'directory'
    };
}

/** Is the tenant open right now, per their own hours? */
function computeOpenNow(hours) {
    if (!hours || !hours.length) return null;
    const now = new Date();
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = hours.find(h => h.day === days[now.getDay()]);
    if (!today || today.closed || !today.open || !today.close) {
        return { open: false, today: today || null };
    }
    const mins = now.getHours() * 60 + now.getMinutes();
    const toMins = (s) => {
        const [h, m] = String(s).split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
    };
    const openM = toMins(today.open);
    let closeM = toMins(today.close);
    if (closeM <= openM) closeM += 1440; // closes after midnight
    return { open: mins >= openM && mins < closeM, today };
}

async function trackVisit(base, tenantId, surface, regionSlug) {
    return base(T.TABLES.PAGE_VIEWS).create([{
        fields: {
            Page: `space:${surface}`,
            Referrer: regionSlug ? `region:${regionSlug}` : '',
            Timestamp: T.nowISO(),
            // NOTE: PageViews uses ClientId (lowercase d) while every other
            // table uses ClientID. Do not "fix" this without migrating the rows.
            ClientId: tenantId
        }
    }], { typecast: true });
}
