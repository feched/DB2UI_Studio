"""DB2UI Studio — no-code конструктор интерфейсов для PostgreSQL.

Приложение позволяет:
  * подключиться к любой базе PostgreSQL;
  * увидеть все её таблицы;
  * перетаскивать элементы (текст, кнопки, поля, таблицы, панели,
    SQL-запросы) на холст;
  * создавать несколько форм, настраивать свойства и переходы между ними;
  * просматривать и редактировать данные таблиц в режиме предпросмотра.

Запуск:  python app.py   (или run.bat)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sys
import threading
import uuid
import webbrowser
from datetime import date, datetime, time, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import quote

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, session
from psycopg2 import sql

# ---------------------------------------------------------------------------
# 1. НАСТРОЙКИ
# ---------------------------------------------------------------------------

def _resource_dir() -> Path:
    """Папка с шаблонами и статикой (в exe — временная папка PyInstaller)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parent


def _data_dir() -> Path:
    """Папка для проектов и настроек, доступная на запись."""
    override = os.getenv("DB2UI_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if getattr(sys, "frozen", False):
        root = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(root) / "DB2UI Studio"
    return BASE_DIR


BASE_DIR = _resource_dir()
DATA_DIR = _data_dir()
DATA_DIR.mkdir(parents=True, exist_ok=True)
load_dotenv(DATA_DIR / ".env")
load_dotenv(BASE_DIR / ".env")

PROJECTS_DIR = DATA_DIR / "projects"
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# Значения только предзаполняют форму подключения.
DEFAULT_DB: dict[str, Any] = {
    "host": os.getenv("PGHOST", "localhost"),
    "port": _env_int("PGPORT", 5432),
    "dbname": os.getenv("PGDATABASE", "postgres"),
    "user": os.getenv("PGUSER", "postgres"),
    "password": os.getenv("PGPASSWORD", "postgres"),
}

def _secret_key() -> str:
    """Постоянный ключ сессий, чтобы вход не слетал после перезапуска."""
    env_value = os.getenv("DB2UI_SECRET")
    if env_value:
        return env_value
    path = DATA_DIR / "secret.key"
    try:
        value = path.read_text(encoding="utf-8").strip()
        if value:
            return value
    except OSError:
        pass
    value = secrets.token_hex(32)
    try:
        path.write_text(value, encoding="utf-8")
    except OSError:
        pass
    return value


app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
)
app.secret_key = _secret_key()
app.config.update(
    JSON_AS_ASCII=False,
    # Изображения хранятся в проекте как data URL, поэтому лимит больше обычного.
    MAX_CONTENT_LENGTH=24 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)

# Серверные сессии: в cookie лежит только случайный идентификатор,
# пароль и подключение остаются в памяти процесса.
SESSIONS: dict[str, dict[str, Any]] = {}
SESSIONS_LOCK = threading.RLock()


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def _handle_api_error(exc: ApiError):
    return jsonify({"error": exc.message}), exc.status


# ---------------------------------------------------------------------------
# 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
# ---------------------------------------------------------------------------


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
    """Привести значение из PostgreSQL к виду, понятному JSON/JS."""
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


def require_state() -> dict[str, Any]:
    sid = session.get("sid")
    state = SESSIONS.get(sid) if sid else None
    if not state:
        raise ApiError(
            "Подключение не найдено или сервер был перезапущен. "
            "Подключитесь к базе заново.",
            401,
        )
    return state


def safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("._")
    return (cleaned or "db")[:48]


def project_file_path(params: dict[str, Any]) -> Path:
    key = f"{params['host']}|{params['port']}|{params['dbname']}"
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
    return PROJECTS_DIR / f"{safe_filename(params['dbname'])}_{digest}.json"


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

SETTINGS_DEFAULT: dict[str, Any] = {
    "grid": 8,
    "snap": True,
    "show_grid": True,
}

MAX_PROJECT_FORMS = 200


def _clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def _text(value: Any, limit: int = 120) -> str:
    return str(value if value is not None else "")[:limit]


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


def normalize_settings(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    return {
        "grid": _clamp_int(source.get("grid"), 8, 2, 64),
        "snap": bool(source.get("snap", True)),
        "show_grid": bool(source.get("show_grid", True)),
    }


def normalize_layout(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    mode = "grid" if source.get("mode") == "grid" else "free"
    return {
        "mode": mode,
        "cols": _clamp_int(source.get("cols"), 4, 1, 24),
        "rows": _clamp_int(source.get("rows"), 6, 1, 60),
        "gap": _clamp_int(source.get("gap"), 12, 0, 80),
    }


def normalize_db_layout(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    result: dict[str, Any] = {}
    for key, value in list(source.items())[:2000]:
        if not isinstance(value, dict):
            continue
        name = _text(key, 200)
        if not name or "." not in name:
            continue
        result[name] = {
            "x": _clamp_int(value.get("x"), 24, 0, 20000),
            "y": _clamp_int(value.get("y"), 24, 0, 20000),
        }
    return result


def normalize_project(
    project: Any,
    dbname: str,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source = project if isinstance(project, dict) else {}
    raw_forms = source.get("forms")
    forms: list[dict[str, Any]] = []
    if isinstance(raw_forms, list):
        for form in raw_forms[:MAX_PROJECT_FORMS]:
            if not isinstance(form, dict):
                continue
            elements = form.get("elements")
            forms.append(
                {
                    "id": _text(form.get("id") or ("form_" + uuid.uuid4().hex[:10]), 80),
                    "name": _text(form.get("name") or "Форма", 120) or "Форма",
                    "width": _clamp_int(form.get("width"), 1180, 320, 4000),
                    "height": _clamp_int(form.get("height"), 900, 240, 4000),
                    "background": _text(form.get("background") or "#ffffff", 32),
                    "layout": normalize_layout(form.get("layout")),
                    "elements": [
                        element
                        for element in (elements if isinstance(elements, list) else [])
                        if isinstance(element, dict)
                        and element.get("type") != "subform"
                    ],
                }
            )

    if not forms:
        form_id = "form_" + uuid.uuid4().hex[:10]
        forms = [
            {
                "id": form_id,
                "name": "Главная",
                "width": 1180,
                "height": 900,
                "background": "#ffffff",
                "elements": [],
            }
        ]

    ids = {form["id"] for form in forms}
    start_form = source.get("start_form")
    if start_form not in ids:
        start_form = forms[0]["id"]

    result: dict[str, Any] = {
        "version": 2,
        "name": _text(source.get("name") or dbname or "Проект", 120) or "Проект",
        "start_form": start_form,
        "forms": forms,
        "auth": normalize_auth(source.get("auth")),
        "settings": normalize_settings(source.get("settings")),
        "db_layout": normalize_db_layout(source.get("db_layout")),
    }
    if meta:
        result["meta"] = meta
    elif isinstance(source.get("meta"), dict):
        result["meta"] = {
            "database": _text(source["meta"].get("database"), 120),
            "host": _text(source["meta"].get("host"), 200),
            "port": _clamp_int(source["meta"].get("port"), 5432, 1, 65535),
        }
    return result


def new_project(dbname: str) -> dict[str, Any]:
    return normalize_project({}, dbname)


def save_project_file(path: Path, project: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(project, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(tmp, path)


def load_project_file(path: Path, dbname: str) -> dict[str, Any]:
    if not path.exists():
        project = new_project(dbname)
        save_project_file(path, project)
        return project

    try:
        project = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(project, dict):
            raise ValueError("project must be an object")
        forms = project.get("forms")
        if not isinstance(forms, list) or not forms:
            raise ValueError("project must contain forms")
        return normalize_project(project, dbname)
    except Exception:
        broken = path.with_suffix(".broken.json")
        try:
            path.replace(broken)
        except OSError:
            pass
        project = new_project(dbname)
        save_project_file(path, project)
        return project


# ---------------------------------------------------------------------------
# 3. ИНТРОСПЕКЦИЯ POSTGRESQL
# ---------------------------------------------------------------------------


def introspect_tables(conn: psycopg2.extensions.connection) -> list[dict[str, Any]]:
    """Получить таблицы и колонки всех пользовательских схем."""
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


def find_table(
    state: dict[str, Any], schema_name: str, table_name: str
) -> dict[str, Any]:
    for table in state["tables"]:
        if table["schema"] == schema_name and table["name"] == table_name:
            return table
    raise ApiError("Таблица не найдена. Обновите список таблиц.", 404)


def table_sql(schema_name: str, table_name: str) -> sql.Composed:
    return sql.SQL("{}.{}").format(
        sql.Identifier(schema_name), sql.Identifier(table_name)
    )


def clean_values(
    table: dict[str, Any],
    values: Any,
    *,
    exclude_pk: bool,
) -> dict[str, Any]:
    if not isinstance(values, dict):
        raise ApiError("Некорректные данные записи.")

    allowed = {
        column["name"]
        for column in table["columns"]
        if column["form_editable"]
        and not (exclude_pk and column["is_pk"])
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


def open_connection(params: dict[str, Any]) -> psycopg2.extensions.connection:
    conn = psycopg2.connect(
        host=params["host"],
        port=params["port"],
        dbname=params["dbname"],
        user=params["user"],
        password=params.get("password", ""),
        connect_timeout=5,
        application_name="db2ui_studio",
    )
    conn.autocommit = True
    return conn


def auth_status(state: dict[str, Any]) -> dict[str, Any]:
    auth = normalize_auth(state["project"].get("auth"))
    configured = bool(auth["table"] and auth["login_column"] and auth["password_column"])
    user = state.get("auth_user")
    return {
        "enabled": bool(auth["enabled"] and configured),
        "configured": configured,
        "authenticated": bool(user),
        "user": user,
    }


def session_payload(state: dict[str, Any]) -> dict[str, Any]:
    params = state["params"]
    return {
        "ok": True,
        "database": state["dbname"],
        "user": state["user"],
        "version": state["version"],
        "host": params["host"],
        "port": params["port"],
        "tables": state["tables"],
        "project": state["project"],
        "auth": auth_status(state),
    }


def storage_meta(params: dict[str, Any]) -> dict[str, Any]:
    return {
        "database": _text(params.get("dbname"), 120),
        "host": _text(params.get("host"), 200),
        "port": _clamp_int(params.get("port"), 5432, 1, 65535),
    }


def project_path_by_name(filename: str) -> Path:
    name = Path(str(filename or "")).name
    if not name or not name.endswith(".json") or name.endswith(".broken.json"):
        raise ApiError("Некорректное имя файла проекта.", 400)
    path = PROJECTS_DIR / name
    if path.parent.resolve() != PROJECTS_DIR.resolve():
        raise ApiError("Некорректное имя файла проекта.", 400)
    return path


def project_summary(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        stat = path.stat()
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    forms = data.get("forms") if isinstance(data.get("forms"), list) else []
    return {
        "file": path.name,
        "name": _text(data.get("name") or path.stem, 120),
        "database": _text(meta.get("database"), 120),
        "host": _text(meta.get("host"), 200),
        "port": _clamp_int(meta.get("port"), 5432, 1, 65535),
        "forms": len(forms),
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
    }


# ---- Описание таблиц для визуального редактора ----------------------------

COLUMN_TYPE_RE = re.compile(
    r"^(?:serial|bigserial|smallint|integer|bigint|"
    r"numeric(?:\(\d{1,2},\d{1,2}\))?|float4|float8|"
    r"boolean|text|varchar\(\d{1,4}\)|char\(\d{1,4}\)|"
    r"date|time|timetz|timestamp|timestamptz|uuid|json|jsonb)$"
)

DEFAULT_EXPRESSIONS = {
    "now()",
    "current_date",
    "current_time",
    "current_timestamp",
    "true",
    "false",
    "0",
    "1",
    "''",
    "gen_random_uuid()",
}

ON_DELETE_ACTIONS = {"NO ACTION", "CASCADE", "SET NULL", "SET DEFAULT", "RESTRICT"}


def clean_identifier(value: Any, label: str) -> str:
    name = str(value or "").strip()
    if not name:
        raise ApiError(f"Укажите {label}.")
    if len(name) > 63:
        raise ApiError(f"{label.capitalize()} не может быть длиннее 63 символов.")
    if any(ch in name for ch in ("\x00", "\n", "\r")):
        raise ApiError(f"{label.capitalize()} содержит недопустимые символы.")
    return name


def column_type_sql(value: Any) -> str:
    data_type = str(value or "text").strip().lower()
    if "(" in data_type:
        data_type = re.sub(r"\s+", "", data_type)
    if not COLUMN_TYPE_RE.match(data_type):
        raise ApiError(
            "Неподдерживаемый тип колонки. Выберите тип из списка.",
            400,
        )
    return data_type


def default_sql(value: Any):
    expression = str(value or "").strip()
    if not expression:
        return None
    if expression not in DEFAULT_EXPRESSIONS:
        raise ApiError("Недопустимое значение по умолчанию. Выберите из списка.")
    return sql.SQL(expression)


def column_sql(spec: dict[str, Any], *, force_not_null: bool = False):
    name = clean_identifier(spec.get("name"), "имя колонки")
    data_type = column_type_sql(spec.get("type"))
    piece = sql.SQL("{} {}").format(sql.Identifier(name), sql.SQL(data_type))
    if force_not_null or spec.get("nullable") is False:
        piece = piece + sql.SQL(" NOT NULL")
    if spec.get("unique"):
        piece = piece + sql.SQL(" UNIQUE")
    default = default_sql(spec.get("default"))
    if default is not None and not data_type.startswith(("serial", "bigserial")):
        piece = piece + sql.SQL(" DEFAULT ") + default
    return piece, name, data_type


def on_delete_sql(value: Any):
    action = str(value or "NO ACTION").strip().upper()
    if action not in ON_DELETE_ACTIONS:
        action = "NO ACTION"
    return sql.SQL(" ON DELETE " + action)


def normalize_column_specs(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise ApiError("Добавьте хотя бы одну колонку.")
    specs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = clean_identifier(item.get("name"), "имя колонки")
        if name.lower() in seen:
            raise ApiError(f"Колонка «{name}» указана дважды.")
        seen.add(name.lower())
        specs.append(
            {
                "name": name,
                "type": column_type_sql(item.get("type")),
                "nullable": bool(item.get("nullable", True)),
                "primary_key": bool(item.get("primary_key")),
                "unique": bool(item.get("unique")),
                "default": item.get("default") or "",
            }
        )
    if not specs:
        raise ApiError("Добавьте хотя бы одну колонку.")
    return specs


# ---------------------------------------------------------------------------
# 4. API: ПОДКЛЮЧЕНИЕ И ПРОЕКТ
# ---------------------------------------------------------------------------


@app.get("/")
def index():
    return render_template("index.html", defaults=DEFAULT_DB)


@app.post("/api/connect")
def api_connect():
    data = request.get_json(silent=True) or {}

    host = str(data.get("host", "")).strip()
    dbname = str(data.get("dbname", "")).strip()
    user = str(data.get("user", "")).strip()
    password = str(data.get("password", ""))
    try:
        port = int(data.get("port", 5432))
    except (TypeError, ValueError):
        raise ApiError("Порт должен быть числом.")

    if not host or not dbname or not user:
        raise ApiError("Заполните сервер, базу данных и пользователя.")
    if not 1 <= port <= 65535:
        raise ApiError("Порт должен быть в диапазоне 1–65535.")

    params = {
        "host": host,
        "port": port,
        "dbname": dbname,
        "user": user,
        "password": password,
    }

    try:
        conn = open_connection(params)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT current_database(),
                       current_user,
                       current_setting('server_version')
                """
            )
            dbname_actual, user_actual, version = cur.fetchone()
        params["dbname"] = dbname_actual
        tables = introspect_tables(conn)
    except Exception as exc:  # noqa: BLE001 — текст ошибки нужен пользователю
        try:
            conn.close()  # type: ignore[possibly-undefined]
        except Exception:
            pass
        raise ApiError(f"Не удалось подключиться: {db_error_text(exc)}")

    sid = session.get("sid") or secrets.token_urlsafe(24)
    with SESSIONS_LOCK:
        old_state = SESSIONS.pop(sid, None)
        if old_state:
            try:
                old_state["conn"].close()
            except Exception:
                pass

        path = project_file_path(params)
        project = load_project_file(path, dbname_actual)
        project["meta"] = storage_meta(params)
        try:
            save_project_file(path, project)
        except OSError:
            pass
        SESSIONS[sid] = {
            "conn": conn,
            "lock": threading.RLock(),
            "params": params,
            "tables": tables,
            "project": project,
            "project_path": path,
            "dbname": dbname_actual,
            "user": user_actual,
            "version": version,
            "auth_user": None,
        }

    session["sid"] = sid
    return jsonify(session_payload(SESSIONS[sid]))


@app.get("/api/state")
def api_state():
    state = SESSIONS.get(session.get("sid", ""))
    if not state:
        return jsonify({"connected": False})
    payload = session_payload(state)
    payload["connected"] = True
    return jsonify(payload)


@app.post("/api/disconnect")
def api_disconnect():
    sid = session.pop("sid", None)
    if sid:
        with SESSIONS_LOCK:
            state = SESSIONS.pop(sid, None)
        if state:
            try:
                state["conn"].close()
            except Exception:
                pass
    return jsonify({"ok": True})


@app.post("/api/schema/refresh")
def api_schema_refresh():
    state = require_state()
    try:
        with state["lock"]:
            tables = introspect_tables(state["conn"])
    except Exception as exc:  # noqa: BLE001
        raise ApiError(f"Не удалось обновить список таблиц: {db_error_text(exc)}")
    state["tables"] = tables
    return jsonify({"ok": True, "tables": tables})


@app.get("/api/project")
def api_project_get():
    state = require_state()
    return jsonify({"project": state["project"]})


@app.put("/api/project")
def api_project_put():
    state = require_state()
    project = request.get_json(silent=True)
    if not isinstance(project, dict):
        raise ApiError("Некорректный проект.")
    forms = project.get("forms")
    if not isinstance(forms, list) or not forms:
        raise ApiError("В проекте должна быть хотя бы одна форма.")

    cleaned = normalize_project(
        project,
        state["dbname"],
        meta=storage_meta(state["params"]),
    )

    try:
        save_project_file(state["project_path"], cleaned)
    except OSError as exc:
        raise ApiError(f"Не удалось сохранить проект: {exc}", 500)

    state["project"] = cleaned
    return jsonify({"ok": True})


@app.get("/api/project/export")
def api_project_export():
    state = require_state()
    params = state["params"]
    payload = {
        "format": "db2ui.project",
        "format_version": 2,
        "exported_at": datetime.now(tz=timezone.utc).isoformat(),
        "database": state["dbname"],
        "host": params["host"],
        "port": params["port"],
        "project": state["project"],
    }
    filename = safe_filename(state["project"].get("name") or state["dbname"])
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    response = Response(body, mimetype="application/json")
    response.headers["Content-Disposition"] = (
        "attachment; filename=\""
        + filename
        + ".db2ui.json\"; filename*=UTF-8''"
        + quote(filename + ".db2ui.json")
    )
    return response


@app.post("/api/project/import")
def api_project_import():
    state = require_state()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Файл проекта пуст или имеет неверный формат.")
    project = data.get("project") if isinstance(data.get("project"), dict) else data
    forms = project.get("forms")
    if not isinstance(forms, list) or not forms:
        raise ApiError("В файле проекта нет форм.")
    cleaned = normalize_project(
        project,
        state["dbname"],
        meta=storage_meta(state["params"]),
    )
    try:
        save_project_file(state["project_path"], cleaned)
    except OSError as exc:
        raise ApiError(f"Не удалось сохранить проект: {exc}", 500)
    state["project"] = cleaned
    state["auth_user"] = None
    return jsonify({"ok": True, "project": cleaned})


@app.get("/api/preview/export")
def api_preview_export():
    """Автономный HTML-файл: проект, стили и снимок данных внутри."""
    state = require_state()
    project = state["project"]
    tables = state["tables"]

    rows: dict[str, list[dict[str, Any]]] = {}
    for table in tables[:80]:
        ref = f"{table['schema']}|{table['name']}"
        try:
            with state["lock"]:
                with state["conn"].cursor(
                    cursor_factory=psycopg2.extras.RealDictCursor
                ) as cur:
                    cur.execute(
                        sql.SQL("SELECT * FROM {} LIMIT 100").format(
                            table_sql(table["schema"], table["name"])
                        )
                    )
                    rows[ref] = [
                        {key: json_safe(value) for key, value in row.items()}
                        for row in cur.fetchall()
                    ]
        except psycopg2.Error:
            rows[ref] = []

    auth_users: list[dict[str, Any]] = []
    auth = normalize_auth(project.get("auth"))
    if auth["table"] and auth["login_column"] and auth["password_column"]:
        try:
            role_sql = (
                sql.SQL("{}::text").format(sql.Identifier(auth["role_column"]))
                if auth["role_column"]
                else sql.SQL("''")
            )
            with state["lock"]:
                with state["conn"].cursor(
                    cursor_factory=psycopg2.extras.RealDictCursor
                ) as cur:
                    cur.execute(
                        sql.SQL(
                            "SELECT {}::text AS login, {} AS role, {}::text AS secret "
                            "FROM {} LIMIT 500"
                        ).format(
                            sql.Identifier(auth["login_column"]),
                            role_sql,
                            sql.Identifier(auth["password_column"]),
                            table_sql(auth["schema"], auth["table"]),
                        )
                    )
                    auth_users = [
                        {
                            "login": str(row["login"]),
                            "role": str(row["role"] or ""),
                            "secret": str(row["secret"] or ""),
                            "mode": auth["password_mode"],
                        }
                        for row in cur.fetchall()
                    ]
        except psycopg2.Error:
            auth_users = []

    sql_results: dict[str, dict[str, Any]] = {}
    for form in project.get("forms", []):
        if not isinstance(form, dict):
            continue
        for element in form.get("elements", []):
            if not isinstance(element, dict) or element.get("type") != "sql":
                continue
            element_id = _text(element.get("id"), 80)
            if not element_id:
                continue
            try:
                sql_results[element_id] = run_readonly_query(
                    state,
                    element.get("query"),
                    _clamp_int(element.get("limit"), 100, 1, 500),
                )
            except ApiError as exc:
                sql_results[element_id] = {
                    "columns": [],
                    "rows": [],
                    "row_count": 0,
                    "error": str(exc),
                }

    from standalone import build_preview_html

    body = build_preview_html(
        project, tables, rows, auth_users, state["dbname"], sql_results
    )
    filename = safe_filename(project.get("name") or state["dbname"])
    ascii_name = filename.encode("ascii", "ignore").decode("ascii").strip() or "project"
    response = Response(body, mimetype="text/html")
    response.headers["Content-Disposition"] = (
        "attachment; filename=\""
        + ascii_name
        + ".preview.html\"; filename*=UTF-8''"
        + quote(filename + ".preview.html")
    )
    return response


@app.get("/api/app/export")
def api_app_export():
    """ZIP с полноценным приложением: сервер, интерфейс и живые данные."""
    state = require_state()
    project = state["project"]
    params = state.get("params") or {}

    from portable import app_zip_ascii_filename, app_zip_filename, build_app_zip

    try:
        payload = build_app_zip(
            project,
            state["tables"],
            {
                "host": params.get("host") or "",
                "port": params.get("port") or 5432,
                "dbname": state.get("dbname") or params.get("dbname") or "",
                "user": state.get("user") or params.get("user") or "",
                "sslmode": params.get("sslmode") or "prefer",
            },
        )
    except RuntimeError as exc:
        raise ApiError(str(exc), 500)

    filename = app_zip_filename(project.get("name") or state["dbname"])
    ascii_name = app_zip_ascii_filename(project.get("name") or state["dbname"])
    response = Response(payload, mimetype="application/zip")
    response.headers["Content-Disposition"] = (
        "attachment; filename=\""
        + ascii_name
        + "\"; filename*=UTF-8''"
        + quote(filename)
    )
    response.headers["Content-Length"] = str(len(payload))
    return response


@app.get("/api/projects")
def api_projects_list():
    state = require_state()
    items = []
    for path in PROJECTS_DIR.glob("*.json"):
        summary = project_summary(path)
        if not summary:
            continue
        summary["current"] = path == state["project_path"]
        items.append(summary)
    items.sort(key=lambda item: item["modified"], reverse=True)
    return jsonify({"projects": items, "current": state["project_path"].name})


@app.post("/api/projects/open")
def api_projects_open():
    state = require_state()
    data = request.get_json(silent=True) or {}
    path = project_path_by_name(str(data.get("file") or ""))
    if not path.exists():
        raise ApiError("Файл проекта не найден.", 404)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        raise ApiError("Не удалось прочитать файл проекта.", 400)
    if not isinstance(raw, dict) or not isinstance(raw.get("forms"), list):
        raise ApiError("Файл не похож на проект DB2UI.", 400)
    project = normalize_project(raw, state["dbname"])
    project["meta"] = storage_meta(state["params"])
    try:
        save_project_file(path, project)
    except OSError as exc:
        raise ApiError(f"Не удалось сохранить проект: {exc}", 500)
    state["project"] = project
    state["project_path"] = path
    state["auth_user"] = None
    return jsonify({"ok": True, "project": project})


@app.post("/api/projects/delete")
def api_projects_delete():
    state = require_state()
    data = request.get_json(silent=True) or {}
    path = project_path_by_name(str(data.get("file") or ""))
    if path == state["project_path"]:
        raise ApiError("Нельзя удалить открытый сейчас проект.")
    if not path.exists():
        raise ApiError("Файл проекта не найден.", 404)
    try:
        path.unlink()
    except OSError as exc:
        raise ApiError(f"Не удалось удалить проект: {exc}", 500)
    return jsonify({"ok": True})


@app.get("/api/projects/download")
def api_projects_download():
    state = require_state()
    path = project_path_by_name(str(request.args.get("file") or ""))
    if not path.exists():
        raise ApiError("Файл проекта не найден.", 404)
    try:
        body = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ApiError(f"Не удалось прочитать проект: {exc}", 500)
    response = Response(body, mimetype="application/json")
    name = path.name
    response.headers["Content-Disposition"] = (
        "attachment; filename=\""
        + name
        + "\"; filename*=UTF-8''"
        + quote(name)
    )
    return response


@app.post("/api/projects/save-as")
def api_projects_save_as():
    state = require_state()
    data = request.get_json(silent=True) or {}
    name = _text(data.get("name") or state["project"].get("name"), 120)
    if not name.strip():
        raise ApiError("Укажите название проекта.")
    state["project"]["name"] = name.strip()
    state["project"]["meta"] = storage_meta(state["params"])
    base = state["project_path"]
    stem = base.stem
    digest = state["params"]
    key = f"{digest['host']}|{digest['port']}|{digest['dbname']}"
    hash_part = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
    db_part = safe_filename(digest["dbname"])
    slug = safe_filename(name) or "project"
    path = PROJECTS_DIR / f"{db_part}_{hash_part}__{slug}.json"
    try:
        save_project_file(path, state["project"])
    except OSError as exc:
        raise ApiError(f"Не удалось сохранить проект: {exc}", 500)
    state["project_path"] = path
    return jsonify({"ok": True, "file": path.name, "project": state["project"]})


@app.post("/api/projects/new")
def api_projects_new():
    state = require_state()
    project = new_project(state["dbname"])
    project["meta"] = storage_meta(state["params"])
    try:
        save_project_file(state["project_path"], project)
    except OSError as exc:
        raise ApiError(f"Не удалось создать проект: {exc}", 500)
    state["project"] = project
    state["auth_user"] = None
    return jsonify({"ok": True, "project": project})


# ---------------------------------------------------------------------------
# 5. API: РЕДАКТОР ТАБЛИЦ, СВЯЗЕЙ И БАЗ ДАННЫХ
# ---------------------------------------------------------------------------


def refresh_state_tables(state: dict[str, Any]) -> list[dict[str, Any]]:
    with state["lock"]:
        tables = introspect_tables(state["conn"])
    state["tables"] = tables
    return tables


def maintenance_connection(state: dict[str, Any]) -> psycopg2.extensions.connection:
    params = dict(state["params"])
    params["dbname"] = "postgres"
    try:
        return open_connection(params)
    except Exception:
        if state["dbname"] != "postgres":
            return open_connection(params)
        raise


@app.get("/api/databases")
def api_databases_list():
    state = require_state()
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(
                    """
                    SELECT datname
                    FROM pg_database
                    WHERE datistemplate = false
                    ORDER BY datname
                    """
                )
                names = [row[0] for row in cur.fetchall()]
    except psycopg2.Error as exc:
        raise ApiError(f"Не удалось прочитать список баз: {db_error_text(exc)}")
    return jsonify(
        {
            "databases": names,
            "current": state["dbname"],
            "can_create": True,
        }
    )


@app.post("/api/database/create")
def api_database_create():
    state = require_state()
    data = request.get_json(silent=True) or {}
    name = clean_identifier(data.get("name"), "имя базы данных")
    try:
        conn = maintenance_connection(state)
    except Exception as exc:  # noqa: BLE001
        raise ApiError(
            "Не удалось открыть служебную базу postgres: " + db_error_text(exc)
        )
    try:
        with conn.cursor() as cur:
            cur.execute(
                sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name))
            )
    except psycopg2.Error as exc:
        raise ApiError("Не удалось создать базу данных: " + db_error_text(exc))
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return jsonify({"ok": True, "name": name})


@app.post("/api/database/open")
def api_database_open():
    state = require_state()
    data = request.get_json(silent=True) or {}
    name = clean_identifier(data.get("name"), "имя базы данных")
    params = dict(state["params"])
    params["dbname"] = name
    try:
        conn = open_connection(params)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT current_database(),
                       current_user,
                       current_setting('server_version')
                """
            )
            dbname_actual, user_actual, version = cur.fetchone()
        tables = introspect_tables(conn)
        path = project_file_path(params)
        project = load_project_file(path, dbname_actual)
        project["meta"] = storage_meta(params)
        save_project_file(path, project)
    except Exception as exc:  # noqa: BLE001
        try:
            conn.close()
        except Exception:
            pass
        raise ApiError("Не удалось открыть базу данных: " + db_error_text(exc))

    with SESSIONS_LOCK:
        old_conn = state["conn"]
        state.update(
            {
                "conn": conn,
                "params": params,
                "tables": tables,
                "project": project,
                "project_path": path,
                "dbname": dbname_actual,
                "user": user_actual,
                "version": version,
                "auth_user": None,
            }
        )
    try:
        old_conn.close()
    except Exception:
        pass
    return jsonify(session_payload(state))


@app.post("/api/db/schemas")
def api_schema_create():
    state = require_state()
    data = request.get_json(silent=True) or {}
    name = clean_identifier(data.get("name"), "имя схемы")
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(
                    sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(name))
                )
    except psycopg2.Error as exc:
        raise ApiError("Не удалось создать схему: " + db_error_text(exc))
    tables = refresh_state_tables(state)
    return jsonify({"ok": True, "tables": tables})


@app.post("/api/db/tables")
def api_table_create():
    state = require_state()
    data = request.get_json(silent=True) or {}
    schema_name = clean_identifier(data.get("schema") or "public", "имя схемы")
    table_name = clean_identifier(data.get("name"), "имя таблицы")
    specs = normalize_column_specs(data.get("columns"))

    pieces = []
    pk_columns = []
    for spec in specs:
        piece, name, data_type = column_sql(spec)
        pieces.append(piece)
        if spec.get("primary_key"):
            pk_columns.append(name)
    if pk_columns:
        pieces.append(
            sql.SQL("PRIMARY KEY ({})").format(
                sql.SQL(", ").join(sql.Identifier(name) for name in pk_columns)
            )
        )

    query = sql.SQL("CREATE TABLE {} ({})").format(
        table_sql(schema_name, table_name),
        sql.SQL(", ").join(pieces),
    )
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(query)
    except psycopg2.Error as exc:
        raise ApiError("Не удалось создать таблицу: " + db_error_text(exc))

    tables = refresh_state_tables(state)
    return jsonify({"ok": True, "tables": tables})


@app.post("/api/db/tables/drop")
def api_table_drop():
    state = require_state()
    data = request.get_json(silent=True) or {}
    schema_name = clean_identifier(data.get("schema"), "имя схемы")
    table_name = clean_identifier(data.get("table"), "имя таблицы")
    find_table(state, schema_name, table_name)
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(
                    sql.SQL("DROP TABLE {}").format(
                        table_sql(schema_name, table_name)
                    )
                )
    except psycopg2.Error as exc:
        raise ApiError("Не удалось удалить таблицу: " + db_error_text(exc))
    tables = refresh_state_tables(state)
    return jsonify({"ok": True, "tables": tables})


@app.post("/api/db/tables/columns/add")
def api_column_add():
    state = require_state()
    data = request.get_json(silent=True) or {}
    schema_name = clean_identifier(data.get("schema"), "имя схемы")
    table_name = clean_identifier(data.get("table"), "имя таблицы")
    table = find_table(state, schema_name, table_name)
    spec = normalize_column_specs([data.get("column")])[0]
    if any(column["name"].lower() == spec["name"].lower() for column in table["columns"]):
        raise ApiError(f"Колонка «{spec['name']}» уже существует.")
    piece, _, _ = column_sql(spec)
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(
                    sql.SQL("ALTER TABLE {} ADD COLUMN {}").format(
                        table_sql(schema_name, table_name), piece
                    )
                )
    except psycopg2.Error as exc:
        raise ApiError("Не удалось добавить колонку: " + db_error_text(exc))
    tables = refresh_state_tables(state)
    return jsonify({"ok": True, "tables": tables})


@app.post("/api/db/tables/columns/drop")
def api_column_drop():
    state = require_state()
    data = request.get_json(silent=True) or {}
    schema_name = clean_identifier(data.get("schema"), "имя схемы")
    table_name = clean_identifier(data.get("table"), "имя таблицы")
    column_name = clean_identifier(data.get("column"), "имя колонки")
    table = find_table(state, schema_name, table_name)
    if not any(column["name"] == column_name for column in table["columns"]):
        raise ApiError("Колонка не найдена.", 404)
    if len(table["columns"]) <= 1:
        raise ApiError("Нельзя удалить последнюю колонку таблицы.")
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(
                    sql.SQL("ALTER TABLE {} DROP COLUMN {}").format(
                        table_sql(schema_name, table_name),
                        sql.Identifier(column_name),
                    )
                )
    except psycopg2.Error as exc:
        raise ApiError("Не удалось удалить колонку: " + db_error_text(exc))
    tables = refresh_state_tables(state)
    return jsonify({"ok": True, "tables": tables})


@app.post("/api/db/tables/relations/add")
def api_relation_add():
    state = require_state()
    data = request.get_json(silent=True) or {}
    schema_name = clean_identifier(data.get("schema"), "имя схемы")
    table_name = clean_identifier(data.get("table"), "имя таблицы")
    column_name = clean_identifier(data.get("column"), "имя колонки")
    ref_schema = clean_identifier(data.get("ref_schema") or "public", "имя схемы")
    ref_table = clean_identifier(data.get("ref_table"), "имя таблицы")
    ref_column = clean_identifier(data.get("ref_column"), "имя колонки")

    table = find_table(state, schema_name, table_name)
    ref = find_table(state, ref_schema, ref_table)
    if not any(column["name"] == column_name for column in table["columns"]):
        raise ApiError("Колонка-источник не найдена.", 404)
    if not any(column["name"] == ref_column for column in ref["columns"]):
        raise ApiError("Колонка-цель не найдена.", 404)

    constraint = (
        "fk_"
        + re.sub(r"[^a-zA-Z0-9_]+", "_", f"{table_name}_{column_name}_{ref_table}")[:50]
        + "_"
        + uuid.uuid4().hex[:4]
    )
    query = sql.SQL(
        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})"
    ).format(
        table_sql(schema_name, table_name),
        sql.Identifier(constraint),
        sql.Identifier(column_name),
        table_sql(ref_schema, ref_table),
        sql.Identifier(ref_column),
    ) + on_delete_sql(data.get("on_delete"))
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(query)
    except psycopg2.Error as exc:
        raise ApiError("Не удалось создать связь: " + db_error_text(exc))
    tables = refresh_state_tables(state)
    return jsonify({"ok": True, "constraint": constraint, "tables": tables})


@app.post("/api/db/tables/relations/drop")
def api_relation_drop():
    state = require_state()
    data = request.get_json(silent=True) or {}
    schema_name = clean_identifier(data.get("schema"), "имя схемы")
    table_name = clean_identifier(data.get("table"), "имя таблицы")
    constraint = clean_identifier(data.get("name"), "имя связи")
    table = find_table(state, schema_name, table_name)
    if not any(fk["name"] == constraint for fk in table.get("foreign_keys", [])):
        raise ApiError("Связь не найдена.", 404)
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(
                    sql.SQL("ALTER TABLE {} DROP CONSTRAINT {}").format(
                        table_sql(schema_name, table_name),
                        sql.Identifier(constraint),
                    )
                )
    except psycopg2.Error as exc:
        raise ApiError("Не удалось удалить связь: " + db_error_text(exc))
    tables = refresh_state_tables(state)
    return jsonify({"ok": True, "tables": tables})


# ---------------------------------------------------------------------------
# 5b. API: ФУНКЦИИ, ПРОЦЕДУРЫ И ТРИГГЕРЫ
# ---------------------------------------------------------------------------

_ROUTINE_CREATE_RE = re.compile(
    r"(?is)^CREATE\s+(?:OR\s+REPLACE\s+)?"
    r"(?:(?:CONSTRAINT\s+)?TRIGGER|FUNCTION|PROCEDURE)\b"
)
_ROUTINE_MAX_SQL = 200_000


def _split_sql_statements(source: str) -> list[str]:
    """Разделяет SQL на операторы, не трогая строки, комментарии
    и тела функций в dollar-quoting ($$ ... $$)."""
    statements: list[str] = []
    start = 0
    index = 0
    length = len(source)

    while index < length:
        char = source[index]

        if char == "'":
            escaped = (
                index > 0
                and source[index - 1] in "Ee"
                and (index < 2 or not (source[index - 2].isalnum() or source[index - 2] in "_$"))
            )
            index += 1
            while index < length:
                if escaped and source[index] == "\\":
                    index += 2
                    continue
                if source[index] == "'":
                    if index + 1 < length and source[index + 1] == "'":
                        index += 2
                        continue
                    index += 1
                    break
                index += 1
            continue

        if char == '"':
            index += 1
            while index < length:
                if source[index] == '"':
                    if index + 1 < length and source[index + 1] == '"':
                        index += 2
                        continue
                    index += 1
                    break
                index += 1
            continue

        if char == "-" and index + 1 < length and source[index + 1] == "-":
            index += 2
            while index < length and source[index] not in "\r\n":
                index += 1
            continue

        if char == "/" and index + 1 < length and source[index + 1] == "*":
            depth = 1
            index += 2
            while index < length and depth:
                if source.startswith("/*", index):
                    depth += 1
                    index += 2
                elif source.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            continue

        if char == "$":
            tag_end = index + 1
            while tag_end < length and (source[tag_end].isalnum() or source[tag_end] == "_"):
                tag_end += 1
            if tag_end < length and source[tag_end] == "$":
                tag = source[index : tag_end + 1]
                closing = source.find(tag, tag_end + 1)
                if closing < 0:
                    index = length
                else:
                    index = closing + len(tag)
                continue
            index += 1
            continue

        if char == ";":
            statements.append(source[start:index])
            start = index + 1

        index += 1

    statements.append(source[start:])
    return [statement for statement in statements if statement.strip()]


def _strip_sql_prefix_comments(source: str) -> str:
    text = source.lstrip()
    while text:
        if text.startswith("--"):
            line_end = text.find("\n")
            text = "" if line_end < 0 else text[line_end + 1 :].lstrip()
        elif text.startswith("/*"):
            comment_end = text.find("*/")
            if comment_end < 0:
                return text
            text = text[comment_end + 2 :].lstrip()
        else:
            return text
    return text


def validate_routine_sql(raw: Any) -> str:
    source = str(raw or "").strip()
    if not source:
        raise ApiError("Введите SQL-код функции, процедуры или триггера.")
    if len(source) > _ROUTINE_MAX_SQL:
        raise ApiError(
            "SQL-код слишком длинный (максимум 200 000 символов)."
        )

    statements = [
        item
        for item in _split_sql_statements(source)
        if _strip_sql_prefix_comments(item).strip()
    ]
    if not statements:
        raise ApiError("Введите SQL-код функции, процедуры или триггера.")
    if len(statements) > 1:
        raise ApiError(
            "Разрешён только один оператор за раз: CREATE FUNCTION, "
            "CREATE PROCEDURE или CREATE TRIGGER."
        )

    statement = statements[0].strip()
    check = _strip_sql_prefix_comments(statement)
    if not _ROUTINE_CREATE_RE.match(check):
        raise ApiError(
            "Можно выполнять только CREATE FUNCTION, CREATE PROCEDURE "
            "или CREATE TRIGGER (допускается OR REPLACE)."
        )
    return statement


def _parse_object_oid(raw: Any) -> int:
    try:
        oid = int(raw)
    except (TypeError, ValueError):
        raise ApiError("Некорректный идентификатор объекта.", 400)
    if oid <= 0:
        raise ApiError("Некорректный идентификатор объекта.", 400)
    return oid


def routines_payload(state: dict[str, Any]) -> dict[str, Any]:
    with state["lock"]:
        with state["conn"].cursor(
            cursor_factory=psycopg2.extras.RealDictCursor
        ) as cur:
            cur.execute(
                """
                SELECT p.oid::int AS oid,
                       n.nspname AS schema,
                       p.proname AS name,
                       CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
                       l.lanname AS language,
                       pg_get_function_arguments(p.oid) AS arguments,
                       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
                       CASE WHEN p.prokind = 'f'
                            THEN pg_get_function_result(p.oid)
                            ELSE ''
                       END AS result,
                       pg_get_userbyid(p.proowner) AS owner,
                       obj_description(p.oid, 'pg_proc') AS comment
                FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
                JOIN pg_language l ON l.oid = p.prolang
                WHERE p.prokind IN ('f', 'p')
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
                ORDER BY n.nspname, p.proname,
                         pg_get_function_identity_arguments(p.oid)
                """
            )
            routine_rows = [
                {key: json_safe(value) for key, value in dict(row).items()}
                for row in cur.fetchall()
            ]

            cur.execute(
                """
                SELECT t.oid::int AS oid,
                       n.nspname AS schema,
                       t.tgname AS name,
                       n.nspname AS table_schema,
                       c.relname AS table_name,
                       fn.nspname AS function_schema,
                       p.proname AS function_name,
                       CASE WHEN (t.tgtype & 64) <> 0 THEN 'INSTEAD OF'
                            WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE'
                            ELSE 'AFTER'
                       END AS timing,
                       concat_ws(
                           ' OR ',
                           CASE WHEN (t.tgtype & 4) <> 0 THEN 'INSERT' END,
                           CASE WHEN (t.tgtype & 8) <> 0 THEN 'DELETE' END,
                           CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE' END,
                           CASE WHEN (t.tgtype & 32) <> 0 THEN 'TRUNCATE' END
                       ) AS events,
                       CASE WHEN (t.tgtype & 1) <> 0 THEN 'ROW' ELSE 'STATEMENT' END
                           AS orientation,
                       (t.tgenabled IN ('O', 'A')) AS enabled,
                       obj_description(t.oid, 'pg_trigger') AS comment
                FROM pg_trigger t
                JOIN pg_class c ON c.oid = t.tgrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_proc p ON p.oid = t.tgfoid
                JOIN pg_namespace fn ON fn.oid = p.pronamespace
                WHERE NOT t.tgisinternal
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
                ORDER BY n.nspname, c.relname, t.tgname
                """
            )
            trigger_rows = [
                {key: json_safe(value) for key, value in dict(row).items()}
                for row in cur.fetchall()
            ]

    functions = [row for row in routine_rows if row["kind"] == "function"]
    procedures = [row for row in routine_rows if row["kind"] == "procedure"]
    return {
        "ok": True,
        "functions": functions,
        "procedures": procedures,
        "triggers": trigger_rows,
    }


@app.get("/api/db/routines")
def api_routines_list():
    state = require_state()
    return jsonify(routines_payload(state))


@app.get("/api/db/routines/definition")
def api_routine_definition():
    state = require_state()
    oid = _parse_object_oid(request.args.get("oid"))
    kind = str(request.args.get("kind", "")).strip().lower()

    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                if kind in {"function", "procedure"}:
                    cur.execute(
                        """
                        SELECT pg_get_functiondef(p.oid) AS definition
                        FROM pg_proc p
                        JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE p.oid = %s
                          AND p.prokind = %s
                          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                          AND n.nspname NOT LIKE 'pg\\_%%' ESCAPE '\\'
                        """,
                        (oid, "p" if kind == "procedure" else "f"),
                    )
                elif kind == "trigger":
                    cur.execute(
                        """
                        SELECT pg_get_triggerdef(t.oid) AS definition
                        FROM pg_trigger t
                        JOIN pg_class c ON c.oid = t.tgrelid
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE t.oid = %s
                          AND NOT t.tgisinternal
                          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                          AND n.nspname NOT LIKE 'pg\\_%%' ESCAPE '\\'
                        """,
                        (oid,),
                    )
                else:
                    raise ApiError("Неизвестный тип объекта.")
                row = cur.fetchone()
    except psycopg2.Error as exc:
        raise ApiError("Не удалось прочитать определение: " + db_error_text(exc))

    if not row or not row[0]:
        raise ApiError("Объект не найден.", 404)
    return jsonify({"ok": True, "kind": kind, "definition": row[0]})


@app.post("/api/db/routines/execute")
def api_routine_execute():
    state = require_state()
    data = request.get_json(silent=True) or {}
    statement = validate_routine_sql(data.get("sql"))

    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(statement)
    except psycopg2.Error as exc:
        raise ApiError("Не удалось создать объект: " + db_error_text(exc))

    return jsonify(routines_payload(state))


@app.post("/api/db/routines/drop")
def api_routine_drop():
    state = require_state()
    data = request.get_json(silent=True) or {}
    oid = _parse_object_oid(data.get("oid"))
    kind = str(data.get("kind", "")).strip().lower()

    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                if kind in {"function", "procedure"}:
                    cur.execute(
                        """
                        SELECT n.nspname AS schema,
                               p.proname AS name,
                               p.prokind AS prokind,
                               pg_get_function_identity_arguments(p.oid) AS arguments
                        FROM pg_proc p
                        JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE p.oid = %s
                          AND p.prokind = %s
                          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                          AND n.nspname NOT LIKE 'pg\\_%%' ESCAPE '\\'
                        """,
                        (oid, "p" if kind == "procedure" else "f"),
                    )
                    row = cur.fetchone()
                    if not row:
                        raise ApiError("Объект не найден.", 404)
                    keyword = "PROCEDURE" if row[2] == "p" else "FUNCTION"
                    cur.execute(
                        sql.SQL("DROP {} {}.{}({})").format(
                            sql.SQL(keyword),
                            sql.Identifier(row[0]),
                            sql.Identifier(row[1]),
                            sql.SQL(row[3] or ""),
                        )
                    )
                elif kind == "trigger":
                    cur.execute(
                        """
                        SELECT n.nspname AS schema,
                               c.relname AS table_name,
                               t.tgname AS name
                        FROM pg_trigger t
                        JOIN pg_class c ON c.oid = t.tgrelid
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE t.oid = %s
                          AND NOT t.tgisinternal
                          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                          AND n.nspname NOT LIKE 'pg\\_%%' ESCAPE '\\'
                        """,
                        (oid,),
                    )
                    row = cur.fetchone()
                    if not row:
                        raise ApiError("Триггер не найден.", 404)
                    cur.execute(
                        sql.SQL("DROP TRIGGER {} ON {}.{}").format(
                            sql.Identifier(row[2]),
                            sql.Identifier(row[0]),
                            sql.Identifier(row[1]),
                        )
                    )
                else:
                    raise ApiError("Неизвестный тип объекта.")
    except psycopg2.Error as exc:
        raise ApiError("Не удалось удалить объект: " + db_error_text(exc))

    return jsonify(routines_payload(state))


# ---------------------------------------------------------------------------
# 6. API: ДАННЫЕ ТАБЛИЦ
# ---------------------------------------------------------------------------


def run_readonly_query(
    state: dict[str, Any], raw_sql: Any, limit: int = 100
) -> dict[str, Any]:
    """Выполняет только читающий SELECT/WITH в режиме READ ONLY."""
    source = str(raw_sql or "").strip()
    if not source:
        raise ApiError("Введите SQL-запрос.")
    if len(source) > 20000:
        raise ApiError("SQL-запрос слишком длинный (максимум 20 000 символов).")

    query = source.rstrip()
    while query.endswith(";"):
        query = query[:-1].rstrip()
    if not query:
        raise ApiError("Введите SQL-запрос.")
    if ";" in query:
        raise ApiError("Разрешён только один SQL-запрос без точки с запятой.")
    if not re.match(r"(?is)^\s*(select|with)\b", query):
        raise ApiError("Разрешены только читающие запросы SELECT или WITH.")

    limit = max(1, min(int(limit or 100), 500))
    wrapped = "SELECT * FROM (" + query + ") AS db2ui_sql LIMIT %s"

    try:
        with state["lock"]:
            with state["conn"].cursor(
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
        raise ApiError(f"Ошибка SQL-запроса: {db_error_text(exc)}")

    rows = [
        {key: json_safe(value) for key, value in dict(row).items()}
        for row in fetched
    ]
    return {
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "limit": limit,
        "truncated": len(rows) >= limit,
    }


@app.get("/api/table")
def api_table_rows():
    state = require_state()
    schema_name = request.args.get("schema", "")
    table_name = request.args.get("table", "")
    try:
        limit = int(request.args.get("limit", 50))
    except ValueError:
        limit = 50
    limit = max(1, min(limit, 200))

    table = find_table(state, schema_name, table_name)
    ident = table_sql(schema_name, table_name)

    try:
        with state["lock"]:
            with state["conn"].cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                if table["primary_key"]:
                    order = sql.SQL(", ").join(
                        sql.Identifier(column)
                        for column in table["primary_key"]
                    )
                    query = sql.SQL(
                        "SELECT * FROM {} ORDER BY {} LIMIT %s"
                    ).format(ident, order)
                else:
                    query = sql.SQL("SELECT * FROM {} LIMIT %s").format(ident)
                cur.execute(query, (limit,))
                rows = [
                    {key: json_safe(value) for key, value in dict(row).items()}
                    for row in cur.fetchall()
                ]
    except psycopg2.Error as exc:
        raise ApiError(f"Не удалось прочитать таблицу: {db_error_text(exc)}")

    return jsonify({"table": table, "rows": rows})


@app.post("/api/sql/query")
def api_sql_query():
    state = require_state()
    data = request.get_json(silent=True) or {}
    limit = _clamp_int(data.get("limit"), 100, 1, 500)
    result = run_readonly_query(state, data.get("sql"), limit)
    return jsonify(result)


@app.post("/api/table/rows")
def api_row_create():
    state = require_state()
    data = request.get_json(silent=True) or {}
    table = find_table(
        state, str(data.get("schema", "")), str(data.get("table", ""))
    )
    values = clean_values(table, data.get("values"), exclude_pk=False)
    if not values:
        raise ApiError("Заполните хотя бы одно поле записи.")

    columns = list(values.keys())
    query = sql.SQL(
        "INSERT INTO {} ({}) VALUES ({}) RETURNING *"
    ).format(
        table_sql(table["schema"], table["name"]),
        sql.SQL(", ").join(sql.Identifier(column) for column in columns),
        sql.SQL(", ").join(sql.Placeholder() for _ in columns),
    )

    try:
        with state["lock"]:
            with state["conn"].cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                cur.execute(query, [values[column] for column in columns])
                row = dict(cur.fetchone())
    except psycopg2.Error as exc:
        raise ApiError(f"Не удалось добавить запись: {db_error_text(exc)}")

    return jsonify(
        {"ok": True, "row": {key: json_safe(value) for key, value in row.items()}}
    )


@app.put("/api/table/rows")
def api_row_update():
    state = require_state()
    data = request.get_json(silent=True) or {}
    table = find_table(
        state, str(data.get("schema", "")), str(data.get("table", ""))
    )
    pk = pk_values(table, data.get("pk"))
    values = clean_values(table, data.get("values"), exclude_pk=True)
    if not values:
        raise ApiError("Нет полей для изменения.")

    columns = list(values.keys())
    query = sql.SQL("UPDATE {} SET {} WHERE {} RETURNING *").format(
        table_sql(table["schema"], table["name"]),
        sql.SQL(", ").join(
            sql.SQL("{} = %s").format(sql.Identifier(column))
            for column in columns
        ),
        sql.SQL(" AND ").join(
            sql.SQL("{} = %s").format(sql.Identifier(column))
            for column in table["primary_key"]
        ),
    )
    params = [values[column] for column in columns] + [
        pk[column] for column in table["primary_key"]
    ]

    try:
        with state["lock"]:
            with state["conn"].cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                cur.execute(query, params)
                found = cur.fetchone()
    except psycopg2.Error as exc:
        raise ApiError(f"Не удалось сохранить запись: {db_error_text(exc)}")

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
    state = require_state()
    data = request.get_json(silent=True) or {}
    table = find_table(
        state, str(data.get("schema", "")), str(data.get("table", ""))
    )
    pk = pk_values(table, data.get("pk"))

    query = sql.SQL("DELETE FROM {} WHERE {}").format(
        table_sql(table["schema"], table["name"]),
        sql.SQL(" AND ").join(
            sql.SQL("{} = %s").format(sql.Identifier(column))
            for column in table["primary_key"]
        ),
    )
    params = [pk[column] for column in table["primary_key"]]

    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(query, params)
                deleted = cur.rowcount
    except psycopg2.Error as exc:
        raise ApiError(f"Не удалось удалить запись: {db_error_text(exc)}")

    if not deleted:
        raise ApiError("Запись не найдена — возможно, её уже удалили.", 404)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# 7. API: АВТОРИЗАЦИЯ ПРИЛОЖЕНИЯ
# ---------------------------------------------------------------------------


def hash_password(password: str, mode: str) -> str:
    if mode == "sha256":
        return hashlib.sha256(password.encode("utf-8")).hexdigest()
    return password


def auth_settings(state: dict[str, Any]) -> dict[str, Any]:
    return normalize_auth(state["project"].get("auth"))


def auth_table(state: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    auth = auth_settings(state)
    if not auth["table"]:
        raise ApiError("Авторизация ещё не настроена.")
    table = find_table(state, auth["schema"], auth["table"])
    for key, label in (
        ("login_column", "логин"),
        ("password_column", "пароль"),
        ("role_column", "роль"),
    ):
        column_name = auth[key]
        if column_name and not any(
            column["name"] == column_name for column in table["columns"]
        ):
            raise ApiError(f"В таблице пользователей нет колонки «{column_name}» ({label}).")
    if not auth["login_column"] or not auth["password_column"]:
        raise ApiError("Укажите колонки логина и пароля в настройках авторизации.")
    return auth, table


@app.get("/api/auth/status")
def api_auth_status():
    state = require_state()
    return jsonify(auth_status(state))


@app.post("/api/auth/login")
def api_auth_login():
    state = require_state()
    data = request.get_json(silent=True) or {}
    login = str(data.get("login") or "").strip()
    password = str(data.get("password") or "")
    if not login or not password:
        raise ApiError("Введите логин и пароль.")
    if len(login) > 64 or len(password) > 128:
        raise ApiError("Слишком длинный логин или пароль.")

    auth, table = auth_table(state)
    select_parts = [
        sql.SQL("{}::text AS login_value").format(sql.Identifier(auth["login_column"])),
        sql.SQL("{}::text AS password_value").format(
            sql.Identifier(auth["password_column"])
        ),
    ]
    if auth["role_column"]:
        select_parts.append(
            sql.SQL("{}::text AS role_value").format(sql.Identifier(auth["role_column"]))
        )
    query = sql.SQL("SELECT {} FROM {} WHERE {}::text = %s LIMIT 1").format(
        sql.SQL(", ").join(select_parts),
        table_sql(table["schema"], table["name"]),
        sql.Identifier(auth["login_column"]),
    )
    try:
        with state["lock"]:
            with state["conn"].cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                cur.execute(query, (login,))
                row = cur.fetchone()
    except psycopg2.Error as exc:
        raise ApiError("Не удалось проверить пользователя: " + db_error_text(exc))

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
    state["auth_user"] = user
    return jsonify({"ok": True, "user": user})


@app.post("/api/auth/register")
def api_auth_register():
    """Регистрация пользователя приложения из окна предпросмотра."""
    state = require_state()
    data = request.get_json(silent=True) or {}
    auth, table = auth_table(state)
    if not auth.get("allow_registration", True):
        raise ApiError("Регистрация новых пользователей отключена в настройках проекта.", 403)

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

    login_ident = sql.Identifier(auth["login_column"])
    exists_query = sql.SQL("SELECT 1 FROM {} WHERE {}::text = %s LIMIT 1").format(
        table_sql(table["schema"], table["name"]),
        login_ident,
    )
    columns = [auth["login_column"], auth["password_column"]]
    values = [login, hash_password(password, auth["password_mode"])]
    if auth["role_column"]:
        columns.append(auth["role_column"])
        values.append(role)
    insert_query = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        table_sql(table["schema"], table["name"]),
        sql.SQL(", ").join(sql.Identifier(column) for column in columns),
        sql.SQL(", ").join(sql.Placeholder() for _ in columns),
    )
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(exists_query, (login,))
                if cur.fetchone():
                    raise ApiError("Пользователь с таким логином уже существует.", 409)
                cur.execute(insert_query, values)
    except ApiError:
        raise
    except psycopg2.Error as exc:
        message = db_error_text(exc)
        if "duplicate" in message.lower() or "unique" in message.lower():
            raise ApiError("Пользователь с таким логином уже существует.", 409)
        raise ApiError("Не удалось зарегистрировать пользователя: " + message)

    user = {"login": login, "role": role if auth["role_column"] else ""}
    state["auth_user"] = user
    return jsonify({"ok": True, "user": user})


@app.post("/api/auth/logout")
def api_auth_logout():
    state = require_state()
    state["auth_user"] = None
    return jsonify({"ok": True})


@app.post("/api/auth/setup")
def api_auth_setup():
    state = require_state()
    data = request.get_json(silent=True) or {}
    schema_name = clean_identifier(data.get("schema") or "public", "имя схемы")
    table_name = clean_identifier(data.get("table") or "app_users", "имя таблицы")
    login_column = clean_identifier(data.get("login_column") or "login", "колонка логина")
    password_column = clean_identifier(
        data.get("password_column") or "password", "колонка пароля"
    )
    role_column = clean_identifier(data.get("role_column") or "role", "колонка роли")
    admin_login = clean_identifier(data.get("admin_login") or "admin", "логин администратора")
    admin_password = str(data.get("admin_password") or "")
    mode = data.get("password_mode")
    if mode not in {"plain", "sha256"}:
        mode = "sha256"
    if not admin_password:
        raise ApiError("Придумайте пароль администратора.")
    if len(admin_password) < 4:
        raise ApiError("Пароль администратора должен содержать не менее 4 символов.")
    if len(admin_login) < 3:
        raise ApiError("Логин администратора должен содержать не менее 3 символов.")
    if len({login_column, password_column, role_column}) != 3:
        raise ApiError("Колонки логина, пароля и роли должны быть разными.")

    table_ident = table_sql(schema_name, table_name)
    query = sql.SQL("CREATE TABLE IF NOT EXISTS {} ({}, {}, {})").format(
        table_ident,
        sql.SQL("{} text NOT NULL UNIQUE").format(sql.Identifier(login_column)),
        sql.SQL("{} text NOT NULL").format(sql.Identifier(password_column)),
        sql.SQL("{} text NOT NULL DEFAULT 'user'").format(sql.Identifier(role_column)),
    )
    insert = sql.SQL(
        "INSERT INTO {} ({}, {}, {}) VALUES (%s, %s, 'admin') "
        "ON CONFLICT ({}) DO NOTHING"
    ).format(
        table_ident,
        sql.Identifier(login_column),
        sql.Identifier(password_column),
        sql.Identifier(role_column),
        sql.Identifier(login_column),
    )
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(query)
                cur.execute(insert, (admin_login, hash_password(admin_password, mode)))
    except psycopg2.Error as exc:
        raise ApiError("Не удалось создать таблицу пользователей: " + db_error_text(exc))

    tables = refresh_state_tables(state)
    config = {
        "enabled": True,
        "allow_registration": auth_settings(state).get("allow_registration", True),
        "title": auth_settings(state)["title"],
        "schema": schema_name,
        "table": table_name,
        "login_column": login_column,
        "password_column": password_column,
        "password_mode": mode,
        "role_column": role_column,
        "welcome": auth_settings(state)["welcome"],
    }
    state["project"]["auth"] = normalize_auth(config)
    try:
        save_project_file(state["project_path"], state["project"])
    except OSError as exc:
        raise ApiError(f"Таблица создана, но проект не сохранён: {exc}", 500)
    return jsonify({"ok": True, "config": config, "tables": tables})


@app.get("/api/auth/users")
def api_auth_users():
    state = require_state()
    auth, table = auth_table(state)
    role_sql = (
        sql.SQL("{}::text").format(sql.Identifier(auth["role_column"]))
        if auth["role_column"]
        else sql.SQL("''")
    )
    query = sql.SQL("SELECT {}::text AS login, {} AS role FROM {} ORDER BY 1 LIMIT 500").format(
        sql.Identifier(auth["login_column"]),
        role_sql,
        table_sql(table["schema"], table["name"]),
    )
    try:
        with state["lock"]:
            with state["conn"].cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cur:
                cur.execute(query)
                users = [
                    {"login": str(row["login"]), "role": str(row["role"] or "")}
                    for row in cur.fetchall()
                ]
    except psycopg2.Error as exc:
        raise ApiError("Не удалось прочитать пользователей: " + db_error_text(exc))
    return jsonify({"users": users})


@app.post("/api/auth/users")
def api_auth_user_create():
    state = require_state()
    data = request.get_json(silent=True) or {}
    auth, table = auth_table(state)
    login = str(data.get("login") or "").strip()
    password = str(data.get("password") or "")
    role = str(data.get("role") or "user").strip() or "user"
    if not login or not password:
        raise ApiError("Укажите логин и пароль нового пользователя.")
    if len(login) < 3:
        raise ApiError("Логин должен содержать не менее 3 символов.")
    if len(login) > 64:
        raise ApiError("Логин не может быть длиннее 64 символов.")
    if len(password) < 4:
        raise ApiError("Пароль должен содержать не менее 4 символов.")
    if len(password) > 128:
        raise ApiError("Пароль слишком длинный (максимум 128 символов).")

    columns = [auth["login_column"], auth["password_column"]]
    values = [login, hash_password(password, auth["password_mode"])]
    if auth["role_column"]:
        columns.append(auth["role_column"])
        values.append(role)
    query = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        table_sql(table["schema"], table["name"]),
        sql.SQL(", ").join(sql.Identifier(column) for column in columns),
        sql.SQL(", ").join(sql.Placeholder() for _ in columns),
    )
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(query, values)
    except psycopg2.Error as exc:
        raise ApiError("Не удалось добавить пользователя: " + db_error_text(exc))
    return jsonify({"ok": True})


@app.put("/api/auth/users")
def api_auth_user_update():
    state = require_state()
    data = request.get_json(silent=True) or {}
    auth, table = auth_table(state)
    login = str(data.get("login") or "").strip()
    password = str(data.get("password") or "")
    if not login or not password:
        raise ApiError("Укажите логин и новый пароль.")
    if len(password) < 4:
        raise ApiError("Пароль должен содержать не менее 4 символов.")
    if len(password) > 128:
        raise ApiError("Пароль слишком длинный (максимум 128 символов).")
    query = sql.SQL("UPDATE {} SET {} = %s WHERE {}::text = %s").format(
        table_sql(table["schema"], table["name"]),
        sql.Identifier(auth["password_column"]),
        sql.Identifier(auth["login_column"]),
    )
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(
                    query,
                    (hash_password(password, auth["password_mode"]), login),
                )
                updated = cur.rowcount
    except psycopg2.Error as exc:
        raise ApiError("Не удалось изменить пароль: " + db_error_text(exc))
    if not updated:
        raise ApiError("Пользователь не найден.", 404)
    return jsonify({"ok": True})


@app.delete("/api/auth/users")
def api_auth_user_delete():
    state = require_state()
    data = request.get_json(silent=True) or {}
    auth, table = auth_table(state)
    login = str(data.get("login") or "").strip()
    if not login:
        raise ApiError("Не указан логин пользователя.")
    query = sql.SQL("DELETE FROM {} WHERE {}::text = %s").format(
        table_sql(table["schema"], table["name"]),
        sql.Identifier(auth["login_column"]),
    )
    try:
        with state["lock"]:
            with state["conn"].cursor() as cur:
                cur.execute(query, (login,))
                deleted = cur.rowcount
    except psycopg2.Error as exc:
        raise ApiError("Не удалось удалить пользователя: " + db_error_text(exc))
    if not deleted:
        raise ApiError("Пользователь не найден.", 404)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# 8. ЗАПУСК
# ---------------------------------------------------------------------------


def _open_browser(port: int) -> None:
    try:
        webbrowser.open(f"http://127.0.0.1:{port}")
    except Exception:
        pass


if __name__ == "__main__":
    port = _env_int("DB2UI_PORT", 8501)
    if os.getenv("DB2UI_NO_BROWSER") != "1":
        threading.Timer(1.2, _open_browser, args=(port,)).start()
    print(f"DB2UI Studio: http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
