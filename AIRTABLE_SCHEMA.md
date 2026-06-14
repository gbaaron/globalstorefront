# Airtable Schema — Global Storefront

**Base Name:** Global Storefront
**Base ID:** `appFruyJCRi9Fj6qX`

## Required Environment Variables

| Variable | Description |
|---|---|
| `AIRTABLE_API_KEY` | Personal Access Token (starts with `pat`) |
| `AIRTABLE_BASE_ID` | `appFruyJCRi9Fj6qX` |
| `JWT_SECRET` | Random 32+ character string for signing tokens |
| `OPENAI_API_KEY` | OpenAI API key for the helper bot (gpt-3.5-turbo) |
| `FIREBASE_SERVER_KEY` | Firebase Cloud Messaging server key (for push notifications) |
| `STRIPE_SECRET_KEY` | Stripe secret key — **deferred**; when absent, billing runs in records-only mode (no money moves) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret — **deferred**; when absent, `stripe-webhook` parses events unverified (test fixtures only) |

## Tables

### AdminUsers

Aaron's admin credentials for the portal dashboard.

| Field | Type | Notes |
|---|---|---|
| Name | Single line text | Display name |
| Email | Single line text | Login email (unique) |
| PasswordHash | Single line text | bcrypt hash (`$2a$10$...`) |

### Clients

Each client has a login that redirects to their preview site. Also serves as the tenant record for the multi-tenant app.

| Field | Type | Notes |
|---|---|---|
| Name | Single line text | Client contact name |
| Email | Single line text | Client email (unique, stored lowercase) |
| Username | Single line text | Login username (alternative to email) |
| PasswordHash | Single line text | bcrypt hash (`$2a$10$...`) |
| Company | Single line text | Business name |
| ProjectURL | Single line text | Full URL to their preview site |
| CreatedAt | Single line text | ISO 8601 timestamp string |
| BaseID | Single line text | Client's own Airtable base ID (e.g., `app08rmSRFifqnt4j`) |
| SiteType | Single select | `product` / `restaurant` / `service` — determines admin views |
| BotPersona | Single line text | Bot display name (e.g., "Glaze", "Counter Helper") |
| BotVoice | Single line text | Tone description (e.g., "warm, neighborly, concise") |
| PushEnabled | Checkbox | Whether push notifications are active for this client |
| Tier | Single select | `Essentials` / `Growth` / `Concierge` — subscription tier (source of truth, surfaced into JWT) |
| BillingCycle | Single select | `annual` / `m2m` — annual is discounted; m2m is month-to-month |
| SubStatus | Single select | `active` / `past_due` / `canceled` — subscription state |
| SubStartDate | Single line text | ISO date (YYYY-MM-DD) the subscription began |
| NextBillingDate | Single line text | ISO date (YYYY-MM-DD) of the next charge |
| StripeCustomerId | Single line text | Stripe customer ID (set at activation; empty until then) |
| StripeSubId | Single line text | Stripe subscription ID (set at activation; empty until then) |

### PageViews

Fire-and-forget visit tracking for the portal itself.

| Field | Type | Notes |
|---|---|---|
| Page | Single line text | Page identifier (e.g., `home`) |
| Referrer | Single line text | `document.referrer` value |
| Timestamp | Single line text | ISO 8601 timestamp string |

### Conversations

Chat threads between customers and store owners, created when the bot escalates.

| Field | Type | Notes |
|---|---|---|
| TenantID | Single line text | Links to Clients record ID |
| CustomerName | Single line text | Customer's name (or "Website Visitor") |
| CustomerEmail | Single line text | Optional, if customer provided it |
| Status | Single select | `active` / `waiting_for_owner` / `resolved` / `archived` |
| Channel | Single line text | Always `website_chat` for now |
| SessionID | Single line text | Widget session ID |
| EscalatedAt | Single line text | ISO timestamp when bot escalated |
| LastMessageAt | Single line text | ISO timestamp of most recent message |
| ResolvedAt | Single line text | ISO timestamp when marked resolved |

### Messages

Individual messages within a conversation thread.

| Field | Type | Notes |
|---|---|---|
| ConversationID | Single line text | Links to Conversations record ID |
| Sender | Single select | `customer` / `bot` / `owner` |
| Content | Long text | Message body |
| Timestamp | Single line text | ISO timestamp |
| ReadByOwner | Checkbox | Whether the owner has seen this message |
| ReadByCustomer | Checkbox | Whether the customer has received this reply |

### DeviceTokens

FCM push notification tokens for the mobile app.

| Field | Type | Notes |
|---|---|---|
| ClientID | Single line text | Links to Clients record ID |
| Token | Single line text | FCM device token |
| Platform | Single select | `ios` / `android` / `web` |
| CreatedAt | Single line text | ISO timestamp |
| LastUsedAt | Single line text | ISO timestamp |

### BotKnowledgeBase

Per-tenant knowledge that powers the AI helper bot's responses.

| Field | Type | Notes |
|---|---|---|
| TenantID | Single line text | Links to Clients record ID |
| Category | Single select | `hours` / `menu` / `policies` / `faq` / `services` / `general` |
| Key | Single line text | Knowledge item label (e.g., "monday_hours", "return_policy") |
| Value | Long text | The actual content the bot uses to answer |
| Priority | Number (0 decimals) | Higher = included first in bot context |

### BotConversations

Logging table for all bot interactions (cost tracking + quality audit).

| Field | Type | Notes |
|---|---|---|
| SessionID | Single line text | Widget session identifier |
| TenantID | Single line text | Which client's bot was used |
| UserMessage | Long text | What the customer asked |
| AssistantMessage | Long text | What the bot replied |
| Model | Single line text | Always `gpt-3.5-turbo` (for now) |
| TokensIn | Number (0 decimals) | Prompt tokens consumed |
| TokensOut | Number (0 decimals) | Completion tokens consumed |
| Escalated | Checkbox | Whether this turn triggered escalation |
| Timestamp | Single line text | ISO timestamp |
| FlaggedForReview | Checkbox | Admin sets after manual audit |

### Transactions

One row per customer-site sale that flows through Aaron's Stripe. GS keeps 10% immediately; 90% is swept to the client (next-business-day). Written by `record-transaction` (called by client sites) and `stripe-webhook` (payment events).

| Field | Type | Notes |
|---|---|---|
| TransactionID | Single line text | Internal ID (`txn_...`) |
| ClientID | Single line text | Links to Clients record ID |
| Amount | Number (2 decimals) | Gross sale amount |
| GSCut | Number (2 decimals) | GS's 10% cut |
| ClientNet | Number (2 decimals) | Client's 90% net |
| StripePaymentId | Single line text | Stripe payment/charge ID (empty pre-activation) |
| Status | Single select | `succeeded` / `pending` / `failed` / `refunded` |
| PayoutStatus | Single select | `pending` / `swept` — set to `swept` by the daily sweep |
| CustomerEmail | Single line text | Buyer email, if available |
| Description | Single line text | Free-text label for the sale |
| Date | Single line text | ISO timestamp |

### Payouts

Daily sweep records — one row per client per sweep, summing that day's pending `ClientNet`. Written by the scheduled `sweep-payouts` function.

| Field | Type | Notes |
|---|---|---|
| PayoutID | Single line text | Internal ID (`po_...`) |
| ClientID | Single line text | Links to Clients record ID |
| Amount | Number (2 decimals) | Summed ClientNet swept in this payout |
| TransactionCount | Number (0 decimals) | How many transactions were rolled up |
| Status | Single select | `pending` / `paid` — `paid` only when Stripe transfer fires (keys present) |
| StripeTransferId | Single line text | Stripe transfer ID (set at activation; empty until then) |
| Date | Single line text | ISO timestamp of the sweep |

### Reports

One row per Growth+ client per calendar month, holding the summary metrics for that period's performance report. Written by the scheduled `generate-reports` function (monthly). The binary PDF is **not** stored here — `get-reports` rebuilds it on demand from these fields via `lib/report-pdf.js` (keeps us under Airtable's long-text cap).

| Field | Type | Notes |
|---|---|---|
| ReportID | Single line text | Internal ID (`rpt_...`) |
| ClientID | Single line text | Links to Clients record ID |
| Period | Single line text | `YYYY-MM` of the reporting month |
| Views | Number (0 decimals) | Total page views in the period (from GS PageViews) |
| Orders | Number (0 decimals) | Total orders in the period (from the tenant's own base) |
| Revenue | Number (2 decimals) | Total revenue in the period |
| AvgOrder | Number (2 decimals) | Average order value (Revenue / Orders) |
| OrdersByStatus | Long text | JSON map of order status → count |
| PDFUrl | Single line text | Empty unless PDFs are ever uploaded to external storage |
| GeneratedAt | Single line text | ISO timestamp the row was generated |
| Status | Single select | `ready` (gated download enabled) |

### Suggestions

One row per Smart Suggestion generated for a Growth+ client. Written weekly by the scheduled `generate-suggestions` function, listed by `get-suggestions`, and acted on by `update-suggestion`. `BaselineMetric` is captured at generation time; `ResultMetric` is filled on keep/stop so the app can show movement vs baseline.

| Field | Type | Notes |
|---|---|---|
| SuggestionID | Single line text | Internal ID (`sug_...`), primary field |
| ClientID | Single line text | Links to Clients record ID (ownership scope) |
| Title | Single line text | Used for per-run dedupe against open (`new`) rows |
| Body | Long text | Owner-facing copy (optionally OpenAI-polished) |
| Category | Single select | `traffic` / `revenue` / `orders` / `retention` / `engagement` / `general` |
| Status | Single select | `new` / `created` / `kept` / `stopped` / `archived` |
| BaselineMetric | Long text | JSON metric snapshot captured at generation time |
| ResultMetric | Long text | JSON metric snapshot captured on keep/stop (movement vs baseline) |
| CreatedAt | Single line text | ISO timestamp the row was generated |
| ReviewedAt | Single line text | ISO timestamp the owner acted on it |

### EmailCampaigns

One row per email marketing campaign created by a Growth+ client in the owner app. Managed by `manage-campaign` (CRUD + send-now); scheduled campaigns are swept and sent by the scheduled `send-campaign` function. The recipient list is **not** stored here — it is read at send time from the client's own base (their `Users` + `Orders` emails) by `lib/campaign-send.js`.

| Field | Type | Notes |
|---|---|---|
| CampaignID | Single line text | Internal ID (`camp_...`), primary field |
| ClientID | Single line text | Links to Clients record ID (ownership scope) |
| Type | Single select | `cart_abandon` / `seasonal` / `blast` |
| Subject | Single line text | Email subject line |
| Body | Long text | Email body (HTML) |
| Status | Single select | `draft` / `scheduled` / `sending` / `sent` / `failed` / `archived` |
| Schedule | Single line text | ISO timestamp to auto-send; empty = manual draft |
| RecipientCount | Number (0 decimals) | Recipients resolved at send time (from the tenant base) |
| SentCount | Number (0 decimals) | How many were actually delivered |
| LastSentAt | Single line text | ISO timestamp of the last send |
| CreatedAt | Single line text | ISO timestamp the row was created |

### SocialPosts

One row per suggested social post for a Concierge client. Generated weekly by the scheduled `generate-social` function (captions + hashtags, optionally OpenAI-polished), listed by `get-social`, and acted on by `update-social` (schedule / post / archive / edit).

| Field | Type | Notes |
|---|---|---|
| PostID | Single line text | Internal ID (`post_...`), primary field |
| ClientID | Single line text | Links to Clients record ID (ownership scope) |
| Platform | Single select | `instagram` / `facebook` / `tiktok` / `twitter` |
| Caption | Long text | Suggested post copy |
| Hashtags | Single line text | Space-separated hashtag string |
| Category | Single select | `promo` / `engagement` / `seasonal` / `behind_scenes` / `product` |
| Status | Single select | `new` / `scheduled` / `posted` / `archived` |
| ScheduledFor | Single line text | ISO date the owner queued it for (set on schedule) |
| CreatedAt | Single line text | ISO timestamp the row was generated |

### StrategyCalls

One row per quarterly strategy call for a Concierge client (one per quarter). The owner requests/cancels via `manage-strategy-call`; Aaron schedules from the admin side (`Status` → `scheduled`, `ScheduledAt`).

| Field | Type | Notes |
|---|---|---|
| CallID | Single line text | Internal ID (`call_...`), primary field |
| ClientID | Single line text | Links to Clients record ID (ownership scope) |
| Quarter | Single line text | `YYYY-QN` label (one active call per quarter) |
| Topic | Single line text | What the owner wants to discuss |
| RequestedSlot | Single line text | Owner's preferred time (free text) |
| ScheduledAt | Single line text | ISO timestamp Aaron confirms (empty until scheduled) |
| Status | Single select | `requested` / `scheduled` / `completed` / `canceled` |
| Notes | Long text | Aaron's post-call notes |
| CreatedAt | Single line text | ISO timestamp the row was created |

### DevHours

One row per dev-hours request for a Concierge client. 1 free hour per calendar month; hours beyond that bill at `$50/hr` (`DEV_HOUR_OVERAGE_RATE`). The owner requests/cancels via `manage-dev-hours`; Aaron does the work and flips `Status`.

| Field | Type | Notes |
|---|---|---|
| EntryID | Single line text | Internal ID (`dev_...`), primary field |
| ClientID | Single line text | Links to Clients record ID (ownership scope) |
| Month | Single line text | `YYYY-MM` the request counts against (free-hour reset window) |
| Description | Long text | What the owner wants built/changed |
| Hours | Number (2 decimals) | Requested hours |
| Status | Single select | `requested` / `in_progress` / `completed` / `canceled` |
| Billable | Checkbox | True when any portion exceeds the free hour |
| OverageAmount | Number (2 decimals) | Computed billable overage ($50/hr beyond free) |
| CreatedAt | Single line text | ISO timestamp the row was created |

## Notes

- Passwords MUST be stored as bcrypt hashes, never plain text
- Email is the canonical user identity key across all tables
- PageViews is a public-write table (no auth required) — used for visit analytics only
- The admin dashboard reads from all tables; the client login reads from Clients only
- `TenantID` in Conversations, Messages, DeviceTokens, BotKnowledgeBase, and BotConversations always refers to the Clients table record ID
- The `BaseID` field on Clients allows the app to read the tenant's own Airtable base for orders/products/appointments
- BotKnowledgeBase entries are fed to GPT-3.5-turbo as context; keep entries concise (under 500 chars each) for token efficiency
- Push notifications require Firebase Cloud Messaging setup (one-time Firebase project creation)
- New tables (Conversations, Messages, DeviceTokens, BotKnowledgeBase, BotConversations) need to be created manually in Airtable
- New fields on Clients table (BaseID, SiteType, BotPersona, BotVoice, PushEnabled) need to be added manually

### Billing / subscription model

- **Tiers** (monthly price, annual vs month-to-month): Essentials $50 / $65 · Growth $100 / $130 · Concierge $175 / $225. Pricing + feature gating live in `netlify/functions/lib/tiers.js` (single source of truth, reused by functions and front-end).
- **Revenue split:** GS takes **10%** of every client-site transaction immediately; **90%** is swept to the client daily (next-business-day) via the scheduled `sweep-payouts` function.
- **Subscription changes:** upgrades are prorated; downgrades refund the unused fraction at the **new tier's month-to-month rate** (anti-gaming). Logic in `update-subscription` via `computeSubscriptionChange()`.
- **Stripe is structure-only for now.** Schema, the 10/90 math, and the webhook handler exist, but no money moves until `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` are set. `sweep-payouts` records payout intent (`Status: pending`) and only marks `paid` once transfers fire.
- Tier is surfaced into the client JWT (`tier`, `billingCycle`, `baseId`, `subStatus`) so the app can gate features without an extra fetch.
- Transactions and Payouts tables, plus the 7 new Clients fields (Tier, BillingCycle, SubStatus, SubStartDate, NextBillingDate, StripeCustomerId, StripeSubId), were created via the Airtable Meta API.

### Owner analytics & monthly reports (Growth+)

- **Analytics:** `get-tenant-admin?action=analytics` returns basic stats for all tiers (views/orders/revenue + recent views). For Growth+ (`tierIncludes(tier, 'advanced_analytics')`) it also returns trailing-14-day `viewsSeries` / `revenueSeries` and `ordersByStatus`, which the app renders as Chart.js charts. Essentials sees an upgrade gate.
- **Monthly reports:** the scheduled `generate-reports` function (`@monthly` in netlify.toml) writes one `Reports` row per Growth+ client for the prior calendar month. The owner app's Analytics tab lists those reports and downloads a PDF on demand via `get-reports?id=...`, which rebuilds the PDF with `lib/report-pdf.js` (pdfkit). Reports are gated to Growth+ (`tierIncludes(tier, 'monthly_reports')`) with an ownership check on download.
- The `Reports` table was created via the Airtable Meta API.

### Smart Suggestions (Growth+)

- **Generation:** the scheduled `generate-suggestions` function (`@weekly` in netlify.toml) analyzes each Growth+ client's last 7 days of traffic (GS PageViews) + orders/revenue (the tenant's own base) vs the prior 7 days, and emits rule-based suggestion rows (`buildSuggestions`). If `OPENAI_API_KEY` is set, each body is polished into warmer owner-facing copy via gpt-3.5-turbo; otherwise the deterministic template text is used. Idempotent per run: a client won't get a second copy of a suggestion whose Title is already sitting in `new` status.
- **Listing:** `get-suggestions` returns this client's suggestions newest-first (optional `?status=` filter), gated to Growth+ (`tierIncludes(tier, 'smart_suggestions')`). Essentials gets a `{ data: [], locked: true }` response that hides the Dashboard block.
- **Actions:** `update-suggestion` (`create` / `keep` / `stop` / `archive`) sets Status + ReviewedAt with an ownership check. On `keep`/`stop` it recomputes only the metric keys present in the baseline and writes `ResultMetric`, so the owner app can render movement chips (baseline → result with ▲/▼).
- The owner app surfaces suggestions as cards on the Dashboard (Growth centerpiece), not a separate nav tab.
- The `Suggestions` table was created via the Airtable Meta API.

### Email marketing management (Growth+)

- **Management:** `manage-campaign` is the client-facing CRUD (`create` / `update` / `delete` (soft → `archived`) / `send`), gated to Growth+ (`tierIncludes(tier, 'email_marketing')`) with an ownership check on every row. GET lists this client's campaigns newest-first; Essentials gets a `{ data: [], locked: true }` response so the app can show an upgrade gate. Campaign management (subject/body/type/schedule) lives in GS; the recipient list does **not**.
- **Recipients stay on the client base:** `lib/campaign-send.js` reads the customer email list from the tenant's own base at send time — registered customers (`Users.Email`) plus a guest-email fallback on `Orders` (`GuestEmail`/`Email`/`CustomerEmail`), deduped. GS never copies the customer list into its own base.
- **Delivery is provider-gated (mirrors Stripe).** With no email-provider key present it runs **records-only**: it resolves + counts recipients and marks the campaign `sent`, but transmits nothing. Set `RESEND_API_KEY` (preferred) or `SENDGRID_API_KEY` (fallback) — and optionally `CAMPAIGN_FROM_EMAIL` — to flip live sends on.
- **Scheduled sweep:** `send-campaign` (`@daily` in netlify.toml) sends every `scheduled` campaign whose `Schedule` ISO timestamp is now due, re-checking each client's `email_marketing` entitlement so a downgrade pauses pending sends. Also manually invokable for testing.
- The `EmailCampaigns` table was created via the Airtable Meta API.

### Concierge tools (Concierge only)

All three are gated to Concierge via `tierIncludes(tier, feature)` with a per-row ownership check; GET/LIST endpoints return `{ data: [], locked: true }` for lower tiers so the app hides the block, while mutations return 403.

- **Social posts (`social_posts`):** the scheduled `generate-social` function (`@weekly` in netlify.toml) writes a fresh batch of `SocialPosts` rows per Concierge client (captions + hashtags, optionally gpt-3.5-turbo-polished). `get-social` lists them (optional `?status=` filter, with status `counts`); `update-social` acts on a row (`schedule` sets `ScheduledFor` → `scheduled`; `post` → `posted`; `archive` → `archived`; `edit` tweaks Caption/Hashtags in place). Surfaced as cards on the owner app's Dashboard.
- **Strategy calls (`strategy_calls`):** Concierge clients get one strategy call per quarter. `manage-strategy-call` GET lists the client's calls + `usedThisQuarter`; POST `request` creates a `requested` row (rejects a second active call in the same quarter, 409); POST `cancel` cancels with an ownership check. Aaron schedules from the admin side. Surfaced in the owner app's Settings tab.
- **Dev hours (`dev_hours`):** 1 free dev hour per calendar month, overage at `$50/hr` (`DEV_HOUR_OVERAGE_RATE` in `lib/tiers.js`). `manage-dev-hours` GET returns the client's entries + a this-month usage `summary` (hoursUsed / freeRemaining / overageOwed); POST `request` computes overage against month-to-date usage and writes a `requested` row; POST `cancel` cancels a still-`requested` entry (in-progress/completed are locked, 409). The cancel write uses `{ typecast: true }`. Surfaced in the owner app's Settings tab with a live overage estimate as the owner types hours.
- The `SocialPosts`, `StrategyCalls`, and `DevHours` tables were created via the Airtable Meta API.
