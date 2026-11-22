import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Optional

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "app.db"
DATABASE_URL = (os.environ.get("DATABASE_URL") or "").strip()
USE_POSTGRES = bool(DATABASE_URL)

if USE_POSTGRES:
    import psycopg2
    import psycopg2.extras

# Tables that have an auto-generated `id` primary key
TABLES_WITH_ID = {
    "users",
    "sessions",
    "posts",
    "comments",
    "stories",
    "story_comments",
    "flashes",
    "notices",
    "polls",
    "xp_events",
}


class RowProxy(dict):
    """Dict-like row that also supports integer indexing (row[0]) like sqlite3.Row."""

    def __init__(self, mapping: dict):
        super().__init__(mapping)
        self._values = list(mapping.values())

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return super().__getitem__(key)


def _translate_sql_for_postgres(sql: str) -> tuple[str, bool]:
    """Translate SQLite-style SQL to Postgres-compatible SQL."""
    s = sql.strip()
    # Replace SQLite COLLATE NOCASE
    s = re.sub(r"\s+COLLATE\s+NOCASE", "", s, flags=re.IGNORECASE)

    # Handle INSERT OR REPLACE INTO story_views
    if re.match(r"INSERT\s+OR\s+REPLACE\s+INTO\s+story_views", s, flags=re.IGNORECASE):
        s = re.sub(r"INSERT\s+OR\s+REPLACE\s+INTO", "INSERT INTO", s, count=1, flags=re.IGNORECASE)
        s += " ON CONFLICT (story_id, user_id) DO UPDATE SET viewed_at = EXCLUDED.viewed_at"

    # Convert ? placeholders to %s
    s = s.replace("?", "%s")

    # Auto-append RETURNING id for inserts into tables with an id column
    wants_returning_id = False
    m = re.match(r"INSERT\s+INTO\s+(?:public\.)?(\w+)", s, flags=re.IGNORECASE)
    if m and m.group(1).lower() in TABLES_WITH_ID and "RETURNING" not in s.upper():
        s += " RETURNING id"
        wants_returning_id = True

    return s, wants_returning_id


class PgCursorWrapper:
    def __init__(self, cur, lastrowid: Optional[int] = None):
        self._cur = cur
        self.lastrowid = lastrowid

    def fetchone(self):
        row = self._cur.fetchone()
        return RowProxy(row) if row is not None else None

    def fetchall(self):
        return [RowProxy(r) for r in self._cur.fetchall()]


class PgConnWrapper:
    def __init__(self, raw_conn):
        self._conn = raw_conn

    def execute(self, sql: str, params: Iterable[Any] = ()):
        pg_sql, wants_id = _translate_sql_for_postgres(sql)
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(pg_sql, tuple(params) if params is not None else ())
        lastrowid = None
        if wants_id:
            r = cur.fetchone()
            if r and "id" in r:
                lastrowid = r["id"]
        return PgCursorWrapper(cur, lastrowid=lastrowid)

    def cursor(self):
        return self

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


def get_db():
    if USE_POSTGRES:
        raw = psycopg2.connect(DATABASE_URL)
        return PgConnWrapper(raw)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn
