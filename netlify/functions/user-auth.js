const jwt = require('jsonwebtoken');
const T = require('./lib/tenants');
const { checkPassword, hashPassword, shouldMigrate } = require('./lib/password');

/**
 * /api/user-auth — END USER accounts (directory shoppers / constituents).
 *
 *   POST { action: 'signup' }
 *   POST { action: 'login' }
 *   POST { action: 'me' }        → refresh profile from a token
 *   POST { action: 'update' }    → name, push opt-in, home region, device token
 *
 * THIS IS A SEPARATE POPULATION FROM TENANTS.
 * A tenant is a business with a dashboard; a user is a person who follows
 * businesses. They live in different tables and carry different token roles
 * (`client` vs `user`), so a user token can never reach a tenant endpoint.
 *
 * One account follows many businesses across many regions. HomeRegionID is a
 * browsing default, never a restriction — somebody who lives in Holland and
 * works in Grand Rapids follows businesses in both.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['POST']);
    if (guard) return guard;

    try {
        const body = T.parseBody(event);
        const action = String(body.action || 'login').toLowerCase();
        const base = T.getBase();

        switch (action) {
            case 'signup': return signup(body, base);
            case 'login': return login(body, base);
            case 'me': return me(event, base);
            case 'update': return update(event, body, base);
            default: return T.bad(`Unknown action "${action}"`, 'POST');
        }
    } catch (error) {
        return T.serverError(error, 'POST');
    }
};

// ---------------------------------------------------------------------------

async function signup(body, base) {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim();

    if (!email || !password) return T.bad('Email and password are required', 'POST');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return T.bad('Invalid email format', 'POST');
    if (password.length < 6) return T.bad('Password must be at least 6 characters', 'POST');

    const existing = await base(T.TABLES.USERS).select({
        filterByFormula: `LOWER({Email}) = '${T.esc(email)}'`,
        maxRecords: 1
    }).firstPage();
    if (existing.length) return T.conflict('An account with that email already exists.', 'POST');

    const regionId = await resolveRegion(base, body.regionSlug, body.regionId);

    const created = await base(T.TABLES.USERS).create([{
        fields: {
            Email: email,
            Name: name,
            PasswordHash: await hashPassword(password),
            HomeRegionID: regionId || '',
            PushOptIn: body.pushOptIn === undefined ? true : !!body.pushOptIn,
            DeviceToken: String(body.deviceToken || ''),
            CreatedAt: T.nowISO(),
            LastLogin: T.nowISO()
        }
    }], { typecast: true });

    const user = shape(created[0]);

    // A signup can carry an intended follow, so "follow this bakery" can create
    // the account and the follow in one step rather than two round trips.
    let followed = null;
    if (body.followTenantId) {
        followed = await createFollow(base, user.id, body.followTenantId, regionId)
            .catch(e => { console.error('Signup follow failed (non-blocking):', e.message); return null; });
    }

    return T.ok({ success: true, token: tokenFor(user), user, followed }, 'POST');
}

async function login(body, base) {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return T.bad('Email and password are required', 'POST');

    const records = await base(T.TABLES.USERS).select({
        filterByFormula: `LOWER({Email}) = '${T.esc(email)}'`,
        maxRecords: 1
    }).firstPage();
    if (!records.length) return T.json(401, { error: 'Invalid email or password' }, 'POST');

    const record = records[0];
    const stored = record.get('PasswordHash') || '';

    if (!(await checkPassword(password, stored))) {
        return T.json(401, { error: 'Invalid email or password' }, 'POST');
    }

    const fields = { LastLogin: T.nowISO() };
    if (shouldMigrate(stored)) fields.PasswordHash = await hashPassword(password);
    if (body.deviceToken) fields.DeviceToken = String(body.deviceToken);

    let updated = record;
    try {
        const res = await base(T.TABLES.USERS).update([{ id: record.id, fields }], { typecast: true });
        updated = res[0];
    } catch (e) { /* never fail a login on a bookkeeping write */ }

    const user = shape(updated);
    return T.ok({ success: true, token: tokenFor(user), user }, 'POST');
}

async function me(event, base) {
    const ctx = T.userContext(event);
    if (!ctx) return T.unauthorized('POST');

    let record;
    try {
        record = await base(T.TABLES.USERS).find(ctx.userId);
    } catch (e) {
        return T.notFound('Account not found', 'POST');
    }

    const user = shape(record);

    // Everyone this user follows, with enough tenant detail to render the list.
    const follows = await T.fetchAll(base, T.TABLES.FOLLOWS, {
        filterByFormula: `{UserID} = '${T.esc(ctx.userId)}'`
    });

    let following = [];
    if (follows.length) {
        const ids = follows.map(f => f.get('TenantID')).filter(Boolean);
        const formula = `OR(${ids.map(id => `RECORD_ID() = '${T.esc(id)}'`).join(',')})`;
        try {
            const tenants = await T.fetchAll(base, T.TABLES.TENANTS, { filterByFormula: formula });
            const byId = new Map(tenants.map(t => [t.id, T.hydrateTenant(t)]));
            following = follows.map(f => {
                const t = byId.get(f.get('TenantID'));
                return {
                    followId: f.id,
                    tenantId: f.get('TenantID'),
                    muted: !!f.get('Muted'),
                    since: f.get('CreatedAt') || '',
                    name: t ? (t.company || t.name) : '',
                    slug: t ? t.slug : '',
                    logoUrl: t ? t.logoUrl : '',
                    tagline: t ? t.tagline : ''
                };
            }).filter(f => f.name);
        } catch (e) { /* degrade to the raw follow list */ }
    }

    return T.ok({ user, following }, 'POST');
}

async function update(event, body, base) {
    const ctx = T.userContext(event);
    if (!ctx) return T.unauthorized('POST');

    const fields = {};
    if (body.name !== undefined) fields.Name = String(body.name).trim();
    if (body.pushOptIn !== undefined) fields.PushOptIn = !!body.pushOptIn;
    if (body.deviceToken !== undefined) fields.DeviceToken = String(body.deviceToken);
    if (body.regionSlug || body.regionId) {
        fields.HomeRegionID = (await resolveRegion(base, body.regionSlug, body.regionId)) || '';
    }
    if (body.password) {
        if (String(body.password).length < 6) return T.bad('Password must be at least 6 characters', 'POST');
        fields.PasswordHash = await hashPassword(body.password);
    }

    if (!Object.keys(fields).length) return T.bad('No fields to update', 'POST');

    const updated = await base(T.TABLES.USERS).update([{ id: ctx.userId, fields }], { typecast: true });
    return T.ok({ success: true, user: shape(updated[0]) }, 'POST');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveRegion(base, slug, id) {
    if (id) return String(id);
    if (!slug) return null;
    try {
        const rows = await base(T.TABLES.REGIONS).select({
            filterByFormula: `{Slug} = '${T.esc(slug)}'`,
            maxRecords: 1
        }).firstPage();
        return rows.length ? rows[0].id : null;
    } catch (e) {
        return null;
    }
}

async function createFollow(base, userId, tenantId, regionId) {
    const created = await base(T.TABLES.FOLLOWS).create([{
        fields: {
            FollowID: T.makeId('fol'),
            UserID: userId,
            TenantID: String(tenantId),
            RegionID: regionId || '',
            CreatedAt: T.nowISO(),
            Muted: false
        }
    }], { typecast: true });
    return { followId: created[0].id, tenantId: String(tenantId) };
}

function tokenFor(user) {
    return jwt.sign(
        {
            userId: user.id,
            email: user.email,
            name: user.name,
            role: 'user',              // NOT 'client' — a user can never reach a tenant endpoint
            regionId: user.homeRegionId
        },
        T.JWT_SECRET(),
        { expiresIn: '30d' }           // shoppers should not be logged out weekly
    );
}

function shape(r) {
    return {
        id: r.id,
        email: r.get('Email') || '',
        name: r.get('Name') || '',
        homeRegionId: r.get('HomeRegionID') || '',
        pushOptIn: !!r.get('PushOptIn'),
        hasDeviceToken: !!r.get('DeviceToken'),
        createdAt: r.get('CreatedAt') || '',
        lastLogin: r.get('LastLogin') || ''
    };
}
