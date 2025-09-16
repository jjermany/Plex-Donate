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
| `SESSION_SECRET` | Secret used to encrypt admin sessions. |
| `ADMIN_PASSWORD` | Password required to access the admin dashboard. |
| `DATABASE_FILE` | Location of the SQLite database file. |

### Configure integrations

Use the **Integration settings** panel in the admin dashboard to store PayPal, Wizarr, SMTP, and optional Plex credentials. Values are written to the database so they survive restarts without exposing secrets in environment files.

### Running

```bash
npm run dev    # start with hot reload
# or
npm start      # production mode
```

The admin dashboard is served from `http://localhost:3000/` and exposes JSON APIs under `/api/admin`. Configure your PayPal webhook to POST to `/api/paypal/webhook`.
