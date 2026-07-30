# Member Hub

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
- Admin-managed courtesy access for friends, family, and existing Plex members without fabricating a paid subscription.
- Existing Plex-user discovery and import, with duplicate-account matching by Plex identity and email.
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

### Windows development

This repository is maintained for Windows development going forward.

- Use Windows Node.js and run the project from PowerShell or `cmd`.
- Do not use WSL for this checkout.
- Native modules such as `better-sqlite3` are OS-specific, so switching the same working tree between Windows Node and WSL Node will break `node_modules`.

If dependencies ever look out of sync on Windows, rebuild them from a Windows terminal:

```powershell
rmdir /s /q node_modules
npm install
npm test
```

After the server is running visit `http://localhost:3000`, sign in with the admin username and password (credentials must be entered in the form), and fill in the integration credentials directly from the dashboard. The default username is `admin`. On first start Member Hub generates a secure temporary password and prints it to the server log so you can sign in and change it from the dashboard. When upgrading from a legacy release that stored the admin secret as a `password` value in `data/admin-credentials.json`, Member Hub rehashes that existing password on startup instead of replacing it, so you can continue signing in with the same credential. If the legacy file also included an obsolete `passwordHash` entry, the plaintext `password` is trusted and the outdated hash is replaced automatically.

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
| `UPS_WEBHOOK_TOKEN` | (Optional) Bearer token that enables the UPS automation webhook at `/api/automation/ups`. |

When running in production, you must set `SESSION_SECRET` or persist `data/.secrets` on a durable volume so the session key survives restarts and shared instances can validate the same login cookies. Without one of those options, admin logins will break after a restart or when multiple instances are deployed.

When you serve Member Hub over HTTPS (for example, behind a reverse proxy that terminates TLS), set `SESSION_COOKIE_SECURE=true` so browsers only send the admin session cookie over secure connections. Secure cookies require HTTPS requests; if you terminate TLS at a proxy, it must forward `X-Forwarded-Proto=https` so the app can confirm the request is secure when `SESSION_COOKIE_SECURE=true`.

After signing in you can manage the admin username and password directly from the dashboard using the **Admin account** panel. Password updates require at least 12 characters.

### Configure integrations

Use the **Integration settings** panel in the admin dashboard to store PayPal, Plex, and SMTP credentials. Values are written to the database so they survive restarts without exposing secrets in environment files.

Set the Overseerr base URL under **Application settings** to expose a shortcut on the donor dashboard for media requests.

### Branding

Member Hub uses a neutral default identity and can be personalized from
**Integration settings → Application**:

- **Application name** controls browser titles, portal copy, installed-app
  metadata, Plex OAuth labels, PayPal product defaults, and authenticator-app
  issuer names.
- **Email sender name** controls the visible display name while preserving the
  SMTP mailbox address.
- **Email sign-off** controls the signature used by every email template.

Branding is resolved at delivery time for invites, imported-member setup,
verification, password reset, subscription, trial, support, announcement,
administrative, and UPS-status emails.

For upgrade safety, existing installations retain legacy database filenames,
session-cookie names, and Plex client identifiers internally. These identifiers
are not shown to members and should not be renamed in place, because doing so
could make an existing database appear missing, invalidate sessions, or disrupt
linked Plex identities. Legacy icon URLs also remain available as aliases, but
serve the new Member Hub artwork.

### Plex invite configuration

Plex invites require the following values:

- **Server URL**: the base URL used to reach your Plex server (e.g. `https://plex.example.com`).
- **Plex token**: generate a long-lived token from Plex and paste it here.
- **Server UUID**: the `machineIdentifier` for the Plex server that should share libraries. Member Hub resolves the numeric
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

### Unraid template icon

Use the raw GitHub asset URL for the Unraid template icon:

`https://raw.githubusercontent.com/jjermany/Plex-Donate/main/public/icons/member-hub-unraid-icon.png`

### Tests and diagnostics

Automated tests stay colocated with the server code as `*.test.js` files under `server/` and run with:

```bash
npm test
```

Manual live-environment diagnostics live under `scripts/manual/` and can be run with:

```bash
npm run diag:plex-invite
npm run diag:access-expiration -- 1
npm run diag:plex-revoke -- 1
npm run diag:plex-sync
```

The admin dashboard is served from `http://localhost:3000/` and exposes JSON APIs under `/api/admin`. Configure your PayPal webhook to POST to `/api/paypal/webhook`.

### Isolated live test environment

Run `npm run test:env` to start a loopback-only test instance with a temporary
database, temporary admin credentials, and representative subscriber records.
The command prints the URL and credentials as `MEMBER_HUB_TEST_ENV` JSON. The
environment shuts down and deletes its temporary files on Ctrl+C or automatically
after 15 minutes.

Use `npm run test:env -- --ttl 300` to change the automatic shutdown timeout,
`npm run test:env -- --empty` to omit seeded subscribers, or
`npm run test:env:smoke` to start it, verify the health endpoint, and immediately
clean it up. This environment never uses the configured production database.

### UPS outage automation

If you use NUT on Unraid, Member Hub can send automatic outage, recovery, and shutdown-imminent emails to `active` and `trial` users when your UPS state changes.

1. Set `UPS_WEBHOOK_TOKEN` in the Member Hub environment.
2. Make sure SMTP is already configured in the Member Hub admin dashboard.
3. Have NUT call the webhook with a bearer token when power fails, when power returns, and when shutdown is imminent.

If you deploy with the included compose example, add the token to the container environment:

```yaml
environment:
  - NODE_ENV=production
  - PORT=8080
  - UPS_WEBHOOK_TOKEN=change-me
```

### Unraid NUT plugin UI

If you are using the Unraid NUT plugin UI, the settings that matter are in `upsmon.conf` and `xnut-notify-hooks.sh`.

In `upsmon.conf`, keep your existing `MONITOR`, `SHUTDOWNCMD`, and `POWERDOWNFLAG` lines, then make sure these lines are present:

```conf
NOTIFYCMD "/etc/nut/xnut-notify-hooks.sh"
NOTIFYFLAG ONBATT SYSLOG+EXEC
NOTIFYFLAG ONLINE SYSLOG+EXEC
NOTIFYFLAG LOWBATT SYSLOG+EXEC
```

Do not put the Member Hub webhook URL or token in `ups.conf`. That file is only for UPS device configuration.

In `xnut-notify-hooks.sh`, update the `ONLINE()`, `ONBATT()`, and low-battery or shutdown function so they call Member Hub. A working example is:

```bash
#!/bin/bash

MEMBER_HUB_WEBHOOK_URL="https://member-hub.example.com/api/automation/ups"
MEMBER_HUB_WEBHOOK_TOKEN="YOUR_UPS_WEBHOOK_TOKEN"
UPS_NAME="CyberPower"
UPS_UPSC_TARGET="CyberPower@127.0.0.1"

get_ups_value () {
    /usr/bin/upsc "$UPS_UPSC_TARGET" "$1" 2>/dev/null | /usr/bin/head -n 1
}

post_ups_event () {
    local event="$1"
    local attempts="${2:-1}"
    local delay_seconds="${3:-0}"
    local battery_charge
    local runtime_seconds
    local occurred_at
    local escaped_ups_name
    local json
    local attempt

    battery_charge="$(get_ups_value battery.charge)"
    runtime_seconds="$(get_ups_value battery.runtime)"
    occurred_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    escaped_ups_name="${UPS_NAME//\"/\\\"}"
    json="{\"event\":\"$event\",\"upsName\":\"$escaped_ups_name\",\"occurredAt\":\"$occurred_at\""

    if [[ "$battery_charge" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      json="$json,\"batteryChargePercent\":$battery_charge"
    fi

    if [[ "$runtime_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      json="$json,\"runtimeSeconds\":$runtime_seconds"
    fi

    json="$json}"

    (
      for (( attempt=1; attempt<=attempts; attempt++ )); do
        if /usr/bin/curl -fsS -X POST "$MEMBER_HUB_WEBHOOK_URL" \
          -H "Authorization: Bearer $MEMBER_HUB_WEBHOOK_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$json" >/dev/null 2>&1; then
          exit 0
        fi

        if [[ "$attempt" -lt "$attempts" && "$delay_seconds" -gt 0 ]]; then
          /usr/bin/sleep "$delay_seconds"
        fi
      done
    ) &
}

ONLINE () {
    echo "ONLINE commands are now executing in background..."
    post_ups_event "power_restored" 3 120
}

ONBATT () {
    echo "ONBATT commands are now executing in background..."
    post_ups_event "power_outage"
}

LOWBATT () {
    echo "LOWBATT commands are now executing in background..."
    post_ups_event "shutdown_imminent"
}

ONBATT_SHUTDOWN () {
    echo "ONBATT_SHUTDOWN commands are now executing in background..."
    post_ups_event "shutdown_imminent"
}

REPLBATT () {
    echo "REPLBATT commands are now executing in background..."
}

case "$NOTIFYTYPE" in
  ONLINE) ONLINE ;;
  ONBATT) ONBATT ;;
  LOWBATT) LOWBATT ;;
  ONBATT_SHUTDOWN) ONBATT_SHUTDOWN ;;
  REPLBATT) REPLBATT ;;
  *)
    logger -t xnut-notify-hooks "Unhandled NOTIFYTYPE: $NOTIFYTYPE"
    ;;
esac
```

After saving the NUT files, restart the NUT plugin/service. A manual webhook test is the fastest way to confirm Member Hub is ready before testing a real UPS event.

Example outage call:

```bash
curl -X POST "https://your-domain/api/automation/ups" \
  -H "Authorization: Bearer $UPS_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "power_outage",
    "upsName": "apc-ups",
    "batteryChargePercent": 82,
    "runtimeSeconds": 2400,
    "occurredAt": "2026-03-17T15:30:00Z"
  }'
```

Example power-restored call:

```bash
curl -X POST "https://your-domain/api/automation/ups" \
  -H "Authorization: Bearer $UPS_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "power_restored",
    "upsName": "apc-ups",
    "occurredAt": "2026-03-17T16:00:00Z"
  }'
```

Example shutdown-imminent call:

```bash
curl -X POST "https://your-domain/api/automation/ups" \
  -H "Authorization: Bearer $UPS_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "shutdown_imminent",
    "upsName": "apc-ups",
    "batteryChargePercent": 12,
    "runtimeSeconds": 180,
    "occurredAt": "2026-03-17T16:05:00Z"
  }'
```

Successful responses look like:

```json
{
  "success": true,
  "event": "power_outage",
  "deduped": false,
  "sent": 12,
  "skipped": 0
}
```

### Shareable donor pages & invite flow

Open the **Subscribers** tab in the admin dashboard to copy invite links for supporters. Each donor row contains a **Copy share link** button that generates the unique `/share/<token>` URL you can send to donors. Once the supporter signs in on that page they can generate a Plex invite directly from Member Hub, send it to their recipient, and resend the same link later without leaving the app. The same action is available immediately after you add a new donor, so you always have a quick way to distribute the self-service invite page.

Subscribers can also access the same invite controls from the `/dashboard` experience. When they create a referral invite, the dashboard and share page both surface the generated `inviteUrl` along with cooldown messaging so they know when the next referral is available.

Paid members and admin-confirmed courtesy members can send referral invites. Member-generated referrals always use the normal trial/paid onboarding path; only an administrator can grant courtesy access. Courtesy members see a quieter dashboard that makes clear their access is already covered while leaving an unobtrusive, optional PayPal support action available.

From the **Subscribers** tab, use **Import Plex users** to find accepted members who already have access to the configured server but are not connected to Member Hub. Imported users receive courtesy access and a setup link without receiving a duplicate Plex share. You can optionally email each selected user their personal setup link as part of the import. To send an imported member the latest setup email later, create a fresh setup link from their subscriber actions and select **Send setup email**. To invite someone new with courtesy access, use **Invite supporter**, select **Grant courtesy access**, and share the generated setup link. Courtesy access can also be granted or removed from an existing subscriber’s detail actions; removing it does not automatically revoke the Plex share. Removing a subscriber deletes only their Member Hub records and preserves their Plex server access; use the separate **Revoke Plex access** action when you also intend to remove their server share.

### Customer dashboard

Set your PayPal return/landing URL to `https://<your-domain>/dashboard`. Subscribers sign in with their PayPal subscription ID and email to view account status, update their preferred streaming address, and generate fresh Plex invites on demand.

## 📱 Progressive Web App

- When Android 13+ "Themed icons" is enabled, the system intentionally displays
  a monochrome version of the Member Hub icon that matches your wallpaper.
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
your Member Hub domain.
