# Prompt for La Creme Claude Code Session

Copy everything below this line and paste it into your La Creme Claude Code session:

---

I need to add admin messaging and restructure the admin panel to support the Global Storefront pipeline. Here's what needs to happen:

## Context

La Creme is a Global Storefront client. The pipeline works like this:
- Client logs into Global Storefront (globalstorefront.netlify.app) → gets redirected to lacrem.netlify.app
- Once on lacrem.netlify.app, they log in as admin using the SAME credentials (email: lacreme@globalmedia.com, password: password)
- After admin login, they get access to admin features INCLUDING messages from the GS messaging system

The admin user `lacreme@globalmedia.com` with password `password` and `IsAdmin: true` already exists in the La Creme Users table.

## Changes Needed

### 1. Dual Authentication (login.js function)

After the local login confirms the user is an admin (`IsAdmin: true`), make a background POST to the Global Storefront API to get a GS token for messaging:

```javascript
// After successful local admin login, also authenticate with GS
if (user.fields.IsAdmin) {
    try {
        const gsRes = await fetch('https://globalstorefront.netlify.app/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: email, password })
        });
        if (gsRes.ok) {
            const gsData = await gsRes.json();
            // Return gs_token alongside the local token
            responseBody.gs_token = gsData.token;
        }
    } catch (e) {
        // Non-blocking — GS auth failure doesn't prevent local login
        console.error('GS auth failed (non-blocking):', e.message);
    }
}
```

On the frontend (login.html), store the GS token:
```javascript
if (data.gs_token) {
    localStorage.setItem('lacreme_gs_token', data.gs_token);
}
```

### 2. Admin Panel Restructure (admin.html)

The admin page should have a tabbed interface with these tabs:
- **Messages** (NEW — first tab, default view)
- **Orders** (existing — links to order-manager.html content or embed)
- **Menu** (existing — links to dashboard.html menu manager)
- **Analytics** (existing — links to daily-summary.html content or embed)

### 3. Messages Tab Implementation

The Messages tab is the main new feature. It connects to the Global Storefront messaging API.

**Conversation List View:**
- Fetch from `https://globalstorefront.netlify.app/api/get-conversations`
- Headers: `Authorization: Bearer ${localStorage.getItem('lacreme_gs_token')}`
- Display: customer name, last message preview, timestamp, status badge (open/resolved)
- Click a conversation to open the chat view

**Chat View (when a conversation is selected):**
- Fetch messages from `https://globalstorefront.netlify.app/api/get-messages?conversationId={id}`
- Headers: same GS token
- Show message bubbles (customer messages left, admin replies right)
- Timestamps on each message
- Reply input at the bottom

**Reply:**
- POST to `https://globalstorefront.netlify.app/api/send-message`
- Body: `{ conversationId, message, sender: 'admin' }`
- Headers: same GS token

**Resolve:**
- "Resolve" button on open conversations
- POST to `https://globalstorefront.netlify.app/api/resolve-conversation`
- Body: `{ conversationId }`
- Headers: same GS token

**Polling:**
- When a chat is open, poll for new messages every 5 seconds
- Clear interval when navigating away from the chat

**Graceful fallback:**
- If `lacreme_gs_token` is missing or API returns 401, show a "Reconnect to Global Storefront" prompt
- The reconnect flow: show email/password fields, POST to GS login, store new token

### 4. Quick Links Section

Add a "Quick Links" section (could be a tab or a sidebar) with:
- "View Site as Customer" → opens lacrem.netlify.app in new tab
- "Global Storefront Admin" → opens globalstorefront.netlify.app in new tab
- "Airtable Base" → opens airtable.com link

### 5. Important Notes

- The GS API uses CORS headers so cross-origin requests work fine
- All GS API endpoints are at `https://globalstorefront.netlify.app/api/`
- The GS token expires after 7 days — if expired, prompt to re-authenticate
- Don't break existing admin functionality (order management, menu management, daily summary)
- Use the existing La Creme brand styling (dark theme, the crepe/pastry aesthetic)
- Store `lacreme_gs_token` separately from the local `lacreme_token`
