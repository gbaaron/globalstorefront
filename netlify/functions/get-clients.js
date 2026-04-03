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

        const records = await base('Clients').select({
            sort: [{ field: 'CreatedAt', direction: 'desc' }]
        }).all();

        const clients = records.map(r => ({
            id: r.id,
            name: r.get('Name') || '',
            email: r.get('Email') || '',
            username: r.get('Username') || '',
            company: r.get('Company') || '',
            projectUrl: r.get('ProjectURL') || '',
            createdAt: r.get('CreatedAt') || ''
        }));

        return {
            statusCode: 200,
            body: JSON.stringify({ clients })
        };

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid or expired token' })
            };
        }
        console.error('Get clients error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch clients' })
        };
    }
};
