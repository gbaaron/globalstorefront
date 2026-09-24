const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * /api/manage-items — the tenant's catalog (products, menu items, services).
 *
 *   GET                                → this tenant's items
 *   POST { action: create|update|delete|restock }
 *
 * Every tenant with a space gets a catalog, because a catalog is content — it
 * renders on the directory card and the space whether or not anyone can buy
 * from it. Ordering is what requires `pay_in_app`, not listing.
 *
 * `restock` is the hook for the restock-alert value module: when an item's
 * stock goes from zero to positive, everyone waiting is notified.
 */

const STATUSES = ['active', 'sold_out', 'coming_soon', 'archived'];

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET', 'POST']);
    if (guard) return guard;

    const ctx = T.tenantContext(event);
    if (!ctx) return T.unauthorized('GET, POST');

    try {
        const base = T.getBase();
        if (event.httpMethod === 'GET') return handleGet(event, ctx, base);

        const body = T.parseBody(event);
        return handlePost(body, String(body.action || '').toLowerCase(), ctx, base);
    } catch (error) {
        return T.serverError(error, 'GET, POST');
    }
};

async function handleGet(event, ctx, base) {
    const params = event.queryStringParameters || {};
    const clauses = [T.tenantScope(ctx.tenantId)];
    if (params.status && STATUSES.includes(params.status)) {
        clauses.push(`{Status} = '${T.esc(params.status)}'`);
    } else if (!params.includeArchived) {
        clauses.push(`{Status} != 'archived'`);
    }

    const rows = await T.fetchAll(base, T.TABLES.ITEMS, {
        filterByFormula: `AND(${clauses.join(',')})`,
        sort: [{ field: 'SortOrder', direction: 'asc' }]
    });

    const data = rows.map(shape);
    const categories = Array.from(new Set(data.map(i => i.category).filter(Boolean))).sort();

    return T.ok({
        data,
        categories,
        counts: STATUSES.reduce((acc, s) => { acc[s] = data.filter(i => i.status === s).length; return acc; }, {}),
        // Listing is always on; taking money is not.
        canSell: C.can(ctx.caps, 'pay_in_app'),
        canRestockAlert: C.can(ctx.caps, 'value_modules')
    }, 'GET, POST');
}

async function handlePost(body, action, ctx, base) {
    const table = T.TABLES.ITEMS;

    if (action === 'create') {
        if (!body.name) return T.bad('name is required', 'GET, POST');
        const created = await base(table).create([{
            fields: {
                ItemID: T.makeId('itm'),
                TenantID: ctx.tenantId,
                Name: String(body.name).trim(),
                Description: T.capText(body.description),
                Price: Number(body.price) || 0,
                Category: String(body.category || '').trim(),
                ImageURL: String(body.imageUrl || '').trim(),
                Status: STATUSES.includes(String(body.status)) ? body.status : 'active',
                SortOrder: Number(body.sortOrder) || 0,
                StockCount: Number(body.stockCount) || 0,
                CreatedAt: T.nowISO()
            }
        }], { typecast: true });
        return T.ok({ success: true, item: shape(created[0]) }, 'GET, POST');
    }

    if (!body.id) return T.bad('id is required', 'GET, POST');

    let record;
    try {
        record = await base(table).find(body.id);
    } catch (e) {
        return T.notFound('Item not found', 'GET, POST');
    }
    if (!T.ownsRow(record, ctx.tenantId)) {
        return T.forbidden('That item belongs to another account.', 'GET, POST');
    }

    if (action === 'delete') {
        await base(table).update([{ id: body.id, fields: { Status: 'archived' } }], { typecast: true });
        return T.ok({ success: true, id: body.id, status: 'archived' }, 'GET, POST');
    }

    if (action === 'update' || action === 'restock') {
        const wasOutOfStock = (Number(record.get('StockCount')) || 0) <= 0;

        const fields = {};
        if (body.name !== undefined) fields.Name = String(body.name).trim();
        if (body.description !== undefined) fields.Description = T.capText(body.description);
        if (body.price !== undefined) fields.Price = Number(body.price) || 0;
        if (body.category !== undefined) fields.Category = String(body.category).trim();
        if (body.imageUrl !== undefined) fields.ImageURL = String(body.imageUrl).trim();
        if (body.sortOrder !== undefined) fields.SortOrder = Number(body.sortOrder) || 0;
        if (body.status !== undefined && STATUSES.includes(String(body.status))) fields.Status = body.status;
        if (body.stockCount !== undefined) fields.StockCount = Number(body.stockCount) || 0;

        if (!Object.keys(fields).length) return T.bad('No fields to update', 'GET, POST');

        const updated = await base(table).update([{ id: body.id, fields }], { typecast: true });
        const nowInStock = (Number(updated[0].get('StockCount')) || 0) > 0;

        // Zero → positive is the restock event. Notify everyone waiting.
        let notified = 0;
        if (wasOutOfStock && nowInStock && C.can(ctx.caps, 'value_modules')) {
            notified = await notifyRestock(base, ctx.tenantId, body.id)
                .catch(e => { console.error('Restock notify failed (non-blocking):', e.message); return 0; });
        }

        return T.ok({ success: true, item: shape(updated[0]), restockNotified: notified }, 'GET, POST');
    }

    return T.bad(`Unknown action "${action}"`, 'GET, POST');
}

/**
 * Mark every waiting restock subscription as notified.
 * Actual delivery rides on the same provider gate as push — with no provider
 * key set this records the intent without transmitting.
 */
async function notifyRestock(base, tenantId, itemId) {
    const waiting = await T.fetchAll(base, T.TABLES.RESTOCK_SUBS, {
        filterByFormula: `AND(${T.tenantScope(tenantId)}, {ItemID} = '${T.esc(itemId)}', {Status} = 'waiting')`
    });
    if (!waiting.length) return 0;

    const updates = waiting.map(r => ({
        id: r.id,
        fields: { Status: 'notified', NotifiedAt: T.nowISO() }
    }));
    await T.batchWrite(base, T.TABLES.RESTOCK_SUBS, updates, 'update');
    return waiting.length;
}

function shape(r) {
    return {
        id: r.id,
        itemId: r.get('ItemID') || '',
        name: r.get('Name') || '',
        description: r.get('Description') || '',
        price: r.get('Price') || 0,
        category: r.get('Category') || '',
        imageUrl: r.get('ImageURL') || '',
        status: r.get('Status') || 'active',
        sortOrder: r.get('SortOrder') || 0,
        stockCount: r.get('StockCount') || 0,
        createdAt: r.get('CreatedAt') || ''
    };
}
