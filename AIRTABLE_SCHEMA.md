# Airtable Schema — Global Storefront

**Base Name:** Global Storefront
**Base ID:** `appFruyJCRi9Fj6qX`

## Required Environment Variables

| Variable | Description |
|---|---|
| `AIRTABLE_API_KEY` | Personal Access Token (starts with `pat`) |
| `AIRTABLE_BASE_ID` | `appFruyJCRi9Fj6qX` |
| `JWT_SECRET` | Random 32+ character string for signing tokens |

## Tables

### AdminUsers

Aaron's admin credentials for the portal dashboard.

| Field | Type | Notes |
|---|---|---|
| Name | Single line text | Display name |
| Email | Single line text | Login email (unique) |
| PasswordHash | Single line text | bcrypt hash (`$2a$10$...`) |

### Clients

Each client has a login that redirects to their preview site.

| Field | Type | Notes |
|---|---|---|
| Name | Single line text | Client contact name |
| Email | Single line text | Client email (unique, stored lowercase) |
| Username | Single line text | Login username (alternative to email) |
| PasswordHash | Single line text | bcrypt hash (`$2a$10$...`) |
| Company | Single line text | Business name |
| ProjectURL | Single line text | Full URL to their preview site (e.g., `https://zeelandbakery.netlify.app/`) |
| CreatedAt | Single line text | ISO 8601 timestamp string |

### PageViews

Fire-and-forget visit tracking for the portal itself.

| Field | Type | Notes |
|---|---|---|
| Page | Single line text | Page identifier (e.g., `home`) |
| Referrer | Single line text | `document.referrer` value |
| Timestamp | Single line text | ISO 8601 timestamp string |

## Notes

- Passwords MUST be stored as bcrypt hashes, never plain text
- Email is the canonical user identity key across all tables
- PageViews is a public-write table (no auth required) — used for visit analytics only
- The admin dashboard reads from all three tables; the client login reads from Clients only
