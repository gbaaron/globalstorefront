const T = require('./lib/tenants');
const C = require('./lib/capabilities');

/**
 * /api/manage-bookings — slots, appointments and jobs.
 *
 *   GET  ?from=&to=&status=      → this tenant's bookings
 *   POST { action: 'create' }    → owner books someone in
 *   POST { action: 'request' }   → PUBLIC: a customer requests a slot
 *   POST { action: 'confirm' | 'complete' | 'cancel' | 'no_show' }
 *   POST { action: 'availability', date } → open slots for a date
 *
 * `request` is the one public action — a customer on any surface can ask for a
 * slot without an account. Everything else requires the tenant's own token.
 */

const STATUSES = ['requested', 'confirmed', 'completed', 'canceled', 'no_show'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET', 'POST']);
    if (guard) return guard;

    try {
        const base = T.getBase();
        const body = event.httpMethod === 'POST' ? T.parseBody(event) : {};
        const action = String(body.action || '').toLowerCase();

        // --- public paths: a customer requesting a slot, or reading availability
        if (event.httpMethod === 'POST' && (action === 'request' || action === 'availability')) {
            return action === 'request'
                ? publicRequest(body, base)
                : publicAvailability(body, base);
        }

        // --- everything else is the owner ---------------------------------
        const ctx = T.tenantContext(event);
        if (!ctx) return T.unauthorized('GET, POST');

        if (!C.can(ctx.caps, 'bookings')) {
            return event.httpMethod === 'GET'
                ? T.locked('Bookings are included with paid directory space.')
                : T.forbidden('Bookings are not enabled on this account.', 'GET, POST');
        }

        return event.httpMethod === 'GET'
            ? handleGet(event, ctx, base)
            : handleOwnerPost(body, action, ctx, base);

    } catch (error) {
        return T.serverError(error, 'GET, POST');
    }
};

// ---------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------

async function handleGet(event, ctx, base) {
    const params = event.queryStringParameters || {};
    const clauses = [T.tenantScope(ctx.tenantId)];
    if (params.status && STATUSES.includes(params.status)) {
        clauses.push(`{Status} = '${T.esc(params.status)}'`);
    }
    if (params.from) clauses.push(`{StartsAt} >= '${T.esc(params.from)}'`);
    if (params.to) clauses.push(`{StartsAt} <= '${T.esc(params.to)}'`);

    const rows = await T.fetchAll(base, T.TABLES.BOOKINGS, {
        filterByFormula: clauses.length > 1 ? `AND(${clauses.join(',')})` : clauses[0]
    });

    const data = rows.map(shape).sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));

    const counts = STATUSES.reduce((acc, s) => {
        acc[s] = data.filter(b => b.status === s).length;
        return acc;
    }, {});

    const now = Date.now();
    return T.ok({
        data,
        counts,
        upcoming: data.filter(b => new Date(b.startsAt).getTime() > now && ['requested', 'confirmed'].includes(b.status)).length,
        needsAction: counts.requested || 0
    }, 'GET, POST');
}

async function handleOwnerPost(body, action, ctx, base) {
    const table = T.TABLES.BOOKINGS;

    if (action === 'create') {
        if (!body.startsAt) return T.bad('startsAt is required', 'GET, POST');
        const created = await base(table).create([{
            fields: {
                BookingID: T.makeId('bkg'),
                TenantID: ctx.tenantId,
                UserID: String(body.userId || ''),
                CustomerName: String(body.customerName || '').trim(),
                CustomerEmail: String(body.customerEmail || '').trim().toLowerCase(),
                CustomerPhone: String(body.customerPhone || '').trim(),
                Service: String(body.service || '').trim(),
                StartsAt: String(body.startsAt),
                DurationMins: Number(body.durationMins) || 30,
                Status: 'confirmed',
                Notes: T.capText(body.notes),
                Price: Number(body.price) || 0,
                CreatedAt: T.nowISO()
            }
        }], { typecast: true });
        return T.ok({ success: true, booking: shape(created[0]) }, 'GET, POST');
    }

    if (!body.id) return T.bad('id is required', 'GET, POST');

    let record;
    try {
        record = await base(table).find(body.id);
    } catch (e) {
        return T.notFound('Booking not found', 'GET, POST');
    }
    if (!T.ownsRow(record, ctx.tenantId)) {
        return T.forbidden('That booking belongs to another account.', 'GET, POST');
    }

    const transitions = {
        confirm: 'confirmed',
        complete: 'completed',
        cancel: 'canceled',
        no_show: 'no_show'
    };

    if (transitions[action]) {
        const fields = { Status: transitions[action] };
        const updated = await base(table).update([{ id: body.id, fields }], { typecast: true });

        // Completing a booking earns the customer loyalty points, when the
        // tenant has loyalty and the customer has an account.
        if (action === 'complete' && C.can(ctx.caps, 'loyalty') && record.get('UserID')) {
            await awardPoints(base, ctx.tenantId, record.get('UserID'), record.id, Number(record.get('Price')) || 0)
                .catch(e => console.error('Loyalty award failed (non-blocking):', e.message));
        }

        return T.ok({ success: true, booking: shape(updated[0]) }, 'GET, POST');
    }

    if (action === 'update') {
        const fields = {};
        if (body.startsAt !== undefined) fields.StartsAt = String(body.startsAt);
        if (body.durationMins !== undefined) fields.DurationMins = Number(body.durationMins) || 30;
        if (body.service !== undefined) fields.Service = String(body.service).trim();
        if (body.notes !== undefined) fields.Notes = T.capText(body.notes);
        if (body.price !== undefined) fields.Price = Number(body.price) || 0;
        if (body.customerName !== undefined) fields.CustomerName = String(body.customerName).trim();
        if (body.customerPhone !== undefined) fields.CustomerPhone = String(body.customerPhone).trim();
        if (!Object.keys(fields).length) return T.bad('No fields to update', 'GET, POST');
        const updated = await base(table).update([{ id: body.id, fields }], { typecast: true });
        return T.ok({ success: true, booking: shape(updated[0]) }, 'GET, POST');
    }

    return T.bad(`Unknown action "${action}"`, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** A customer requests a slot. No account required — guest bookings are normal. */
async function publicRequest(body, base) {
    const tenantId = String(body.tenantId || '').trim();
    if (!tenantId) return T.bad('tenantId is required', 'GET, POST');
    if (!body.startsAt) return T.bad('startsAt is required', 'GET, POST');
    if (!body.customerName && !body.customerEmail) {
        return T.bad('A name or email is required', 'GET, POST');
    }

    const tenant = await T.getTenant(tenantId, base);
    if (!tenant) return T.notFound('Business not found', 'GET, POST');
    if (!C.can(tenant.caps, 'bookings')) {
        return T.forbidden('This business does not take bookings.', 'GET, POST');
    }

    // Refuse a slot that collides with an existing confirmed booking.
    const clash = await hasClash(base, tenantId, body.startsAt, Number(body.durationMins) || 30);
    if (clash) return T.conflict('That time was just taken. Please pick another slot.', 'GET, POST');

    const created = await base(T.TABLES.BOOKINGS).create([{
        fields: {
            BookingID: T.makeId('bkg'),
            TenantID: tenantId,
            UserID: String(body.userId || ''),
            CustomerName: String(body.customerName || '').trim(),
            CustomerEmail: String(body.customerEmail || '').trim().toLowerCase(),
            CustomerPhone: String(body.customerPhone || '').trim(),
            Service: String(body.service || '').trim(),
            StartsAt: String(body.startsAt),
            DurationMins: Number(body.durationMins) || 30,
            Status: 'requested',
            Notes: T.capText(body.notes),
            Price: Number(body.price) || 0,
            CreatedAt: T.nowISO()
        }
    }], { typecast: true });

    return T.ok({
        success: true,
        booking: shape(created[0]),
        message: `Thanks — ${tenant.company || tenant.name} will confirm shortly.`
    }, 'GET, POST');
}

/**
 * Open slots for a date, derived from the tenant's own opening hours minus
 * anything already booked. Hours are the single source of truth here too.
 */
async function publicAvailability(body, base) {
    const tenantId = String(body.tenantId || '').trim();
    const date = String(body.date || '').trim(); // YYYY-MM-DD
    if (!tenantId || !date) return T.bad('tenantId and date are required', 'GET, POST');

    const tenant = await T.getTenant(tenantId, base);
    if (!tenant) return T.notFound('Business not found', 'GET, POST');
    if (!C.can(tenant.caps, 'bookings')) {
        return T.forbidden('This business does not take bookings.', 'GET, POST');
    }

    const slotMins = Number(body.durationMins) || 30;
    const dayName = DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];

    const hoursRows = await T.fetchAll(base, T.TABLES.HOURS, {
        filterByFormula: `AND(${T.tenantScope(tenantId)}, {Day} = '${T.esc(dayName)}')`
    });
    const today = hoursRows[0];
    if (!today || C.toBool(today.get('Closed')) || !today.get('OpenTime') || !today.get('CloseTime')) {
        return T.ok({ date, day: dayName, open: false, slots: [] }, 'GET, POST');
    }

    const booked = await T.fetchAll(base, T.TABLES.BOOKINGS, {
        filterByFormula: `AND(${T.tenantScope(tenantId)}, OR({Status} = 'confirmed', {Status} = 'requested'))`
    });
    const taken = booked
        .map(b => ({ start: new Date(b.get('StartsAt')).getTime(), mins: Number(b.get('DurationMins')) || 30 }))
        .filter(b => !isNaN(b.start));

    const toMins = (s) => {
        const [h, m] = String(s).split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
    };
    const openM = toMins(today.get('OpenTime'));
    const closeM = toMins(today.get('CloseTime'));

    const slots = [];
    const nowMs = Date.now();
    for (let m = openM; m + slotMins <= closeM; m += slotMins) {
        const hh = String(Math.floor(m / 60)).padStart(2, '0');
        const mm = String(m % 60).padStart(2, '0');
        const iso = `${date}T${hh}:${mm}:00`;
        const startMs = new Date(iso).getTime();
        if (startMs < nowMs) continue; // never offer a slot in the past
        const clash = taken.some(t => startMs < t.start + t.mins * 60000 && t.start < startMs + slotMins * 60000);
        if (!clash) slots.push({ time: `${hh}:${mm}`, startsAt: iso });
    }

    return T.ok({ date, day: dayName, open: true, slotMins, slots, note: today.get('Note') || '' }, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hasClash(base, tenantId, startsAt, durationMins) {
    const start = new Date(startsAt).getTime();
    if (isNaN(start)) return false;
    const end = start + durationMins * 60000;
    const rows = await T.fetchAll(base, T.TABLES.BOOKINGS, {
        filterByFormula: `AND(${T.tenantScope(tenantId)}, OR({Status} = 'confirmed', {Status} = 'requested'))`
    });
    return rows.some(r => {
        const s = new Date(r.get('StartsAt')).getTime();
        if (isNaN(s)) return false;
        const e = s + (Number(r.get('DurationMins')) || 30) * 60000;
        return start < e && s < end;
    });
}

/** One point per dollar, floored, minimum 5 for any completed booking. */
async function awardPoints(base, tenantId, userId, bookingId, price) {
    const delta = Math.max(5, Math.floor(price));
    return base(T.TABLES.POINTS_LEDGER).create([{
        fields: {
            EntryID: T.makeId('pts'),
            UserID: userId,
            TenantID: tenantId,
            Delta: delta,
            Reason: 'Completed booking',
            Source: 'booking',
            RefID: bookingId,
            Timestamp: T.nowISO()
        }
    }], { typecast: true });
}

function shape(r) {
    return {
        id: r.id,
        bookingId: r.get('BookingID') || '',
        userId: r.get('UserID') || '',
        customerName: r.get('CustomerName') || '',
        customerEmail: r.get('CustomerEmail') || '',
        customerPhone: r.get('CustomerPhone') || '',
        service: r.get('Service') || '',
        startsAt: r.get('StartsAt') || '',
        durationMins: r.get('DurationMins') || 30,
        status: r.get('Status') || 'requested',
        notes: r.get('Notes') || '',
        price: r.get('Price') || 0,
        createdAt: r.get('CreatedAt') || ''
    };
}
