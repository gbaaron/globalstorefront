const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const { tierIncludes, normalizeTier } = require('./lib/tiers');
const { buildReportPDF } = require('./lib/report-pdf');

// Client-facing reports endpoint for the owner app.
//   GET /api/get-reports            → list this client's report rows (Period desc)
//   GET /api/get-reports?id=recXXX  → rebuild + download that report's PDF
//   GET /api/get-reports?period=Y-M → rebuild + download by period
//
// Reports rows store only summary metrics (see generate-reports.js); the binary
// PDF is rebuilt on demand here so we never hit Airtable's long-text cap.
// Gated to Growth+ (tier includes 'monthly_reports').

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
};

function verifyToken(event) {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    try {
        return jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production');
    } catch (e) {
        return null;
    }
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const decoded = verifyToken(event);
    if (!decoded || decoded.role !== 'client') {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const tier = normalizeTier(decoded.tier);
    if (!tierIncludes(tier, 'monthly_reports')) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: [], locked: true, message: 'Monthly reports are a Growth feature.' })
        };
    }

    try {
        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const params = event.queryStringParameters || {};
        const clientId = decoded.userId;

        // Company name for the PDF header.
        let company = '';
        try {
            const tenant = await base('Clients').find(clientId);
            company = tenant.get('Company') || tenant.get('Name') || '';
        } catch (e) {}

        // --- Download path: rebuild a single report's PDF ---
        if (params.id || params.period) {
            let report;
            if (params.id) {
                try {
                    report = await base('Reports').find(params.id);
                } catch (e) {
                    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Report not found' }) };
                }
                // Ownership check: a client may only fetch their own reports.
                if (report.get('ClientID') !== clientId) {
                    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
                }
            } else {
                const matches = await base('Reports').select({
                    filterByFormula: `AND({ClientID} = '${clientId}', {Period} = '${params.period}')`,
                    maxRecords: 1
                }).firstPage();
                if (!matches.length) {
                    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Report not found' }) };
                }
                report = matches[0];
            }

            const period = report.get('Period') || '';
            let ordersByStatus = {};
            try {
                ordersByStatus = JSON.parse(report.get('OrdersByStatus') || '{}');
            } catch (e) {}

            const stats = {
                views: Number(report.get('Views') || 0),
                orders: Number(report.get('Orders') || 0),
                revenue: Number(report.get('Revenue') || 0),
                avgOrder: Number(report.get('AvgOrder') || 0),
                ordersByStatus
            };

            const pdfBuffer = await buildReportPDF({ company, period, stats });
            const filename = `report-${(company || 'global-storefront').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${period}.pdf`;

            return {
                statusCode: 200,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': `attachment; filename="${filename}"`
                },
                body: pdfBuffer.toString('base64'),
                isBase64Encoded: true
            };
        }

        // --- List path: this client's reports, newest first ---
        const records = await base('Reports').select({
            filterByFormula: `{ClientID} = '${clientId}'`,
            sort: [{ field: 'Period', direction: 'desc' }],
            maxRecords: 60
        }).all();

        const data = records.map(r => ({
            id: r.id,
            period: r.get('Period') || '',
            views: Number(r.get('Views') || 0),
            orders: Number(r.get('Orders') || 0),
            revenue: Number(r.get('Revenue') || 0),
            avgOrder: Number(r.get('AvgOrder') || 0),
            generatedAt: r.get('GeneratedAt') || '',
            status: r.get('Status') || 'ready'
        }));

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data })
        };

    } catch (error) {
        console.error('Get reports error:', error);
        // Reports table may not exist yet — return empty rather than 500.
        return { statusCode: 200, headers, body: JSON.stringify({ data: [], message: 'No reports available yet.' }) };
    }
};
