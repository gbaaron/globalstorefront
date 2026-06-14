# Global Storefront — Session Handoff

> **Purpose of this file:** This session started on a phone, where the sandbox
> network policy blocks outbound calls to `api.airtable.com`, so the live
> Airtable steps below could not be executed. Pick this up in a **new session
> from a computer** (whose environment allows Airtable egress) to finish.
> Branch: `claude/global-storefront-architecture-oi9hjj`.
> Date of this handoff: 2026-06-14.

---

## 1. Quick context — what Global Storefront is

- **One admin app, many tenants.** `app.html` is the store-owner admin app
  (Home / Inbox / Orders / Analytics / Settings). The iOS/Android app is that
  same page wrapped by Capacitor (in `/mobile`), which adds push, haptics, badge.
- **`admin.html`** is the agency super-admin (Aaron): manage Clients, Bot
  Knowledge, Test Bot. Separate from the owner app.
- **Customers** go straight to each company's own website (e.g. Zeeland Bakery).
  The only Global Storefront piece there is the chat widget (`widget/helper-bot.js`,
  one `<script data-tenant="rec…">` tag).
- **Database is split:**
  - **Global Storefront base** `appFruyJCRi9Fj6qX` — Clients (tenant registry),
    AdminUsers, PageViews, Conversations, Messages, DeviceTokens,
    BotKnowledgeBase, BotConversations. (All chat/bot data, for every client.)
  - **Each client's OWN base** (Zeeland = `app08rmSRFifqnt4j`, etc.) — Orders,
    Products/MenuItems, Appointments. Linked from `Clients.BaseID`.
  - Net effect: a customer's **order** → the client's own base; a customer's
    **chat message** → the shared Global Storefront base.

The full visual explanation is in **`architecture-explainer.html`** (open in a
browser — it has 5 animated SVG diagrams).

---

## 2. What was done in this session (all committed + pushed)

| File | Change |
|---|---|
| `architecture-explainer.html` | **NEW.** Visual architecture explainer: system map, surfaces, admin shells, customer flow, DB split, customer-data journey, **integration wiring section**, Q&A. 5 animated SVG diagrams. |
| `netlify/functions/delete-account.js` | **NEW.** In-app account deletion (Apple Guideline 5.1.1). Client-JWT auth, requires `{confirm:"DELETE"}`, add-only/destructive only on the caller's own data: deletes the caller's Messages, Conversations, DeviceTokens, BotConversations, BotKnowledgeBase, then the Clients record. |
| `app.html` | Added Settings → **Danger Zone → "Delete My Account"** button (double confirm: `confirm()` then type `DELETE`), CSS, and the handler that calls `/api/delete-account` and logs out. |
| `privacy.html` | Updated §4 (Data Retention) to state in-app deletion exists (Settings → Delete Account) and what it removes. |
| `scripts/seed-demo.js` | **NEW.** Add-only demo-data seeder for App Store review. Env-keyed (`AIRTABLE_API_KEY`), no npm install (Node 18+ built-in fetch). Seeds KB entries, one unread + one resolved conversation, and 5 orders in the client's own base. |

Commits (newest first): `a6dd5c4`, `0d36778`, `143d374`, `c42308c`, `980ae8f`.

---

## 3. REMAINING STEPS TO COMPLETE (do these from a computer)

### Step A — Seed the demo account (needs Airtable network access)
This is the last piece of Apple checklist item #4 ("no placeholder content" — the
reviewer must see a working app, not empty screens).

Two ways:
1. **Run locally** (simplest):
   ```bash
   # list clients, pick the DEMO one (not a real client):
   AIRTABLE_API_KEY=<token> node scripts/seed-demo.js
   # then seed it:
   AIRTABLE_API_KEY=<token> node scripts/seed-demo.js "<company name or recId>"
   ```
2. **Let Claude run it** in a computer-originated session: confirm
   `api.airtable.com` is reachable (it should be on a laptop environment), then
   ask Claude to run `scripts/seed-demo.js` for the demo client.

   > NOTE: if Claude reports `x-deny-reason: host_not_allowed` / "Host not in
   > allowlist: api.airtable.com", the environment's egress allowlist is blocking
   > it. Add `api.airtable.com` to the environment network/egress settings, or
   > run the script locally.

After seeding: log into the app as that demo account, confirm Inbox + Orders show
content, then give those exact credentials to Apple in App Store Connect →
**App Review Information** (Sign-in required → username + password).

### Step B — App icon + splash (only the human can supply the art)
- Save the provided icon PNG as `mobile/resources/icon.png` (exactly 1024×1024).
- Create `mobile/resources/splash.png` (2732×2732, logo centered on `#0f0f1a`).
- Generate all sizes:
  ```bash
  cd mobile && npx capacitor-assets generate
  ```

### Step C — Rotate the Airtable token
The token was pasted into the phone chat. Regenerate it in Airtable
(Developer hub → Personal access tokens) and update `AIRTABLE_API_KEY` in Netlify.

### Step D — Apple submission items (settings, not code)
- [ ] Demo login provided in App Store Connect (after Step A).
- [ ] Account deletion — **DONE in code** (Settings → Delete My Account). Verify on device.
- [ ] Native features present — push/haptics/badge (already built). Add a line in
      Review Notes: "Native push alerts owners to live customer messages."
- [ ] App icon 1024×1024 (Step B).
- [ ] Screenshots — capture from device/simulator: Inbox, Chat, Orders, Dashboard
      (6.7" iPhone = 1290×2796 required).
- [ ] Privacy Policy URL: `globalstorefront.netlify.app/privacy.html`.
- [ ] App Privacy questionnaire answers:
      Contact Info (email, name) → linked → App Functionality;
      User Content (messages) → linked → App Functionality;
      Identifiers (user id/device token) → linked → App Functionality;
      Tracking? **No.** Advertising? **No.**
- [ ] Push capability in Xcode: App target → Signing & Capabilities → + Push
      Notifications; + Background Modes → Remote notifications.
- [ ] Support contact: your email is fine.
- Note: **"Sign in with Apple" is NOT required** (no third-party logins).

---

## 4. Known issues found during the audit (optional fixes)

1. **Stale Firebase env var.** `escalate.js` uses `FIREBASE_SERVICE_ACCOUNT`
   (FCM v1, service-account JSON). But `AIRTABLE_SCHEMA.md` and `mobile/BUILD.md`
   still reference the legacy `FIREBASE_SERVER_KEY`. If `FIREBASE_SERVICE_ACCOUNT`
   isn't set in Netlify, escalations still record but **push silently no-ops**.
   → Set `FIREBASE_SERVICE_ACCOUNT` in Netlify; update the two docs.
2. **Plaintext passwords.** `login.js` compares `password !== stored`
   (reads `Password` or `PasswordHash` field as-is). Privacy policy claims bcrypt.
   Demo-era simplicity; hash before any real launch.
3. **Dead code in `customer-poll.js`.** It builds an `after`/`IS_AFTER` filter
   then ignores it (actually filters on `ReadByCustomer = FALSE()`). Works, but
   the unused branch is misleading. Safe to clean up.

---

## 5. The integration "contract" (what must line up per client)

The single client **Clients record ID** (`rec…`) must match across:
`widget data-tenant` → `helper-bot/escalate tenantId` → `Conversations.TenantID`
→ app login `JWT.userId` → `DeviceTokens.ClientID`. You only set the first one by
hand; code fills the rest.

Per-client config that must be set or features fail quietly:
- `Clients.BaseID` (else Orders/Dashboard empty).
- `Clients.SiteType` = product | restaurant | service (controls which table the
  app reads: Products vs MenuItems; Appointments only for service).
- Widget `<script src>` must point at the Global Storefront deployment (never
  self-hosted on the client domain — that breaks the API base path).
- `AIRTABLE_API_KEY` must have access to **every** client base, not just the GS base.

Client base table/field expectations (read by `get-tenant-admin.js`):
- `Orders`: OrderDate, Status, Total (or TotalAmount), CustomerName, Items
- `Products` / `MenuItems`
- `Appointments`: Date

---

## 6. How to resume in the new (computer) session

Tell the new chat something like:
> "Read HANDOFF.md on branch `claude/global-storefront-architecture-oi9hjj`.
> Verify you can reach api.airtable.com, then run scripts/seed-demo.js for the
> demo client `<name/id>`. Then help me finish the Apple checklist in section 3."

Everything is already committed and pushed to that branch.
