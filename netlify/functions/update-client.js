const T = require('./lib/tenants');
const { normalizeTier, normalizeCycle } = require('./lib/tiers');
const C = require('./lib/capabilities');
const { hashPassword } = require('./lib/password');

/**
 * POST /api/update-client — Aaron edits a TENANT (admin only).
 *
 * This is where the two axes are actually operated: toggle a tenant into a
 * directory, hand them an app, switch their payment channel, or grant/revoke a
 * single capability by hand — without touching their tier.
 *
 * Returns the freshly resolved capability set so the admin grid can re-render
 * from the response rather than refetching.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['POST']);
    if (guard) return guard;

    const admin = T.adminContext(event);
    if (!admin) return T.forbidden('Admin access required', 'POST');

    try {
        const body = T.parseBody(event);
        const {
            clientId, name, email, username, password, company, projectUrl, baseId,
            tier, billingCycle, subStatus,
            // axes
            regionId, hasWebsite, websiteMode, hasApp, directoryStatus,
            paymentChannel, monetizationMode, posSystem,
            // capability overrides
            capabilities, grant, revoke,
            // directory presentation
            slug, address, phone, websiteUrl, tagline, brandColor, logoUrl,
            siteType, botPersona, botVoice, pushEnabled
        } = body;

        if (!clientId) return T.bad('Client ID is required', 'POST');

        const base = T.getBase();
        const fields = {};

        // --- identity ---------------------------------------------------
        if (name) fields.Name = String(name).trim();
        if (username) fields.Username = String(username).trim();
        if (email) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return T.bad('Invalid email format', 'POST');
            }
            const existing = await base(T.TABLES.TENANTS).select({
                filterByFormula: `AND(LOWER({Email}) = '${T.esc(String(email).toLowerCase())}', RECORD_ID() != '${T.esc(clientId)}')`,
                maxRecords: 1
            }).firstPage();
            if (existing.length > 0) return T.bad('A client with this email already exists', 'POST');
            fields.Email = String(email).trim().toLowerCase();
        }
        if (password) {
            if (String(password).length < 6) return T.bad('Password must be at least 6 characters', 'POST');
            fields.PasswordHash = await hashPassword(password);
        }

        // --- presentation -------------------------------------------------
        if (company !== undefined) fields.Company = String(company).trim();
        if (projectUrl !== undefined) fields.ProjectURL = String(projectUrl).trim();
        if (baseId !== undefined) fields.BaseID = String(baseId).trim();
        if (slug !== undefined) fields.Slug = T.slugify(slug);
        if (address !== undefined) fields.Address = String(address).trim();
        if (phone !== undefined) fields.Phone = String(phone).trim();
        if (websiteUrl !== undefined) fields.WebsiteURL = String(websiteUrl).trim();
        if (tagline !== undefined) fields.Tagline = String(tagline).trim();
        if (brandColor !== undefined) fields.BrandColor = String(brandColor).trim();
        if (logoUrl !== undefined) fields.LogoURL = String(logoUrl).trim();
        if (siteType !== undefined) fields.SiteType = String(siteType).trim();
        if (botPersona !== undefined) fields.BotPersona = String(botPersona).trim();
        if (botVoice !== undefined) fields.BotVoice = String(botVoice).trim();
        if (pushEnabled !== undefined) fields.PushEnabled = C.toBool(pushEnabled);

        // --- billing preset -------------------------------------------------
        if (tier) fields.Tier = normalizeTier(tier);
        if (billingCycle) fields.BillingCycle = normalizeCycle(billingCycle);
        if (subStatus) fields.SubStatus = String(subStatus).trim();

        // --- Axis 1: surfaces -------------------------------------------------
        if (hasWebsite !== undefined) fields.HasWebsite = C.toBool(hasWebsite);
        if (websiteMode !== undefined) fields.WebsiteMode = C.normalizeWebsiteMode(websiteMode);
        if (hasApp !== undefined) fields.HasApp = C.toBool(hasApp);

        // --- Axis 2: distribution ---------------------------------------------
        if (directoryStatus !== undefined) fields.DirectoryStatus = C.normalizeDirectoryStatus(directoryStatus);
        if (regionId !== undefined) fields.RegionID = regionId ? String(regionId).trim() : '';

        // --- payment ----------------------------------------------------------
        if (paymentChannel !== undefined) fields.PaymentChannel = C.normalizePaymentChannel(paymentChannel);
        if (monetizationMode !== undefined) fields.MonetizationMode = C.normalizeMonetizationMode(monetizationMode);
        if (posSystem !== undefined) fields.POSSystem = String(posSystem).trim();

        // --- capability overrides ---------------------------------------------
        // `capabilities` replaces the override list wholesale; `grant`/`revoke`
        // edit it incrementally so the admin UI can flip one switch at a time.
        if (capabilities !== undefined) {
            fields.Capabilities = Array.isArray(capabilities) ? JSON.stringify(capabilities) : String(capabilities || '');
        } else if (grant || revoke) {
            let current;
            try {
                current = await base(T.TABLES.TENANTS).find(clientId);
            } catch (e) {
                return T.notFound('Client not found', 'POST');
            }
            const { grants, revokes } = C.parseOverrides(current.get('Capabilities'));
            const g = new Set(grants);
            const r = new Set(revokes);

            for (const cap of toArray(grant)) { g.add(cap); r.delete(cap); }
            for (const cap of toArray(revoke)) { r.add(cap); g.delete(cap); }

            const merged = Array.from(g).concat(Array.from(r).map(c => `-${c}`));
            fields.Capabilities = JSON.stringify(merged);
        }

        if (Object.keys(fields).length === 0) {
            return T.bad('No fields to update', 'POST');
        }

        const updated = await base(T.TABLES.TENANTS).update(
            [{ id: clientId, fields }],
            { typecast: true }
        );
        const tenant = T.hydrateTenant(updated[0]);

        return T.ok({
            success: true,
            client: {
                id: tenant.id,
                name: tenant.name,
                company: tenant.company,
                email: tenant.email,
                slug: tenant.slug,
                tier: tenant.tier,
                regionId: tenant.regionId,
                surfaces: tenant.surfaces,
                directoryStatus: tenant.directoryStatus,
                paymentChannel: tenant.paymentChannel,
                monetizationMode: tenant.monetizationMode,
                caps: tenant.caps
            }
        }, 'POST');

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return T.json(401, { error: 'Invalid or expired token' }, 'POST');
        }
        return T.serverError(error, 'POST');
    }
};

function toArray(v) {
    if (!v) return [];
    return (Array.isArray(v) ? v : [v]).map(x => String(x).trim()).filter(Boolean);
}
