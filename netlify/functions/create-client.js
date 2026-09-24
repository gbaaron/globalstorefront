const T = require('./lib/tenants');
const { normalizeTier, normalizeCycle } = require('./lib/tiers');
const C = require('./lib/capabilities');
const { hashPassword } = require('./lib/password');

/**
 * POST /api/create-client — Aaron creates a new TENANT (admin only).
 *
 * A tenant is seeded from a tier PRESET, then free to diverge on either axis.
 * The caller may override any axis field directly, so "Essentials business with
 * paid directory space and no website" is a first-class thing to create.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['POST']);
    if (guard) return guard;

    const admin = T.adminContext(event);
    if (!admin) return T.forbidden('Admin access required', 'POST');

    try {
        const body = T.parseBody(event);
        const {
            name, email, username, password, company, projectUrl, baseId,
            tier, billingCycle,
            // axis overrides
            regionId, hasWebsite, websiteMode, hasApp, directoryStatus,
            paymentChannel, monetizationMode, posSystem, capabilities,
            // directory presentation
            slug, address, phone, websiteUrl, tagline, brandColor, logoUrl
        } = body;

        if (!name || !email || !username || !password) {
            return T.bad('Name, email, username and password are required', 'POST');
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return T.bad('Invalid email format', 'POST');
        }
        if (String(password).length < 6) {
            return T.bad('Password must be at least 6 characters', 'POST');
        }

        const base = T.getBase();

        const existing = await base(T.TABLES.TENANTS).select({
            filterByFormula: `LOWER({Email}) = '${T.esc(String(email).toLowerCase())}'`,
            maxRecords: 1
        }).firstPage();
        if (existing.length > 0) {
            return T.bad('A client with this email already exists', 'POST');
        }

        const resolvedTier = normalizeTier(tier);
        const resolvedCycle = normalizeCycle(billingCycle);
        const now = new Date();
        const nextBilling = new Date(now);
        if (resolvedCycle === 'annual') nextBilling.setFullYear(nextBilling.getFullYear() + 1);
        else nextBilling.setMonth(nextBilling.getMonth() + 1);

        // Seed the axes from the tier preset, then apply any explicit overrides.
        const preset = C.presetForTier(resolvedTier);
        const axes = {
            HasWebsite: hasWebsite !== undefined ? C.toBool(hasWebsite) : preset.HasWebsite,
            WebsiteMode: websiteMode !== undefined ? C.normalizeWebsiteMode(websiteMode) : preset.WebsiteMode,
            HasApp: hasApp !== undefined ? C.toBool(hasApp) : preset.HasApp,
            DirectoryStatus: directoryStatus !== undefined ? C.normalizeDirectoryStatus(directoryStatus) : preset.DirectoryStatus,
            PaymentChannel: paymentChannel !== undefined ? C.normalizePaymentChannel(paymentChannel) : preset.PaymentChannel,
            MonetizationMode: monetizationMode !== undefined ? C.normalizeMonetizationMode(monetizationMode) : preset.MonetizationMode
        };

        const resolvedSlug = T.slugify(slug || company || name);

        const fields = Object.assign({
            Name: String(name).trim(),
            Email: String(email).trim().toLowerCase(),
            Username: String(username).trim(),
            // The Clients table has PasswordHash only — there is no `Password`
            // field. Writing one throws "Unknown field name".
            PasswordHash: await hashPassword(password),
            Company: company ? String(company).trim() : '',
            ProjectURL: projectUrl ? String(projectUrl).trim() : '',
            Slug: resolvedSlug,
            CreatedAt: now.toISOString(),
            Tier: resolvedTier,
            BillingCycle: resolvedCycle,
            SubStatus: 'active',
            SubStartDate: now.toISOString().split('T')[0],
            NextBillingDate: nextBilling.toISOString().split('T')[0]
        }, axes);

        if (baseId) fields.BaseID = String(baseId).trim();
        if (regionId) fields.RegionID = String(regionId).trim();
        if (posSystem) fields.POSSystem = String(posSystem).trim();
        if (address) fields.Address = String(address).trim();
        if (phone) fields.Phone = String(phone).trim();
        if (websiteUrl) fields.WebsiteURL = String(websiteUrl).trim();
        if (tagline) fields.Tagline = String(tagline).trim();
        if (brandColor) fields.BrandColor = String(brandColor).trim();
        if (logoUrl) fields.LogoURL = String(logoUrl).trim();
        if (capabilities) {
            fields.Capabilities = Array.isArray(capabilities)
                ? JSON.stringify(capabilities)
                : String(capabilities);
        }

        const created = await base(T.TABLES.TENANTS).create([{ fields }], { typecast: true });
        const tenant = T.hydrateTenant(created[0]);

        // Credential sync into the tenant's own base, if they have one.
        // Non-blocking: a PAT without access to their base must not fail signup.
        if (baseId) {
            try {
                const clientBase = T.getBase(String(baseId).trim());
                await clientBase('Users').create([{
                    fields: {
                        Name: String(name).trim(),
                        Email: String(email).trim().toLowerCase(),
                        PasswordHash: await hashPassword(password),
                        IsAdmin: true,
                        MemberSince: T.todayISO()
                    }
                }], { typecast: true });
            } catch (syncError) {
                console.error('Admin user sync failed (non-blocking):', syncError.message);
            }
        }

        return T.ok({
            success: true,
            client: {
                id: tenant.id,
                name: tenant.name,
                email: tenant.email,
                username: tenant.username,
                company: tenant.company,
                projectUrl: tenant.projectUrl,
                slug: tenant.slug,
                tier: tenant.tier,
                billingCycle: tenant.billingCycle,
                subStatus: tenant.subStatus,
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
