const Airtable = require('airtable');
const jwt = require('jsonwebtoken');

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const token = event.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'No authorization token' })
            };
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production');

        if (decoded.role !== 'admin') {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'Admin access required' })
            };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        const records = await base('PageViews').select({
            sort: [{ field: 'Timestamp', direction: 'desc' }],
            maxRecords: 500
        }).all();

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).toISOString();

        const views = records.map(r => ({
            page: r.get('Page') || '',
            timestamp: r.get('Timestamp') || '',
            referrer: r.get('Referrer') || ''
        }));

        const total = views.length;
        const today = views.filter(v => v.timestamp >= todayStart).length;
        const thisWeek = views.filter(v => v.timestamp >= weekStart).length;
        const recent = views.slice(0, 10);

        return {
            statusCode: 200,
            body: JSON.stringify({ total, today, thisWeek, recent })
        };

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid or expired token' })
            };
        }
        console.error('Get analytics error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch analytics' })
        };
    }
};
