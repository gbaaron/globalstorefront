const jwt = require('jsonwebtoken');
const T = require('./lib/tenants');
const { resolveCapabilities, describeTenant } = require('./lib/capabilities');
const { checkPassword, shouldMigrate, hashPassword } = require('./lib/password');

/**
 * POST /api/login — tenant (business owner) login.
 *
 * Issues a token carrying the tenant's RESOLVED CAPABILITIES, not just a tier.
 * Every downstream gate reads `caps` off the token, so no function needs a
 * second fetch to know what this business may do.
 *
 * Accepts either a username or an email address.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['POST']);
    if (guard) return guard;

    try {
        const { username, password } = T.parseBody(event);

        if (!username || !password) {
            return T.bad('Username and password are required', 'POST');
        }

        const base = T.getBase();

        // Accept either a username or an email address.
        const isEmail = String(username).includes('@');
        const filterFormula = isEmail
            ? `LOWER({Email}) = '${T.esc(String(username).toLowerCase())}'`
            : `{Username} = '${T.esc(username)}'`;

        const records = await base(T.TABLES.TENANTS).select({
            filterByFormula: filterFormula,
            maxRecords: 1
        }).firstPage();

        if (records.length === 0) {
            return T.json(401, { error: 'Invalid username or password' }, 'POST');
        }

        const record = records[0];
        const stored = record.get('Password') || record.get('PasswordHash') || '';

        const valid = await checkPassword(password, stored);
        if (!valid) {
            return T.json(401, { error: 'Invalid username or password' }, 'POST');
        }

        // Upgrade a plain-text row to a digest ONLY once HASH_PASSWORDS is on.
        if (shouldMigrate(stored)) {
            try {
                await base(T.TABLES.TENANTS).update(record.id, {
                    PasswordHash: await hashPassword(password)
                }, { typecast: true });
            } catch (e) {
                console.error('Password migration failed (non-blocking):', e.message);
            }
        }

        const tenant = T.hydrateTenant(record);
        const described = describeTenant(record);

        const token = jwt.sign(
            {
                userId: record.id,
                email: tenant.email,
                role: 'client',
                tier: tenant.tier,
                billingCycle: tenant.billingCycle,
                baseId: tenant.baseId,
                // the reframe — resolved once, read everywhere
                caps: tenant.caps,
                regionId: tenant.regionId,
                subStatus: tenant.subStatus
            },
            T.JWT_SECRET(),
            { expiresIn: '7d' }
        );

        try {
            await base(T.TABLES.TENANTS).update(record.id, { LastLogin: T.nowISO() }, { typecast: true });
        } catch (e) { /* LastLogin is optional — never block a login on it */ }

        return T.ok({
            token,
            name: tenant.name,
            company: tenant.company,
            projectUrl: tenant.projectUrl,
            username: tenant.username,
            slug: tenant.slug,
            tier: tenant.tier,
            billingCycle: tenant.billingCycle,
            subStatus: tenant.subStatus,
            baseId: tenant.baseId,
            // What this business owns and where it is listed — drives the
            // dashboard shell without a second round trip.
            caps: tenant.caps,
            regionId: tenant.regionId,
            surfaces: described.surfaces,
            directoryStatus: described.directoryStatus,
            paymentChannel: described.paymentChannel,
            monetizationMode: described.monetizationMode
        }, 'POST');

    } catch (error) {
        return T.serverError(error, 'POST');
    }
};
