const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * /api/manage-content — content & hours, edited ONCE.
 *
 * Whatever a tenant writes here renders on every surface they own: their space,
 * their website, their app, and their directory card. There is no per-surface
 * copy to keep in sync, because there is no per-surface copy.
 *
 *   GET  ?resource=content|hours|all
 *   POST { resource, action: create|update|delete|publish|reorder, ... }
 *
 * Every tenant has `content_hours` (it comes with having a space), so this is
 * the one dashboard module with no upgrade gate.
 */

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const KINDS = ['about', 'announcement', 'photo', 'menu_note', 'policy', 'faq', 'hero'];

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET', 'POST']);
    if (guard) return guard;

    const ctx = T.tenantContext(event);
    if (!ctx) return T.unauthorized('GET, POST');

    // Having a space is unconditional, so this should never fire — but gate it
    // explicitly rather than assuming.
    if (!C.can(ctx.caps, 'content_hours')) {
        return T.forbidden('Content management is not enabled on this account.', 'GET, POST');
    }

    try {
        const base = T.getBase();
        return event.httpMethod === 'GET'
            ? await handleGet(event, ctx, base)
            : await handlePost(event, ctx, base);
    } catch (error) {
        return T.serverError(error, 'GET, POST');
    }
};

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

async function handleGet(event, ctx, base) {
    const resource = String((event.queryStringParameters || {}).resource || 'all').toLowerCase();
    const out = {};

    if (resource === 'content' || resource === 'all') {
        const rows = await T.fetchAll(base, T.TABLES.CONTENT, {
            filterByFormula: T.tenantScope(ctx.tenantId),
            sort: [{ field: 'SortOrder', direction: 'asc' }]
        });
        out.content = rows.map(shapeContent);
    }

    if (resource === 'hours' || resource === 'all') {
        const rows = await T.fetchAll(base, T.TABLES.HOURS, {
            filterByFormula: T.tenantScope(ctx.tenantId)
        });
        const byDay = new Map(rows.map(r => [String(r.get('Day') || '').toLowerCase(), r]));
        // Always return all seven days so the editor renders a complete week,
        // whether or not a row exists yet.
        out.hours = DAYS.map(day => {
            const r = byDay.get(day);
            return r ? shapeHours(r) : {
                id: null, day, open: '', close: '', closed: true, note: ''
            };
        });
    }

    // Which surfaces this content will appear on — shown in the editor so the
    // owner can see the reach of a single edit.
    out.surfaces = surfaceList(ctx.caps);
    return T.ok(out, 'GET, POST');
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

async function handlePost(event, ctx, base) {
    const body = T.parseBody(event);
    const resource = String(body.resource || 'content').toLowerCase();
    const action = String(body.action || '').toLowerCase();

    if (resource === 'hours') return handleHours(body, action, ctx, base);
    return handleContent(body, action, ctx, base);
}

async function handleContent(body, action, ctx, base) {
    const table = T.TABLES.CONTENT;

    if (action === 'create') {
        const kind = KINDS.includes(String(body.kind)) ? body.kind : 'about';
        const created = await base(table).create([{
            fields: {
                ContentID: T.makeId('cnt'),
                TenantID: ctx.tenantId,
                Kind: kind,
                Title: String(body.title || '').trim(),
                Body: T.capText(body.body),
                ImageURL: String(body.imageUrl || '').trim(),
                SortOrder: Number(body.sortOrder) || 0,
                Status: body.publish ? 'published' : 'draft',
                CreatedAt: T.nowISO(),
                UpdatedAt: T.nowISO()
            }
        }], { typecast: true });
        return T.ok({ success: true, item: shapeContent(created[0]) }, 'GET, POST');
    }

    if (!body.id) return T.bad('id is required', 'GET, POST');

    // Ownership check on every single row touched.
    let record;
    try {
        record = await base(table).find(body.id);
    } catch (e) {
        return T.notFound('Content not found', 'GET, POST');
    }
    if (!T.ownsRow(record, ctx.tenantId)) {
        return T.forbidden('That content belongs to another account.', 'GET, POST');
    }

    if (action === 'delete') {
        // Soft delete — archived rows stop rendering but stay recoverable.
        await base(table).update([{ id: body.id, fields: { Status: 'archived', UpdatedAt: T.nowISO() } }], { typecast: true });
        return T.ok({ success: true, id: body.id, status: 'archived' }, 'GET, POST');
    }

    if (action === 'publish') {
        const status = body.published === false ? 'draft' : 'published';
        const updated = await base(table).update([{ id: body.id, fields: { Status: status, UpdatedAt: T.nowISO() } }], { typecast: true });
        return T.ok({ success: true, item: shapeContent(updated[0]) }, 'GET, POST');
    }

    if (action === 'update') {
        const fields = { UpdatedAt: T.nowISO() };
        if (body.title !== undefined) fields.Title = String(body.title).trim();
        if (body.body !== undefined) fields.Body = T.capText(body.body);
        if (body.imageUrl !== undefined) fields.ImageURL = String(body.imageUrl).trim();
        if (body.sortOrder !== undefined) fields.SortOrder = Number(body.sortOrder) || 0;
        if (body.kind !== undefined && KINDS.includes(String(body.kind))) fields.Kind = body.kind;
        const updated = await base(table).update([{ id: body.id, fields }], { typecast: true });
        return T.ok({ success: true, item: shapeContent(updated[0]) }, 'GET, POST');
    }

    return T.bad(`Unknown action "${action}"`, 'GET, POST');
}

async function handleHours(body, action, ctx, base) {
    const table = T.TABLES.HOURS;

    if (action !== 'update' && action !== 'set') {
        return T.bad('Hours support action "set"', 'GET, POST');
    }

    // Accept the whole week at once — the editor is a week grid, so a single
    // save writes every changed day together.
    const week = Array.isArray(body.hours) ? body.hours : [body];

    const existing = await T.fetchAll(base, table, {
        filterByFormula: T.tenantScope(ctx.tenantId)
    });
    const byDay = new Map(existing.map(r => [String(r.get('Day') || '').toLowerCase(), r]));

    const creates = [];
    const updates = [];

    for (const entry of week) {
        const day = String(entry.day || '').toLowerCase();
        if (!DAYS.includes(day)) continue;

        const fields = {
            TenantID: ctx.tenantId,
            Day: day,
            OpenTime: String(entry.open || '').trim(),
            CloseTime: String(entry.close || '').trim(),
            Closed: C.toBool(entry.closed),
            Note: String(entry.note || '').trim()
        };

        const found = byDay.get(day);
        if (found) {
            updates.push({ id: found.id, fields });
        } else {
            creates.push({ fields: Object.assign({ HoursID: T.makeId('hrs') }, fields) });
        }
    }

    if (creates.length) await T.batchWrite(base, table, creates, 'create');
    if (updates.length) await T.batchWrite(base, table, updates, 'update');

    const refreshed = await T.fetchAll(base, table, {
        filterByFormula: T.tenantScope(ctx.tenantId)
    });
    const map = new Map(refreshed.map(r => [String(r.get('Day') || '').toLowerCase(), r]));

    return T.ok({
        success: true,
        hours: DAYS.map(d => (map.has(d) ? shapeHours(map.get(d)) : { id: null, day: d, open: '', close: '', closed: true, note: '' }))
    }, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function shapeContent(r) {
    return {
        id: r.id,
        contentId: r.get('ContentID') || '',
        kind: r.get('Kind') || 'about',
        title: r.get('Title') || '',
        body: r.get('Body') || '',
        imageUrl: r.get('ImageURL') || '',
        sortOrder: r.get('SortOrder') || 0,
        status: r.get('Status') || 'draft',
        updatedAt: r.get('UpdatedAt') || ''
    };
}

function shapeHours(r) {
    return {
        id: r.id,
        day: String(r.get('Day') || '').toLowerCase(),
        open: r.get('OpenTime') || '',
        close: r.get('CloseTime') || '',
        closed: C.toBool(r.get('Closed')),
        note: r.get('Note') || ''
    };
}

/** The surfaces a single edit will reach — rendered as reassurance in the editor. */
function surfaceList(caps) {
    const out = [{ key: 'space', label: 'Your Global Storefront space' }];
    if (C.can(caps, 'website')) out.push({ key: 'website', label: 'Your website' });
    if (C.can(caps, 'app_surface')) out.push({ key: 'app', label: 'Your app' });
    if (C.can(caps, 'directory_listing')) out.push({ key: 'directory', label: 'Your directory listing' });
    return out;
}
