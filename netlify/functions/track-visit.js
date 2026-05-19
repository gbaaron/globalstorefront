const Airtable = require('airtable');

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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
        const { page, referrer } = JSON.parse(event.body || '{}');

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        await base('PageViews').create([{
            fields: {
                Page: page || 'unknown',
                Timestamp: new Date().toISOString(),
                Referrer: referrer || ''
            }
        }]);

        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } catch (error) {
        // Fail silently — don't break the page if tracking fails
        return { statusCode: 200, headers, body: JSON.stringify({ success: false }) };
    }
};
