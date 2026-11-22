"""
Run this script once in your terminal to pair your phone's Authenticator app
(Google Authenticator, Authy, Apple Passwords, etc.) with ClassPulse Admin.

Usage:
    python3 setup_admin.py
"""

from security import (
    CONFIG_PATH,
    format_secret_readable,
    generate_totp,
    get_otpauth_uri,
    load_admin_config,
)


def main():
    cfg = load_admin_config()
    secret = cfg["totp_secret"]
    formatted = format_secret_readable(secret)
    uri = get_otpauth_uri(secret)
    current_code = generate_totp(secret)

    print("=" * 62)
    print("  ClassPulse Admin — Phone Authenticator Setup (TOTP)")
    print("=" * 62)
    print("\n1. Open Google Authenticator or Authy on your phone.")
    print("2. Tap '+' -> 'Enter a setup key' (Time-based / TOTP).")
    print("3. Enter these details:")
    print(f"   Account Name : ClassPulse Admin")
    print(f"   Setup Key    : {formatted}")
    print(f"   Type         : Time-based (30s, 6 digits)")
    print("\n   (Or paste this otpauth URI if your app supports it:)")
    print(f"   {uri}")
    print("\n4. Verify your phone shows this 6-digit code right now:")
    print(f"   Current 6-digit code: {current_code}")
    print("\n5. Use your phone's rotating 6-digit code to unlock the Admin Panel")
    print("   at http://127.0.0.1:8000 -> 'Admin Panel Login'.")
    print(f"\nConfig saved securely at: {CONFIG_PATH} (owner-only permissions)")
    print("=" * 62)


if __name__ == "__main__":
    main()
