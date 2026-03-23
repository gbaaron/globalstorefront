const Airtable = require('airtable');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { email, password } = JSON.parse(event.body);

        if (!email || !password) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Email and password are required' })
            };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        const records = await base('AdminUsers').select({
            filterByFormula: `{Email} = '${email.replace(/'/g, "\\'")}'`,
            maxRecords: 1
        }).firstPage();

        if (records.length === 0) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid credentials' })
            };
        }

        const admin = records[0];
        const isValid = await bcrypt.compare(password, admin.get('PasswordHash'));

        if (!isValid) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid credentials' })
            };
        }

        const token = jwt.sign(
            { userId: admin.id, email: admin.get('Email'), role: 'admin' },
            process.env.JWT_SECRET || 'globalstorefront-secret-change-in-production',
            { expiresIn: '24h' }
        );

        return {
            statusCode: 200,
            body: JSON.stringify({ token, name: admin.get('Name') })
        };

    } catch (error) {
        console.error('Admin login error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Server error. Please try again.' })
        };
    }
};
