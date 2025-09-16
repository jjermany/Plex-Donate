# Plex-Donate

Automated system to handle:
- **PayPal subscriptions** (monthly donations).
- Auto-generate **Wizarr invites** + email delivery.
- Manage invites/subscriptions from an **Admin dashboard**.
- Optionally revoke **Plex access** if a subscription is canceled.

## 📋 Requirements
- Node.js 18+ (20+ recommended)
- npm 9+
- PayPal developer account
- Wizarr running
- SMTP credentials
- (Optional) Plex Token for revoke

## 📦 Setup

```bash
git clone https://github.com/yourname/Plex-Donate.git
cd Plex-Donate
npm install
cp .env.example .env   # then edit values
npm run dev            # run locally
