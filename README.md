# ClassPulse — Student Social Hub

A full-stack social web app where students share **Pics**, **Vlogs**, and **Blogs**, protected by **per-session admin verification** via **Gmail One-Click Allow/Deny Emails** and a **Phone Authenticator App (TOTP)**.

## Security Architecture
- **No Static Admin Password**: The Admin Panel is unlocked using a rotating **6-digit code** from your phone's Authenticator app (Google Authenticator, Authy, Apple Passwords, etc.), with brute-force rate limiting and replay protection.
- **One-Click Gmail Approval Links**: Every student sign-in generates single-use, 15-minute expiring cryptographic Allow/Deny links emailed directly to your Gmail (and logged in a Local Test Inbox inside the Admin Panel until Gmail is connected).

## Quick Start
1. **Pair your Phone Authenticator App** (run once in your terminal):
   ```bash
   python3 setup_admin.py
   ```
   Add the printed Setup Key to Google Authenticator or Authy.

2. **Start the server**:
   ```bash
   python3 -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
   ```
   Open `http://127.0.0.1:8000`.

3. **Connect Gmail (optional, for real email notifications)**:
   - Open **Admin Panel Login**, enter the 6-digit code from your phone, and open the **Gmail & Test Inbox** tab.
   - Enter your Gmail address and a **16-character Google App Password** (from Google Account → Security → 2-Step Verification → App Passwords), then click **Save Gmail Settings** and **Send Test Email**.
