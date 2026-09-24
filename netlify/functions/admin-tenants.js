const T = require('./lib/tenants');
const C = require('./lib/capabilities');
const { TIERS, monthlyPrice, GS_CUT_RATE } = require('./lib/tiers');

/**
 * /api/admin-tenants — AARON'S CONTROL ROOM. Admin only.
 *
 *   GET ?view=tenants   → every tenant across every region, with axes + caps
 *   GET ?view=billing   → who pays what, per module
 *   GET ?view=regions   → directory management
 *   GET ?view=releases  → app release tracking
 *   GET ?view=overview  → the single screen
 *
 *   POST { action: 'toggle_directory' }  → put a tenant into / out of a region
 *   POST { action: 'set_region' }
 *   POST { action: 'grant' | 'revoke' }  → one capability, by hand
 *   POST { action: 'region' }            → create / update a region
 *
 * THIS IS NOT THE TENANT DASHBOARD. Owners never see it. The only real
 * overhead a standalone app adds is Aaron's, not the tenant's — which is why
 * release management lives here and nowhere else.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET', 'POST']);
    if (guard) return guard;

    const admin = T.adminContext(event);
    if (!admin && !T.headerAdminOk(event)) {
        return T.forbidden('Admin access required', 'GET, POST');
    }

    try {
        const base = T.getBase();
        if (event.httpMethod === 'GET') {
            const view = String((event.queryStringParameters || {}).view || 'overview').toLowerCase();
            return handleGet(view, base);
        }
        const body = T.parseBody(event);
        return handlePost(body, String(body.action || '').toLowerCase(), base);
    } catch (error) {
        return T.serverError(error, 'GET, POST');
    }
};

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

async function handleGet(view, base) {
    const [tenantRows, regionRows] = await Promise.all([
        T.fetchAll(base, T.TABLES.TENANTS, {}),
        T.fetchAll(base, T.TABLES.REGIONS, {}).catch(() => [])
    ]);

    const regions = regionRows.map(shapeRegion);
    const regionById = new Map(regions.map(r => [r.id, r]));
    const tenants = tenantRows.map(r => {
        const t = T.hydrateTenant(r);
        const region = t.regionId ? regionById.get(t.regionId) : null;
        return {
            id: t.id,
            name: t.name,
            company: t.company,
            email: t.email,
            slug: t.slug,
            tier: t.tier,
            billingCycle: t.billingCycle,
            subStatus: t.subStatus,
            nextBillingDate: t.nextBillingDate,
            projectUrl: t.projectUrl,
            baseId: t.baseId,
            regionId: t.regionId,
            regionName: region ? region.name : '',
            surfaces: t.surfaces,
            directoryStatus: t.directoryStatus,
            paymentChannel: t.paymentChannel,
            monetizationMode: t.monetizationMode,
            posSystem: t.posSystem,
            caps: t.caps,
            capCount: t.caps.length,
            monthly: monthlyPrice(t.tier, t.billingCycle),
            lastLogin: r.get('LastLogin') || ''
        };
    });

    if (view === 'tenants') {
        return T.ok({
            tenants: tenants.sort((a, b) => (a.company || a.name).localeCompare(b.company || b.name)),
            regions,
            // The toggle grid the admin UI renders, straight from the registry
            // so a new capability shows up without touching the front end.
            capabilityGroups: C.CAPABILITY_GROUPS,
            capabilityLabels: C.CAPABILITY_LABELS
        }, 'GET, POST');
    }

    if (view === 'regions') {
        // Live tenant counts per region — the denormalised TenantCount is a
        // cache, so compute the truth here rather than trusting it.
        const counts = new Map();
        tenants.forEach(t => {
            if (!t.regionId || t.directoryStatus === 'none') return;
            const cur = counts.get(t.regionId) || { free: 0, paid: 0 };
            cur[t.directoryStatus === 'paid' ? 'paid' : 'free']++;
            counts.set(t.regionId, cur);
        });
        return T.ok({
            regions: regions.map(r => Object.assign({}, r, {
                live: counts.get(r.id) || { free: 0, paid: 0 },
                total: (counts.get(r.id) || { free: 0, paid: 0 }).free + (counts.get(r.id) || { free: 0, paid: 0 }).paid
            })),
            unassigned: tenants.filter(t => !t.regionId).map(t => ({
                id: t.id, name: t.company || t.name, directoryStatus: t.directoryStatus
            }))
        }, 'GET, POST');
    }

    if (view === 'billing') {
        const [transactions, payouts] = await Promise.all([
            T.fetchAll(base, T.TABLES.TRANSACTIONS, {}).catch(() => []),
            T.fetchAll(base, T.TABLES.PAYOUTS, {}).catch(() => [])
        ]);

        const revenueByTenant = new Map();
        let gsRevenue = 0;
        transactions.forEach(tx => {
            if (tx.get('Status') !== 'succeeded') return;
            const cid = tx.get('ClientID');
            const cur = revenueByTenant.get(cid) || { gross: 0, gsCut: 0, net: 0, count: 0 };
            cur.gross += Number(tx.get('Amount')) || 0;
            cur.gsCut += Number(tx.get('GSCut')) || 0;
            cur.net += Number(tx.get('ClientNet')) || 0;
            cur.count++;
            revenueByTenant.set(cid, cur);
            gsRevenue += Number(tx.get('GSCut')) || 0;
        });

        const billing = tenants.map(t => Object.assign({
            id: t.id,
            name: t.company || t.name,
            tier: t.tier,
            billingCycle: t.billingCycle,
            subStatus: t.subStatus,
            monthly: t.monthly,
            monetizationMode: t.monetizationMode,
            paymentChannel: t.paymentChannel,
            // Which modules this tenant is actually paying for — the two-axis
            // answer to "what does this account cost".
            modules: modulesFor(t)
        }, revenueByTenant.get(t.id) || { gross: 0, gsCut: 0, net: 0, count: 0 }));

        const mrr = billing
            .filter(b => b.subStatus === 'active')
            .reduce((s, b) => s + b.monthly, 0);

        return T.ok({
            billing: billing.sort((a, b) => b.monthly - a.monthly),
            summary: {
                mrr,
                arr: mrr * 12,
                activeCount: billing.filter(b => b.subStatus === 'active').length,
                pastDueCount: billing.filter(b => b.subStatus === 'past_due').length,
                freeCount: billing.filter(b => b.monetizationMode === 'free').length,
                gsRevenue: round2(gsRevenue),
                cutRate: GS_CUT_RATE,
                pendingPayouts: payouts.filter(p => p.get('Status') === 'pending')
                    .reduce((s, p) => s + (Number(p.get('Amount')) || 0), 0)
            },
            tiers: Object.values(TIERS).map(t => ({
                key: t.key, label: t.label, priceAnnual: t.priceAnnual, priceM2M: t.priceM2M, blurb: t.blurb
            }))
        }, 'GET, POST');
    }

    if (view === 'releases') {
        // App release tracking: every tenant with an app surface is a build
        // Aaron has to ship and resubmit. That list IS the overhead.
        const withApps = tenants.filter(t => t.surfaces.app);
        return T.ok({
            apps: withApps.map(t => ({
                id: t.id,
                name: t.company || t.name,
                slug: t.slug,
                bundleId: `com.globalstorefront.${String(t.slug || '').replace(/-/g, '')}`,
                regionName: t.regionName,
                directoryStatus: t.directoryStatus,
                tier: t.tier
            })),
            summary: {
                total: withApps.length,
                note: 'Each app is a separate App Store listing to build, submit and maintain. That cost is yours, not the tenant\'s.'
            }
        }, 'GET, POST');
    }

    // overview
    const pushRows = await T.fetchAll(base, T.TABLES.PUSH_BROADCASTS, {}).catch(() => []);
    const month = T.monthKey();
    const blockedThisMonth = pushRows.filter(p => p.get('Status') === 'blocked' && p.get('Month') === month);

    return T.ok({
        counts: {
            tenants: tenants.length,
            regionsLive: regions.filter(r => r.status === 'live').length,
            regionsPlanned: regions.filter(r => r.status === 'planned').length,
            withWebsite: tenants.filter(t => t.surfaces.website).length,
            withApp: tenants.filter(t => t.surfaces.app).length,
            directoryFree: tenants.filter(t => t.directoryStatus === 'free').length,
            directoryPaid: tenants.filter(t => t.directoryStatus === 'paid').length,
            noDirectory: tenants.filter(t => t.directoryStatus === 'none').length,
            unassignedRegion: tenants.filter(t => !t.regionId).length
        },
        mrr: tenants.filter(t => t.subStatus === 'active').reduce((s, t) => s + t.monthly, 0),
        // Tenants who hit the free push cap this month are the upgrade
        // conversations — surface them rather than making Aaron go looking.
        hittingPushCap: blockedThisMonth.map(p => {
            const t = tenants.find(x => x.id === p.get('TenantID'));
            return { tenantId: p.get('TenantID'), name: t ? (t.company || t.name) : 'Unknown', at: p.get('CreatedAt') };
        }),
        regions,
        recentTenants: tenants
            .slice()
            .sort((a, b) => String(b.lastLogin).localeCompare(String(a.lastLogin)))
            .slice(0, 10)
            .map(t => ({ id: t.id, name: t.company || t.name, lastLogin: t.lastLogin, tier: t.tier }))
    }, 'GET, POST');
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

async function handlePost(body, action, base) {
    // --- region CRUD ------------------------------------------------------
    if (action === 'region') {
        const fields = {};
        if (body.name !== undefined) fields.Name = String(body.name).trim();
        if (body.slug !== undefined) fields.Slug = T.slugify(body.slug);
        if (body.city !== undefined) fields.City = String(body.city).trim();
        if (body.state !== undefined) fields.State = String(body.state).trim();
        if (body.kind !== undefined) fields.Kind = body.kind === 'vote' ? 'vote' : 'shop';
        if (body.status !== undefined) fields.Status = String(body.status);
        if (body.accentColor !== undefined) fields.AccentColor = String(body.accentColor).trim();
        if (body.blurb !== undefined) fields.Blurb = T.capText(body.blurb);

        if (body.id) {
            if (fields.Status === 'live') fields.LaunchedAt = T.todayISO();
            const updated = await base(T.TABLES.REGIONS).update([{ id: body.id, fields }], { typecast: true });
            return T.ok({ success: true, region: shapeRegion(updated[0]) }, 'GET, POST');
        }

        if (!fields.Name || !fields.Slug) return T.bad('name and slug are required', 'GET, POST');
        fields.RegionID = T.makeId('reg');
        fields.TenantCount = 0;
        if (!fields.Status) fields.Status = 'planned';
        if (fields.Status === 'live') fields.LaunchedAt = T.todayISO();
        const created = await base(T.TABLES.REGIONS).create([{ fields }], { typecast: true });
        return T.ok({ success: true, region: shapeRegion(created[0]) }, 'GET, POST');
    }

    // --- everything else acts on a tenant -----------------------------------
    const tenantId = String(body.tenantId || body.clientId || '').trim();
    if (!tenantId) return T.bad('tenantId is required', 'GET, POST');

    let record;
    try {
        record = await base(T.TABLES.TENANTS).find(tenantId);
    } catch (e) {
        return T.notFound('Tenant not found', 'GET, POST');
    }

    if (action === 'toggle_directory') {
        // THE ONLY MECHANISM by which a business enters a directory.
        const status = C.normalizeDirectoryStatus(body.directoryStatus);
        const fields = { DirectoryStatus: status };

        // Being in a directory requires a region to be in.
        if (status !== 'none') {
            const regionId = body.regionId || record.get('RegionID');
            if (!regionId) {
                return T.bad('Assign a region before putting this tenant in a directory.', 'GET, POST');
            }
            fields.RegionID = regionId;
        }

        const updated = await base(T.TABLES.TENANTS).update([{ id: tenantId, fields }], { typecast: true });
        const t = T.hydrateTenant(updated[0]);
        await refreshRegionCount(base, t.regionId).catch(() => {});
        return T.ok({
            success: true,
            tenant: { id: t.id, directoryStatus: t.directoryStatus, regionId: t.regionId, caps: t.caps },
            pushQuota: C.pushQuota(t.caps)
        }, 'GET, POST');
    }

    if (action === 'set_region') {
        const regionId = String(body.regionId || '').trim();
        const updated = await base(T.TABLES.TENANTS).update(
            [{ id: tenantId, fields: { RegionID: regionId } }],
            { typecast: true }
        );
        const t = T.hydrateTenant(updated[0]);
        await refreshRegionCount(base, regionId).catch(() => {});
        return T.ok({ success: true, tenant: { id: t.id, regionId: t.regionId } }, 'GET, POST');
    }

    if (action === 'set_surface') {
        const fields = {};
        if (body.hasWebsite !== undefined) fields.HasWebsite = C.toBool(body.hasWebsite);
        if (body.websiteMode !== undefined) fields.WebsiteMode = C.normalizeWebsiteMode(body.websiteMode);
        if (body.hasApp !== undefined) fields.HasApp = C.toBool(body.hasApp);
        if (body.paymentChannel !== undefined) fields.PaymentChannel = C.normalizePaymentChannel(body.paymentChannel);
        if (body.monetizationMode !== undefined) fields.MonetizationMode = C.normalizeMonetizationMode(body.monetizationMode);
        if (!Object.keys(fields).length) return T.bad('No surface fields given', 'GET, POST');
        const updated = await base(T.TABLES.TENANTS).update([{ id: tenantId, fields }], { typecast: true });
        const t = T.hydrateTenant(updated[0]);
        return T.ok({
            success: true,
            tenant: { id: t.id, surfaces: t.surfaces, paymentChannel: t.paymentChannel, caps: t.caps }
        }, 'GET, POST');
    }

    if (action === 'grant' || action === 'revoke') {
        const cap = String(body.capability || '').trim();
        if (!cap) return T.bad('capability is required', 'GET, POST');

        const { grants, revokes } = C.parseOverrides(record.get('Capabilities'));
        const g = new Set(grants);
        const r = new Set(revokes);
        if (action === 'grant') { g.add(cap); r.delete(cap); } else { r.add(cap); g.delete(cap); }

        const merged = Array.from(g).concat(Array.from(r).map(x => `-${x}`));
        const updated = await base(T.TABLES.TENANTS).update(
            [{ id: tenantId, fields: { Capabilities: JSON.stringify(merged) } }],
            { typecast: true }
        );
        const t = T.hydrateTenant(updated[0]);
        return T.ok({
            success: true,
            tenant: { id: t.id, caps: t.caps },
            overrides: merged,
            has: C.can(t.caps, cap)
        }, 'GET, POST');
    }

    return T.bad(`Unknown action "${action}"`, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** What this tenant is actually being billed for — modules, not a rung. */
function modulesFor(t) {
    const out = [{ key: `tier_${t.tier.toLowerCase()}`, label: `${t.tier} plan`, price: t.monthly }];
    if (t.surfaces.website && t.surfaces.websiteMode === 'built') out.push({ key: 'website_built', label: 'Website', price: 0 });
    if (t.surfaces.website && t.surfaces.websiteMode === 'linked') out.push({ key: 'website_linked', label: 'Linked website', price: 0 });
    if (t.surfaces.app) out.push({ key: 'app_surface', label: 'Standalone app', price: 0 });
    if (t.directoryStatus === 'free') out.push({ key: 'directory_free', label: 'Free listing', price: 0 });
    if (t.directoryStatus === 'paid') out.push({ key: 'directory_paid', label: 'Paid directory space', price: 0 });
    return out;
}

async function refreshRegionCount(base, regionId) {
    if (!regionId) return;
    const rows = await T.fetchAll(base, T.TABLES.TENANTS, {
        filterByFormula: `AND({RegionID} = '${T.esc(regionId)}', OR({DirectoryStatus} = 'free', {DirectoryStatus} = 'paid'))`
    });
    await base(T.TABLES.REGIONS).update([{ id: regionId, fields: { TenantCount: rows.length } }], { typecast: true });
}

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

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
