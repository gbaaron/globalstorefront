# Global Storefront App — Architecture Plan

## What We're Building

A mobile app (iOS + Android via Capacitor) that gives store owners a branded admin dashboard + real-time customer messaging on their phone. The existing website chatbot (§28 universal helper bot) handles FAQ automatically, then escalates unanswered questions to the store owner via push notification. Owner replies in-app, answer routes back to the customer on the website.

**One app, many tenants.** When a bakery owner logs in, they see Zeeland's orders + messages. When a barbershop owner logs in, they see their appointments + messages. Same app binary, different data.

---

## Architecture Decision: Single URL, Tenant by JWT

The app points at ONE URL (the Global Storefront portal itself, rebuilt as a multi-tenant admin hub). After login, the JWT contains `clientId` + `projectUrl` + `tenantBaseId`. Every API call and UI render is scoped to that tenant. This is cleaner than dynamically swapping webview URLs per client.

**Why not just wrap each client's separate site?** Because then you'd need N app builds (or a dynamic URL router that Apple would reject as a "thin webview wrapper"). One cohesive admin app with tenant-scoped data is the right call for App Store approval and maintenance sanity.

---

## Phase 1: Multi-Tenant Admin Web App

**Goal:** Rebuild the Global Storefront portal into a proper multi-tenant admin dashboard that works in a browser (desktop + mobile responsive). This becomes the web app that Capacitor will later wrap.

### New Airtable Tables (add to existing `appFruyJCRi9Fj6qX` base)

| Table | Purpose |
|---|---|
| `Conversations` | Chat threads between customers and store chatbot/owner |
| `Messages` | Individual messages within conversations |
| `DeviceTokens` | FCM push notification tokens per client |
| `BotKnowledgeBase` | Per-tenant bot context (hours, menu, policies, FAQ) |
| `BotConversations` | Logging table per §28 |

**Conversations schema:**
- ConversationID (auto)
- TenantID (links to Clients record ID)
- CustomerName (from chatbot session)
- CustomerEmail (if provided)
- Status: `active | waiting_for_owner | resolved | archived`
- LastMessageAt (dateTime)
- Channel: `website_chat`
- EscalatedAt (dateTime, null if bot handled it)
- ResolvedAt (dateTime)

**Messages schema:**
- MessageID (auto)
- ConversationID (text — links to Conversations)
- Sender: `customer | bot | owner`
- Content (multilineText)
- Timestamp (dateTime)
- ReadByOwner (checkbox)
- ReadByCustomer (checkbox)

**DeviceTokens schema:**
- ClientID (text — links to Clients)
- Token (text — FCM device token)
- Platform: `ios | android | web`
- CreatedAt (dateTime)
- LastUsedAt (dateTime)

**BotKnowledgeBase schema:**
- TenantID (text — links to Clients)
- Category: `hours | menu | policies | faq | services | general`
- Key (text — e.g., "monday_hours", "return_policy")
- Value (multilineText — the content the bot uses to answer)
- Priority (number — higher = more important context)

### New Netlify Functions

| Function | Auth | Purpose |
|---|---|---|
| `helper-bot.js` | None (session-based) | §28 bot — answers FAQ from BotKnowledgeBase, escalates unknowns |
| `escalate.js` | Internal (called by helper-bot) | Creates Conversation + sends FCM push to owner |
| `get-conversations.js` | JWT (client) | Owner's conversation inbox (filtered by tenant) |
| `get-messages.js` | JWT (client) | Messages for a specific conversation |
| `send-message.js` | JWT (client) | Owner replies to customer |
| `resolve-conversation.js` | JWT (client) | Mark conversation resolved |
| `register-device.js` | JWT (client) | Save FCM token after app login |
| `send-push.js` | Internal | Firebase Cloud Messaging sender utility |
| `get-tenant-admin.js` | JWT (client) | Tenant-scoped admin data (orders, appointments, etc.) |
| `get-bot-kb.js` | JWT (admin) | Read knowledge base entries for a tenant |
| `update-bot-kb.js` | JWT (admin) | Update knowledge base (Aaron manages per client) |

### New HTML Pages

| Page | Purpose |
|---|---|
| `app.html` | The single-page app shell (this is what Capacitor wraps) |
| `app-login.html` | Mobile-optimized login for the app |

**`app.html` is the core.** It's a single-page app with these views (no router library — same `go(page)` pattern from PVL Manager §7):

1. **Inbox** — Conversations list, unread badges, status indicators
2. **Chat** — Message thread view with reply input (real-time via polling every 5s)
3. **Orders** — Tenant's orders from their site's Airtable base (read via `get-tenant-admin.js`)
4. **Dashboard** — Quick stats (today's orders, unread messages, revenue)
5. **Settings** — Push notification toggle, profile, logout

### How the Chatbot → Owner → Customer Flow Works

```
1. Customer visits store website (e.g., zeeland-bakery.netlify.app)
2. Clicks helper bot bubble, asks "Do you have gluten-free options?"
3. helper-bot.js checks BotKnowledgeBase for this tenant
   - Found answer → responds directly, logs to BotConversations
   - Can't answer → responds "Let me check with the team" + calls escalate.js
4. escalate.js:
   - Creates Conversation record (status: waiting_for_owner)
   - Creates Message record (sender: customer)
   - Looks up DeviceTokens for this tenant
   - Sends FCM push: "New question from a customer: Do you have gluten-free options?"
5. Owner opens app, sees unread conversation in Inbox
6. Owner types reply: "Yes! We have 3 gluten-free donut flavors..."
7. send-message.js:
   - Creates Message record (sender: owner)
   - Updates Conversation status to active
8. Customer's chat widget polls for new messages → shows owner's reply
```

### Cross-Base Tenant Data Access

Each client site has its own Airtable base (Zeeland = `app08rmSRFifqnt4j`, Sushi GoGo = `app7AjhbsDG8I7s1h`, etc.). The `get-tenant-admin.js` function needs to read from the CLIENT'S base, not Global Storefront's base.

**Solution:** Add a `BaseID` field to the existing `Clients` table. When the owner logs in, their JWT includes `baseId`. The admin function uses that base ID to fetch their orders/products/appointments. One function, tenant-routed by JWT claim.

**Updated Clients table (add fields):**
- BaseID (text — their Airtable base ID)
- SiteType (singleSelect: product | restaurant | service) — determines which admin views to show
- BotPersona (text — bot name for their site)
- BotVoice (text — tone description)
- PushEnabled (checkbox)

---

## Phase 2: Capacitor Native Wrapper

**Goal:** Wrap `app.html` in Capacitor for iOS + Android with push notifications.

### Capacitor Setup (following PVL Manager pattern)

```
global-storefront-app/
├── capacitor.config.ts
├── package.json (Capacitor deps)
├── ios/                    (generated)
├── android/                (generated)
└── www/                    (symlink or copy of the web app)
```

**capacitor.config.ts:**
```typescript
import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.globalstorefront.app',
  appName: 'Global Storefront',
  webDir: 'www',
  server: {
    url: 'https://globalstorefront.netlify.app/app.html',
    cleartext: false
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0f0f1a'
    },
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#0f0f1a'
    }
  }
};
```

### Native Features (beyond webview — for App Store approval)

1. **Push Notifications** (`@capacitor/push-notifications`) — FCM integration
2. **Status Bar** (`@capacitor/status-bar`) — dark theme matching app
3. **Splash Screen** (`@capacitor/splash-screen`) — branded loading
4. **Haptics** (`@capacitor/haptics`) — vibrate on new message
5. **Badge** (`@capacitor/badge`) — unread count on app icon
6. **Local Notifications** (`@capacitor/local-notifications`) — fallback if FCM fails

### Push Notification Flow

```
1. App login → Capacitor registers with FCM → gets device token
2. App calls /api/register-device with token + clientId
3. Token stored in DeviceTokens table
4. When escalate.js fires, it:
   a. Fetches DeviceTokens where ClientID = tenant
   b. POSTs to FCM API: { to: token, notification: { title, body }, data: { conversationId } }
5. Phone receives push → user taps → app opens to that conversation
```

### Firebase Setup (one-time)

- Create Firebase project "Global Storefront"
- Enable Cloud Messaging
- Download `google-services.json` (Android) + `GoogleService-Info.plist` (iOS)
- Add `FIREBASE_SERVER_KEY` to Netlify env vars (for server-side push sending)

---

## Phase 3: Customer-Side Chat Widget

**Goal:** Deploy the §28 helper bot on each client's website with escalation wired to the Global Storefront messaging system.

### Per-Client Deployment

Each client site gets:
1. `<script src="https://globalstorefront.netlify.app/widget/helper-bot.js" data-tenant="CLIENT_ID"></script>` — single script tag
2. The widget JS is hosted on Global Storefront (not each client site) — one codebase to maintain
3. Widget calls Global Storefront's `/api/helper-bot` with `tenantId` in the request
4. Bot uses that tenant's `BotKnowledgeBase` entries for context

### Why Host the Widget Centrally

- Update the bot logic once, every client site gets the update
- No need to redeploy 10 client sites when you improve the chatbot
- One OpenAI API key, one billing relationship
- Conversation data stays in Global Storefront's base (not scattered across client bases)

### Widget Features

- Floating bubble (bottom-right, brand-colored per tenant via CSS custom properties)
- Expandable chat panel
- Customer provides name (optional) at start of conversation
- Real-time polling for owner replies (every 3s when panel is open)
- "Typically replies within X minutes" indicator
- Session persists via sessionStorage (refreshing doesn't lose history)

---

## Phase 4: Knowledge Base Management

**Goal:** Give Aaron a way to populate and update each client's bot knowledge base.

### Admin Interface (extend existing `admin.html`)

Add a "Bot Knowledge" tab to the existing admin dashboard:
- Select client from dropdown
- See their current KB entries (categorized)
- Add/edit/delete entries
- "Test Bot" panel — simulate a customer question, see how the bot responds
- Bulk import from the client's existing Airtable data (e.g., pull menu items from Zeeland's Products table into KB automatically)

### Auto-Sync Pattern

For clients with structured data (menu items, services, products), run a nightly sync that pulls their latest data into BotKnowledgeBase:
- Zeeland: Products table → "menu" category KB entries
- Barbershop: Services table → "services" category KB entries
- Sushi GoGo: MenuItems table → "menu" category KB entries

This means the bot always has current prices/availability without Aaron manually updating KB entries.

---

## Phase 5: App Store Submission

### Apple App Store Requirements Met

| Requirement | How We Meet It |
|---|---|
| Native functionality beyond webview | Push notifications, haptics, badge count, status bar |
| Unique value | Real-time customer messaging + business management |
| Consistent UI | Single branded app shell (not just loading different websites) |
| No thin wrapper rejection | The app IS the admin dashboard — it's purpose-built, not a browser |

### Metadata

- **App Name:** Global Storefront
- **Category:** Business
- **Description:** Manage your store, respond to customers, and track orders — all from your phone.
- **Screenshots:** Inbox view, Chat view, Orders view, Dashboard view
- **Privacy Policy:** Required — host at globalstorefront.netlify.app/privacy.html

---

## File Manifest (What Gets Built)

### Phase 1 Files (Web App)

```
Global Storefront/
├── app.html                          (SPA shell — inbox, chat, orders, dashboard, settings)
├── app-login.html                    (Mobile-optimized login)
├── widget/
│   ├── helper-bot.js                 (Customer-facing chat widget — hosted centrally)
│   └── helper-bot.css                (Widget styles with CSS custom properties per tenant)
├── assets/
│   └── app.js                        (App logic — view router, API calls, polling)
├── netlify/functions/
│   ├── helper-bot.js                 (§28 bot + escalation logic)
│   ├── escalate.js                   (Create conversation + trigger push)
│   ├── get-conversations.js          (Owner's inbox)
│   ├── get-messages.js               (Thread messages)
│   ├── send-message.js               (Owner reply)
│   ├── resolve-conversation.js       (Close thread)
│   ├── register-device.js            (FCM token storage)
│   ├── send-push.js                  (FCM sender utility)
│   ├── get-tenant-admin.js           (Cross-base order/appointment data)
│   ├── get-bot-kb.js                 (Read KB)
│   ├── update-bot-kb.js              (Write KB)
│   └── customer-poll.js              (Customer checks for owner replies)
│   (existing 8 functions unchanged)
```

### Phase 2 Files (Capacitor — separate repo)

```
global-storefront-app/
├── capacitor.config.ts
├── package.json
├── ios/
├── android/
├── resources/
│   ├── icon.png                      (1024x1024 app icon)
│   ├── splash.png                    (2732x2732 splash)
│   └── icon-foreground.png           (Android adaptive)
└── www/                              (points to deployed app.html)
```

### Phase 3 Files (Widget — delivered to client sites)

Each client site adds ONE line:
```html
<script src="https://globalstorefront.netlify.app/widget/helper-bot.js" data-tenant="rec..." defer></script>
```

---

## Environment Variables (Updated)

```
# Existing
AIRTABLE_API_KEY=pat...
AIRTABLE_BASE_ID=appFruyJCRi9Fj6qX
JWT_SECRET=...

# New — Phase 1
OPENAI_API_KEY=sk-...                  (for helper bot)

# New — Phase 2
FIREBASE_SERVER_KEY=...                (for push notifications)
FIREBASE_PROJECT_ID=global-storefront

# Client base IDs (stored in Clients table BaseID field, not env vars)
```

---

## Build Order (Implementation Sequence)

1. **Add tables** to existing Airtable base (Conversations, Messages, DeviceTokens, BotKnowledgeBase, BotConversations)
2. **Add BaseID + SiteType fields** to existing Clients table
3. **Build helper-bot.js** (Netlify function) — the §28 bot with tenant-scoped KB lookup + escalation trigger
4. **Build escalate.js + send-push.js** — conversation creation + FCM push
5. **Build get-conversations.js, get-messages.js, send-message.js** — the messaging API
6. **Build app.html** — the SPA shell (Inbox → Chat → Orders → Dashboard → Settings)
7. **Build widget/helper-bot.js** — customer-facing chat widget (centrally hosted)
8. **Build customer-poll.js** — endpoint for widget to check for owner replies
9. **Wire FCM** — Firebase project, server key, device token registration
10. **Build Capacitor project** (separate repo) — wrap app.html with native plugins
11. **Deploy to TestFlight + Play Console internal testing**
12. **Populate KB** for Zeeland (first tenant test)
13. **App Store + Play Store submission**

---

## What Doesn't Change

- `index.html` (landing page) — untouched
- `sales.html` — untouched
- `business-card.html` — untouched
- `admin.html` — gets a "Bot Knowledge" tab added, otherwise untouched
- All 8 existing Netlify functions — untouched
- All existing client sites (Zeeland, Sushi GoGo, etc.) — untouched except adding the widget script tag
- The Global Storefront Airtable base keeps its existing 3 tables, we just ADD new ones

---

## The Recurring Revenue Justification

This is the pitch to clients:

| What they get | Without app | With app |
|---|---|---|
| Website | Yes | Yes |
| Chatbot answers basic questions | No | Yes (automatic, 24/7) |
| Customer messages reach owner | No | Yes (push notification to phone) |
| Owner can reply from anywhere | No | Yes (in-app) |
| Order management on phone | No | Yes |
| Monthly cost to owner | $0 (one-time site build) | $X/month (covers OpenAI + hosting + support) |

The app is what turns a one-time website sale into a monthly subscription. The bot handles 80% of questions for free (OpenAI cost is pennies). The 20% that escalate to the owner are the moments that close sales and retain customers — that's worth paying for.
