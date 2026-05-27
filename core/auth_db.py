import sqlite3
import os
import secrets
import hashlib
from datetime import datetime
import config

DB_PATH = os.path.join(config.BASE_DIR, 'data', 'users.db')


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Создаёт таблицы если не существуют"""
    with get_conn() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone TEXT UNIQUE NOT NULL,
                role TEXT NOT NULL DEFAULT 'viewer',
                name TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now')),
                last_login TEXT,
                active INTEGER DEFAULT 1
            )
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS auth_sessions (
                phone TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                code_hash TEXT,
                expires_at TEXT NOT NULL,
                attempts INTEGER DEFAULT 0
            )
        ''')
        conn.commit()
    # Добавить admin из .env если не существует
    admin_phone = os.getenv('ADMIN_PHONE', '')
    if admin_phone:
        add_user(admin_phone, role='admin', name='Admin')


def add_user(phone: str, role: str = 'viewer', name: str = ''):
    """Добавить пользователя которому разрешён вход"""
    phone = phone.strip()
    if not phone.startswith('+'):
        phone = '+' + phone
    with get_conn() as conn:
        conn.execute(
            'INSERT OR IGNORE INTO users (phone, role, name) VALUES (?, ?, ?)',
            (phone, role, name)
        )
        conn.commit()


def get_user(phone: str):
    with get_conn() as conn:
        row = conn.execute('SELECT * FROM users WHERE phone = ? AND active = 1', (phone,)).fetchone()
        return dict(row) if row else None


def update_user(phone: str, name: str = None, role: str = None):
    """Обновить имя и/или роль пользователя"""
    with get_conn() as conn:
        fields = []
        vals = []
        if name is not None:
            fields.append('name = ?')
            vals.append(name)
        if role is not None:
            fields.append('role = ?')
            vals.append(role)
        if fields:
            vals.append(phone)
            conn.execute(f'UPDATE users SET {", ".join(fields)} WHERE phone = ?', vals)
            conn.commit()


def list_users():
    with get_conn() as conn:
        rows = conn.execute('SELECT * FROM users ORDER BY created_at DESC').fetchall()
        return [dict(r) for r in rows]


def delete_user(phone: str):
    with get_conn() as conn:
        conn.execute('DELETE FROM users WHERE phone = ?', (phone,))
        conn.commit()


def update_last_login(phone: str):
    with get_conn() as conn:
        conn.execute('UPDATE users SET last_login = ? WHERE phone = ?', (datetime.utcnow().isoformat(), phone))
        conn.commit()


def save_auth_session(phone: str, code_hash: str, expires_at: str):
    with get_conn() as conn:
        conn.execute(
            'INSERT OR REPLACE INTO auth_sessions (phone, code, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)',
            (phone, '', code_hash, expires_at)
        )
        conn.commit()


def get_auth_session(phone: str):
    with get_conn() as conn:
        row = conn.execute('SELECT * FROM auth_sessions WHERE phone = ?', (phone,)).fetchone()
        return dict(row) if row else None


def increment_attempts(phone: str):
    with get_conn() as conn:
        conn.execute('UPDATE auth_sessions SET attempts = attempts + 1 WHERE phone = ?', (phone,))
        conn.commit()


def delete_auth_session(phone: str):
    with get_conn() as conn:
        conn.execute('DELETE FROM auth_sessions WHERE phone = ?', (phone,))
        conn.commit()
