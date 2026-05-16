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
