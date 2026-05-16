const Airtable = require('airtable');
const jwt = require('jsonwebtoken');

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

    try {
        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const params = event.queryStringParameters || {};
        const dataType = params.type; // orders, products, appointments, stats

        // Get tenant info to find their base ID and site type
        let tenant;
        try {
            tenant = await base('Clients').find(decoded.userId);
        } catch (e) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: 'Tenant not found' }) };
        }

        const tenantBaseId = tenant.get('BaseID');
        const siteType = tenant.get('SiteType') || 'product';

        if (!tenantBaseId) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    data: [],
                    message: 'No base connected yet. Contact your administrator.'
                })
            };
        }

        // Connect to the tenant's own Airtable base
        const tenantBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(tenantBaseId);

        let data = [];

        switch (dataType) {
            case 'orders': {
                // Works for product, restaurant, and service types
                const tableName = 'Orders';
                try {
                    const records = await tenantBase(tableName).select({
                        sort: [{ field: 'OrderDate', direction: 'desc' }],
                        maxRecords: 50
                    }).firstPage();
                    data = records.map(r => ({
                        id: r.id,
                        ...r.fields
                    }));
                } catch (e) {
                    // Table might not exist for this tenant
                    data = [];
                }
                break;
            }

            case 'products': {
                // Products or MenuItems depending on site type
                const tableName = siteType === 'restaurant' ? 'MenuItems' : 'Products';
                try {
                    const records = await tenantBase(tableName).select({
                        maxRecords: 100
                    }).firstPage();
                    data = records.map(r => ({
                        id: r.id,
                        ...r.fields
                    }));
                } catch (e) {
                    data = [];
                }
                break;
            }

            case 'appointments': {
                // Service-type sites only
                if (siteType !== 'service') {
                    return { statusCode: 200, headers, body: JSON.stringify({ data: [] }) };
                }
                try {
                    const records = await tenantBase('Appointments').select({
                        sort: [{ field: 'Date', direction: 'desc' }],
                        maxRecords: 50
                    }).firstPage();
                    data = records.map(r => ({
                        id: r.id,
                        ...r.fields
                    }));
                } catch (e) {
                    data = [];
                }
                break;
            }

            case 'stats': {
                // Aggregate quick stats for the dashboard
                const stats = {
                    totalOrders: 0,
                    todayOrders: 0,
                    pendingOrders: 0,
                    totalRevenue: 0
                };

                try {
                    const orders = await tenantBase('Orders').select({ maxRecords: 200 }).firstPage();
                    const today = new Date().toISOString().split('T')[0];

                    stats.totalOrders = orders.length;
                    for (const order of orders) {
                        const orderDate = (order.get('OrderDate') || '').split('T')[0];
                        if (orderDate === today) stats.todayOrders++;
                        if ((order.get('Status') || '').toLowerCase() === 'pending') stats.pendingOrders++;
                        const total = parseFloat(order.get('Total') || order.get('TotalAmount') || 0);
                        if (!isNaN(total)) stats.totalRevenue += total;
                    }
                } catch (e) {}

                data = stats;
                break;
            }

            default:
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid data type. Use: orders, products, appointments, stats' }) };
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data, siteType })
        };

    } catch (error) {
        console.error('Get tenant admin error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to fetch tenant data' })
        };
    }
};
