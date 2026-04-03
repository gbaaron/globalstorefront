const Airtable = require('airtable');
const jwt = require('jsonwebtoken');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { username, password } = JSON.parse(event.body);

        if (!username || !password) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Username and password are required' })
            };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        const records = await base('Clients').select({
            filterByFormula: `{Username} = '${username.replace(/'/g, "\\'")}'`,
            maxRecords: 1
        }).firstPage();

        if (records.length === 0) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid username or password' })
            };
        }

        const client = records[0];

        if (password !== client.get('PasswordHash')) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid username or password' })
            };
        }

        const token = jwt.sign(
            { userId: client.id, email: client.get('Email'), role: 'client' },
            process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production',
            { expiresIn: '7d' }
        );

        return {
            statusCode: 200,
            body: JSON.stringify({
                token,
                name: client.get('Name'),
                company: client.get('Company'),
                projectUrl: client.get('ProjectURL')
            })
        };

    } catch (error) {
        console.error('Login error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Server error. Please try again.' })
        };
    }
};
