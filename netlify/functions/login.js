const Airtable = require('airtable');
const jwt = require('jsonwebtoken');

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { username, password } = JSON.parse(event.body);

        if (!username || !password) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Username and password are required' })
            };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        // Accept either a username or email address
        const isEmail = username.includes('@');
        const sanitized = username.replace(/'/g, "\\'");
        const filterFormula = isEmail
            ? `{Email} = '${sanitized.toLowerCase()}'`
            : `{Username} = '${sanitized}'`;

        const records = await base('Clients').select({
            filterByFormula: filterFormula,
            maxRecords: 1
        }).firstPage();

        if (records.length === 0) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: 'Invalid username or password' })
            };
        }

        const client = records[0];

        const stored = client.get('Password') || client.get('PasswordHash') || '';
        if (password !== stored) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: 'Invalid username or password' })
            };
        }

        const tier = client.get('Tier') || 'Essentials';
        const billingCycle = client.get('BillingCycle') || 'annual';
        const baseId = client.get('BaseID') || '';

        const token = jwt.sign(
            {
                userId: client.id,
                email: client.get('Email'),
                role: 'client',
                tier,
                billingCycle,
                baseId
            },
            process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production',
            { expiresIn: '7d' }
        );

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                token,
                name: client.get('Name'),
                company: client.get('Company'),
                projectUrl: client.get('ProjectURL'),
                username: client.get('Username') || '',
                tier,
                billingCycle,
                subStatus: client.get('SubStatus') || 'active',
                baseId
            })
        };

    } catch (error) {
        console.error('Login error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Server error. Please try again.' })
        };
    }
};
