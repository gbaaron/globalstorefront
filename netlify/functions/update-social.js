const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const { tierIncludes, normalizeTier } = require('./lib/tiers');

// Client-facing social-post action endpoint for the owner app.
//   POST /api/update-social  { id, action, scheduledFor? }
//     action: 'schedule' → queue for a date     (Status: scheduled, sets ScheduledFor)
//             'post'     → mark as posted        (Status: posted)
//             'archive'  → dismiss without using (Status: archived)
//             'edit'     → tweak caption/hashtags before using
//
// Gated to Concierge ('social_posts') with an ownership check (a client may only
// act on their own suggested posts).

const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

// action → resulting Status value
const ACTION_STATUS = {
    schedule: 'scheduled',
    post: 'posted',
    archive: 'archived'
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

function serializePost(r) {
    return {
        id: r.id,
        postId: r.get('PostID') || '',
        platform: r.get('Platform') || 'instagram',
        caption: r.get('Caption') || '',
        hashtags: r.get('Hashtags') || '',
        category: r.get('Category') || 'promo',
        status: r.get('Status') || 'new',
        scheduledFor: r.get('ScheduledFor') || '',
        createdAt: r.get('CreatedAt') || ''
    };
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const decoded = verifyToken(event);
    if (!decoded || decoded.role !== 'client') {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const tier = normalizeTier(decoded.tier);
    if (!tierIncludes(tier, 'social_posts')) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Social post suggestions are a Concierge feature.' }) };
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (e) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { id, action } = payload;
    if (!id || !action) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'id and action are required' }) };
    }
    if (action !== 'edit' && !ACTION_STATUS[action]) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    try {
        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
        const clientId = decoded.userId;

        // Fetch + ownership check.
        let post;
        try {
            post = await base('SocialPosts').find(id);
        } catch (e) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: 'Post not found' }) };
        }
        if (post.get('ClientID') !== clientId) {
            return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
        }

        const fields = {};

        // ---- EDIT (caption/hashtags tweak, keeps current status) ----
        if (action === 'edit') {
            if (typeof payload.caption === 'string') fields.Caption = payload.caption.trim();
            if (typeof payload.hashtags === 'string') fields.Hashtags = payload.hashtags.trim();
        } else {
            // ---- SCHEDULE / POST / ARCHIVE ----
            fields.Status = ACTION_STATUS[action];
            if (action === 'schedule') {
                fields.ScheduledFor = (payload.scheduledFor || '').trim();
            }
        }

        const updated = await base('SocialPosts').update([{ id, fields }]);

        return { statusCode: 200, headers, body: JSON.stringify({ success: true, post: serializePost(updated[0]) }) };

    } catch (error) {
        console.error('Update social error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update post' }) };
    }
};
