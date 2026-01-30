# Plex-Donate

Automated system to handle:
- **PayPal subscriptions** (monthly donations) and payment webhooks.
- Auto-generate **Plex invites** and deliver them by email.
- Manage invites/subscriptions from an **Admin dashboard** with CSRF-protected API.
- Optionally revoke **Plex access** if a subscription is canceled.

## ✨ Features

- Secure admin dashboard with session-based authentication.
- PayPal webhook endpoint that keeps the local SQLite database in sync.
- Direct Plex invite creation, storage, email delivery, and optional auto-revocation on cancellation.
- Optional Plex integration to remove canceled donors automatically.
- Activity log for webhook events and admin actions.
- Shareable donor dashboard so supporters can confirm donations, pick their invite email, and self-serve Plex access.
- Built-in referral share links that generate Plex invites directly—no external tooling or Wizarr deployment required.
- Dedicated customer dashboard at `/dashboard` where subscribers can log in with their PayPal subscription ID to manage invites and update contact details.

## 📋 Requirements
- Node.js 18+ (20+ recommended)
- npm 9+
- PayPal developer account
- Plex Media Server running (token, server UUID, and library section IDs)
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

After the server is running visit `http://localhost:3000`, sign in with the admin username and password (credentials must be entered in the form), and fill in the integration credentials directly from the dashboard. The default username is `admin`. On first start Plex Donate generates a secure temporary password and prints it to the server log so you can sign in and change it from the dashboard. When upgrading from a legacy release that stored the admin secret as a `password` value in `data/admin-credentials.json`, Plex Donate rehashes that existing password on startup instead of replacing it, so you can continue signing in with the same credential. If the legacy file also included an obsolete `passwordHash` entry, the plaintext `password` is trusted and the outdated hash is replaced automatically.

If you need to reset the admin password after a crash/restart, run the helper script (it writes a new hash to `data/admin-credentials.json` and prints the new password directly to stdout):

```bash
npm run reset-admin
```

You can also set explicit values:

```bash
npm run reset-admin -- --username=admin --password="your-new-long-password"
```

### Environment variables

Only the core application settings live in `.env` now:

| Variable | Description |
| --- | --- |
| `NODE_ENV` | Runtime environment label (defaults to `development`). |
| `PORT` | Port the Express server listens on. |
| `SESSION_SECRET` | (Optional) Override the generated admin session secret for the dashboard. |
| `SESSION_COOKIE_SECURE` | Set to `true` to mark the admin session cookie as secure (requires HTTPS). Defaults to `false`. |
| `ADMIN_USERNAME` | (Optional) Username for the admin dashboard. Defaults to `admin`. |
| `DATABASE_FILE` | Location of the SQLite database file. |

When running in production, you must set `SESSION_SECRET` or persist `data/.secrets` on a durable volume so the session key survives restarts and shared instances can validate the same login cookies. Without one of those options, admin logins will break after a restart or when multiple instances are deployed.

When you serve Plex-Donate over HTTPS (for example, behind a reverse proxy that terminates TLS), set `SESSION_COOKIE_SECURE=true` so browsers only send the admin session cookie over secure connections. Secure cookies require HTTPS requests; if you terminate TLS at a proxy, it must forward `X-Forwarded-Proto=https` so the app can confirm the request is secure when `SESSION_COOKIE_SECURE=true`.

After signing in you can manage the admin username and password directly from the dashboard using the **Admin account** panel. Password updates require at least 12 characters.

### Configure integrations

Use the **Integration settings** panel in the admin dashboard to store PayPal, Plex, and SMTP credentials. Values are written to the database so they survive restarts without exposing secrets in environment files.

Set the Overseerr base URL under **Application settings** to expose a shortcut on the donor dashboard for media requests.

### Plex invite configuration

Plex invites require the following values:

- **Server URL**: the base URL used to reach your Plex server (e.g. `https://plex.example.com`).
- **Plex token**: generate a long-lived token from Plex and paste it here.
- **Server UUID**: the `machineIdentifier` for the Plex server that should share libraries. Plex Donate now resolves the numeric
  server id automatically, so you can continue pasting the machine identifier from Plex.
- **Library section IDs**: a comma-separated list of section IDs to share with donors.
- **Allow sync/camera uploads/channels**: toggle the permissions that should be applied when creating an invite.

The admin test invite button will verify these settings by creating a temporary Plex invite and emailing it to the address you provide.

Each integration also provides a **Test** button directly beneath the save action so you can validate credentials before rolling them out to donors.

PayPal settings now include fields for the subscription plan ID, recurring price, and currency. The plan ID powers the "Open PayPal subscription" button on shareable invite pages, and the price is shown as a reminder to donors before they generate their Plex invite.

### Running

```bash
npm run dev    # start with hot reload
# or
npm start      # production mode
```

The admin dashboard is served from `http://localhost:3000/` and exposes JSON APIs under `/api/admin`. Configure your PayPal webhook to POST to `/api/paypal/webhook`.

### Shareable donor pages & invite flow

Open the **Subscribers** tab in the admin dashboard to copy invite links for supporters. Each donor row contains a **Copy share link** button that generates the unique `/share/<token>` URL you can send to donors. Once the supporter signs in on that page they can generate a Plex invite directly from Plex Donate, send it to their recipient, and resend the same link later without leaving the app. The same action is available immediately after you add a new donor, so you always have a quick way to distribute the self-service invite page.

Subscribers can also access the same invite controls from the `/dashboard` experience. When they create a referral invite, the dashboard and share page both surface the generated `inviteUrl` along with cooldown messaging so they know when the next referral is available.

### Customer dashboard

Set your PayPal return/landing URL to `https://<your-domain>/dashboard`. Subscribers sign in with their PayPal subscription ID and email to view account status, update their preferred streaming address, and generate fresh Plex invites on demand.

## 📱 Progressive Web App

- When Android 13+ "Themed icons" is enabled, the system intentionally displays
  a monochrome version of the Plex Donate icon that matches your wallpaper.
  Disable themed icons in Android settings if you prefer the full-color
  artwork. The manifest continues to ship the full-color maskable icons for
  launchers that do not support theming.
- The PWA is available at `https://your.domain/dashboard`.
- If you run into issues on iOS, make sure you set the `publicBaseUrl` setting
  in the admin dashboard under _Application settings_.
- Safari on macOS does not currently support push notifications for PWAs.

### Brave browser CSRF protection

Brave Shields may block authentication cookies for installed PWAs, which can
result in an `Invalid CSRF token` error when you open the dashboard from the
home screen. The frontend now retries once by requesting a fresh session token,
but if Brave continues to block the cookie you will need to disable Shields for
your Plex Donate domain.
