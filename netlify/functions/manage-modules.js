const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * /api/manage-modules — the value modules: events, wishlist/registry, restock.
 *
 *   GET  ?resource=events|wishlist|restock
 *   POST { resource, action, ... }
 *
 * These three ship together because they are ONE capability (`value_modules`)
 * and one upsell. Splitting them into three functions would mean three copies
 * of the same gate and the same ownership check.
 *
 * Each resource has public actions (a customer signing up for an event, adding
 * to a registry, asking to be told when something is back) and owner actions.
 * Public actions are explicitly enumerated — anything not on that list needs
 * the tenant's own token.
 */

const PUBLIC_ACTIONS = {
    events: ['signup', 'cancel_signup', 'list'],
    wishlist: ['create_list', 'add_item', 'claim', 'view'],
    restock: ['subscribe', 'unsubscribe']
};

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET', 'POST']);
    if (guard) return guard;

    try {
        const base = T.getBase();
        const body = event.httpMethod === 'POST' ? T.parseBody(event) : {};
        const params = event.queryStringParameters || {};
        const resource = String(body.resource || params.resource || 'events').toLowerCase();
        const action = String(body.action || '').toLowerCase();

        if (!PUBLIC_ACTIONS[resource]) {
            return T.bad(`Unknown resource "${resource}"`, 'GET, POST');
        }

        // --- public paths ---------------------------------------------------
        if (event.httpMethod === 'POST' && PUBLIC_ACTIONS[resource].includes(action)) {
            const tenantId = String(body.tenantId || '').trim();
            if (!tenantId) return T.bad('tenantId is required', 'GET, POST');
            const tenant = await T.getTenant(tenantId, base);
            if (!tenant) return T.notFound('Business not found', 'GET, POST');
            if (!C.can(tenant.caps, 'value_modules')) {
                return T.forbidden('This business does not offer that yet.', 'GET, POST');
            }
            return publicAction(resource, action, body, tenant, base, event);
        }

        // --- owner paths -----------------------------------------------------
        const ctx = T.tenantContext(event);
        if (!ctx) return T.unauthorized('GET, POST');

        if (!C.can(ctx.caps, 'value_modules')) {
            return event.httpMethod === 'GET'
                ? T.locked('Registry, restock alerts and events come with paid directory space.')
                : T.forbidden('Value modules are not enabled on this account.', 'GET, POST');
        }

        return event.httpMethod === 'GET'
            ? ownerGet(resource, params, ctx, base)
            : ownerPost(resource, action, body, ctx, base);

    } catch (error) {
        return T.serverError(error, 'GET, POST');
    }
};

// ---------------------------------------------------------------------------
// Owner — GET
// ---------------------------------------------------------------------------

async function ownerGet(resource, params, ctx, base) {
    if (resource === 'events') {
        const rows = await T.fetchAll(base, T.TABLES.EVENTS, { filterByFormula: T.tenantScope(ctx.tenantId) });
        const data = rows.map(shapeEvent).sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));

        // Signups for one event, when asked for.
        let signups = [];
        if (params.eventId) {
            const rows2 = await T.fetchAll(base, T.TABLES.EVENT_SIGNUPS, {
                filterByFormula: `AND(${T.tenantScope(ctx.tenantId)}, {EventID} = '${T.esc(params.eventId)}')`
            });
            signups = rows2.map(shapeSignup);
        }

        return T.ok({
            data,
            signups,
            counts: {
                published: data.filter(e => e.status === 'published').length,
                draft: data.filter(e => e.status === 'draft').length,
                totalSignups: data.reduce((s, e) => s + e.signupCount, 0)
            }
        }, 'GET, POST');
    }

    if (resource === 'wishlist') {
        const lists = await T.fetchAll(base, T.TABLES.WISHLISTS, { filterByFormula: T.tenantScope(ctx.tenantId) });
        const items = await T.fetchAll(base, T.TABLES.WISHLIST_ITEMS, { filterByFormula: T.tenantScope(ctx.tenantId) });
        const byList = new Map();
        items.forEach(i => {
            const k = i.get('WishlistID');
            if (!byList.has(k)) byList.set(k, []);
            byList.get(k).push(shapeWishlistItem(i));
        });
        return T.ok({
            data: lists.map(l => Object.assign(shapeWishlist(l), { items: byList.get(l.id) || [] })),
            counts: { lists: lists.length, items: items.length }
        }, 'GET, POST');
    }

    // restock
    const rows = await T.fetchAll(base, T.TABLES.RESTOCK_SUBS, { filterByFormula: T.tenantScope(ctx.tenantId) });
    const data = rows.map(shapeRestock);

    // Group by item so the owner sees demand, which is the actual value here:
    // "eleven people are waiting on this" is a reason to reorder.
    const demand = new Map();
    data.filter(s => s.status === 'waiting').forEach(s => {
        demand.set(s.itemId, (demand.get(s.itemId) || 0) + 1);
    });

    return T.ok({
        data,
        demand: Array.from(demand.entries())
            .map(([itemId, count]) => ({ itemId, waiting: count }))
            .sort((a, b) => b.waiting - a.waiting),
        counts: {
            waiting: data.filter(s => s.status === 'waiting').length,
            notified: data.filter(s => s.status === 'notified').length
        }
    }, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Owner — POST
// ---------------------------------------------------------------------------

async function ownerPost(resource, action, body, ctx, base) {
    if (resource === 'events') return ownerEvents(action, body, ctx, base);
    if (resource === 'wishlist') return ownerWishlist(action, body, ctx, base);
    return ownerRestock(action, body, ctx, base);
}

async function ownerEvents(action, body, ctx, base) {
    const table = T.TABLES.EVENTS;

    if (action === 'create') {
        if (!body.title) return T.bad('title is required', 'GET, POST');
        const created = await base(table).create([{
            fields: {
                EventID: T.makeId('evt'),
                TenantID: ctx.tenantId,
                Title: String(body.title).trim(),
                Description: T.capText(body.description),
                StartsAt: String(body.startsAt || ''),
                EndsAt: String(body.endsAt || ''),
                Location: String(body.location || '').trim(),
                Capacity: Number(body.capacity) || 0,
                SignupCount: 0,
                Price: Number(body.price) || 0,
                ImageURL: String(body.imageUrl || '').trim(),
                Status: body.publish ? 'published' : 'draft',
                CreatedAt: T.nowISO()
            }
        }], { typecast: true });
        return T.ok({ success: true, event: shapeEvent(created[0]) }, 'GET, POST');
    }

    const record = await ownedRecord(base, table, body.id, ctx.tenantId);
    if (record.error) return record.error;

    if (action === 'publish') {
        const updated = await base(table).update(
            [{ id: body.id, fields: { Status: body.published === false ? 'draft' : 'published' } }],
            { typecast: true }
        );
        return T.ok({ success: true, event: shapeEvent(updated[0]) }, 'GET, POST');
    }
    if (action === 'cancel') {
        const updated = await base(table).update([{ id: body.id, fields: { Status: 'canceled' } }], { typecast: true });
        return T.ok({ success: true, event: shapeEvent(updated[0]) }, 'GET, POST');
    }
    if (action === 'update') {
        const fields = {};
        if (body.title !== undefined) fields.Title = String(body.title).trim();
        if (body.description !== undefined) fields.Description = T.capText(body.description);
        if (body.startsAt !== undefined) fields.StartsAt = String(body.startsAt);
        if (body.endsAt !== undefined) fields.EndsAt = String(body.endsAt);
        if (body.location !== undefined) fields.Location = String(body.location).trim();
        if (body.capacity !== undefined) fields.Capacity = Number(body.capacity) || 0;
        if (body.price !== undefined) fields.Price = Number(body.price) || 0;
        if (body.imageUrl !== undefined) fields.ImageURL = String(body.imageUrl).trim();
        if (!Object.keys(fields).length) return T.bad('No fields to update', 'GET, POST');
        const updated = await base(table).update([{ id: body.id, fields }], { typecast: true });
        return T.ok({ success: true, event: shapeEvent(updated[0]) }, 'GET, POST');
    }

    return T.bad(`Unknown action "${action}"`, 'GET, POST');
}

async function ownerWishlist(action, body, ctx, base) {
    if (action === 'archive') {
        const record = await ownedRecord(base, T.TABLES.WISHLISTS, body.id, ctx.tenantId);
        if (record.error) return record.error;
        const updated = await base(T.TABLES.WISHLISTS).update(
            [{ id: body.id, fields: { Status: 'archived' } }], { typecast: true }
        );
        return T.ok({ success: true, wishlist: shapeWishlist(updated[0]) }, 'GET, POST');
    }
    return T.bad(`Unknown action "${action}"`, 'GET, POST');
}

async function ownerRestock(action, body, ctx, base) {
    if (action === 'notify') {
        // Manually notify everyone waiting on an item.
        const itemId = String(body.itemId || '').trim();
        if (!itemId) return T.bad('itemId is required', 'GET, POST');
        const waiting = await T.fetchAll(base, T.TABLES.RESTOCK_SUBS, {
            filterByFormula: `AND(${T.tenantScope(ctx.tenantId)}, {ItemID} = '${T.esc(itemId)}', {Status} = 'waiting')`
        });
        if (!waiting.length) return T.ok({ success: true, notified: 0 }, 'GET, POST');
        await T.batchWrite(base, T.TABLES.RESTOCK_SUBS,
            waiting.map(r => ({ id: r.id, fields: { Status: 'notified', NotifiedAt: T.nowISO() } })), 'update');
        return T.ok({ success: true, notified: waiting.length }, 'GET, POST');
    }
    return T.bad(`Unknown action "${action}"`, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

async function publicAction(resource, action, body, tenant, base, event) {
    const user = T.userContext(event); // optional — guests are allowed

    if (resource === 'events') {
        if (action === 'list') {
            const rows = await T.fetchAll(base, T.TABLES.EVENTS, {
                filterByFormula: `AND(${T.tenantScope(tenant.id)}, {Status} = 'published')`
            });
            return T.ok({ data: rows.map(shapeEvent).sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt))) }, 'GET, POST');
        }

        if (action === 'signup') {
            const eventId = String(body.eventId || '').trim();
            if (!eventId) return T.bad('eventId is required', 'GET, POST');

            let ev;
            try { ev = await base(T.TABLES.EVENTS).find(eventId); } catch (e) { return T.notFound('Event not found', 'GET, POST'); }
            if (!T.ownsRow(ev, tenant.id)) return T.notFound('Event not found', 'GET, POST');
            // A FULL event still takes signups — they go to the waitlist.
            // Only draft / canceled / past events are actually closed.
            const evStatus = ev.get('Status');
            if (evStatus !== 'published' && evStatus !== 'full') {
                return T.conflict('That event is not open for signups.', 'GET, POST');
            }

            const capacity = Number(ev.get('Capacity')) || 0;
            const taken = Number(ev.get('SignupCount')) || 0;
            const guests = Math.max(0, Number(body.guests) || 0);
            const seats = 1 + guests;

            // Over capacity goes to the waitlist rather than being refused —
            // a waitlist is information the owner wants.
            // Already full, or this party would overflow it → waitlist.
            const status = evStatus === 'full' || (capacity > 0 && taken + seats > capacity)
                ? 'waitlist'
                : 'going';

            const created = await base(T.TABLES.EVENT_SIGNUPS).create([{
                fields: {
                    SignupID: T.makeId('sgn'),
                    EventID: eventId,
                    TenantID: tenant.id,
                    UserID: user ? user.userId : '',
                    Name: String(body.name || (user ? user.name : '')).trim(),
                    Email: String(body.email || (user ? user.email : '')).trim().toLowerCase(),
                    Guests: guests,
                    Status: status,
                    CreatedAt: T.nowISO()
                }
            }], { typecast: true });

            if (status === 'going') {
                const next = taken + seats;
                await base(T.TABLES.EVENTS).update([{
                    id: eventId,
                    fields: Object.assign(
                        { SignupCount: next },
                        capacity > 0 && next >= capacity ? { Status: 'full' } : {}
                    )
                }], { typecast: true });
            }

            return T.ok({
                success: true,
                signup: shapeSignup(created[0]),
                waitlisted: status === 'waitlist',
                message: status === 'waitlist'
                    ? "That event is full — you're on the waitlist and we'll let you know."
                    : "You're on the list."
            }, 'GET, POST');
        }

        if (action === 'cancel_signup') {
            if (!user) return T.unauthorized('GET, POST');
            const rows = await base(T.TABLES.EVENT_SIGNUPS).select({
                filterByFormula: `AND({EventID} = '${T.esc(body.eventId)}', {UserID} = '${T.esc(user.userId)}')`,
                maxRecords: 1
            }).firstPage();
            if (!rows.length) return T.notFound('Signup not found', 'GET, POST');

            const wasGoing = rows[0].get('Status') === 'going';
            const seats = 1 + (Number(rows[0].get('Guests')) || 0);
            await base(T.TABLES.EVENT_SIGNUPS).update([{ id: rows[0].id, fields: { Status: 'canceled' } }], { typecast: true });

            if (wasGoing) {
                try {
                    const ev = await base(T.TABLES.EVENTS).find(body.eventId);
                    const next = Math.max(0, (Number(ev.get('SignupCount')) || 0) - seats);
                    const fields = { SignupCount: next };
                    if (ev.get('Status') === 'full') fields.Status = 'published';
                    await base(T.TABLES.EVENTS).update([{ id: body.eventId, fields }], { typecast: true });
                } catch (e) { /* the cancel already landed */ }
            }
            return T.ok({ success: true, canceled: true }, 'GET, POST');
        }
    }

    if (resource === 'wishlist') {
        if (action === 'create_list') {
            if (!user) return T.unauthorized('GET, POST');
            const created = await base(T.TABLES.WISHLISTS).create([{
                fields: {
                    WishlistID: T.makeId('wsh'),
                    TenantID: tenant.id,
                    UserID: user.userId,
                    Title: String(body.title || 'My list').trim(),
                    Kind: body.kind === 'registry' ? 'registry' : 'wishlist',
                    ShareCode: T.makeId('share').replace('share_', ''),
                    EventDate: String(body.eventDate || ''),
                    Status: 'active',
                    CreatedAt: T.nowISO()
                }
            }], { typecast: true });
            return T.ok({ success: true, wishlist: shapeWishlist(created[0]) }, 'GET, POST');
        }

        if (action === 'add_item') {
            if (!user) return T.unauthorized('GET, POST');
            const listId = String(body.wishlistId || '').trim();
            if (!listId) return T.bad('wishlistId is required', 'GET, POST');

            let list;
            try { list = await base(T.TABLES.WISHLISTS).find(listId); } catch (e) { return T.notFound('List not found', 'GET, POST'); }
            if (String(list.get('UserID')) !== user.userId) {
                return T.forbidden('That list belongs to someone else.', 'GET, POST');
            }

            const created = await base(T.TABLES.WISHLIST_ITEMS).create([{
                fields: {
                    WishlistItemID: T.makeId('wsi'),
                    WishlistID: listId,
                    TenantID: tenant.id,
                    ItemID: String(body.itemId || ''),
                    Name: String(body.name || '').trim(),
                    Quantity: Math.max(1, Number(body.quantity) || 1),
                    ClaimedCount: 0,
                    ClaimedBy: '',
                    Status: 'open',
                    Note: T.capText(body.note),
                    CreatedAt: T.nowISO()
                }
            }], { typecast: true });
            return T.ok({ success: true, item: shapeWishlistItem(created[0]) }, 'GET, POST');
        }

        if (action === 'claim') {
            // Claiming is what stops two people buying the same gift.
            const itemId = String(body.wishlistItemId || '').trim();
            if (!itemId) return T.bad('wishlistItemId is required', 'GET, POST');

            let item;
            try { item = await base(T.TABLES.WISHLIST_ITEMS).find(itemId); } catch (e) { return T.notFound('Item not found', 'GET, POST'); }
            if (!T.ownsRow(item, tenant.id)) return T.notFound('Item not found', 'GET, POST');

            const quantity = Number(item.get('Quantity')) || 1;
            const claimed = Number(item.get('ClaimedCount')) || 0;
            if (claimed >= quantity) return T.conflict('Someone already claimed that one.', 'GET, POST');

            const next = claimed + 1;
            const claimedBy = String(item.get('ClaimedBy') || '').split(',').filter(Boolean);
            claimedBy.push(user ? user.userId : `guest:${String(body.name || 'someone').trim()}`);

            const updated = await base(T.TABLES.WISHLIST_ITEMS).update([{
                id: itemId,
                fields: {
                    ClaimedCount: next,
                    ClaimedBy: claimedBy.join(','),
                    Status: next >= quantity ? 'claimed' : 'partial'
                }
            }], { typecast: true });
            return T.ok({ success: true, item: shapeWishlistItem(updated[0]) }, 'GET, POST');
        }

        if (action === 'view') {
            const code = String(body.shareCode || '').trim();
            if (!code) return T.bad('shareCode is required', 'GET, POST');
            const lists = await base(T.TABLES.WISHLISTS).select({
                filterByFormula: `{ShareCode} = '${T.esc(code)}'`,
                maxRecords: 1
            }).firstPage();
            if (!lists.length) return T.notFound('List not found', 'GET, POST');

            const items = await T.fetchAll(base, T.TABLES.WISHLIST_ITEMS, {
                filterByFormula: `{WishlistID} = '${T.esc(lists[0].id)}'`
            });
            return T.ok({
                wishlist: shapeWishlist(lists[0]),
                // Never leak WHO claimed what — that ruins the surprise.
                items: items.map(i => {
                    const s = shapeWishlistItem(i);
                    delete s.claimedBy;
                    return s;
                })
            }, 'GET, POST');
        }
    }

    if (resource === 'restock') {
        const itemId = String(body.itemId || '').trim();
        if (!itemId) return T.bad('itemId is required', 'GET, POST');
        const email = String(body.email || (user ? user.email : '')).trim().toLowerCase();
        if (!email) return T.bad('An email is required so we can tell you.', 'GET, POST');

        if (action === 'subscribe') {
            const existing = await base(T.TABLES.RESTOCK_SUBS).select({
                filterByFormula: `AND({ItemID} = '${T.esc(itemId)}', LOWER({Email}) = '${T.esc(email)}', {Status} = 'waiting')`,
                maxRecords: 1
            }).firstPage();
            if (existing.length) {
                return T.ok({ success: true, already: true, message: "You're already on the list for that." }, 'GET, POST');
            }
            const created = await base(T.TABLES.RESTOCK_SUBS).create([{
                fields: {
                    SubID: T.makeId('rst'),
                    TenantID: tenant.id,
                    ItemID: itemId,
                    UserID: user ? user.userId : '',
                    Email: email,
                    Status: 'waiting',
                    CreatedAt: T.nowISO()
                }
            }], { typecast: true });
            return T.ok({
                success: true,
                subscription: shapeRestock(created[0]),
                message: "We'll let you know the moment it's back."
            }, 'GET, POST');
        }

        if (action === 'unsubscribe') {
            const rows = await base(T.TABLES.RESTOCK_SUBS).select({
                filterByFormula: `AND({ItemID} = '${T.esc(itemId)}', LOWER({Email}) = '${T.esc(email)}', {Status} = 'waiting')`,
                maxRecords: 1
            }).firstPage();
            if (!rows.length) return T.ok({ success: true, already: true }, 'GET, POST');
            await base(T.TABLES.RESTOCK_SUBS).update([{ id: rows[0].id, fields: { Status: 'canceled' } }], { typecast: true });
            return T.ok({ success: true, unsubscribed: true }, 'GET, POST');
        }
    }

    return T.bad(`Unknown action "${action}" for ${resource}`, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ownedRecord(base, table, id, tenantId) {
    if (!id) return { error: T.bad('id is required', 'GET, POST') };
    let record;
    try {
        record = await base(table).find(id);
    } catch (e) {
        return { error: T.notFound('Not found', 'GET, POST') };
    }
    if (!T.ownsRow(record, tenantId)) {
        return { error: T.forbidden('That record belongs to another account.', 'GET, POST') };
    }
    return { record };
}

function shapeEvent(r) {
    return {
        id: r.id,
        eventId: r.get('EventID') || '',
        title: r.get('Title') || '',
        description: r.get('Description') || '',
        startsAt: r.get('StartsAt') || '',
        endsAt: r.get('EndsAt') || '',
        location: r.get('Location') || '',
        capacity: Number(r.get('Capacity')) || 0,
        signupCount: Number(r.get('SignupCount')) || 0,
        price: Number(r.get('Price')) || 0,
        imageUrl: r.get('ImageURL') || '',
        status: r.get('Status') || 'draft',
        createdAt: r.get('CreatedAt') || ''
    };
}

function shapeSignup(r) {
    return {
        id: r.id,
        signupId: r.get('SignupID') || '',
        eventId: r.get('EventID') || '',
        userId: r.get('UserID') || '',
        name: r.get('Name') || '',
        email: r.get('Email') || '',
        guests: Number(r.get('Guests')) || 0,
        status: r.get('Status') || 'going',
        createdAt: r.get('CreatedAt') || ''
    };
}

function shapeWishlist(r) {
    return {
        id: r.id,
        wishlistId: r.get('WishlistID') || '',
        userId: r.get('UserID') || '',
        title: r.get('Title') || '',
        kind: r.get('Kind') || 'wishlist',
        shareCode: r.get('ShareCode') || '',
        eventDate: r.get('EventDate') || '',
        status: r.get('Status') || 'active',
        createdAt: r.get('CreatedAt') || ''
    };
}

function shapeWishlistItem(r) {
    return {
        id: r.id,
        wishlistItemId: r.get('WishlistItemID') || '',
        wishlistId: r.get('WishlistID') || '',
        itemId: r.get('ItemID') || '',
        name: r.get('Name') || '',
        quantity: Number(r.get('Quantity')) || 1,
        claimedCount: Number(r.get('ClaimedCount')) || 0,
        claimedBy: String(r.get('ClaimedBy') || '').split(',').filter(Boolean),
        status: r.get('Status') || 'open',
        note: r.get('Note') || ''
    };
}

function shapeRestock(r) {
    return {
        id: r.id,
        subId: r.get('SubID') || '',
        itemId: r.get('ItemID') || '',
        userId: r.get('UserID') || '',
        email: r.get('Email') || '',
        status: r.get('Status') || 'waiting',
        notifiedAt: r.get('NotifiedAt') || '',
        createdAt: r.get('CreatedAt') || ''
    };
}
