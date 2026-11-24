"""Портативное приложение DB2UI — локальный сервер.

Этот файл попадает в ZIP-пакет, который скачивается из DB2UI Studio.
Он читает проект из data/project.json, подключается к PostgreSQL и
обслуживает готовый интерфейс приложения вместе с CRUD и авторизацией.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import socket
import sys
import threading
import webbrowser
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras
from flask import Flask, jsonify, render_template, request, session
from psycopg2 import sql as psql
from werkzeug.exceptions import HTTPException

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DB2UI_APP_DATA") or (BASE_DIR / "data"))
PROJECT_FILE = DATA_DIR / "project.json"
CONFIG_FILE = DATA_DIR / "config.json"
SECRET_FILE = DATA_DIR / "secret.key"

DATA_DIR.mkdir(parents=True, exist_ok=True)


def _read_secret() -> str:
    try:
        if SECRET_FILE.exists():
            value = SECRET_FILE.read_text(encoding="utf-8").strip()
            if len(value) >= 32:
                return value
    except OSError:
        pass
    value = secrets.token_hex(32)
    try:
        SECRET_FILE.write_text(value, encoding="utf-8")
    except OSError:
        pass
    return value


app = Flask(__name__)
app.config.update(
    SECRET_KEY=_read_secret(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    JSON_AS_ASCII=False,
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def _api_error(exc: ApiError):
    return jsonify({"error": exc.message}), exc.status


@app.errorhandler(Exception)
def _unexpected_error(exc: Exception):
    if isinstance(exc, HTTPException):
        return exc
    return jsonify({"error": "Внутренняя ошибка: " + str(exc)}), 500


def _decode_db_bytes(raw: bytes) -> str:
    """Сообщения PostgreSQL приходят в кодировке сервера (часто cp1251)."""
    for encoding in ("utf-8", "cp1251", "cp866"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def db_error_text(exc: Exception) -> str:
    if isinstance(exc, UnicodeDecodeError):
        raw = exc.object if isinstance(exc.object, (bytes, bytearray)) else b""
        text = _decode_db_bytes(bytes(raw)).strip() if raw else ""
        if text:
            return text
    if isinstance(exc, psycopg2.Error):
        return (exc.pgerror or str(exc)).strip()
    return str(exc).strip()


def json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).hex()
    return str(value)


AUTH_DEFAULT: dict[str, Any] = {
    "enabled": False,
    "allow_registration": True,
    "title": "Вход в приложение",
    "schema": "public",
    "table": "",
    "login_column": "",
    "password_column": "",
    "password_mode": "plain",
    "role_column": "",
    "welcome": "",
}

SSL_MODES = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}


def _text(value: Any, limit: int = 120) -> str:
    return str(value if value is not None else "")[:limit]


def _clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def normalize_auth(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    mode = source.get("password_mode")
    if mode not in {"plain", "sha256"}:
        mode = "plain"
    return {
        "enabled": bool(source.get("enabled")),
        "allow_registration": source.get("allow_registration", True) is not False,
        "title": _text(source.get("title") or AUTH_DEFAULT["title"], 120),
        "schema": _text(source.get("schema") or "public", 80),
        "table": _text(source.get("table"), 120),
        "login_column": _text(source.get("login_column"), 120),
        "password_column": _text(source.get("password_column"), 120),
        "password_mode": mode,
        "role_column": _text(source.get("role_column"), 120),
        "welcome": _text(source.get("welcome"), 240),
    }


def normalize_config(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    sslmode = str(source.get("sslmode") or "prefer")
    if sslmode not in SSL_MODES:
        sslmode = "prefer"
    return {
        "host": _text(source.get("host") or "localhost", 200).strip(),
        "port": _clamp_int(source.get("port"), 5432, 1, 65535),
        "dbname": _text(source.get("dbname"), 120).strip(),
        "user": _text(source.get("user"), 120).strip(),
        "password": str(source.get("password") or ""),
        "sslmode": sslmode,
    }


def load_bundle() -> dict[str, Any]:
    try:
        raw = json.loads(PROJECT_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(
            "Не найден файл data/project.json. Распакуйте ZIP-пакет целиком."
        ) from exc
    except (OSError, ValueError) as exc:
        raise RuntimeError("Не удалось прочитать data/project.json: " + str(exc)) from exc

    if isinstance(raw, dict) and isinstance(raw.get("project"), dict):
        project = raw["project"]
        tables = raw.get("tables") if isinstance(raw.get("tables"), list) else []
    else:
        project = raw if isinstance(raw, dict) else {}
        tables = []

    forms = project.get("forms")
    if not isinstance(forms, list) or not forms:
        raise RuntimeError("В проекте нет форм. Пересоберите приложение в DB2UI Studio.")

    return {
        "project": project,
        "tables": [item for item in tables if isinstance(item, dict)],
    }


def load_config() -> dict[str, Any]:
    try:
        raw = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError):
        return normalize_config({})
    config = normalize_config(raw)
    # Если в файле был только шаблон, оставляем пустые поля — их заполнит пользователь.
    return config


def save_config(config: dict[str, Any]) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_FILE.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(tmp, CONFIG_FILE)
    except OSError:
        # Конфигурация не критична для работы уже запущенного приложения.
        pass


BUNDLE = load_bundle()

DB: dict[str, Any] = {
    "conn": None,
    "lock": threading.RLock(),
    "config": load_config(),
    "tables": BUNDLE["tables"],
    "connected": False,
    "database": "",
    "db_user": "",
    "version": "",
    "error": "",
}


# ---------------------------------------------------------------------------
# Подключение и схема
# ---------------------------------------------------------------------------


def open_connection(config: dict[str, Any]):
    params: dict[str, Any] = {
        "host": config["host"],
        "port": config["port"],
        "dbname": config["dbname"],
        "user": config["user"],
        "password": config.get("password", ""),
        "connect_timeout": 6,
        "application_name": "db2ui_app",
    }
    if config.get("sslmode"):
        params["sslmode"] = config["sslmode"]
    conn = psycopg2.connect(**params)
    conn.autocommit = True
    return conn


def introspect_tables(conn) -> list[dict[str, Any]]:
    tables: list[dict[str, Any]] = []
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT table_schema, table_name
            FROM information_schema.tables
            WHERE table_type = 'BASE TABLE'
              AND table_schema NOT IN ('pg_catalog', 'information_schema')
              AND table_schema NOT LIKE 'pg\\_%' ESCAPE '\\'
            ORDER BY table_schema, table_name
            """
        )
        found = cur.fetchall()

        for item in found:
            schema_name = item["table_schema"]
            table_name = item["table_name"]

            cur.execute(
                """
                SELECT column_name,
                       data_type,
                       udt_name,
                       (is_nullable = 'YES') AS nullable,
                       column_default,
                       COALESCE(is_identity, 'NO') AS is_identity,
                       COALESCE(is_generated, 'NEVER') AS is_generated
                FROM information_schema.columns
                WHERE table_schema = %s AND table_name = %s
                ORDER BY ordinal_position
                """,
                (schema_name, table_name),
            )
            raw_columns = cur.fetchall()

            cur.execute(
                """
                SELECT kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                 AND tc.table_name = kcu.table_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = %s
                  AND tc.table_name = %s
                ORDER BY kcu.ordinal_position
                """,
                (schema_name, table_name),
            )
            primary_key = [row["column_name"] for row in cur.fetchall()]

            cur.execute(
                """
                SELECT con.conname AS name,
                       att.attname AS column_name,
                       fns.nspname AS ref_schema,
                       fcl.relname AS ref_table,
                       fatt.attname AS ref_column
                FROM pg_constraint con
                JOIN pg_class cl ON cl.oid = con.conrelid
                JOIN pg_namespace ns ON ns.oid = cl.relnamespace
                JOIN pg_class fcl ON fcl.oid = con.confrelid
                JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
                JOIN LATERAL generate_subscripts(con.conkey, 1) AS s(i) ON TRUE
                JOIN pg_attribute att
                  ON att.attrelid = con.conrelid AND att.attnum = con.conkey[s.i]
                JOIN pg_attribute fatt
                  ON fatt.attrelid = con.confrelid AND fatt.attnum = con.confkey[s.i]
                WHERE con.contype = 'f'
                  AND ns.nspname = %s
                  AND cl.relname = %s
                ORDER BY con.conname, s.i
                """,
                (schema_name, table_name),
            )
            foreign_keys = [
                {
                    "name": row["name"],
                    "column": row["column_name"],
                    "ref_schema": row["ref_schema"],
                    "ref_table": row["ref_table"],
                    "ref_column": row["ref_column"],
                }
                for row in cur.fetchall()
            ]
            references_by_column = {fk["column"]: fk for fk in foreign_keys}

            columns = []
            for col in raw_columns:
                default = col["column_default"] or ""
                is_identity = col["is_identity"] == "YES"
                is_generated = col["is_generated"] != "NEVER"
                is_serial = "nextval(" in default
                columns.append(
                    {
                        "name": col["column_name"],
                        "data_type": col["data_type"],
                        "udt_name": col["udt_name"],
                        "nullable": bool(col["nullable"]),
                        "default": default or None,
                        "is_identity": is_identity,
                        "is_generated": is_generated,
                        "is_serial": is_serial,
                        "is_pk": col["column_name"] in primary_key,
                        "form_editable": not (
                            is_identity or is_generated or is_serial
                        ),
                        "references": references_by_column.get(col["column_name"]),
                    }
                )

            tables.append(
                {
                    "schema": schema_name,
                    "name": table_name,
                    "label": (
                        table_name
                        if schema_name == "public"
                        else f"{schema_name}.{table_name}"
                    ),
                    "columns": columns,
                    "primary_key": primary_key,
                    "foreign_keys": foreign_keys,
                    "editable": bool(primary_key),
                }
            )
    return tables


def apply_connection(config: dict[str, Any]) -> dict[str, Any]:
    conn = None
    try:
        conn = open_connection(config)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT current_database(),
                       current_user,
                       current_setting('server_version')
                """
            )
            dbname, db_user, version = cur.fetchone()
        tables = introspect_tables(conn)
    except Exception as exc:  # noqa: BLE001 — текст нужен пользователю
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        raise ApiError("Не удалось подключиться: " + db_error_text(exc)) from exc

    with DB["lock"]:
        old = DB["conn"]
        DB["conn"] = conn
        DB["connected"] = True
        DB["database"] = dbname
        DB["db_user"] = db_user
        DB["version"] = version
        DB["tables"] = tables
        DB["config"] = normalize_config({**config, "dbname": dbname})
        DB["error"] = ""
    if old is not None and old is not conn:
        try:
            old.close()
        except Exception:
            pass
    return DB


def ensure_db():
    with DB["lock"]:
        conn = DB["conn"]
        if conn is not None and getattr(conn, "closed", 1) == 0:
            return conn
        config = dict(DB["config"])
    if not config.get("host") or not config.get("dbname") or not config.get("user"):
        raise ApiError(
            "Нет подключения к базе данных. Укажите сервер, базу и пользователя.", 503
        )
    try:
        apply_connection(config)
    except ApiError as exc:
        with DB["lock"]:
            DB["connected"] = False
            DB["error"] = exc.message
        raise ApiError(exc.message, 503) from exc
    with DB["lock"]:
        return DB["conn"]


def table_sql(schema_name: str, table_name: str):
    return psql.SQL("{}.{}").format(
        psql.Identifier(schema_name), psql.Identifier(table_name)
    )


def find_table(schema_name: str, table_name: str) -> dict[str, Any]:
    with DB["lock"]:
        tables = list(DB["tables"])
    for table in tables:
        if table.get("schema") == schema_name and table.get("name") == table_name:
            return table
    raise ApiError("Таблица не найдена. Переподключитесь к базе данных.", 404)


def clean_values(
    table: dict[str, Any], values: Any, *, exclude_pk: bool
) -> dict[str, Any]:
    if not isinstance(values, dict):
        raise ApiError("Некорректные данные записи.")
    allowed = {
        column["name"]
        for column in table["columns"]
        if column["form_editable"] and not (exclude_pk and column["is_pk"])
    }
    clean: dict[str, Any] = {}
    for key, value in values.items():
        if key not in allowed:
            continue
        if isinstance(value, (dict, list)):
            raise ApiError(f"Некорректное значение для поля «{key}».")
        clean[key] = value
    return clean


def pk_values(table: dict[str, Any], payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ApiError("Не указан первичный ключ записи.")
    pk_columns = table["primary_key"]
    if not pk_columns:
        raise ApiError("У таблицы нет первичного ключа — редактирование недоступно.")
    result = {}
    for column in pk_columns:
        if column not in payload:
            raise ApiError(f"Не указано значение первичного ключа «{column}».")
        result[column] = payload[column]
    return result


# ---------------------------------------------------------------------------
# Авторизация приложения
# ---------------------------------------------------------------------------


def auth_settings() -> dict[str, Any]:
    return normalize_auth(BUNDLE["project"].get("auth"))


def auth_configured(auth: dict[str, Any] | None = None) -> bool:
    config = auth or auth_settings()
    return bool(
        config["table"] and config["login_column"] and config["password_column"]
    )


def auth_status() -> dict[str, Any]:
    auth = auth_settings()
    user = session.get("user")
    return {
        "enabled": bool(auth["enabled"] and auth_configured(auth)),
        "configured": auth_configured(auth),
        "authenticated": bool(user),
        "user": user,
    }


def require_login() -> None:
    status = auth_status()
    if status["enabled"] and not status["authenticated"]:
        raise ApiError("Войдите в приложение.", 401)


def auth_table() -> tuple[dict[str, Any], dict[str, Any]]:
    auth = auth_settings()
    if not auth_configured(auth):
        raise ApiError("Авторизация приложения не настроена в проекте.")
    table = find_table(auth["schema"], auth["table"])
    column_names = {column["name"] for column in table["columns"]}
    for key, label in (
        ("login_column", "логина"),
        ("password_column", "пароля"),
        ("role_column", "роли"),
    ):
        name = auth[key]
        if name and name not in column_names:
            raise ApiError(f"В таблице авторизации нет колонки {label} «{name}».")
    return auth, table


def hash_password(password: str, mode: str) -> str:
    if mode == "sha256":
        return hashlib.sha256(password.encode("utf-8")).hexdigest()
    return password


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


def public_config() -> dict[str, Any]:
    config = DB["config"]
    return {
        "host": config.get("host") or "localhost",
        "port": config.get("port") or 5432,
        "dbname": config.get("dbname") or "",
        "user": config.get("user") or "",
        "sslmode": config.get("sslmode") or "prefer",
        "has_password": bool(config.get("password")),
    }


@app.after_request
def _no_cache(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/")
def index():
    return render_template("index.html", app_name=BUNDLE["project"].get("name") or "DB2UI")


@app.get("/favicon.ico")
def favicon():
    return "", 204


@app.get("/api/bootstrap")
def api_bootstrap():
    status = auth_status()
    connected = bool(DB.get("connected") and DB.get("conn") is not None)
    return jsonify(
        {
            "connected": connected,
            "database": DB.get("database") or "",
            "server_version": DB.get("version") or "",
            "config": public_config(),
            "project": BUNDLE["project"],
            "tables": DB.get("tables") if connected else BUNDLE["tables"],
            "auth": status,
            "last_error": DB.get("error") or "",
        }
    )


@app.post("/api/connect")
def api_connect():
    data = request.get_json(silent=True) or {}
    host = str(data.get("host") or "").strip()
    dbname = str(data.get("dbname") or "").strip()
    user = str(data.get("user") or "").strip()
    if not host or not dbname or not user:
        raise ApiError("Заполните сервер, базу данных и пользователя.")
    try:
        port = int(data.get("port", 5432))
    except (TypeError, ValueError) as exc:
        raise ApiError("Порт должен быть числом.") from exc
    if not 1 <= port <= 65535:
        raise ApiError("Порт должен быть в диапазоне 1–65535.")

    sslmode = str(data.get("sslmode") or "prefer")
    if sslmode not in SSL_MODES:
        sslmode = "prefer"
    password = str(data.get("password") or "")
    if password == "":
        password = str(DB["config"].get("password") or "")
    remember = data.get("remember", True) is not False

    config = normalize_config(
        {
            "host": host,
            "port": port,
            "dbname": dbname,
            "user": user,
            "password": password,
            "sslmode": sslmode,
        }
    )
    apply_connection(config)
    save_config({**DB["config"], "password": password if remember else ""})
    if not remember:
        DB["config"]["password"] = password
    session.pop("user", None)
    return jsonify(
        {
            "ok": True,
            "connected": True,
            "database": DB["database"],
            "server_version": DB["version"],
            "tables": DB["tables"],
        }
    )


@app.post("/api/disconnect")
def api_disconnect():
    with DB["lock"]:
        conn = DB["conn"]
        DB["conn"] = None
        DB["connected"] = False
        DB["error"] = ""
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    session.pop("user", None)
    return jsonify({"ok": True})


@app.get("/api/auth/status")
def api_auth_status():
    return jsonify(auth_status())


@app.post("/api/auth/login")
def api_auth_login():
    data = request.get_json(silent=True) or {}
    login = str(data.get("login") or "").strip()
    password = str(data.get("password") or "")
    if not login or not password:
        raise ApiError("Введите логин и пароль.")
    if len(login) > 64 or len(password) > 128:
        raise ApiError("Слишком длинный логин или пароль.")

    auth, table = auth_table()
    ensure_db()
    select_parts = [
        psql.SQL("{}::text AS login_value").format(
            psql.Identifier(auth["login_column"])
        ),
        psql.SQL("{}::text AS password_value").format(
            psql.Identifier(auth["password_column"])
        ),
    ]
    if auth["role_column"]:
        select_parts.append(
            psql.SQL("{}::text AS role_value").format(
                psql.Identifier(auth["role_column"])
            )
        )
    query = psql.SQL("SELECT {} FROM {} WHERE {}::text = %s LIMIT 1").format(
        psql.SQL(", ").join(select_parts),
        table_sql(table["schema"], table["name"]),
        psql.Identifier(auth["login_column"]),
    )
    try:
        with DB["lock"]:
            with DB["conn"].cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                cur.execute(query, (login,))
                row = cur.fetchone()
    except psycopg2.Error as exc:
        raise ApiError("Не удалось проверить пользователя: " + db_error_text(exc)) from exc

    stored = None if row is None else row.get("password_value")
    ok = False
    if stored is not None:
        if auth["password_mode"] == "sha256":
            ok = hmac.compare_digest(
                str(stored).strip().lower(),
                hashlib.sha256(password.encode("utf-8")).hexdigest(),
            )
        else:
            ok = hmac.compare_digest(str(stored), password)
    if not ok:
        raise ApiError("Неверный логин или пароль.", 403)

    user = {
        "login": row.get("login_value") or login,
        "role": (row.get("role_value") or "") if auth["role_column"] else "",
    }
    session["user"] = user
    return jsonify({"ok": True, "user": user})


@app.post("/api/auth/register")
def api_auth_register():
    auth, table = auth_table()
    if not auth.get("allow_registration", True):
        raise ApiError(
            "Регистрация новых пользователей отключена в настройках проекта.", 403
        )
    data = request.get_json(silent=True) or {}
    login = str(data.get("login") or "").strip()
    password = str(data.get("password") or "")
    password2 = data.get("password2")
    role = "user"

    if not login:
        raise ApiError("Введите логин.")
    if len(login) < 3:
        raise ApiError("Логин должен содержать не менее 3 символов.")
    if len(login) > 64:
        raise ApiError("Логин не может быть длиннее 64 символов.")
    if not re.match(r"^[A-Za-zА-Яа-яЁё0-9._@-]+$", login):
        raise ApiError("Логин может содержать буквы, цифры и символы . _ @ -")
    if len(password) < 4:
        raise ApiError("Пароль должен содержать не менее 4 символов.")
    if len(password) > 128:
        raise ApiError("Пароль слишком длинный (максимум 128 символов).")
    if password2 is not None and str(password2) != password:
        raise ApiError("Пароли не совпадают.")

    ensure_db()
    login_ident = psql.Identifier(auth["login_column"])
    exists_query = psql.SQL("SELECT 1 FROM {} WHERE {}::text = %s LIMIT 1").format(
        table_sql(table["schema"], table["name"]),
        login_ident,
    )
    columns = [auth["login_column"], auth["password_column"]]
    values = [login, hash_password(password, auth["password_mode"])]
    if auth["role_column"]:
        columns.append(auth["role_column"])
        values.append(role)
    insert_query = psql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        table_sql(table["schema"], table["name"]),
        psql.SQL(", ").join(psql.Identifier(column) for column in columns),
        psql.SQL(", ").join(psql.Placeholder() for _ in columns),
    )
    try:
        with DB["lock"]:
            with DB["conn"].cursor() as cur:
                cur.execute(exists_query, (login,))
                if cur.fetchone():
                    raise ApiError("Пользователь с таким логином уже существует.", 409)
                cur.execute(insert_query, values)
    except ApiError:
        raise
    except psycopg2.Error as exc:
        message = db_error_text(exc)
        if "duplicate" in message.lower() or "unique" in message.lower():
            raise ApiError("Пользователь с таким логином уже существует.", 409) from exc
        raise ApiError("Не удалось зарегистрировать пользователя: " + message) from exc

    user = {"login": login, "role": role if auth["role_column"] else ""}
    session["user"] = user
    return jsonify({"ok": True, "user": user})


@app.post("/api/auth/logout")
def api_auth_logout():
    session.pop("user", None)
    return jsonify({"ok": True})


@app.get("/api/table")
def api_table_rows():
    require_login()
    ensure_db()
    schema_name = str(request.args.get("schema") or "")
    table_name = str(request.args.get("table") or "")
    limit = _clamp_int(request.args.get("limit"), 50, 1, 500)
    table = find_table(schema_name, table_name)
    ident = table_sql(schema_name, table_name)

    try:
        with DB["lock"]:
            with DB["conn"].cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                if table["primary_key"]:
                    order = psql.SQL(", ").join(
                        psql.Identifier(column) for column in table["primary_key"]
                    )
                    query = psql.SQL(
                        "SELECT * FROM {} ORDER BY {} LIMIT %s"
                    ).format(ident, order)
                else:
                    query = psql.SQL("SELECT * FROM {} LIMIT %s").format(ident)
                cur.execute(query, (limit,))
                rows = [
                    {key: json_safe(value) for key, value in dict(row).items()}
                    for row in cur.fetchall()
                ]
    except psycopg2.Error as exc:
        raise ApiError("Не удалось прочитать таблицу: " + db_error_text(exc)) from exc

    return jsonify({"table": table, "rows": rows})


@app.post("/api/table/rows")
def api_row_create():
    require_login()
    ensure_db()
    data = request.get_json(silent=True) or {}
    table = find_table(str(data.get("schema") or ""), str(data.get("table") or ""))
    values = clean_values(table, data.get("values"), exclude_pk=False)
    if not values:
        raise ApiError("Заполните хотя бы одно поле записи.")

    columns = list(values.keys())
    query = psql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING *").format(
        table_sql(table["schema"], table["name"]),
        psql.SQL(", ").join(psql.Identifier(column) for column in columns),
        psql.SQL(", ").join(psql.Placeholder() for _ in columns),
    )
    try:
        with DB["lock"]:
            with DB["conn"].cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                cur.execute(query, [values[column] for column in columns])
                row = dict(cur.fetchone())
    except psycopg2.Error as exc:
        raise ApiError("Не удалось добавить запись: " + db_error_text(exc)) from exc

    return jsonify(
        {"ok": True, "row": {key: json_safe(value) for key, value in row.items()}}
    )


@app.put("/api/table/rows")
def api_row_update():
    require_login()
    ensure_db()
    data = request.get_json(silent=True) or {}
    table = find_table(str(data.get("schema") or ""), str(data.get("table") or ""))
    pk = pk_values(table, data.get("pk"))
    values = clean_values(table, data.get("values"), exclude_pk=True)
    if not values:
        raise ApiError("Нет полей для изменения.")

    columns = list(values.keys())
    query = psql.SQL("UPDATE {} SET {} WHERE {} RETURNING *").format(
        table_sql(table["schema"], table["name"]),
        psql.SQL(", ").join(
            psql.SQL("{} = %s").format(psql.Identifier(column))
            for column in columns
        ),
        psql.SQL(" AND ").join(
            psql.SQL("{} = %s").format(psql.Identifier(column))
            for column in table["primary_key"]
        ),
    )
    params = [values[column] for column in columns] + [
        pk[column] for column in table["primary_key"]
    ]
    try:
        with DB["lock"]:
            with DB["conn"].cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                cur.execute(query, params)
                found = cur.fetchone()
    except psycopg2.Error as exc:
        raise ApiError("Не удалось сохранить запись: " + db_error_text(exc)) from exc

    if not found:
        raise ApiError("Запись не найдена — возможно, её уже удалили.", 404)
    return jsonify(
        {
            "ok": True,
            "row": {key: json_safe(value) for key, value in dict(found).items()},
        }
    )


@app.delete("/api/table/rows")
def api_row_delete():
    require_login()
    ensure_db()
    data = request.get_json(silent=True) or {}
    table = find_table(str(data.get("schema") or ""), str(data.get("table") or ""))
    pk = pk_values(table, data.get("pk"))
    query = psql.SQL("DELETE FROM {} WHERE {}").format(
        table_sql(table["schema"], table["name"]),
        psql.SQL(" AND ").join(
            psql.SQL("{} = %s").format(psql.Identifier(column))
            for column in table["primary_key"]
        ),
    )
    params = [pk[column] for column in table["primary_key"]]
    try:
        with DB["lock"]:
            with DB["conn"].cursor() as cur:
                cur.execute(query, params)
                deleted = cur.rowcount
    except psycopg2.Error as exc:
        raise ApiError("Не удалось удалить запись: " + db_error_text(exc)) from exc

    if not deleted:
        raise ApiError("Запись не найдена — возможно, её уже удалили.", 404)
    return jsonify({"ok": True})


@app.post("/api/sql/query")
def api_sql_query():
    require_login()
    ensure_db()
    data = request.get_json(silent=True) or {}
    limit = _clamp_int(data.get("limit"), 100, 1, 500)
    source = str(data.get("sql") or "").strip()
    if not source:
        raise ApiError("Введите SQL-запрос.")
    if len(source) > 20000:
        raise ApiError("SQL-запрос слишком длинный (максимум 20 000 символов).")
    query_text = source.rstrip()
    while query_text.endswith(";"):
        query_text = query_text[:-1].rstrip()
    if not query_text:
        raise ApiError("Введите SQL-запрос.")
    if ";" in query_text:
        raise ApiError("Разрешён только один SQL-запрос без точки с запятой.")
    if not re.match(r"(?is)^\s*(select|with)\b", query_text):
        raise ApiError("Разрешены только читающие запросы SELECT или WITH.")

    wrapped = "SELECT * FROM (" + query_text + ") AS db2ui_sql LIMIT %s"
    try:
        with DB["lock"]:
            with DB["conn"].cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                try:
                    cur.execute("BEGIN READ ONLY")
                    cur.execute("SET LOCAL statement_timeout = 5000")
                    cur.execute(wrapped, (limit,))
                    fetched = cur.fetchall()
                    columns = [desc[0] for desc in (cur.description or [])]
                finally:
                    try:
                        cur.execute("ROLLBACK")
                    except psycopg2.Error:
                        pass
    except psycopg2.Error as exc:
        raise ApiError("Ошибка SQL-запроса: " + db_error_text(exc)) from exc

    rows = [
        {key: json_safe(value) for key, value in dict(row).items()} for row in fetched
    ]
    return jsonify(
        {
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "limit": limit,
            "truncated": len(rows) >= limit,
        }
    )


# ---------------------------------------------------------------------------
# Запуск
# ---------------------------------------------------------------------------


def _find_port(start: int) -> int:
    for port in range(start, start + 25):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start


def _try_autoconnect() -> None:
    config = DB["config"]
    if not config.get("host") or not config.get("dbname") or not config.get("user"):
        return
    try:
        apply_connection(config)
        print(
            f"DB2UI App: подключено к базе «{DB['database']}» "
            f"({len(DB['tables'])} таблиц).",
            flush=True,
        )
    except ApiError as exc:
        DB["error"] = exc.message
        print("DB2UI App: автоподключение не удалось — " + exc.message, flush=True)


def main() -> None:
    requested = os.environ.get("DB2UI_PORT", "").strip()
    try:
        start = int(requested) if requested else 8765
    except ValueError:
        start = 8765
    port = _find_port(start)
    host = os.environ.get("DB2UI_HOST", "127.0.0.1").strip() or "127.0.0.1"

    _try_autoconnect()
    url = f"http://{host}:{port}/"
    print("=" * 58, flush=True)
    print("  DB2UI App — готовое приложение", flush=True)
    print(f"  Откройте в браузере: {url}", flush=True)
    print("  Остановить: закройте это окно или нажмите Ctrl+C", flush=True)
    print("=" * 58, flush=True)

    if os.environ.get("DB2UI_NO_BROWSER") != "1":
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    try:
        app.run(host=host, port=port, debug=False, threaded=True, use_reloader=False)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print("\nНе удалось запустить приложение:", exc, flush=True)
        if os.name == "nt":
            try:
                input("Нажмите Enter, чтобы закрыть окно...")
            except EOFError:
                pass
        sys.exit(1)
