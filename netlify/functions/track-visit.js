const Airtable = require('airtable');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
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

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        // Fail silently — don't break the page if tracking fails
        return { statusCode: 200, body: JSON.stringify({ success: false }) };
    }
};
