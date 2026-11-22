import base64
import hashlib
import hmac
import json
import os
import secrets
import smtplib
import struct
import time
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "admin_config.json"
LOCAL_INBOX_DIR = BASE_DIR / "local_inbox"
LOCAL_INBOX_DIR.mkdir(exist_ok=True)


# ---------- Config Management ----------

def load_admin_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    else:
        data = {}

    changed = False
    if not data.get("totp_secret"):
        # 160-bit cryptographically random secret encoded as Base32 (standard for Google Authenticator / Authy)
        raw = secrets.token_bytes(20)
        data["totp_secret"] = base64.b32encode(raw).decode("ascii").rstrip("=")
        changed = True

    defaults = {
        "email_mode": os.environ.get("EMAIL_MODE", "mailpit"),  # mailpit | gmail
        "smtp_host": os.environ.get("SMTP_HOST", "127.0.0.1"),
        "smtp_port": int(os.environ.get("SMTP_PORT", "1025")),
        "admin_email": os.environ.get("ADMIN_EMAIL", "kinza.surya@gmail.com"),
        "gmail_user": os.environ.get("GMAIL_USER", ""),
        "gmail_app_password": os.environ.get("GMAIL_APP_PASSWORD", ""),
        "app_base_url": os.environ.get("APP_BASE_URL", "http://127.0.0.1:8000"),
    }
    for k, v in defaults.items():
        if k not in data:
            data[k] = v
            changed = True

    if changed:
        save_admin_config(data)
    return data


def save_admin_config(data: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass


# ---------- RFC 6238 TOTP (Google Authenticator / Authy) ----------

def _b32_decode(secret: str) -> bytes:
    cleaned = secret.strip().replace(" ", "").upper()
    pad = (-len(cleaned)) % 8
    return base64.b32decode(cleaned + ("=" * pad), casefold=True)


def generate_totp(secret: str, for_time: Optional[int] = None, step: int = 30, digits: int = 6) -> str:
    if for_time is None:
        for_time = int(time.time())
    counter = int(for_time // step)
    key = _b32_decode(secret)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code_int = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(code_int % (10 ** digits)).zfill(digits)


class TotpGuard:
    """Rate-limits admin login attempts and prevents 6-digit TOTP replay."""

    def __init__(self, max_failures: int = 5, lockout_seconds: int = 300):
        self.max_failures = max_failures
        self.lockout_seconds = lockout_seconds
        self.failures: list[float] = []
        self.used_counters: set[int] = set()

    def _prune(self, now: float) -> None:
        cutoff = now - self.lockout_seconds
        self.failures = [t for t in self.failures if t > cutoff]
        current_counter = int(now // 30)
        self.used_counters = {c for c in self.used_counters if c >= current_counter - 2}

    def check_lockout(self) -> Optional[int]:
        now = time.time()
        self._prune(now)
        if len(self.failures) >= self.max_failures:
            retry_after = int(self.lockout_seconds - (now - self.failures[0]))
            return max(1, retry_after)
        return None

    def verify(self, secret: str, code: str) -> tuple[bool, str]:
        now = time.time()
        retry = self.check_lockout()
        if retry is not None:
            return False, f"Too many failed attempts. Try again in {retry}s."

        cleaned = code.strip().replace(" ", "")
        if not cleaned.isdigit() or len(cleaned) != 6:
            self.failures.append(now)
            return False, "Please enter a valid 6-digit code from your Authenticator app."

        current_counter = int(now // 30)
        # Allow +/- 1 time step (30s) to handle minor clock drift
        for offset in (0, -1, 1):
            counter = current_counter + offset
            expected = generate_totp(secret, for_time=counter * 30)
            if secrets.compare_digest(cleaned, expected):
                if counter in self.used_counters:
                    return False, "This 6-digit code was already used. Wait for the next code."
                self.used_counters.add(counter)
                self.failures.clear()
                return True, "ok"

        self.failures.append(now)
        return False, "Invalid authenticator code."


totp_guard = TotpGuard()


def get_otpauth_uri(secret: str, account_name: str = "Primus Pix Admin", issuer: str = "Primus Pix") -> str:
    from urllib.parse import quote
    label = quote(f"{issuer}:{account_name}")
    iss = quote(issuer)
    return f"otpauth://totp/{label}?secret={secret}&issuer={iss}&algorithm=SHA1&digits=6&period=30"


def format_secret_readable(secret: str) -> str:
    return " ".join(secret[i : i + 4] for i in range(0, len(secret), 4))


# ---------- Approval Email Delivery (Gmail SMTP + Local Test Inbox) ----------

def build_approval_email_html(
    reg_number: str,
    name: str,
    class_name: str,
    allow_url: str,
    deny_url: str,
    requested_at: str,
) -> str:
    return f"""<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0f19;color:#f1f5f9;padding:24px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#161d31;border:1px solid #2b3552;border-radius:16px;padding:26px;">
    <h2 style="margin:0 0 8px;color:#ffffff;">New Primus Pix Sign-In Request</h2>
    <p style="margin:0 0 18px;color:#94a3b8;font-size:14px;">
      A student is trying to sign in. Click <strong>Allow</strong> or <strong>Deny</strong> below (links expire in 15 minutes and work only once).
    </p>
    <table style="width:100%;border-collapse:collapse;background:#0e1424;border-radius:10px;margin-bottom:22px;">
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Registration No</td><td style="padding:10px 14px;font-weight:700;color:#fff;">{reg_number}</td></tr>
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Full Name</td><td style="padding:10px 14px;font-weight:700;color:#fff;">{name}</td></tr>
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Class</td><td style="padding:10px 14px;font-weight:700;color:#fff;">{class_name}</td></tr>
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Requested At</td><td style="padding:10px 14px;color:#cbd5e1;font-size:13px;">{requested_at}</td></tr>
    </table>
    <div style="text-align:center;">
      <a href="{allow_url}" style="display:inline-block;background:#10b981;color:#041c13;font-weight:700;text-decoration:none;padding:12px 26px;border-radius:10px;margin-right:10px;">
        ✓ Allow Sign-In
      </a>
      <a href="{deny_url}" style="display:inline-block;background:#ef4444;color:#ffffff;font-weight:700;text-decoration:none;padding:12px 26px;border-radius:10px;">
        ✕ Deny Sign-In
      </a>
    </div>
  </div>
</body>
</html>"""


def send_approval_email(
    session_id: int,
    reg_number: str,
    name: str,
    class_name: str,
    allow_token: str,
    deny_token: str,
    requested_at: str,
) -> dict:
    cfg = load_admin_config()
    base_url = cfg.get("app_base_url", "http://127.0.0.1:8000").rstrip("/")
    allow_url = f"{base_url}/api/email-action/{allow_token}"
    deny_url = f"{base_url}/api/email-action/{deny_token}"

    subject = f"[Primus Pix] Sign-In Request: {name} ({reg_number})"
    html_body = build_approval_email_html(
        reg_number=reg_number,
        name=name,
        class_name=class_name,
        allow_url=allow_url,
        deny_url=deny_url,
        requested_at=requested_at,
    )

    # Always save a copy in local_inbox so admin can also preview/test locally
    email_record = {
        "session_id": session_id,
        "subject": subject,
        "reg_number": reg_number,
        "name": name,
        "class_name": class_name,
        "allow_url": allow_url,
        "deny_url": deny_url,
        "created_at": requested_at,
        "delivery": "local_inbox",
        "error": None,
    }

    email_mode = (cfg.get("email_mode") or "mailpit").strip().lower()
    smtp_host = (cfg.get("smtp_host") or "127.0.0.1").strip()
    smtp_port = int(cfg.get("smtp_port") or 1025)
    gmail_user = (cfg.get("gmail_user") or "").strip()
    gmail_pass = (cfg.get("gmail_app_password") or "").replace(" ", "").strip()
    admin_email = (cfg.get("admin_email") or gmail_user or "admin@primuspix.local").strip()

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = gmail_user or "noreply@primuspix.local"
    msg["To"] = admin_email
    text_body = (
        f"New Primus Pix Sign-In Request\n"
        f"Reg No: {reg_number}\nName: {name}\nClass: {class_name}\n\n"
        f"ALLOW: {allow_url}\n"
        f"DENY:  {deny_url}\n"
    )
    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    if email_mode == "mailpit":
        try:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=5) as server:
                server.sendmail(msg["From"], [admin_email], msg.as_string())
            email_record["delivery"] = f"mailpit ({smtp_host}:{smtp_port})"
        except Exception as exc:
            email_record["delivery"] = "local_inbox (mailpit not running)"
            email_record["error"] = str(exc)
    elif gmail_user and gmail_pass and admin_email:
        try:
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=10) as server:
                server.login(gmail_user, gmail_pass)
                server.sendmail(gmail_user, [admin_email], msg.as_string())
            email_record["delivery"] = f"gmail ({admin_email})"
        except Exception as exc:
            email_record["delivery"] = "local_inbox (gmail failed)"
            email_record["error"] = str(exc)

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    fname = f"{ts}_session_{session_id}.json"
    (LOCAL_INBOX_DIR / fname).write_text(json.dumps(email_record, indent=2), encoding="utf-8")
    return email_record


def _deliver_email(subject: str, text_body: str, html_body: str) -> tuple[str, Optional[str]]:
    cfg = load_admin_config()
    email_mode = (cfg.get("email_mode") or "mailpit").strip().lower()
    smtp_host = (cfg.get("smtp_host") or "127.0.0.1").strip()
    smtp_port = int(cfg.get("smtp_port") or 1025)
    gmail_user = (cfg.get("gmail_user") or "").strip()
    gmail_pass = (cfg.get("gmail_app_password") or "").replace(" ", "").strip()
    admin_email = (cfg.get("admin_email") or gmail_user or "admin@primuspix.local").strip()

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = gmail_user or "noreply@primuspix.local"
    msg["To"] = admin_email
    msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    if email_mode == "mailpit":
        try:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=5) as server:
                server.sendmail(msg["From"], [admin_email], msg.as_string())
            return f"mailpit ({smtp_host}:{smtp_port})", None
        except Exception as exc:
            return "local_inbox (mailpit not running)", str(exc)
    elif gmail_user and gmail_pass and admin_email:
        try:
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=10) as server:
                server.login(gmail_user, gmail_pass)
                server.sendmail(gmail_user, [admin_email], msg.as_string())
            return f"gmail ({admin_email})", None
        except Exception as exc:
            return "local_inbox (gmail failed)", str(exc)
    return "local_inbox (gmail not configured)", "Gmail credentials not configured"


def send_admin_magic_link_email(
    magic_url: str,
    requested_ip: str,
    user_agent: str,
    requested_at: str,
) -> dict:
    subject = "[Primus Pix] Admin Panel Access Request (One-Time Link)"
    safe_ua = (user_agent or "Unknown browser")[:140]
    html_body = f"""<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0f19;color:#f1f5f9;padding:24px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#161d31;border:1px solid #2b3552;border-radius:16px;padding:26px;">
    <h2 style="margin:0 0 8px;color:#ffffff;">Admin Panel Login Attempt</h2>
    <p style="margin:0 0 18px;color:#94a3b8;font-size:14px;">
      Someone requested access to the <strong>Primus Pix Admin Panel</strong>. Click the button below to open it.
      This link expires in <strong>10 minutes</strong> and works <strong>only once</strong>.
    </p>
    <table style="width:100%;border-collapse:collapse;background:#0e1424;border-radius:10px;margin-bottom:22px;">
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Requested At</td><td style="padding:10px 14px;color:#fff;font-size:13px;">{requested_at}</td></tr>
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">IP Address</td><td style="padding:10px 14px;font-weight:700;color:#fff;">{requested_ip}</td></tr>
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Device</td><td style="padding:10px 14px;color:#cbd5e1;font-size:12px;">{safe_ua}</td></tr>
    </table>
    <div style="text-align:center;margin-bottom:18px;">
      <a href="{magic_url}" style="display:inline-block;background:#f472b6;color:#ffffff;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:10px;font-size:15px;">
        Open Primus Pix Admin Panel
      </a>
    </div>
    <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
      Didn't request this? Ignore this email — nobody can enter the Admin Panel without clicking this link.
    </p>
  </div>
</body>
</html>"""
    text_body = (
        f"Primus Pix Admin Panel Login Attempt\n"
        f"Requested At: {requested_at}\n"
        f"IP Address: {requested_ip}\n"
        f"Device: {safe_ua}\n\n"
        f"Open Admin Panel (one-time link, expires in 10 min):\n{magic_url}\n\n"
        f"If you did not request this, ignore this email."
    )
    delivery, err = _deliver_email(subject, text_body, html_body)
    record = {
        "type": "admin_magic_link",
        "subject": subject,
        "requested_ip": requested_ip,
        "user_agent": safe_ua,
        "created_at": requested_at,
        "delivery": delivery,
        "error": err,
    }
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    (LOCAL_INBOX_DIR / f"{ts}_admin_link.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def send_student_login_alert_email(
    reg_number: str,
    name: str,
    class_name: str,
    requested_ip: str,
    requested_at: str,
) -> dict:
    subject = f"[Primus Pix] Student Sign-In Alert: {name} ({reg_number})"
    html_body = f"""<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0f19;color:#f1f5f9;padding:24px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#161d31;border:1px solid #2b3552;border-radius:16px;padding:26px;">
    <h2 style="margin:0 0 8px;color:#ffffff;">Student Sign-In Notification</h2>
    <p style="margin:0 0 18px;color:#94a3b8;font-size:14px;">
      A verified student just signed in to <strong>Primus Pix</strong>.
    </p>
    <table style="width:100%;border-collapse:collapse;background:#0e1424;border-radius:10px;">
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Registration No</td><td style="padding:10px 14px;font-weight:700;color:#fff;">{reg_number}</td></tr>
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Full Name</td><td style="padding:10px 14px;font-weight:700;color:#fff;">{name}</td></tr>
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Class</td><td style="padding:10px 14px;font-weight:700;color:#fff;">{class_name}</td></tr>
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">IP Address</td><td style="padding:10px 14px;color:#cbd5e1;font-size:13px;">{requested_ip}</td></tr>
      <tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Signed In At</td><td style="padding:10px 14px;color:#cbd5e1;font-size:13px;">{requested_at}</td></tr>
    </table>
  </div>
</body>
</html>"""
    text_body = (
        f"Primus Pix Student Sign-In Alert\n"
        f"Reg No: {reg_number}\nName: {name}\nClass: {class_name}\n"
        f"IP: {requested_ip}\nTime: {requested_at}\n"
    )
    delivery, err = _deliver_email(subject, text_body, html_body)
    record = {
        "type": "student_login_alert",
        "subject": subject,
        "reg_number": reg_number,
        "name": name,
        "class_name": class_name,
        "requested_ip": requested_ip,
        "created_at": requested_at,
        "delivery": delivery,
        "error": err,
    }
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    (LOCAL_INBOX_DIR / f"{ts}_signin_{reg_number}.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def list_local_inbox(limit: int = 30) -> list[dict]:
    files = sorted(LOCAL_INBOX_DIR.glob("*.json"), reverse=True)[:limit]
    items = []
    for f in files:
        try:
            items.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            pass
    return items


def send_test_gmail() -> tuple[bool, str]:
    cfg = load_admin_config()
    email_mode = (cfg.get("email_mode") or "mailpit").strip().lower()
    smtp_host = (cfg.get("smtp_host") or "127.0.0.1").strip()
    smtp_port = int(cfg.get("smtp_port") or 1025)
    gmail_user = (cfg.get("gmail_user") or "").strip()
    gmail_pass = (cfg.get("gmail_app_password") or "").replace(" ", "").strip()
    admin_email = (cfg.get("admin_email") or gmail_user or "admin@primuspix.local").strip()

    if email_mode == "mailpit":
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = "[Primus Pix] Mailpit Test Email Successful"
            msg["From"] = "noreply@primuspix.local"
            msg["To"] = admin_email
            msg.attach(MIMEText("Your Primus Pix local Mailpit email testing is working!", "plain"))
            msg.attach(
                MIMEText(
                    "<div style='font-family:sans-serif;padding:20px;background:#fdf2f8;border-radius:12px;'>"
                    "<h2 style='color:#db2777;margin-top:0;'>Primus Pix + Mailpit Connected!</h2>"
                    "<p>Approval emails with one-click Allow / Deny buttons will appear right here in Mailpit.</p></div>",
                    "html",
                )
            )
            with smtplib.SMTP(smtp_host, smtp_port, timeout=5) as server:
                server.sendmail(msg["From"], [admin_email], msg.as_string())
            return True, f"Test email sent to Mailpit ({smtp_host}:{smtp_port})! Check http://127.0.0.1:8025"
        except Exception as exc:
            return False, f"Could not reach Mailpit at {smtp_host}:{smtp_port} — make sure Mailpit is running! ({exc})"

    if not gmail_user or not gmail_pass or not admin_email:
        return False, "Please fill in your Gmail address and 16-character Google App Password first."
    try:
        msg = MIMEText("Your Primus Pix Gmail approval notifications are working!", "plain")
        msg["Subject"] = "[Primus Pix] Test Email Successful"
        msg["From"] = gmail_user
        msg["To"] = admin_email
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=10) as server:
            server.login(gmail_user, gmail_pass)
            server.sendmail(gmail_user, [admin_email], msg.as_string())
        return True, f"Test email sent to {admin_email}!"
    except Exception as exc:
        return False, f"Gmail error: {exc}"
