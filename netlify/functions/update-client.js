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

        const { clientId, name, email, username, password, company, projectUrl } = JSON.parse(event.body);

        if (!clientId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Client ID is required' })
            };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        const fields = {};
        if (name) fields.Name = name.trim();
        if (username) fields.Username = username.trim();
        if (email) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Invalid email format' })
                };
            }

            const existing = await base('Clients').select({
                filterByFormula: `AND({Email} = '${email.replace(/'/g, "\\'")}', RECORD_ID() != '${clientId}')`,
                maxRecords: 1
            }).firstPage();

            if (existing.length > 0) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'A client with this email already exists' })
                };
            }

            fields.Email = email.trim().toLowerCase();
        }
        if (password) {
            if (password.length < 6) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Password must be at least 6 characters' })
                };
            }
            fields.PasswordHash = password;
        }
        if (company !== undefined) fields.Company = company.trim();
        if (projectUrl) fields.ProjectURL = projectUrl.trim();

        if (Object.keys(fields).length === 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'No fields to update' })
            };
        }

        await base('Clients').update([
            { id: clientId, fields }
        ]);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Invalid or expired token' })
            };
        }
        console.error('Update client error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to update client' })
        };
    }
};
