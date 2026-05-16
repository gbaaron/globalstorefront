const Airtable = require('airtable');
const jwt = require('jsonwebtoken');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
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

        const { name, email, username, password, company, projectUrl, baseId } = JSON.parse(event.body);

        if (!name || !email || !username || !password || !projectUrl) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Name, email, username, password, and project URL are required' })
            };
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid email format' })
            };
        }

        if (password.length < 6) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Password must be at least 6 characters' })
            };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        const existing = await base('Clients').select({
            filterByFormula: `{Email} = '${email.replace(/'/g, "\\'")}'`,
            maxRecords: 1
        }).firstPage();

        if (existing.length > 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'A client with this email already exists' })
            };
        }

        const fields = {
            Name: name.trim(),
            Email: email.trim().toLowerCase(),
            Username: username.trim(),
            Password: password,
            Company: company ? company.trim() : '',
            ProjectURL: projectUrl.trim(),
            CreatedAt: new Date().toISOString()
        };
        if (baseId) fields.BaseID = baseId.trim();

        const newRecord = await base('Clients').create([{ fields }]);

        // Sync admin user to the client's own Airtable base (non-blocking)
        if (baseId) {
            try {
                const clientBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(baseId.trim());
                await clientBase('Users').create([{
                    fields: {
                        Name: name.trim(),
                        Email: email.trim().toLowerCase(),
                        PasswordHash: password,
                        IsAdmin: true,
                        MemberSince: new Date().toISOString().split('T')[0]
                    }
                }]);
            } catch (syncError) {
                console.error('Admin user sync failed (non-blocking):', syncError.message);
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                client: {
                    id: newRecord[0].id,
                    name: newRecord[0].get('Name'),
                    email: newRecord[0].get('Email'),
                    username: newRecord[0].get('Username'),
                    company: newRecord[0].get('Company'),
                    projectUrl: newRecord[0].get('ProjectURL'),
                    createdAt: newRecord[0].get('CreatedAt')
                }
            })
        };

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid or expired token' })
            };
        }
        console.error('Create client error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to create client' })
        };
    }
};
