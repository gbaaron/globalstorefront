const T = require('./lib/tenants');
const C = require('./lib/capabilities');
const { splitTransaction, GS_CUT_RATE } = require('./lib/tiers');

/**
 * /api/manage-invoices — invoices and the three payment states.
 *
 *   GET                          → this tenant's invoices + payment posture
 *   POST { action: 'create' }    → draft an invoice
 *   POST { action: 'send' }      → mark sent
 *   POST { action: 'pay' }       → record a payment
 *   POST { action: 'void' }
 *   POST { action: 'view' }      → PUBLIC: a customer opens an invoice by number
 *
 * PAYMENT CHANNEL IS A FLAG, NOT AN ASSUMPTION:
 *
 *   us     → invoice AND pay inside the app. We are the channel, so the 10/90
 *            split applies and a Transactions row is written.
 *   theirs → they already take payment on their own site. We issue the invoice
 *            as a document and DO NOT touch the money — no split, no Transaction.
 *   none   → attention only. No invoicing at all.
 *
 * Money only moves through a compliant processor. This function never holds
 * funds and never stores card data; `pay` records that a payment happened,
 * and stripe-webhook.js is what hears from the processor.
 */

exports.handler = async (event) => {
    const guard = T.guardMethod(event, ['GET', 'POST']);
    if (guard) return guard;

    try {
        const base = T.getBase();
        const body = event.httpMethod === 'POST' ? T.parseBody(event) : {};
        const action = String(body.action || '').toLowerCase();

        if (event.httpMethod === 'POST' && action === 'view') {
            return publicView(body, base);
        }

        const ctx = T.tenantContext(event);
        if (!ctx) return T.unauthorized('GET, POST');

        if (!C.can(ctx.caps, 'invoicing')) {
            return event.httpMethod === 'GET'
                ? T.locked('Invoicing turns on when your payment channel is set.', { paymentChannel: 'none' })
                : T.forbidden('Invoicing is not enabled on this account.', 'GET, POST');
        }

        return event.httpMethod === 'GET'
            ? handleGet(event, ctx, base)
            : handlePost(body, action, ctx, base);

    } catch (error) {
        return T.serverError(error, 'GET, POST');
    }
};

// ---------------------------------------------------------------------------

async function handleGet(event, ctx, base) {
    const params = event.queryStringParameters || {};
    const clauses = [T.tenantScope(ctx.tenantId)];
    if (params.status) clauses.push(`{Status} = '${T.esc(params.status)}'`);

    const rows = await T.fetchAll(base, T.TABLES.INVOICES, {
        filterByFormula: clauses.length > 1 ? `AND(${clauses.join(',')})` : clauses[0]
    });

    const data = rows.map(shape).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const now = Date.now();

    // Overdue is derived, not stored — a due date in the past on an unpaid
    // invoice. Storing it would mean a nightly job just to keep it true.
    data.forEach(inv => {
        inv.overdue = ['sent', 'partial'].includes(inv.status) &&
            inv.dueDate && new Date(inv.dueDate).getTime() < now;
    });

    const tenant = await T.getTenant(ctx.tenantId, base);
    const channel = tenant ? tenant.paymentChannel : 'none';

    return T.ok({
        data,
        summary: {
            outstanding: data.filter(i => ['sent', 'partial', 'overdue'].includes(i.status))
                .reduce((s, i) => s + (i.total - i.amountPaid), 0),
            paid: data.filter(i => i.status === 'paid').reduce((s, i) => s + i.total, 0),
            overdueCount: data.filter(i => i.overdue).length,
            draftCount: data.filter(i => i.status === 'draft').length
        },
        payment: describeChannel(channel, ctx.caps)
    }, 'GET, POST');
}

async function handlePost(body, action, ctx, base) {
    const table = T.TABLES.INVOICES;
    const tenant = await T.getTenant(ctx.tenantId, base);
    const channel = tenant ? tenant.paymentChannel : 'none';

    if (action === 'create') {
        const lineItems = Array.isArray(body.lineItems) ? body.lineItems : [];
        if (!lineItems.length) return T.bad('At least one line item is required', 'GET, POST');

        const subtotal = round2(lineItems.reduce((s, li) =>
            s + (Number(li.price) || 0) * (Number(li.quantity) || 1), 0));
        const tax = round2(Number(body.tax) || 0);
        const total = round2(subtotal + tax);

        const created = await base(table).create([{
            fields: {
                InvoiceID: T.makeId('inv'),
                TenantID: ctx.tenantId,
                UserID: String(body.userId || ''),
                Number: String(body.number || '').trim() || await nextNumber(base, ctx.tenantId),
                CustomerName: String(body.customerName || '').trim(),
                CustomerEmail: String(body.customerEmail || '').trim().toLowerCase(),
                LineItems: T.capText(JSON.stringify(lineItems)),
                Subtotal: subtotal,
                Tax: tax,
                Total: total,
                AmountPaid: 0,
                Status: 'draft',
                PaymentChannel: channel,
                DueDate: String(body.dueDate || '').trim(),
                CreatedAt: T.nowISO()
            }
        }], { typecast: true });

        return T.ok({ success: true, invoice: shape(created[0]), payment: describeChannel(channel, ctx.caps) }, 'GET, POST');
    }

    if (!body.id) return T.bad('id is required', 'GET, POST');

    let record;
    try {
        record = await base(table).find(body.id);
    } catch (e) {
        return T.notFound('Invoice not found', 'GET, POST');
    }
    if (!T.ownsRow(record, ctx.tenantId)) {
        return T.forbidden('That invoice belongs to another account.', 'GET, POST');
    }

    if (action === 'send') {
        const updated = await base(table).update([{ id: body.id, fields: { Status: 'sent' } }], { typecast: true });
        return T.ok({ success: true, invoice: shape(updated[0]) }, 'GET, POST');
    }

    if (action === 'void') {
        if (record.get('Status') === 'paid') {
            return T.conflict('A paid invoice cannot be voided. Refund it instead.', 'GET, POST');
        }
        const updated = await base(table).update([{ id: body.id, fields: { Status: 'void' } }], { typecast: true });
        return T.ok({ success: true, invoice: shape(updated[0]) }, 'GET, POST');
    }

    if (action === 'pay') {
        const amount = round2(Number(body.amount) || 0);
        if (amount <= 0) return T.bad('amount must be greater than zero', 'GET, POST');

        const total = Number(record.get('Total')) || 0;
        const already = Number(record.get('AmountPaid')) || 0;
        const paid = round2(already + amount);
        if (paid > total + 0.01) {
            return T.bad(`That overpays the invoice. Outstanding: ${round2(total - already)}.`, 'GET, POST');
        }

        const fields = {
            AmountPaid: paid,
            Status: paid >= total - 0.01 ? 'paid' : 'partial'
        };
        if (fields.Status === 'paid') fields.PaidAt = T.nowISO();
        if (body.stripePaymentId) fields.StripePaymentId = String(body.stripePaymentId);

        const updated = await base(table).update([{ id: body.id, fields }], { typecast: true });

        // THE SPLIT ONLY APPLIES WHEN WE ARE THE CHANNEL.
        // If the tenant takes payment on their own site, we recorded a document
        // and nothing else — taking a cut of money we never touched would be
        // both wrong and unenforceable.
        let transaction = null;
        if (channel === 'us' && C.can(ctx.caps, 'transaction_split')) {
            const split = splitTransaction(amount);
            const txn = await base(T.TABLES.TRANSACTIONS).create([{
                fields: {
                    TransactionID: T.makeId('txn'),
                    ClientID: ctx.tenantId,
                    Amount: split.amount,
                    GSCut: split.gsCut,
                    ClientNet: split.clientNet,
                    StripePaymentId: String(body.stripePaymentId || ''),
                    Status: 'succeeded',
                    PayoutStatus: 'pending',
                    CustomerEmail: record.get('CustomerEmail') || '',
                    Description: `Invoice ${record.get('Number') || ''}`,
                    Date: T.nowISO()
                }
            }], { typecast: true });
            transaction = {
                id: txn[0].id,
                amount: split.amount,
                gsCut: split.gsCut,
                clientNet: split.clientNet,
                rate: GS_CUT_RATE
            };
        }

        return T.ok({
            success: true,
            invoice: shape(updated[0]),
            transaction,
            note: channel === 'theirs'
                ? 'Recorded. You took this payment on your own site — we did not touch it.'
                : undefined
        }, 'GET, POST');
    }

    if (action === 'update') {
        if (record.get('Status') === 'paid') {
            return T.conflict('A paid invoice cannot be edited.', 'GET, POST');
        }
        const fields = {};
        if (body.customerName !== undefined) fields.CustomerName = String(body.customerName).trim();
        if (body.customerEmail !== undefined) fields.CustomerEmail = String(body.customerEmail).trim().toLowerCase();
        if (body.dueDate !== undefined) fields.DueDate = String(body.dueDate).trim();
        if (Array.isArray(body.lineItems)) {
            const subtotal = round2(body.lineItems.reduce((s, li) =>
                s + (Number(li.price) || 0) * (Number(li.quantity) || 1), 0));
            const tax = round2(body.tax !== undefined ? Number(body.tax) : Number(record.get('Tax')) || 0);
            fields.LineItems = T.capText(JSON.stringify(body.lineItems));
            fields.Subtotal = subtotal;
            fields.Tax = tax;
            fields.Total = round2(subtotal + tax);
        }
        if (!Object.keys(fields).length) return T.bad('No fields to update', 'GET, POST');
        const updated = await base(table).update([{ id: body.id, fields }], { typecast: true });
        return T.ok({ success: true, invoice: shape(updated[0]) }, 'GET, POST');
    }

    return T.bad(`Unknown action "${action}"`, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** A customer opens an invoice. Needs the invoice id AND the exact number. */
async function publicView(body, base) {
    const id = String(body.id || '').trim();
    const number = String(body.number || '').trim();
    if (!id || !number) return T.bad('id and number are required', 'GET, POST');

    let record;
    try {
        record = await base(T.TABLES.INVOICES).find(id);
    } catch (e) {
        return T.notFound('Invoice not found', 'GET, POST');
    }
    // The number acts as the shared secret — a record ID alone is not enough.
    if (String(record.get('Number')) !== number) {
        return T.notFound('Invoice not found', 'GET, POST');
    }
    if (record.get('Status') === 'draft') {
        return T.notFound('That invoice has not been sent yet.', 'GET, POST');
    }

    const tenant = await T.getTenant(record.get('TenantID') || record.get('ClientID'), base);
    const invoice = shape(record);

    return T.ok({
        invoice,
        business: tenant ? {
            name: tenant.company || tenant.name,
            logoUrl: tenant.logoUrl,
            brandColor: tenant.brandColor,
            phone: tenant.phone,
            address: tenant.address
        } : null,
        // Only offer in-app payment when we are actually the channel.
        payable: tenant ? tenant.paymentChannel === 'us' && C.can(tenant.caps, 'pay_in_app') : false
    }, 'GET, POST');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeChannel(channel, caps) {
    const map = {
        us: {
            channel: 'us',
            label: 'Paid through Global Storefront',
            canCollect: C.can(caps, 'pay_in_app'),
            split: `We keep ${Math.round(GS_CUT_RATE * 100)}% of each sale; the rest is swept to you daily.`
        },
        theirs: {
            channel: 'theirs',
            label: 'Paid on your own site',
            canCollect: false,
            split: 'We never touch your money. Invoices here are documents only.'
        },
        none: {
            channel: 'none',
            label: 'No payments',
            canCollect: false,
            split: 'This account is attention-only.'
        }
    };
    return map[channel] || map.none;
}

async function nextNumber(base, tenantId) {
    try {
        const rows = await T.fetchAll(base, T.TABLES.INVOICES, {
            filterByFormula: T.tenantScope(tenantId)
        });
        return String(1000 + rows.length + 1);
    } catch (e) {
        return String(Date.now()).slice(-6);
    }
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function shape(r) {
    let lineItems = [];
    try { lineItems = JSON.parse(r.get('LineItems') || '[]'); } catch (e) { lineItems = []; }
    return {
        id: r.id,
        invoiceId: r.get('InvoiceID') || '',
        number: r.get('Number') || '',
        customerName: r.get('CustomerName') || '',
        customerEmail: r.get('CustomerEmail') || '',
        lineItems,
        subtotal: r.get('Subtotal') || 0,
        tax: r.get('Tax') || 0,
        total: r.get('Total') || 0,
        amountPaid: r.get('AmountPaid') || 0,
        status: r.get('Status') || 'draft',
        paymentChannel: r.get('PaymentChannel') || 'none',
        dueDate: r.get('DueDate') || '',
        paidAt: r.get('PaidAt') || '',
        createdAt: r.get('CreatedAt') || ''
    };
}
