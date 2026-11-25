import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from db import USE_POSTGRES, get_db
from security import (
    list_local_inbox,
    load_admin_config,
    save_admin_config,
    send_admin_magic_link_email,
    send_approval_email,
    send_student_login_alert_email,
    send_test_gmail,
)

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
STATIC_DIR = BASE_DIR / "static"

UPLOAD_DIR.mkdir(exist_ok=True)
STATIC_DIR.mkdir(exist_ok=True)

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
SUPABASE_BUCKET = (os.environ.get("SUPABASE_BUCKET") or "primus-media").strip()
USE_SUPABASE_STORAGE = bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)

# Ensure admin config exists on startup
load_admin_config()

ALLOWED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
ALLOWED_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".ogg"}
MAX_IMAGE_BYTES = 20 * 1024 * 1024   # 20 MB
MAX_VIDEO_BYTES = 100 * 1024 * 1024  # 100 MB

app = FastAPI(title="Primus Pix")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    if USE_POSTGRES:
        # Postgres schema is managed via Supabase migrations; ensure new columns exist
        conn = get_db()
        try:
            conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_message TEXT NOT NULL DEFAULT ''")
            conn.execute("ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_hidden INTEGER NOT NULL DEFAULT 0")
            conn.execute("ALTER TABLE stories ADD COLUMN IF NOT EXISTS is_hidden INTEGER NOT NULL DEFAULT 0")
            conn.execute("ALTER TABLE flashes ADD COLUMN IF NOT EXISTS is_hidden INTEGER NOT NULL DEFAULT 0")
            conn.commit()
        except Exception:
            pass
        finally:
            conn.close()
        return
    conn = get_db()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reg_number TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            class_name TEXT NOT NULL,
            is_banned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL,
            reg_number TEXT NOT NULL,
            name TEXT NOT NULL,
            class_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | revoked | logged_out
            created_at TEXT NOT NULL,
            decided_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS admin_sessions (
            token TEXT PRIMARY KEY,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS admin_magic_links (
            token TEXT PRIMARY KEY,
            expires_at TEXT NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            requested_ip TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            post_type TEXT NOT NULL, -- pic | vlog | blog
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            media_url TEXT,
            media_mime TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS likes (
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (post_id, user_id),
            FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS email_action_tokens (
            token TEXT PRIMARY KEY,
            session_id INTEGER NOT NULL,
            action TEXT NOT NULL, -- approve | deny
            expires_at TEXT NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS stories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            story_type TEXT NOT NULL, -- image | video | text
            caption TEXT NOT NULL DEFAULT '',
            bg_color TEXT NOT NULL DEFAULT '#7a1c38',
            media_url TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            recipient_id INTEGER, -- NULL means Campus Group Chat
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS reactions (
            post_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            emoji TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (post_id, user_id, emoji),
            FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS polls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER, -- NULL for system campus poll
            question TEXT NOT NULL,
            options_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS poll_votes (
            poll_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            option_index INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (poll_id, user_id),
            FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS xp_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS notices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'info', -- info | important | urgent
            pinned INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS close_friends (
            user_id INTEGER NOT NULL,
            friend_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (user_id, friend_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS flashes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            media_url TEXT,
            audience TEXT NOT NULL DEFAULT 'all', -- all | close_friends
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS story_views (
            story_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            viewed_at TEXT NOT NULL,
            PRIMARY KEY (story_id, user_id),
            FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS story_likes (
            story_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (story_id, user_id),
            FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS story_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            story_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        """
    )
    # Safe migrations on existing tables
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    if "xp" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0")
    if "display_name" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN display_name TEXT")
    if "display_name_changed_at" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN display_name_changed_at TEXT")
    if "bio" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''")
    if "avatar_url" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT")
    if "is_verified" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN is_verified INTEGER NOT NULL DEFAULT 0")
        conn.execute(
            "UPDATE users SET is_verified = 1 WHERE id IN (SELECT DISTINCT user_id FROM sessions WHERE status = 'approved')"
        )
    if "ban_message" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN ban_message TEXT NOT NULL DEFAULT ''")

    st_cols = [r["name"] for r in conn.execute("PRAGMA table_info(stories)").fetchall()]
    if "audience" not in st_cols:
        conn.execute("ALTER TABLE stories ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'")
    if "reposted_from" not in st_cols:
        conn.execute("ALTER TABLE stories ADD COLUMN reposted_from TEXT NOT NULL DEFAULT ''")
    if "is_hidden" not in st_cols:
        conn.execute("ALTER TABLE stories ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0")

    fl_cols = [r["name"] for r in conn.execute("PRAGMA table_info(flashes)").fetchall()]
    if "is_hidden" not in fl_cols:
        conn.execute("ALTER TABLE flashes ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0")

    nt_cols = [r["name"] for r in conn.execute("PRAGMA table_info(notices)").fetchall()]
    if "target_class" not in nt_cols:
        conn.execute("ALTER TABLE notices ADD COLUMN target_class TEXT NOT NULL DEFAULT ''")

    p_cols = [r["name"] for r in conn.execute("PRAGMA table_info(posts)").fetchall()]
    if "audience" not in p_cols:
        conn.execute("ALTER TABLE posts ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'")
    if "is_hidden" not in p_cols:
        conn.execute("ALTER TABLE posts ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0")

    # Seed one welcome notice if empty so the Notice Board is visible right away
    notice_count = conn.execute("SELECT COUNT(*) FROM notices").fetchone()[0]
    if notice_count == 0:
        now_n = utc_now()
        conn.execute(
            "INSERT INTO notices (title, body, priority, pinned, created_at, updated_at) VALUES (?, ?, 'important', 1, ?, ?)",
            (
                "Welcome to Primus Pix!",
                "Official campus updates, schedules, and announcements appear here. Admins can add or edit notices anytime from the Admin Panel.",
                now_n,
                now_n,
            ),
        )

    # Seed one starter Campus Poll if none exist so the hub feels alive immediately
    poll_count = conn.execute("SELECT COUNT(*) FROM polls").fetchone()[0]
    if poll_count == 0:
        import json as _json
        conn.execute(
            "INSERT INTO polls (user_id, question, options_json, created_at) VALUES (NULL, ?, ?, ?)",
            (
                "What should our next campus theme day be?",
                _json.dumps(["Throwback Y2K Day", "Pajama & Study Chill", "Neon Glow Fest", "Sports Jersey Clash"]),
                utc_now(),
            ),
        )
    conn.commit()
    conn.close()


init_db()


# ---------- Pydantic Models ----------

class LoginRequest(BaseModel):
    reg_number: str
    name: str
    class_name: str


class AdminLoginRequest(BaseModel):
    password: str


class MessageCreate(BaseModel):
    recipient_id: Optional[int] = None
    body: str


class ReactRequest(BaseModel):
    emoji: str


class PollCreate(BaseModel):
    question: str
    options: list[str]


class PollVoteRequest(BaseModel):
    option_index: int


class NoticePayload(BaseModel):
    title: str
    body: str
    priority: str = "info"  # info | important | urgent
    pinned: bool = True
    target_class: str = ""  # comma-separated or "" for All Classes
    target_classes: Optional[list[str]] = None


ALLOWED_EMOJIS = ["🔥", "💖", "😂", "🤯", "👏"]

LEVEL_TITLES = [
    (0, 1, "Campus Rookie"),
    (100, 2, "Vibe Starter"),
    (250, 3, "Trendsetter"),
    (450, 4, "Class Icon"),
    (750, 5, "Campus Legend"),
    (1200, 6, "Hall of Famer"),
]


def compute_level(xp: int) -> dict:
    level = 1
    title = "Campus Rookie"
    current_floor = 0
    next_cap = 100
    for idx, (threshold, lv, label) in enumerate(LEVEL_TITLES):
        if xp >= threshold:
            level = lv
            title = label
            current_floor = threshold
            next_cap = LEVEL_TITLES[idx + 1][0] if idx + 1 < len(LEVEL_TITLES) else threshold + 500
    span = max(1, next_cap - current_floor)
    progress = min(100, int(((xp - current_floor) / span) * 100))
    return {
        "level": level,
        "title": title,
        "xp": xp,
        "next_xp": next_cap,
        "progress_pct": progress,
    }


def award_xp(conn: Any, user_id: int, amount: int, reason: str) -> int:
    conn.execute("UPDATE users SET xp = xp + ? WHERE id = ?", (amount, user_id))
    conn.execute(
        "INSERT INTO xp_events (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)",
        (user_id, amount, reason, utc_now()),
    )
    row = conn.execute("SELECT xp FROM users WHERE id = ?", (user_id,)).fetchone()
    return row["xp"] if row else 0


def compute_badges(conn: Any, user_id: int) -> list[dict]:
    badges = []
    posts = conn.execute("SELECT post_type FROM posts WHERE user_id = ?", (user_id,)).fetchall()
    types = [p["post_type"] for p in posts]
    stories = conn.execute("SELECT COUNT(*) FROM stories WHERE user_id = ?", (user_id,)).fetchone()[0]
    msgs = conn.execute("SELECT COUNT(*) FROM messages WHERE sender_id = ?", (user_id,)).fetchone()[0]
    votes = conn.execute("SELECT COUNT(*) FROM poll_votes WHERE user_id = ?", (user_id,)).fetchone()[0]
    rx_received = conn.execute(
        "SELECT COUNT(*) FROM reactions r JOIN posts p ON p.id = r.post_id WHERE p.user_id = ?",
        (user_id,),
    ).fetchone()[0]

    if len(posts) >= 1:
        badges.append({"icon": "🌟", "label": "First Drop"})
    if "pic" in types:
        badges.append({"icon": "📸", "label": "Snapper"})
    if "vlog" in types:
        badges.append({"icon": "🎬", "label": "Vlogger"})
    if "blog" in types:
        badges.append({"icon": "✍️", "label": "Wordsmith"})
    if stories >= 1:
        badges.append({"icon": "✨", "label": "Storyteller"})
    if msgs >= 3:
        badges.append({"icon": "💬", "label": "Chatterbox"})
    if votes >= 1:
        badges.append({"icon": "📊", "label": "Campus Voter"})
    if rx_received >= 5:
        badges.append({"icon": "🔥", "label": "Crowd Favorite"})
    return badges


class AdminSettingsUpdate(BaseModel):
    email_mode: str = "resend"  # resend | mailpit | gmail
    resend_api_key: Optional[str] = None
    resend_from: str = "Primus Pix <onboarding@resend.dev>"
    smtp_host: str = "127.0.0.1"
    smtp_port: int = 1025
    admin_email: str = ""
    gmail_user: str = ""
    gmail_app_password: Optional[str] = None
    app_base_url: str = "http://127.0.0.1:8000"


class CommentCreate(BaseModel):
    body: str


class BanRequest(BaseModel):
    is_banned: bool
    ban_message: str = ""


class HideRequest(BaseModel):
    is_hidden: bool


# ---------- Auth Helpers ----------

def require_approved_user(x_session_token: Optional[str] = Header(default=None)):
    if not x_session_token:
        raise HTTPException(status_code=401, detail="Not signed in.")
    conn = get_db()
    try:
        row = conn.execute(
            """
            SELECT s.id AS session_id, s.token, s.status, s.user_id,
                   u.reg_number, u.name, u.class_name, u.is_banned
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?
            """,
            (x_session_token,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="Invalid session.")
        if row["is_banned"]:
            raise HTTPException(status_code=403, detail="Your account has been banned by the admin.")
        if row["status"] != "approved":
            raise HTTPException(
                status_code=403,
                detail=f"Session is {row['status']}. Admin approval required.",
            )
        return dict(row)
    finally:
        conn.close()


def require_admin(x_admin_token: Optional[str] = Header(default=None)):
    if not x_admin_token:
        raise HTTPException(status_code=401, detail="Admin authentication required.")
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT token FROM admin_sessions WHERE token = ?",
            (x_admin_token,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="Invalid or expired admin session.")
        return True
    finally:
        conn.close()


NAME_CHANGE_COOLDOWN_DAYS = 14


def display_name_cooldown_info(changed_at: Optional[str]) -> dict:
    if not changed_at:
        return {"can_change_name": True, "next_name_change_at": None, "days_remaining": 0}
    try:
        last_dt = datetime.fromisoformat(changed_at)
        next_dt = last_dt + timedelta(days=NAME_CHANGE_COOLDOWN_DAYS)
        now_dt = datetime.now(timezone.utc)
        if now_dt >= next_dt:
            return {"can_change_name": True, "next_name_change_at": None, "days_remaining": 0}
        remaining = next_dt - now_dt
        days_rem = max(1, (remaining.days + (1 if remaining.seconds > 0 else 0)))
        return {
            "can_change_name": False,
            "next_name_change_at": next_dt.isoformat(),
            "days_remaining": days_rem,
        }
    except Exception:
        return {"can_change_name": True, "next_name_change_at": None, "days_remaining": 0}


def serialize_post(conn: Any, row: Any, current_user_id: Optional[int] = None) -> dict:
    post_id = row["id"]
    like_count = conn.execute("SELECT COUNT(*) FROM likes WHERE post_id = ?", (post_id,)).fetchone()[0]
    comment_count = conn.execute("SELECT COUNT(*) FROM comments WHERE post_id = ?", (post_id,)).fetchone()[0]
    liked_by_me = False
    if current_user_id is not None:
        liked_by_me = (
            conn.execute(
                "SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?",
                (post_id, current_user_id),
            ).fetchone()
            is not None
        )

    rx_rows = conn.execute(
        "SELECT emoji, COUNT(*) AS cnt FROM reactions WHERE post_id = ? GROUP BY emoji",
        (post_id,),
    ).fetchall()
    rx_counts = {e: 0 for e in ALLOWED_EMOJIS}
    for r in rx_rows:
        if r["emoji"] in rx_counts:
            rx_counts[r["emoji"]] = r["cnt"]

    my_rx = set()
    if current_user_id is not None:
        my_rx = {
            r["emoji"]
            for r in conn.execute(
                "SELECT emoji FROM reactions WHERE post_id = ? AND user_id = ?",
                (post_id, current_user_id),
            ).fetchall()
        }

    author_row = conn.execute(
        "SELECT xp, COALESCE(NULLIF(display_name, ''), name) AS dname, avatar_url FROM users WHERE id = ?",
        (row["user_id"],),
    ).fetchone()
    author_lv = compute_level(author_row["xp"] if author_row else 0)
    author_display = author_row["dname"] if author_row else row["author_name"]
    author_avatar = author_row["avatar_url"] if author_row else None

    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "author_name": author_display,
        "author_avatar": author_avatar,
        "author_reg_number": row["author_reg_number"],
        "author_class": row["author_class"],
        "author_level": author_lv["level"],
        "author_title": author_lv["title"],
        "post_type": row["post_type"],
        "audience": row["audience"] if "audience" in row.keys() else "all",
        "is_hidden": bool(row["is_hidden"]) if "is_hidden" in row.keys() else False,
        "title": row["title"],
        "content": row["content"],
        "media_url": row["media_url"],
        "media_mime": row["media_mime"],
        "created_at": row["created_at"],
        "like_count": like_count,
        "comment_count": comment_count,
        "liked_by_me": liked_by_me,
        "reactions": rx_counts,
        "my_reactions": list(my_rx),
    }


async def save_upload(file: UploadFile, allowed_exts: set, max_bytes: int) -> tuple[str, str]:
    orig_name = file.filename or ""
    ext = Path(orig_name).suffix.lower()
    if ext not in allowed_exts:
        allowed_list = ", ".join(sorted(allowed_exts))
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {allowed_list}",
        )
    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(data) > max_bytes:
        mb = max_bytes // (1024 * 1024)
        raise HTTPException(status_code=400, detail=f"File too large. Max size is {mb} MB.")

    safe_name = f"{secrets.token_hex(12)}{ext}"
    mime = file.content_type or "application/octet-stream"

    if USE_SUPABASE_STORAGE:
        upload_endpoint = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{safe_name}"
        headers = {
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Content-Type": mime,
            "x-upsert": "true",
        }
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(upload_endpoint, content=data, headers=headers)
        if resp.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail=f"Storage upload failed ({resp.status_code}).")
        public_url = f"{SUPABASE_URL}/storage/v1/object/public/{SUPABASE_BUCKET}/{safe_name}"
        return public_url, mime

    dest = UPLOAD_DIR / safe_name
    dest.write_bytes(data)
    return f"/uploads/{safe_name}", mime


# ---------- Static & Uploads ----------

@app.get("/", response_class=HTMLResponse)
def serve_index():
    index_path = STATIC_DIR / "index.html"
    if not index_path.exists():
        return HTMLResponse("<h1>Frontend not found</h1>", status_code=404)
    return HTMLResponse(
        index_path.read_text(encoding="utf-8"),
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@app.get("/sw.js")
def serve_service_worker():
    sw_path = STATIC_DIR / "sw.js"
    if not sw_path.is_file():
        raise HTTPException(status_code=404, detail="Service worker not found")
    return FileResponse(
        sw_path,
        media_type="application/javascript",
        headers={
            "Service-Worker-Allowed": "/",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        },
    )


@app.get("/manifest.json")
def serve_manifest():
    m_path = STATIC_DIR / "manifest.json"
    if not m_path.is_file():
        raise HTTPException(status_code=404, detail="Manifest not found")
    return FileResponse(m_path, media_type="application/manifest+json")


@app.get("/static/{filename:path}")
def serve_static(filename: str):
    target = (STATIC_DIR / filename).resolve()
    if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        target,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@app.get("/uploads/{filename}")
def serve_upload(filename: str):
    if not re.fullmatch(r"[a-f0-9]+\.[a-z0-9]+", filename):
        raise HTTPException(status_code=400, detail="Invalid filename")
    target = (UPLOAD_DIR / filename).resolve()
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Media not found")
    return FileResponse(target)


# ---------- Student Auth & Per-Session Verification ----------

def _get_client_ip(request: Request) -> str:
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if fwd:
        return fwd
    return request.client.host if request.client else "unknown"


@app.post("/api/auth/login")
def student_login(payload: LoginRequest, request: Request, background_tasks: BackgroundTasks):
    reg_number = payload.reg_number.strip().upper()
    name = payload.name.strip()
    class_name = payload.class_name.strip()

    if not reg_number or not name or not class_name:
        raise HTTPException(status_code=400, detail="Registration number, name, and class are all required.")

    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    expires_at = (now_dt + timedelta(minutes=15)).isoformat()
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT * FROM users WHERE reg_number = ?",
            (reg_number,),
        ).fetchone()

        is_verified = False
        if user:
            if user["is_banned"]:
                ban_msg = (user["ban_message"] or "").strip() if "ban_message" in user.keys() else ""
                return {
                    "session_id": None,
                    "token": None,
                    "status": "banned",
                    "ban_message": ban_msg,
                    "user": {
                        "id": user["id"],
                        "reg_number": user["reg_number"],
                        "name": (user["display_name"] or "").strip() or user["name"],
                        "registered_name": user["name"],
                        "class_name": user["class_name"],
                    },
                }
            user_id = user["id"]
            is_verified = bool(user["is_verified"])
            conn.execute(
                "UPDATE users SET name = ?, class_name = ?, updated_at = ? WHERE id = ?",
                (name, class_name, now, user_id),
            )
            display_name = (user["display_name"] or "").strip() or name
            bio = user["bio"] or ""
            avatar_url = user["avatar_url"]
            cd = display_name_cooldown_info(user["display_name_changed_at"])
        else:
            cur = conn.execute(
                """
                INSERT INTO users (reg_number, name, class_name, is_banned, is_verified, created_at, updated_at)
                VALUES (?, ?, ?, 0, 0, ?, ?)
                """,
                (reg_number, name, class_name, now, now),
            )
            user_id = cur.lastrowid
            display_name = name
            bio = ""
            avatar_url = None
            cd = display_name_cooldown_info(None)

        token = secrets.token_urlsafe(32)
        initial_status = "approved" if is_verified else "pending"
        decided_at = now if is_verified else None
        cur = conn.execute(
            """
            INSERT INTO sessions (token, user_id, reg_number, name, class_name, status, created_at, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (token, user_id, reg_number, name, class_name, initial_status, now, decided_at),
        )
        session_id = cur.lastrowid

        if not is_verified:
            allow_token = secrets.token_urlsafe(32)
            deny_token = secrets.token_urlsafe(32)
            conn.execute(
                "INSERT INTO email_action_tokens (token, session_id, action, expires_at, used) VALUES (?, ?, 'approve', ?, 0)",
                (allow_token, session_id, expires_at),
            )
            conn.execute(
                "INSERT INTO email_action_tokens (token, session_id, action, expires_at, used) VALUES (?, ?, 'deny', ?, 0)",
                (deny_token, session_id, expires_at),
            )
            conn.commit()
            background_tasks.add_task(
                send_approval_email,
                session_id,
                reg_number,
                name,
                class_name,
                allow_token,
                deny_token,
                now,
            )
        else:
            conn.commit()
            background_tasks.add_task(
                send_student_login_alert_email,
                reg_number,
                name,
                class_name,
                _get_client_ip(request),
                now,
            )

        return {
            "session_id": session_id,
            "token": token,
            "status": initial_status,
            "user": {
                "id": user_id,
                "reg_number": reg_number,
                "name": display_name,
                "registered_name": name,
                "class_name": class_name,
                "bio": bio,
                "avatar_url": avatar_url,
                **cd,
            },
        }
    finally:
        conn.close()


@app.get("/api/email-action/{action_token}", response_class=HTMLResponse)
def handle_email_action(action_token: str):
    conn = get_db()
    try:
        row = conn.execute(
            """
            SELECT t.token, t.session_id, t.action, t.expires_at, t.used,
                   s.status AS session_status, s.user_id, s.name, s.reg_number, s.class_name, u.is_banned
            FROM email_action_tokens t
            JOIN sessions s ON s.id = t.session_id
            JOIN users u ON u.id = s.user_id
            WHERE t.token = ?
            """,
            (action_token,),
        ).fetchone()

        def render_page(title: str, message: str, color: str) -> HTMLResponse:
            return HTMLResponse(
                f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} — Primus Pix</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0f19;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;">
  <div style="max-width:440px;width:100%;background:#161d31;border:1px solid #2b3552;border-top:4px solid {color};border-radius:16px;padding:28px;text-align:center;">
    <h2 style="margin:0 0 10px;color:#fff;">{title}</h2>
    <p style="margin:0 0 20px;color:#cbd5e1;line-height:1.5;">{message}</p>
    <a href="/" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:10px;">Open Primus Pix</a>
  </div>
</body></html>"""
            )

        if not row:
            return render_page("Invalid Link", "This verification link is invalid or does not exist.", "#ef4444")
        if row["used"]:
            return render_page("Link Already Used", f"A decision has already been recorded for {row['name']} ({row['reg_number']}). Current status: {row['session_status']}.", "#f59e0b")
        if datetime.now(timezone.utc) > datetime.fromisoformat(row["expires_at"]):
            return render_page("Link Expired", "This approval link expired after 15 minutes. Ask the student to sign in again or use the Admin Panel.", "#f59e0b")
        if row["session_status"] != "pending":
            return render_page("Already Decided", f"This sign-in request is already '{row['session_status']}'.", "#f59e0b")
        if row["action"] == "approve" and row["is_banned"]:
            return render_page("Student Banned", f"{row['name']} ({row['reg_number']}) is currently banned. Unban them in the Admin Panel first.", "#ef4444")

        new_status = "approved" if row["action"] == "approve" else "denied"
        conn.execute(
            "UPDATE sessions SET status = ?, decided_at = ? WHERE id = ?",
            (new_status, utc_now(), row["session_id"]),
        )
        if new_status == "approved":
            conn.execute("UPDATE users SET is_verified = 1 WHERE id = ?", (row["user_id"],))
        # Invalidate both allow and deny tokens for this session
        conn.execute(
            "UPDATE email_action_tokens SET used = 1 WHERE session_id = ?",
            (row["session_id"],),
        )
        conn.commit()

        if new_status == "approved":
            return render_page(
                "Sign-In Allowed",
                f"<strong>{row['name']}</strong> ({row['reg_number']} &bull; {row['class_name']}) has been allowed into Primus Pix. Their browser will unlock automatically.",
                "#10b981",
            )
        return render_page(
            "Sign-In Denied",
            f"<strong>{row['name']}</strong> ({row['reg_number']} &bull; {row['class_name']}) has been denied access.",
            "#ef4444",
        )
    finally:
        conn.close()


@app.get("/api/auth/session")
def check_session(x_session_token: Optional[str] = Header(default=None)):
    if not x_session_token:
        raise HTTPException(status_code=401, detail="Missing session token.")
    conn = get_db()
    try:
        row = conn.execute(
            """
            SELECT s.id AS session_id, s.status, s.created_at, s.decided_at,
                   u.id AS user_id, u.reg_number, u.name, u.class_name, u.is_banned,
                   COALESCE(u.ban_message, '') AS ban_message,
                   COALESCE(NULLIF(u.display_name, ''), u.name) AS display_name,
                   u.display_name_changed_at, u.bio, u.avatar_url
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?
            """,
            (x_session_token,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="Session not found.")
        status = "banned" if row["is_banned"] else row["status"]
        cd = display_name_cooldown_info(row["display_name_changed_at"])
        return {
            "session_id": row["session_id"],
            "status": status,
            "ban_message": (row["ban_message"] or "").strip(),
            "created_at": row["created_at"],
            "decided_at": row["decided_at"],
            "user": {
                "id": row["user_id"],
                "reg_number": row["reg_number"],
                "name": row["display_name"],
                "registered_name": row["name"],
                "class_name": row["class_name"],
                "bio": row["bio"] or "",
                "avatar_url": row["avatar_url"],
                **cd,
            },
        }
    finally:
        conn.close()


@app.post("/api/auth/logout")
def student_logout(x_session_token: Optional[str] = Header(default=None)):
    if not x_session_token:
        return {"ok": True}
    conn = get_db()
    try:
        conn.execute(
            "UPDATE sessions SET status = 'logged_out', decided_at = ? WHERE token = ? AND status IN ('pending', 'approved')",
            (utc_now(), x_session_token),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ---------- Posts, Feed, Likes, Comments, Profiles ----------

@app.get("/api/meta/classes")
def list_classes(user=Depends(require_approved_user)):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT DISTINCT class_name FROM users ORDER BY class_name COLLATE NOCASE"
        ).fetchall()
        return {"classes": [r["class_name"] for r in rows]}
    finally:
        conn.close()


@app.get("/api/posts")
def list_posts(
    post_type: Optional[str] = None,
    class_name: Optional[str] = None,
    user_id: Optional[int] = None,
    audience: Optional[str] = None,
    q: Optional[str] = None,
    user=Depends(require_approved_user),
):
    me = user["user_id"]
    conn = get_db()
    try:
        query = """
            SELECT p.*, u.name AS author_name, u.reg_number AS author_reg_number, u.class_name AS author_class
            FROM posts p
            JOIN users u ON u.id = p.user_id
            WHERE COALESCE(p.is_hidden, 0) = 0
              AND (
                COALESCE(p.audience, 'all') = 'all'
                OR p.user_id = ?
                OR EXISTS (
                    SELECT 1 FROM close_friends cf
                    WHERE cf.user_id = p.user_id AND cf.friend_id = ?
                )
            )
        """
        params = [me, me]
        if audience in ("all", "close_friends"):
            query += " AND COALESCE(p.audience, 'all') = ?"
            params.append(audience)
        if post_type in ("pic", "vlog", "blog"):
            query += " AND p.post_type = ?"
            params.append(post_type)
        if class_name:
            query += " AND u.class_name = ?"
            params.append(class_name)
        if user_id is not None:
            query += " AND p.user_id = ?"
            params.append(user_id)
        if q and q.strip():
            like_q = f"%{q.strip()}%"
            query += " AND (p.title LIKE ? OR p.content LIKE ? OR u.name LIKE ? OR u.reg_number LIKE ?)"
            params.extend([like_q, like_q, like_q, like_q])

        query += " ORDER BY p.created_at DESC LIMIT 100"
        rows = conn.execute(query, params).fetchall()
        return {"posts": [serialize_post(conn, r, me) for r in rows]}
    finally:
        conn.close()


@app.post("/api/posts")
async def create_post(
    post_type: str = Form(...),
    title: str = Form(default=""),
    content: str = Form(default=""),
    audience: str = Form(default="all"),
    media: Optional[UploadFile] = File(default=None),
    user=Depends(require_approved_user),
):
    post_type = post_type.strip().lower()
    title = title.strip()
    content = content.strip()
    audience = "close_friends" if audience.strip().lower() == "close_friends" else "all"

    if post_type not in ("vlog", "blog"):
        raise HTTPException(status_code=400, detail="Photo post uploads are disabled. Please upload a Video or write a Blog.")

    media_url = None
    media_mime = None

    if post_type == "vlog":
        if not media or not media.filename:
            raise HTTPException(status_code=400, detail="Please attach a video file to upload a video.")
        media_url, media_mime = await save_upload(media, ALLOWED_VIDEO_EXTS, MAX_VIDEO_BYTES)
        if not title:
            title = "Untitled Video"
    elif post_type == "blog":
        if not title or not content:
            raise HTTPException(status_code=400, detail="Blog posts require both a title and content.")

    conn = get_db()
    try:
        now = utc_now()
        cur = conn.execute(
            """
            INSERT INTO posts (user_id, post_type, audience, title, content, media_url, media_mime, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (user["user_id"], post_type, audience, title, content, media_url, media_mime, now),
        )
        post_id = cur.lastrowid
        award_xp(conn, user["user_id"], 50, f"Published a {post_type}")
        conn.commit()
        row = conn.execute(
            """
            SELECT p.*, u.name AS author_name, u.reg_number AS author_reg_number, u.class_name AS author_class
            FROM posts p
            JOIN users u ON u.id = p.user_id
            WHERE p.id = ?
            """,
            (post_id,),
        ).fetchone()
        return {"post": serialize_post(conn, row, user["user_id"]), "xp_earned": 50}
    finally:
        conn.close()


@app.delete("/api/posts/{post_id}")
def delete_own_post(post_id: int, user=Depends(require_approved_user)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id, user_id, media_url FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Post not found.")
        if row["user_id"] != user["user_id"]:
            raise HTTPException(status_code=403, detail="You can only delete your own posts.")
        conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
        conn.commit()
        _cleanup_media_file(row["media_url"])
        return {"ok": True}
    finally:
        conn.close()


@app.post("/api/posts/{post_id}/like")
def toggle_like(post_id: int, user=Depends(require_approved_user)):
    conn = get_db()
    try:
        exists = conn.execute("SELECT 1 FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Post not found.")
        existing_like = conn.execute(
            "SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?",
            (post_id, user["user_id"]),
        ).fetchone()
        if existing_like:
            conn.execute(
                "DELETE FROM likes WHERE post_id = ? AND user_id = ?",
                (post_id, user["user_id"]),
            )
            liked = False
        else:
            conn.execute(
                "INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)",
                (post_id, user["user_id"], utc_now()),
            )
            liked = True
        conn.commit()
        like_count = conn.execute("SELECT COUNT(*) FROM likes WHERE post_id = ?", (post_id,)).fetchone()[0]
        return {"liked": liked, "like_count": like_count}
    finally:
        conn.close()


@app.get("/api/posts/{post_id}/comments")
def list_comments(post_id: int, user=Depends(require_approved_user)):
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT c.id, c.post_id, c.user_id, c.body, c.created_at,
                   COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.reg_number AS author_reg_number, u.class_name AS author_class, u.avatar_url AS author_avatar
            FROM comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.post_id = ?
            ORDER BY c.created_at ASC
            """,
            (post_id,),
        ).fetchall()
        return {"comments": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.post("/api/posts/{post_id}/comments")
def add_comment(post_id: int, payload: CommentCreate, user=Depends(require_approved_user)):
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Comment cannot be empty.")
    conn = get_db()
    try:
        exists = conn.execute("SELECT 1 FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Post not found.")
        now = utc_now()
        cur = conn.execute(
            "INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
            (post_id, user["user_id"], body, now),
        )
        comment_id = cur.lastrowid
        award_xp(conn, user["user_id"], 15, "Posted a comment")
        conn.commit()
        row = conn.execute(
            """
            SELECT c.id, c.post_id, c.user_id, c.body, c.created_at,
                   COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.reg_number AS author_reg_number, u.class_name AS author_class, u.avatar_url AS author_avatar
            FROM comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.id = ?
            """,
            (comment_id,),
        ).fetchone()
        return {"comment": dict(row), "xp_earned": 15}
    finally:
        conn.close()


@app.delete("/api/comments/{comment_id}")
def delete_own_comment(comment_id: int, user=Depends(require_approved_user)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id, user_id FROM comments WHERE id = ?", (comment_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Comment not found.")
        if row["user_id"] != user["user_id"]:
            raise HTTPException(status_code=403, detail="You can only delete your own comments.")
        conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/users/{user_id}")
def get_user_profile(user_id: int, user=Depends(require_approved_user)):
    conn = get_db()
    try:
        profile = conn.execute(
            """
            SELECT id, reg_number,
                   COALESCE(NULLIF(display_name, ''), name) AS name,
                   name AS registered_name,
                   class_name, bio, avatar_url, display_name_changed_at, created_at
            FROM users WHERE id = ?
            """,
            (user_id,),
        ).fetchone()
        if not profile:
            raise HTTPException(status_code=404, detail="Student not found.")

        counts = conn.execute(
            """
            SELECT
                SUM(CASE WHEN post_type = 'pic' THEN 1 ELSE 0 END) AS pics,
                SUM(CASE WHEN post_type = 'vlog' THEN 1 ELSE 0 END) AS vlogs,
                SUM(CASE WHEN post_type = 'blog' THEN 1 ELSE 0 END) AS blogs
            FROM posts WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()

        total_likes = conn.execute(
            """
            SELECT COUNT(*) FROM likes l
            JOIN posts p ON p.id = l.post_id
            WHERE p.user_id = ?
            """,
            (user_id,),
        ).fetchone()[0]

        me = user["user_id"]
        posts_rows = conn.execute(
            """
            SELECT p.*, u.name AS author_name, u.reg_number AS author_reg_number, u.class_name AS author_class
            FROM posts p
            JOIN users u ON u.id = p.user_id
            WHERE p.user_id = ?
              AND COALESCE(p.is_hidden, 0) = 0
              AND (
                COALESCE(p.audience, 'all') = 'all'
                OR p.user_id = ?
                OR EXISTS (
                  SELECT 1 FROM close_friends cf
                  WHERE cf.user_id = p.user_id AND cf.friend_id = ?
                )
              )
            ORDER BY p.created_at DESC
            """,
            (user_id, me, me),
        ).fetchall()

        cd = display_name_cooldown_info(profile["display_name_changed_at"])
        prof_dict = dict(profile)
        prof_dict["bio"] = prof_dict.get("bio") or ""
        return {
            "profile": {
                **prof_dict,
                **cd,
                "stats": {
                    "pics": counts["pics"] or 0,
                    "vlogs": counts["vlogs"] or 0,
                    "blogs": counts["blogs"] or 0,
                    "total_likes": total_likes,
                },
            },
            "posts": [serialize_post(conn, r, user["user_id"]) for r in posts_rows],
        }
    finally:
        conn.close()


@app.post("/api/profile/me")
async def update_my_profile(
    display_name: Optional[str] = Form(default=None),
    bio: Optional[str] = Form(default=None),
    avatar: Optional[UploadFile] = File(default=None),
    user=Depends(require_approved_user),
):
    uid = user["user_id"]
    conn = get_db()
    try:
        current = conn.execute(
            """
            SELECT id, reg_number, name, class_name,
                   COALESCE(NULLIF(display_name, ''), name) AS current_display_name,
                   display_name_changed_at, bio, avatar_url
            FROM users WHERE id = ?
            """,
            (uid,),
        ).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="User not found.")

        now = utc_now()
        new_display_name = current["current_display_name"]
        new_changed_at = current["display_name_changed_at"]

        if display_name is not None:
            cleaned_name = display_name.strip()
            if not cleaned_name:
                raise HTTPException(status_code=400, detail="Display name cannot be empty.")
            if len(cleaned_name) > 40:
                raise HTTPException(status_code=400, detail="Display name must be 40 characters or fewer.")
            if cleaned_name != current["current_display_name"]:
                cd = display_name_cooldown_info(current["display_name_changed_at"])
                if not cd["can_change_name"]:
                    days = cd["days_remaining"]
                    raise HTTPException(
                        status_code=400,
                        detail=f"You can only change your display name once every 14 days. Try again in {days} day{'s' if days != 1 else ''}.",
                    )
                new_display_name = cleaned_name
                new_changed_at = now

        new_bio = current["bio"] or ""
        if bio is not None:
            new_bio = bio.strip()[:200]

        new_avatar_url = current["avatar_url"]
        old_avatar_to_delete = None
        if avatar and avatar.filename:
            uploaded_url, _ = await save_upload(avatar, ALLOWED_IMAGE_EXTS, MAX_IMAGE_BYTES)
            old_avatar_to_delete = current["avatar_url"]
            new_avatar_url = uploaded_url

        conn.execute(
            """
            UPDATE users
            SET display_name = ?, display_name_changed_at = ?, bio = ?, avatar_url = ?, updated_at = ?
            WHERE id = ?
            """,
            (new_display_name, new_changed_at, new_bio, new_avatar_url, now, uid),
        )
        conn.commit()
        if old_avatar_to_delete:
            _cleanup_media_file(old_avatar_to_delete)

        cd = display_name_cooldown_info(new_changed_at)
        return {
            "user": {
                "id": uid,
                "reg_number": current["reg_number"],
                "name": new_display_name,
                "registered_name": current["name"],
                "class_name": current["class_name"],
                "bio": new_bio,
                "avatar_url": new_avatar_url,
                **cd,
            }
        }
    finally:
        conn.close()


# ---------- Stories (24-Hour Disappearing Stories + Close Friends) ----------

@app.get("/api/stories")
def list_stories(user=Depends(require_approved_user)):
    now = utc_now()
    me = user["user_id"]
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT st.*, COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.reg_number AS author_reg_number, u.class_name AS author_class, u.avatar_url AS author_avatar
            FROM stories st
            JOIN users u ON u.id = st.user_id
            WHERE st.expires_at > ?
              AND COALESCE(st.is_hidden, 0) = 0
              AND (
                st.audience = 'all'
                OR st.user_id = ?
                OR EXISTS (
                  SELECT 1 FROM close_friends cf
                  WHERE cf.user_id = st.user_id AND cf.friend_id = ?
                )
              )
            ORDER BY st.created_at DESC
            """,
            (now, me, me),
        ).fetchall()
        return {"stories": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.post("/api/stories")
async def create_story(
    story_type: str = Form(...),
    caption: str = Form(default=""),
    bg_color: str = Form(default="#ffd6e8"),
    audience: str = Form(default="all"),
    media: Optional[UploadFile] = File(default=None),
    user=Depends(require_approved_user),
):
    story_type = story_type.strip().lower()
    caption = caption.strip()
    audience = "close_friends" if audience.strip().lower() == "close_friends" else "all"
    if story_type not in ("image", "video", "text"):
        raise HTTPException(status_code=400, detail="Invalid story type.")

    media_url = None
    if story_type == "image":
        if not media or not media.filename:
            raise HTTPException(status_code=400, detail="Please pick or capture a photo for your story.")
        media_url, _ = await save_upload(media, ALLOWED_IMAGE_EXTS, MAX_IMAGE_BYTES)
    elif story_type == "video":
        if not media or not media.filename:
            raise HTTPException(status_code=400, detail="Please pick a video for your story.")
        media_url, _ = await save_upload(media, ALLOWED_VIDEO_EXTS, MAX_VIDEO_BYTES)
    elif story_type == "text":
        if not caption:
            raise HTTPException(status_code=400, detail="Please write something for your text story.")

    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    expires_at = (now_dt + timedelta(hours=24)).isoformat()

    conn = get_db()
    try:
        cur = conn.execute(
            """
            INSERT INTO stories (user_id, story_type, caption, bg_color, audience, media_url, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (user["user_id"], story_type, caption, bg_color.strip() or "#ffd6e8", audience, media_url, now, expires_at),
        )
        story_id = cur.lastrowid
        award_xp(conn, user["user_id"], 30, "Posted a 24h story")
        conn.commit()
        row = conn.execute(
            """
            SELECT st.*, COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.reg_number AS author_reg_number, u.class_name AS author_class, u.avatar_url AS author_avatar
            FROM stories st
            JOIN users u ON u.id = st.user_id
            WHERE st.id = ?
            """,
            (story_id,),
        ).fetchone()
        return {"story": dict(row), "xp_earned": 30}
    finally:
        conn.close()


# ---------- Close Friends Management ----------

@app.get("/api/close-friends")
def list_close_friends(user=Depends(require_approved_user)):
    me = user["user_id"]
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.name) AS name,
                   u.reg_number, u.class_name, u.avatar_url,
                   CASE WHEN cf.friend_id IS NOT NULL THEN 1 ELSE 0 END AS is_close_friend
            FROM users u
            LEFT JOIN close_friends cf ON cf.user_id = ? AND cf.friend_id = u.id
            WHERE u.id != ? AND u.is_banned = 0
            ORDER BY is_close_friend DESC, name COLLATE NOCASE
            """,
            (me, me),
        ).fetchall()
        return {"friends": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.post("/api/close-friends/{friend_id}")
def toggle_close_friend(friend_id: int, user=Depends(require_approved_user)):
    me = user["user_id"]
    if friend_id == me:
        raise HTTPException(status_code=400, detail="You cannot add yourself.")
    conn = get_db()
    try:
        exists = conn.execute("SELECT 1 FROM users WHERE id = ?", (friend_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Student not found.")
        cur = conn.execute(
            "SELECT 1 FROM close_friends WHERE user_id = ? AND friend_id = ?",
            (me, friend_id),
        ).fetchone()
        if cur:
            conn.execute("DELETE FROM close_friends WHERE user_id = ? AND friend_id = ?", (me, friend_id))
            added = False
        else:
            conn.execute(
                "INSERT INTO close_friends (user_id, friend_id, created_at) VALUES (?, ?, ?)",
                (me, friend_id, utc_now()),
            )
            added = True
        conn.commit()
        return {"ok": True, "is_close_friend": added}
    finally:
        conn.close()


# ---------- Flashes (Instant Camera Snaps & Quick Status Bubbles) ----------

@app.get("/api/flashes")
def list_flashes(user=Depends(require_approved_user)):
    now = utc_now()
    me = user["user_id"]
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT f.*, COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.class_name AS author_class, u.avatar_url AS author_avatar
            FROM flashes f
            JOIN users u ON u.id = f.user_id
            WHERE f.expires_at > ?
              AND COALESCE(f.is_hidden, 0) = 0
              AND (
                f.audience = 'all'
                OR f.user_id = ?
                OR EXISTS (
                  SELECT 1 FROM close_friends cf
                  WHERE cf.user_id = f.user_id AND cf.friend_id = ?
                )
              )
            ORDER BY f.created_at DESC
            LIMIT 30
            """,
            (now, me, me),
        ).fetchall()
        return {"flashes": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.post("/api/flashes")
async def create_flash(
    text: str = Form(default=""),
    audience: str = Form(default="all"),
    media: Optional[UploadFile] = File(default=None),
    user=Depends(require_approved_user),
):
    text = text.strip()[:80]
    audience = "close_friends" if audience.strip().lower() == "close_friends" else "all"
    media_url = None
    if media and media.filename:
        media_url, _ = await save_upload(media, ALLOWED_IMAGE_EXTS, MAX_IMAGE_BYTES)
    if not text and not media_url:
        raise HTTPException(status_code=400, detail="Add a quick note or snap a photo for your Flash.")

    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    expires_at = (now_dt + timedelta(hours=24)).isoformat()

    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO flashes (user_id, text, media_url, audience, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            (user["user_id"], text, media_url, audience, now, expires_at),
        )
        fid = cur.lastrowid
        conn.commit()
        row = conn.execute(
            """
            SELECT f.*, COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.class_name AS author_class, u.avatar_url AS author_avatar
            FROM flashes f
            JOIN users u ON u.id = f.user_id
            WHERE f.id = ?
            """,
            (fid,),
        ).fetchone()
        return {"flash": dict(row)}
    finally:
        conn.close()


@app.delete("/api/flashes/{flash_id}")
def delete_flash(flash_id: int, user=Depends(require_approved_user)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id, user_id, media_url FROM flashes WHERE id = ?", (flash_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Flash not found.")
        if row["user_id"] != user["user_id"]:
            raise HTTPException(status_code=403, detail="You can only delete your own Flash.")
        conn.execute("DELETE FROM flashes WHERE id = ?", (flash_id,))
        conn.commit()
        _cleanup_media_file(row["media_url"])
        return {"ok": True}
    finally:
        conn.close()


@app.delete("/api/stories/{story_id}")
def delete_story(story_id: int, user=Depends(require_approved_user)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id, user_id, media_url FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Story not found.")
        if row["user_id"] != user["user_id"]:
            raise HTTPException(status_code=403, detail="You can only delete your own story.")
        conn.execute("DELETE FROM stories WHERE id = ?", (story_id,))
        conn.commit()
        # Only delete media file if no reposted story still references it
        if row["media_url"]:
            still_used = conn.execute(
                "SELECT 1 FROM stories WHERE media_url = ? LIMIT 1", (row["media_url"],)
            ).fetchone()
            if not still_used:
                _cleanup_media_file(row["media_url"])
        return {"ok": True}
    finally:
        conn.close()


@app.post("/api/stories/{story_id}/view")
def view_story(story_id: int, user=Depends(require_approved_user)):
    me = user["user_id"]
    conn = get_db()
    try:
        st = conn.execute("SELECT id, user_id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not st:
            raise HTTPException(status_code=404, detail="Story not found.")

        # Record view if viewer is not the owner
        if st["user_id"] != me:
            conn.execute(
                "INSERT OR REPLACE INTO story_views (story_id, user_id, viewed_at) VALUES (?, ?, ?)",
                (story_id, me, utc_now()),
            )
            conn.commit()

        like_count = conn.execute("SELECT COUNT(*) FROM story_likes WHERE story_id = ?", (story_id,)).fetchone()[0]
        liked_by_me = (
            conn.execute(
                "SELECT 1 FROM story_likes WHERE story_id = ? AND user_id = ?",
                (story_id, me),
            ).fetchone()
            is not None
        )

        comments_rows = conn.execute(
            """
            SELECT c.id, c.story_id, c.user_id, c.body, c.created_at,
                   COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.class_name AS author_class, u.avatar_url AS author_avatar
            FROM story_comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.story_id = ?
            ORDER BY c.created_at ASC
            """,
            (story_id,),
        ).fetchall()

        # Viewers list is ONLY returned to the story owner
        viewers = None
        if st["user_id"] == me:
            v_rows = conn.execute(
                """
                SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.name) AS name,
                       u.class_name, u.avatar_url, sv.viewed_at
                FROM story_views sv
                JOIN users u ON u.id = sv.user_id
                WHERE sv.story_id = ?
                ORDER BY sv.viewed_at DESC
                """,
                (story_id,),
            ).fetchall()
            viewers = [dict(v) for v in v_rows]

        return {
            "like_count": like_count,
            "liked_by_me": liked_by_me,
            "comments": [dict(c) for c in comments_rows],
            "viewers": viewers,
        }
    finally:
        conn.close()


@app.post("/api/stories/{story_id}/like")
def toggle_story_like(story_id: int, user=Depends(require_approved_user)):
    me = user["user_id"]
    conn = get_db()
    try:
        exists = conn.execute("SELECT 1 FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Story not found.")
        cur = conn.execute(
            "SELECT 1 FROM story_likes WHERE story_id = ? AND user_id = ?",
            (story_id, me),
        ).fetchone()
        if cur:
            conn.execute("DELETE FROM story_likes WHERE story_id = ? AND user_id = ?", (story_id, me))
            liked = False
        else:
            conn.execute(
                "INSERT INTO story_likes (story_id, user_id, created_at) VALUES (?, ?, ?)",
                (story_id, me, utc_now()),
            )
            liked = True
        conn.commit()
        count = conn.execute("SELECT COUNT(*) FROM story_likes WHERE story_id = ?", (story_id,)).fetchone()[0]
        return {"liked": liked, "like_count": count}
    finally:
        conn.close()


@app.post("/api/stories/{story_id}/comments")
def add_story_comment(story_id: int, payload: CommentCreate, user=Depends(require_approved_user)):
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Comment cannot be empty.")
    conn = get_db()
    try:
        exists = conn.execute("SELECT 1 FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Story not found.")
        now = utc_now()
        cur = conn.execute(
            "INSERT INTO story_comments (story_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
            (story_id, user["user_id"], body, now),
        )
        cid = cur.lastrowid
        conn.commit()
        row = conn.execute(
            """
            SELECT c.id, c.story_id, c.user_id, c.body, c.created_at,
                   COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.class_name AS author_class, u.avatar_url AS author_avatar
            FROM story_comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.id = ?
            """,
            (cid,),
        ).fetchone()
        return {"comment": dict(row)}
    finally:
        conn.close()


@app.post("/api/stories/{story_id}/repost")
def repost_story(story_id: int, user=Depends(require_approved_user)):
    me = user["user_id"]
    conn = get_db()
    try:
        orig = conn.execute(
            """
            SELECT st.*, COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name
            FROM stories st
            JOIN users u ON u.id = st.user_id
            WHERE st.id = ?
            """,
            (story_id,),
        ).fetchone()
        if not orig:
            raise HTTPException(status_code=404, detail="Story not found.")

        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat()
        expires_at = (now_dt + timedelta(hours=24)).isoformat()
        reposted_from = orig["reposted_from"] or orig["author_name"]

        cur = conn.execute(
            """
            INSERT INTO stories (user_id, story_type, caption, bg_color, audience, media_url, reposted_from, created_at, expires_at)
            VALUES (?, ?, ?, ?, 'all', ?, ?, ?, ?)
            """,
            (me, orig["story_type"], orig["caption"], orig["bg_color"], orig["media_url"], reposted_from, now, expires_at),
        )
        new_id = cur.lastrowid
        conn.commit()
        row = conn.execute(
            """
            SELECT st.*, COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.reg_number AS author_reg_number, u.class_name AS author_class, u.avatar_url AS author_avatar
            FROM stories st
            JOIN users u ON u.id = st.user_id
            WHERE st.id = ?
            """,
            (new_id,),
        ).fetchone()
        return {"story": dict(row)}
    finally:
        conn.close()


# (Direct messaging / texting removed per user request)


# ---------- Gamification: Multi-Emoji Reactions, Live Polls, Quests & Leaderboard ----------

@app.post("/api/posts/{post_id}/react")
def toggle_reaction(post_id: int, payload: ReactRequest, user=Depends(require_approved_user)):
    emoji = payload.emoji.strip()
    if emoji not in ALLOWED_EMOJIS:
        raise HTTPException(status_code=400, detail="Unsupported reaction emoji.")
    conn = get_db()
    try:
        post = conn.execute("SELECT id, user_id FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not post:
            raise HTTPException(status_code=404, detail="Post not found.")
        existing = conn.execute(
            "SELECT 1 FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?",
            (post_id, user["user_id"], emoji),
        ).fetchone()
        xp_earned = 0
        if existing:
            conn.execute(
                "DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?",
                (post_id, user["user_id"], emoji),
            )
            reacted = False
        else:
            conn.execute(
                "INSERT INTO reactions (post_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
                (post_id, user["user_id"], emoji, utc_now()),
            )
            award_xp(conn, user["user_id"], 5, f"Reacted {emoji}")
            if post["user_id"] != user["user_id"]:
                award_xp(conn, post["user_id"], 10, f"Received {emoji} reaction")
            xp_earned = 5
            reacted = True
        conn.commit()

        rx_rows = conn.execute(
            "SELECT emoji, COUNT(*) AS cnt FROM reactions WHERE post_id = ? GROUP BY emoji",
            (post_id,),
        ).fetchall()
        rx_counts = {e: 0 for e in ALLOWED_EMOJIS}
        for r in rx_rows:
            if r["emoji"] in rx_counts:
                rx_counts[r["emoji"]] = r["cnt"]
        my_rx = [
            r["emoji"]
            for r in conn.execute(
                "SELECT emoji FROM reactions WHERE post_id = ? AND user_id = ?",
                (post_id, user["user_id"]),
            ).fetchall()
        ]
        return {"reacted": reacted, "reactions": rx_counts, "my_reactions": my_rx, "xp_earned": xp_earned}
    finally:
        conn.close()


@app.get("/api/polls")
def list_polls(user=Depends(require_approved_user)):
    import json as _json
    conn = get_db()
    try:
        rows = conn.execute(
            """
            SELECT p.*, u.name AS author_name, u.class_name AS author_class
            FROM polls p
            LEFT JOIN users u ON u.id = p.user_id
            ORDER BY p.created_at DESC LIMIT 6
            """
        ).fetchall()
        result = []
        for r in rows:
            options = _json.loads(r["options_json"])
            votes_rows = conn.execute(
                "SELECT option_index, COUNT(*) AS cnt FROM poll_votes WHERE poll_id = ? GROUP BY option_index",
                (r["id"],),
            ).fetchall()
            counts = [0] * len(options)
            for vr in votes_rows:
                if 0 <= vr["option_index"] < len(options):
                    counts[vr["option_index"]] = vr["cnt"]
            my_vote_row = conn.execute(
                "SELECT option_index FROM poll_votes WHERE poll_id = ? AND user_id = ?",
                (r["id"], user["user_id"]),
            ).fetchone()
            result.append({
                "id": r["id"],
                "question": r["question"],
                "options": options,
                "counts": counts,
                "total_votes": sum(counts),
                "my_vote": my_vote_row["option_index"] if my_vote_row else None,
                "author_name": r["author_name"] or "Primus Pix Campus",
                "created_at": r["created_at"],
            })
        return {"polls": result}
    finally:
        conn.close()


@app.post("/api/polls")
def create_poll(payload: PollCreate, user=Depends(require_approved_user)):
    import json as _json
    q = payload.question.strip()
    opts = [o.strip() for o in payload.options if o.strip()]
    if not q or len(opts) < 2 or len(opts) > 4:
        raise HTTPException(status_code=400, detail="Polls need a question and 2 to 4 options.")
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO polls (user_id, question, options_json, created_at) VALUES (?, ?, ?, ?)",
            (user["user_id"], q, _json.dumps(opts), utc_now()),
        )
        award_xp(conn, user["user_id"], 35, "Created a campus poll")
        conn.commit()
        return {"ok": True, "xp_earned": 35}
    finally:
        conn.close()


@app.post("/api/polls/{poll_id}/vote")
def vote_poll(poll_id: int, payload: PollVoteRequest, user=Depends(require_approved_user)):
    import json as _json
    conn = get_db()
    try:
        poll = conn.execute("SELECT id, options_json FROM polls WHERE id = ?", (poll_id,)).fetchone()
        if not poll:
            raise HTTPException(status_code=404, detail="Poll not found.")
        options = _json.loads(poll["options_json"])
        if not (0 <= payload.option_index < len(options)):
            raise HTTPException(status_code=400, detail="Invalid option.")
        existing = conn.execute(
            "SELECT option_index FROM poll_votes WHERE poll_id = ? AND user_id = ?",
            (poll_id, user["user_id"]),
        ).fetchone()
        xp_earned = 0
        if existing:
            conn.execute(
                "UPDATE poll_votes SET option_index = ?, created_at = ? WHERE poll_id = ? AND user_id = ?",
                (payload.option_index, utc_now(), poll_id, user["user_id"]),
            )
        else:
            conn.execute(
                "INSERT INTO poll_votes (poll_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)",
                (poll_id, user["user_id"], payload.option_index, utc_now()),
            )
            award_xp(conn, user["user_id"], 15, "Voted in a campus poll")
            xp_earned = 15
        conn.commit()
        return {"ok": True, "xp_earned": xp_earned}
    finally:
        conn.close()


@app.get("/api/gamification/me")
def gamification_me(user=Depends(require_approved_user)):
    uid = user["user_id"]
    today_prefix = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    conn = get_db()
    try:
        u = conn.execute("SELECT xp FROM users WHERE id = ?", (uid,)).fetchone()
        xp = u["xp"] if u else 0
        level_info = compute_level(xp)
        badges = compute_badges(conn, uid)

        # Daily quest progress
        did_post = conn.execute(
            "SELECT COUNT(*) FROM posts WHERE user_id = ? AND created_at LIKE ?",
            (uid, f"{today_prefix}%"),
        ).fetchone()[0] > 0
        did_story = conn.execute(
            "SELECT COUNT(*) FROM stories WHERE user_id = ? AND created_at LIKE ?",
            (uid, f"{today_prefix}%"),
        ).fetchone()[0] > 0
        did_msg = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE sender_id = ? AND created_at LIKE ?",
            (uid, f"{today_prefix}%"),
        ).fetchone()[0] > 0
        rx_today = conn.execute(
            "SELECT COUNT(*) FROM reactions WHERE user_id = ? AND created_at LIKE ?",
            (uid, f"{today_prefix}%"),
        ).fetchone()[0]
        did_vote = conn.execute(
            "SELECT COUNT(*) FROM poll_votes WHERE user_id = ? AND created_at LIKE ?",
            (uid, f"{today_prefix}%"),
        ).fetchone()[0] > 0

        quests = [
            {"id": "post", "label": "Drop a Pic, Vlog, or Blog", "xp": 50, "done": did_post},
            {"id": "story", "label": "Share a 24h Story", "xp": 30, "done": did_story},
            {"id": "poll", "label": "Vote in a Campus Poll", "xp": 15, "done": did_vote},
            {"id": "chat", "label": "Send a Text in Messages", "xp": 10, "done": did_msg},
            {"id": "react", "label": f"React to 3 Posts ({min(3, rx_today)}/3)", "xp": 15, "done": rx_today >= 3},
        ]

        return {
            **level_info,
            "badges": badges,
            "quests": quests,
        }
    finally:
        conn.close()


@app.get("/api/gamification/leaderboard")
def gamification_leaderboard(user=Depends(require_approved_user)):
    conn = get_db()
    try:
        top_students = conn.execute(
            """
            SELECT id, name, reg_number, class_name, xp
            FROM users
            WHERE is_banned = 0
            ORDER BY xp DESC, id ASC
            LIMIT 10
            """
        ).fetchall()

        students_out = []
        for idx, s in enumerate(top_students, start=1):
            lv = compute_level(s["xp"])
            students_out.append({
                "rank": idx,
                "id": s["id"],
                "name": s["name"],
                "reg_number": s["reg_number"],
                "class_name": s["class_name"],
                "xp": s["xp"],
                "level": lv["level"],
                "title": lv["title"],
            })

        class_rows = conn.execute(
            """
            SELECT class_name, SUM(xp) AS total_xp, COUNT(*) AS member_count
            FROM users
            WHERE is_banned = 0
            GROUP BY class_name
            ORDER BY total_xp DESC
            LIMIT 6
            """
        ).fetchall()

        return {
            "students": students_out,
            "classes": [dict(c) for c in class_rows],
        }
    finally:
        conn.close()


# ---------- Admin Authentication & Moderation ----------

def _ensure_admin_magic_links_table(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_magic_links (
            token TEXT PRIMARY KEY,
            expires_at TEXT NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            requested_ip TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )


@app.post("/api/admin/login")
def admin_login(payload: AdminLoginRequest):
    raise HTTPException(
        status_code=403,
        detail="Password login is disabled. Request a one-time Admin Access Link via email instead.",
    )


@app.post("/api/admin/request-link")
def admin_request_magic_link(request: Request):
    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
    expires_at = (now_dt + timedelta(minutes=10)).isoformat()
    magic_token = secrets.token_urlsafe(32)
    client_ip = _get_client_ip(request)
    user_agent = (request.headers.get("user-agent") or "Unknown")[:200]

    conn = get_db()
    try:
        _ensure_admin_magic_links_table(conn)
        conn.execute(
            """
            INSERT INTO admin_magic_links (token, expires_at, used, requested_ip, user_agent, created_at)
            VALUES (?, ?, 0, ?, ?, ?)
            """,
            (magic_token, expires_at, client_ip, user_agent, now),
        )
        conn.commit()
    finally:
        conn.close()

    cfg = load_admin_config()
    req_base = str(request.base_url).rstrip("/")
    configured_base = (cfg.get("app_base_url") or "").strip().rstrip("/")
    # Use the active request origin on localhost/LAN so local testing links always open locally;
    # otherwise use configured APP_BASE_URL (e.g. Railway HTTPS URL).
    if "127.0.0.1" in req_base or "localhost" in req_base or req_base.startswith("http://192.168."):
        base_url = req_base
    else:
        base_url = configured_base or req_base

    magic_url = f"{base_url}/admin/magic-login?token={magic_token}"
    record = send_admin_magic_link_email(
        magic_url=magic_url,
        requested_ip=client_ip,
        user_agent=user_agent,
        requested_at=now,
    )
    return {
        "ok": True,
        "delivery": record.get("delivery"),
        "email_mode": (cfg.get("email_mode") or "mailpit").strip().lower(),
        "message": "One-time Admin Access Link sent to the admin email! Open your email and click the link within 10 minutes.",
    }


@app.get("/admin/magic-login", response_class=HTMLResponse)
def admin_magic_login(token: str = ""):
    def _error_page(title: str, subtitle: str) -> HTMLResponse:
        return HTMLResponse(
            status_code=400,
            content=f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Primus Pix — {title}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #fdf2f8; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }}
    .card {{ background: #ffffff; border: 2px solid #f472b6; border-radius: 18px; padding: 28px; max-width: 440px; text-align: center; box-shadow: 0 12px 30px rgba(244,114,182,0.18); }}
    h1 {{ margin: 0 0 10px; font-size: 22px; color: #be185d; }}
    p {{ margin: 0 0 20px; color: #475569; font-size: 14px; line-height: 1.5; }}
    a {{ display: inline-block; background: #f472b6; color: #fff; text-decoration: none; font-weight: 700; padding: 11px 22px; border-radius: 10px; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>{title}</h1>
    <p>{subtitle}</p>
    <a href="/">Back to Primus Pix</a>
  </div>
</body>
</html>""",
        )

    clean_token = (token or "").strip()
    if not clean_token:
        return _error_page("Missing Access Link", "This admin login link is incomplete. Please request a new link from Primus Pix.")

    conn = get_db()
    try:
        _ensure_admin_magic_links_table(conn)
        row = conn.execute(
            "SELECT * FROM admin_magic_links WHERE token = ?",
            (clean_token,),
        ).fetchone()
        if not row:
            return _error_page("Invalid Access Link", "This admin link is not valid. Please request a fresh link.")
        if row["used"]:
            return _error_page("Link Already Used", "For your security, each Admin Access Link can only be used once. Request a new link to sign in again.")
        if datetime.now(timezone.utc) > datetime.fromisoformat(row["expires_at"]):
            return _error_page("Link Expired", "This Admin Access Link has expired (10-minute limit). Please request a new link.")

        conn.execute("UPDATE admin_magic_links SET used = 1 WHERE token = ?", (clean_token,))
        admin_token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO admin_sessions (token, created_at) VALUES (?, ?)",
            (admin_token, utc_now()),
        )
        conn.commit()
    finally:
        conn.close()

    return HTMLResponse(
        content=f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Opening Primus Pix Admin...</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #eff6ff; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }}
    .card {{ background: #fff; border: 2px solid #93c5fd; border-radius: 16px; padding: 24px 28px; text-align: center; }}
  </style>
</head>
<body>
  <div class="card">
    <h2>Admin Verified</h2>
    <p>Opening Primus Pix Admin Panel...</p>
  </div>
  <script>
    localStorage.setItem("cp_admin_token", "{admin_token}");
    window.location.replace("/?admin=1");
  </script>
</body>
</html>""",
    )


@app.get("/api/admin/settings")
def admin_get_settings(_=Depends(require_admin)):
    cfg = load_admin_config()
    return {
        "email_mode": cfg.get("email_mode", "mailpit"),
        "resend_api_key_set": bool((cfg.get("resend_api_key") or "").strip()),
        "resend_from": cfg.get("resend_from", "Primus Pix <onboarding@resend.dev>"),
        "smtp_host": cfg.get("smtp_host", "127.0.0.1"),
        "smtp_port": int(cfg.get("smtp_port", 1025)),
        "admin_email": cfg.get("admin_email", ""),
        "gmail_user": cfg.get("gmail_user", ""),
        "gmail_app_password_set": bool((cfg.get("gmail_app_password") or "").strip()),
        "app_base_url": cfg.get("app_base_url", "http://127.0.0.1:8000"),
        "local_inbox": list_local_inbox(),
    }


@app.post("/api/admin/settings")
def admin_update_settings(payload: AdminSettingsUpdate, _=Depends(require_admin)):
    cfg = load_admin_config()
    mode = payload.email_mode.strip().lower()
    cfg["email_mode"] = mode if mode in ("resend", "mailpit", "gmail") else "mailpit"
    if payload.resend_api_key is not None and payload.resend_api_key.strip() != "":
        cfg["resend_api_key"] = payload.resend_api_key.strip()
    if payload.resend_from.strip():
        cfg["resend_from"] = payload.resend_from.strip()
    cfg["smtp_host"] = payload.smtp_host.strip() or "127.0.0.1"
    cfg["smtp_port"] = int(payload.smtp_port or 1025)
    cfg["admin_email"] = payload.admin_email.strip()
    cfg["gmail_user"] = payload.gmail_user.strip()
    if payload.gmail_app_password is not None and payload.gmail_app_password.strip() != "":
        cfg["gmail_app_password"] = payload.gmail_app_password.replace(" ", "").strip()
    if payload.app_base_url.strip():
        cfg["app_base_url"] = payload.app_base_url.strip().rstrip("/")
    save_admin_config(cfg)
    return {
        "ok": True,
        "email_mode": cfg["email_mode"],
        "resend_api_key_set": bool((cfg.get("resend_api_key") or "").strip()),
        "gmail_app_password_set": bool((cfg.get("gmail_app_password") or "").strip()),
    }


@app.post("/api/admin/settings/test-email")
def admin_test_email(_=Depends(require_admin)):
    ok, msg = send_test_gmail()
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    return {"ok": True, "message": msg}


@app.post("/api/admin/logout")
def admin_logout(x_admin_token: Optional[str] = Header(default=None)):
    if not x_admin_token:
        return {"ok": True}
    conn = get_db()
    try:
        conn.execute("DELETE FROM admin_sessions WHERE token = ?", (x_admin_token,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.get("/api/admin/overview")
def admin_overview(_=Depends(require_admin)):
    conn = get_db()
    try:
        sessions = conn.execute(
            """
            SELECT s.id, s.user_id, s.reg_number, s.name, s.class_name, s.status, s.created_at, s.decided_at,
                   u.is_banned
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            ORDER BY
                CASE WHEN s.status = 'pending' THEN 0 ELSE 1 END,
                s.created_at DESC
            LIMIT 200
            """
        ).fetchall()

        users = conn.execute(
            """
            SELECT u.id, u.reg_number, u.name, u.class_name, u.is_banned,
                   COALESCE(u.ban_message, '') AS ban_message, u.created_at,
                   (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id) AS post_count,
                   (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.status = 'approved') AS active_sessions
            FROM users u
            ORDER BY u.created_at DESC
            """
        ).fetchall()

        posts_rows = conn.execute(
            """
            SELECT p.*, u.name AS author_name, u.reg_number AS author_reg_number, u.class_name AS author_class
            FROM posts p
            JOIN users u ON u.id = p.user_id
            ORDER BY p.created_at DESC
            LIMIT 100
            """
        ).fetchall()

        notices_rows = conn.execute(
            "SELECT * FROM notices ORDER BY pinned DESC, updated_at DESC"
        ).fetchall()

        class_rows = conn.execute(
            "SELECT DISTINCT class_name FROM users ORDER BY class_name COLLATE NOCASE"
        ).fetchall()

        import json as _json
        poll_rows = conn.execute("SELECT * FROM polls ORDER BY created_at DESC LIMIT 20").fetchall()
        polls_out = []
        for pr in poll_rows:
            opts = _json.loads(pr["options_json"])
            vrows = conn.execute(
                "SELECT option_index, COUNT(*) AS cnt FROM poll_votes WHERE poll_id = ? GROUP BY option_index",
                (pr["id"],),
            ).fetchall()
            counts = [0] * len(opts)
            for vr in vrows:
                if 0 <= vr["option_index"] < len(opts):
                    counts[vr["option_index"]] = vr["cnt"]
            polls_out.append({
                "id": pr["id"],
                "question": pr["question"],
                "options": opts,
                "counts": counts,
                "total_votes": sum(counts),
                "created_at": pr["created_at"],
            })

        stories_rows = conn.execute(
            """
            SELECT st.id, st.user_id, st.story_type, st.caption, st.media_url, st.audience,
                   COALESCE(st.is_hidden, 0) AS is_hidden, st.created_at, st.expires_at,
                   COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.reg_number AS author_reg_number, u.class_name AS author_class
            FROM stories st
            JOIN users u ON u.id = st.user_id
            ORDER BY st.created_at DESC
            LIMIT 60
            """
        ).fetchall()

        flashes_rows = conn.execute(
            """
            SELECT f.id, f.user_id, f.text, f.media_url, f.audience,
                   COALESCE(f.is_hidden, 0) AS is_hidden, f.created_at, f.expires_at,
                   COALESCE(NULLIF(u.display_name, ''), u.name) AS author_name,
                   u.reg_number AS author_reg_number, u.class_name AS author_class
            FROM flashes f
            JOIN users u ON u.id = f.user_id
            ORDER BY f.created_at DESC
            LIMIT 60
            """
        ).fetchall()

        return {
            "sessions": [dict(s) for s in sessions],
            "users": [dict(u) for u in users],
            "posts": [serialize_post(conn, r, None) for r in posts_rows],
            "stories": [dict(st) for st in stories_rows],
            "flashes": [dict(fl) for fl in flashes_rows],
            "notices": [dict(n) for n in notices_rows],
            "classes": [c["class_name"] for c in class_rows],
            "polls": polls_out,
        }
    finally:
        conn.close()


# ---------- Campus Notice Board (Admin Editable, Multi-Class Targetable) ----------

def _normalize_target_classes(payload: NoticePayload) -> str:
    if payload.target_classes is not None:
        cleaned = [c.strip() for c in payload.target_classes if c and c.strip()]
        return ", ".join(dict.fromkeys(cleaned))
    cleaned = [c.strip() for c in (payload.target_class or "").split(",") if c.strip()]
    return ", ".join(dict.fromkeys(cleaned))


@app.get("/api/notices")
def list_notices(user=Depends(require_approved_user)):
    my_class = (user.get("class_name") or "").strip().lower()
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM notices ORDER BY pinned DESC, updated_at DESC"
        ).fetchall()
        visible = []
        for r in rows:
            tc = (r["target_class"] or "").strip()
            if not tc:
                visible.append(dict(r))
            else:
                targets = [c.strip().lower() for c in tc.split(",") if c.strip()]
                if my_class in targets:
                    visible.append(dict(r))
        return {"notices": visible}
    finally:
        conn.close()


@app.post("/api/admin/notices")
def admin_create_notice(payload: NoticePayload, _=Depends(require_admin)):
    title = payload.title.strip()
    body = payload.body.strip()
    priority = payload.priority.strip().lower()
    target_class = _normalize_target_classes(payload)
    if priority not in ("info", "important", "urgent"):
        priority = "info"
    if not title or not body:
        raise HTTPException(status_code=400, detail="Notice title and message are required.")
    now = utc_now()
    conn = get_db()
    try:
        cur = conn.execute(
            """
            INSERT INTO notices (title, body, priority, pinned, target_class, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (title, body, priority, 1 if payload.pinned else 0, target_class, now, now),
        )
        notice_id = cur.lastrowid
        conn.commit()
        row = conn.execute("SELECT * FROM notices WHERE id = ?", (notice_id,)).fetchone()
        return {"notice": dict(row)}
    finally:
        conn.close()


@app.put("/api/admin/notices/{notice_id}")
def admin_update_notice(notice_id: int, payload: NoticePayload, _=Depends(require_admin)):
    title = payload.title.strip()
    body = payload.body.strip()
    priority = payload.priority.strip().lower()
    target_class = _normalize_target_classes(payload)
    if priority not in ("info", "important", "urgent"):
        priority = "info"
    if not title or not body:
        raise HTTPException(status_code=400, detail="Notice title and message are required.")
    conn = get_db()
    try:
        exists = conn.execute("SELECT 1 FROM notices WHERE id = ?", (notice_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Notice not found.")
        conn.execute(
            """
            UPDATE notices
            SET title = ?, body = ?, priority = ?, pinned = ?, target_class = ?, updated_at = ?
            WHERE id = ?
            """,
            (title, body, priority, 1 if payload.pinned else 0, target_class, utc_now(), notice_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM notices WHERE id = ?", (notice_id,)).fetchone()
        return {"notice": dict(row)}
    finally:
        conn.close()


# ---------- Admin Poll Management ----------

@app.post("/api/admin/polls")
def admin_create_poll(payload: PollCreate, _=Depends(require_admin)):
    import json as _json
    q = payload.question.strip()
    opts = [o.strip() for o in payload.options if o and o.strip()]
    if not q or len(opts) < 2 or len(opts) > 4:
        raise HTTPException(status_code=400, detail="Polls need a question and 2 to 4 options.")
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO polls (user_id, question, options_json, created_at) VALUES (NULL, ?, ?, ?)",
            (q, _json.dumps(opts), utc_now()),
        )
        pid = cur.lastrowid
        conn.commit()
        return {"ok": True, "poll_id": pid}
    finally:
        conn.close()


@app.put("/api/admin/polls/{poll_id}")
def admin_update_poll(poll_id: int, payload: PollCreate, _=Depends(require_admin)):
    import json as _json
    q = payload.question.strip()
    opts = [o.strip() for o in payload.options if o and o.strip()]
    if not q or len(opts) < 2 or len(opts) > 4:
        raise HTTPException(status_code=400, detail="Polls need a question and 2 to 4 options.")
    conn = get_db()
    try:
        exists = conn.execute("SELECT 1 FROM polls WHERE id = ?", (poll_id,)).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Poll not found.")
        conn.execute(
            "UPDATE polls SET question = ?, options_json = ? WHERE id = ?",
            (q, _json.dumps(opts), poll_id),
        )
        # Clear out-of-range votes if options count shrank
        conn.execute(
            "DELETE FROM poll_votes WHERE poll_id = ? AND option_index >= ?",
            (poll_id, len(opts)),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.delete("/api/admin/polls/{poll_id}")
def admin_delete_poll(poll_id: int, _=Depends(require_admin)):
    conn = get_db()
    try:
        conn.execute("DELETE FROM polls WHERE id = ?", (poll_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.delete("/api/admin/notices/{notice_id}")
def admin_delete_notice(notice_id: int, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM notices WHERE id = ?", (notice_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Notice not found.")
        conn.execute("DELETE FROM notices WHERE id = ?", (notice_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.post("/api/admin/sessions/{session_id}/approve")
def admin_approve_session(session_id: int, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute(
            """
            SELECT s.id, s.user_id, u.is_banned
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.id = ?
            """,
            (session_id,),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Sign-in request not found.")
        if row["is_banned"]:
            raise HTTPException(status_code=400, detail="Unban this student before approving their sign-in.")
        conn.execute(
            "UPDATE sessions SET status = 'approved', decided_at = ? WHERE id = ?",
            (utc_now(), session_id),
        )
        conn.execute("UPDATE users SET is_verified = 1 WHERE id = ?", (row["user_id"],))
        conn.execute(
            "UPDATE email_action_tokens SET used = 1 WHERE session_id = ?",
            (session_id,),
        )
        conn.commit()
        return {"ok": True, "status": "approved"}
    finally:
        conn.close()


@app.post("/api/admin/sessions/{session_id}/deny")
def admin_deny_session(session_id: int, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Sign-in request not found.")
        conn.execute(
            "UPDATE sessions SET status = 'denied', decided_at = ? WHERE id = ?",
            (utc_now(), session_id),
        )
        conn.execute(
            "UPDATE email_action_tokens SET used = 1 WHERE session_id = ?",
            (session_id,),
        )
        conn.commit()
        return {"ok": True, "status": "denied"}
    finally:
        conn.close()


@app.post("/api/admin/sessions/{session_id}/revoke")
def admin_revoke_session(session_id: int, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Session not found.")
        conn.execute(
            "UPDATE sessions SET status = 'revoked', decided_at = ? WHERE id = ?",
            (utc_now(), session_id),
        )
        conn.commit()
        return {"ok": True, "status": "revoked"}
    finally:
        conn.close()


@app.post("/api/admin/users/{user_id}/ban")
def admin_toggle_ban(user_id: int, payload: BanRequest, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Student not found.")
        is_banned_int = 1 if payload.is_banned else 0
        ban_msg = payload.ban_message.strip()[:500] if payload.is_banned else ""
        now = utc_now()
        conn.execute(
            "UPDATE users SET is_banned = ?, ban_message = ?, updated_at = ? WHERE id = ?",
            (is_banned_int, ban_msg, now, user_id),
        )
        if payload.is_banned:
            conn.execute(
                "UPDATE sessions SET status = 'revoked', decided_at = ? WHERE user_id = ? AND status IN ('pending', 'approved')",
                (now, user_id),
            )
        conn.commit()
        return {"ok": True, "is_banned": payload.is_banned, "ban_message": ban_msg}
    finally:
        conn.close()


@app.delete("/api/admin/users/{user_id}")
def admin_remove_user(user_id: int, _=Depends(require_admin)):
    conn = get_db()
    media_urls: list[str] = []
    try:
        user_row = conn.execute("SELECT id, avatar_url FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user_row:
            raise HTTPException(status_code=404, detail="Student not found.")
        if user_row["avatar_url"]:
            media_urls.append(user_row["avatar_url"])

        for r in conn.execute("SELECT media_url FROM posts WHERE user_id = ?", (user_id,)).fetchall():
            if r["media_url"]:
                media_urls.append(r["media_url"])
        for r in conn.execute("SELECT media_url FROM stories WHERE user_id = ?", (user_id,)).fetchall():
            if r["media_url"]:
                media_urls.append(r["media_url"])
        for r in conn.execute("SELECT media_url FROM flashes WHERE user_id = ?", (user_id,)).fetchall():
            if r["media_url"]:
                media_urls.append(r["media_url"])

        # Remove dependent records explicitly as well as relying on ON DELETE CASCADE
        conn.execute("DELETE FROM email_action_tokens WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)", (user_id,))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM likes WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM comments WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM story_views WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM story_likes WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM story_comments WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM close_friends WHERE user_id = ? OR friend_id = ?", (user_id, user_id))
        conn.execute("DELETE FROM poll_votes WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM reactions WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM xp_events WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM flashes WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM stories WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM posts WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    finally:
        conn.close()

    for url in media_urls:
        _cleanup_media_file(url)
    return {"ok": True, "deleted_user_id": user_id}


@app.post("/api/admin/posts/{post_id}/hide")
def admin_toggle_hide_post(post_id: int, payload: HideRequest, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Post not found.")
        val = 1 if payload.is_hidden else 0
        conn.execute("UPDATE posts SET is_hidden = ? WHERE id = ?", (val, post_id))
        conn.commit()
        return {"ok": True, "is_hidden": payload.is_hidden}
    finally:
        conn.close()


@app.post("/api/admin/stories/{story_id}/hide")
def admin_toggle_hide_story(story_id: int, payload: HideRequest, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Story not found.")
        val = 1 if payload.is_hidden else 0
        conn.execute("UPDATE stories SET is_hidden = ? WHERE id = ?", (val, story_id))
        conn.commit()
        return {"ok": True, "is_hidden": payload.is_hidden}
    finally:
        conn.close()


@app.delete("/api/admin/stories/{story_id}")
def admin_delete_story(story_id: int, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id, media_url FROM stories WHERE id = ?", (story_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Story not found.")
        conn.execute("DELETE FROM stories WHERE id = ?", (story_id,))
        conn.commit()
        _cleanup_media_file(row["media_url"])
        return {"ok": True}
    finally:
        conn.close()


@app.post("/api/admin/flashes/{flash_id}/hide")
def admin_toggle_hide_flash(flash_id: int, payload: HideRequest, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM flashes WHERE id = ?", (flash_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Flash not found.")
        val = 1 if payload.is_hidden else 0
        conn.execute("UPDATE flashes SET is_hidden = ? WHERE id = ?", (val, flash_id))
        conn.commit()
        return {"ok": True, "is_hidden": payload.is_hidden}
    finally:
        conn.close()


@app.delete("/api/admin/flashes/{flash_id}")
def admin_delete_flash(flash_id: int, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id, media_url FROM flashes WHERE id = ?", (flash_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Flash not found.")
        conn.execute("DELETE FROM flashes WHERE id = ?", (flash_id,))
        conn.commit()
        _cleanup_media_file(row["media_url"])
        return {"ok": True}
    finally:
        conn.close()


@app.delete("/api/admin/posts/{post_id}")
def admin_delete_post(post_id: int, _=Depends(require_admin)):
    conn = get_db()
    try:
        row = conn.execute("SELECT id, media_url FROM posts WHERE id = ?", (post_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Post not found.")
        conn.execute("DELETE FROM posts WHERE id = ?", (post_id,))
        conn.commit()
        _cleanup_media_file(row["media_url"])
        return {"ok": True}
    finally:
        conn.close()


def _cleanup_media_file(media_url: Optional[str]) -> None:
    if not media_url:
        return
    if USE_SUPABASE_STORAGE and f"/storage/v1/object/public/{SUPABASE_BUCKET}/" in media_url:
        fname = media_url.split(f"/storage/v1/object/public/{SUPABASE_BUCKET}/", 1)[1]
        try:
            del_url = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{fname}"
            headers = {
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
            }
            httpx.delete(del_url, headers=headers, timeout=10.0)
        except Exception:
            pass
        return
    if not media_url.startswith("/uploads/"):
        return
    fname = media_url.split("/uploads/", 1)[1]
    target = UPLOAD_DIR / fname
    if target.is_file():
        try:
            target.unlink()
        except OSError:
            pass
