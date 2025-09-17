# Plex-Donate

Automated system to handle:
- **PayPal subscriptions** (monthly donations) and payment webhooks.
- Auto-generate **Wizarr invites** and deliver them by email.
- Manage invites/subscriptions from an **Admin dashboard** with CSRF-protected API.
- Optionally revoke **Plex access** if a subscription is canceled.

## ✨ Features

- Secure admin dashboard with session-based authentication.
- PayPal webhook endpoint that keeps the local SQLite database in sync.
- Wizarr invite generation, storage, email delivery, and optional auto-revocation on cancellation.
- Optional Plex integration to remove canceled donors automatically.
- Activity log for webhook events and admin actions.
- Shareable donor dashboard so supporters can confirm donations, pick their invite email, and self-serve Plex access.

## 📋 Requirements
- Node.js 18+ (20+ recommended)
- npm 9+
- PayPal developer account
- Wizarr running
- SMTP credentials
- (Optional) Plex Token for revoke

## 📦 Setup

```bash
git clone https://github.com/jjermany/Plex-Donate.git
cd Plex-Donate
npm install
cp .env.example .env   # adjust only the core app settings
npm run dev            # run locally with nodemon
```

After the server is running visit `http://localhost:3000`, sign in with the admin password from `.env`, and fill in the integration credentials directly from the dashboard.

### Environment variables

Only the core application settings live in `.env` now:

| Variable | Description |
| --- | --- |
| `NODE_ENV` | Runtime environment label (defaults to `development`). |
| `PORT` | Port the Express server listens on. |
| `SESSION_SECRET` | (Optional) Override the generated admin session secret for the dashboard. |
| `SESSION_COOKIE_SECURE` | Set to `true` to mark the admin session cookie as secure (requires HTTPS). Defaults to `false`. |
| `ADMIN_PASSWORD` | Password required to access the admin dashboard. |
| `DATABASE_FILE` | Location of the SQLite database file. |

When you serve Plex-Donate over HTTPS (for example, behind a reverse proxy that terminates TLS), set `SESSION_COOKIE_SECURE=true` so browsers only send the admin session cookie over secure connections.

### Configure integrations

Use the **Integration settings** panel in the admin dashboard to store PayPal, Wizarr, SMTP, and optional Plex credentials. Values are written to the database so they survive restarts without exposing secrets in environment files.

Each integration also provides a **Test** button directly beneath the save action so you can validate credentials before rolling them out to donors.

PayPal settings now include fields for the subscription plan ID, recurring price, and currency. The plan ID powers the "Open PayPal subscription" button on shareable invite pages, and the price is shown as a reminder to donors before they generate their Plex invite.

### Running

```bash
npm run dev    # start with hot reload
# or
npm start      # production mode
```

The admin dashboard is served from `http://localhost:3000/` and exposes JSON APIs under `/api/admin`. Configure your PayPal webhook to POST to `/api/paypal/webhook`.

### Shareable donor pages

Open the **Subscribers** tab in the admin dashboard to copy invite links for supporters. Each donor row contains a **Copy share link** button that generates the unique `/share/<token>` URL you can send to donors. The same action is available immediately after you add a new donor, so you always have a quick way to distribute the self-service invite page.
