"""Сборка портативного ZIP-пакета приложения DB2UI.

Пакет содержит локальный Flask-сервер, готовый интерфейс, файл проекта
и шаблон подключения к PostgreSQL. Его можно распаковать на любом
компьютере с Python 3 и открыть как обычное приложение.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
RUNTIME_DIR = BASE_DIR / "portable_runtime"


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def _connection_template(config: dict[str, Any]) -> dict[str, Any]:
    """Параметры подключения без пароля.

    Пароль не попадает в скачанный архив: его вводят на первом запуске
    на новом компьютере, после чего приложение может запомнить его
    локально в data/config.json.
    """
    return {
        "host": str(config.get("host") or "localhost"),
        "port": int(config.get("port") or 5432),
        "dbname": str(config.get("dbname") or ""),
        "user": str(config.get("user") or ""),
        "password": "",
        "sslmode": str(config.get("sslmode") or "prefer"),
    }


def _requirements() -> bytes:
    lines = [
        "flask>=3.0,<4",
        "psycopg2-binary>=2.9.9,<3",
        "",
        "# Пакет собран в DB2UI Studio.",
        "# Установка: python -m pip install -r requirements.txt",
        "",
    ]
    return "\n".join(lines).encode("utf-8")


def _run_bat() -> bytes:
    text = "\r\n".join(
        [
            "@echo off",
            "setlocal",
            "cd /d \"%~dp0\"",
            "title DB2UI App",
            "",
            "set \"PY=python\"",
            "where py >nul 2>&1 && set \"PY=py -3\"",
            "",
            "if not exist \".venv\\Scripts\\python.exe\" (",
            "    echo [1/3] Creating Python environment .venv ...",
            "    %PY% -m venv .venv",
            "    if errorlevel 1 goto :error",
            ")",
            "",
            "\".venv\\Scripts\\python.exe\" -c \"import flask, psycopg2\" >nul 2>&1",
            "if errorlevel 1 (",
            "    echo [2/3] Installing dependencies. This is needed only once...",
            "    \".venv\\Scripts\\python.exe\" -m pip install --upgrade pip",
            "    \".venv\\Scripts\\python.exe\" -m pip install -r requirements.txt",
            "    if errorlevel 1 goto :error",
            ")",
            "",
            "echo [3/3] Starting the application...",
            "\".venv\\Scripts\\python.exe\" app.py",
            "if errorlevel 1 goto :error",
            "goto :eof",
            "",
            ":error",
            "echo.",
            "echo Could not start the application.",
            "echo Install Python 3.10+ from https://www.python.org/downloads/",
            "echo and make sure the whole archive is extracted.",
            "echo.",
            "pause",
            "",
        ]
    )
    return text.encode("ascii", "replace")


def _run_sh(app_title: str) -> bytes:
    text = "\n".join(
        [
            "#!/usr/bin/env bash",
            f"# {app_title}",
            "set -e",
            "cd \"$(dirname \"$0\")\"",
            "",
            "PYTHON=python3",
            "command -v python3 >/dev/null 2>&1 || PYTHON=python",
            "",
            "if [ ! -x \".venv/bin/python\" ]; then",
            "  echo \"[1/3] Создание виртуального окружения .venv ...\"",
            "  \"$PYTHON\" -m venv .venv",
            "fi",
            "",
            "if ! .venv/bin/python -c \"import flask, psycopg2\" >/dev/null 2>&1; then",
            "  echo \"[2/3] Установка зависимостей. Это нужно только один раз...\"",
            "  .venv/bin/python -m pip install --upgrade pip",
            "  .venv/bin/python -m pip install -r requirements.txt",
            "fi",
            "",
            "echo \"[3/3] Запуск приложения...\"",
            "exec .venv/bin/python app.py",
            "",
        ]
    )
    return text.encode("utf-8")


def _readme(
    project_name: str,
    config: dict[str, Any],
    table_count: int,
    form_count: int,
) -> bytes:
    host = str(config.get("host") or "localhost")
    port = int(config.get("port") or 5432)
    dbname = str(config.get("dbname") or "")
    user = str(config.get("user") or "")
    lines = [
        "=" * 62,
        f"  {project_name}",
        "  Приложение, собранное в DB2UI Studio",
        "=" * 62,
        "",
        "ЧТО ВНУТРИ",
        f"  • {form_count} форм(ы) интерфейса;",
        f"  • {table_count} таблиц(ы) базы данных;",
        "  • локальный сервер приложения на Flask;",
        "  • файл проекта project.db2ui.json для повторного импорта",
        "    в DB2UI Studio.",
        "",
        "ЧТО НУЖНО НА КОМПЬЮТЕРЕ",
        "  1. Python 3.10 или новее — https://www.python.org/downloads/",
        "     При установке на Windows отметьте «Add Python to PATH».",
        "  2. Доступ к серверу PostgreSQL, где лежат данные приложения.",
        "",
        "БЫСТРЫЙ ЗАПУСК (Windows)",
        "  Дважды щёлкните run.bat. При первом запуске он создаст",
        "  окружение .venv и установит Flask и psycopg2 — нужен интернет.",
        "  Затем откроется браузер с приложением.",
        "",
        "БЫСТРЫЙ ЗАПУСК (Linux / macOS)",
        "  Выполните в терминале:",
        "      chmod +x run.sh",
        "      ./run.sh",
        "",
        "РУЧНОЙ ЗАПУСК",
        "      python -m venv .venv",
        "      .venv\\Scripts\\python -m pip install -r requirements.txt",
        "      .venv\\Scripts\\python app.py",
        "  На Linux/macOS вместо .venv\\Scripts используйте .venv/bin.",
        "",
        "ПОДКЛЮЧЕНИЕ К БАЗЕ",
        "  При первом запуске приложение попросит параметры PostgreSQL.",
        "  В архив уже вписаны:",
        f"      сервер:       {host}",
        f"      порт:         {port}",
        f"      база данных:  {dbname or '—'}",
        f"      пользователь: {user or '—'}",
        "  Пароль в архив не попадает — его нужно ввести при первом",
        "  запуске. Если отметить «Запомнить подключение», параметры",
        "  сохранятся только на этом компьютере в data/config.json.",
        "",
        "  Кнопка с названием базы в шапке приложения открывает окно",
        "  подключения: там можно сменить сервер или базу.",
        "",
        "ГДЕ ЛЕЖАТ ДАННЫЕ",
        "  Данные не копируются в архив: приложение работает с живой",
        "  базой PostgreSQL. Изменения в таблицах сразу видны в базе.",
        "",
        "АВТОРИЗАЦИЯ",
        "  Если в проекте включён вход в приложение, при запуске",
        "  появится экран входа. Пользователи и роли читаются из той же",
        "  таблицы PostgreSQL, что и в DB2UI Studio.",
        "",
        "ПОВТОРНОЕ РЕДАКТИРОВАНИЕ",
        "  Файл project.db2ui.json импортируется в DB2UI Studio",
        "  (кнопка «Проект» → «Импорт»), если нужно изменить интерфейс.",
        "",
        "ОСТАНОВКА",
        "  Закройте окно с сервером или нажмите Ctrl+C.",
        "",
        "ПОРТ",
        "  По умолчанию приложение занимает http://127.0.0.1:8765/.",
        "  Если порт занят, берётся следующий свободный.",
        "  Можно задать свой: set DB2UI_PORT=9000 && run.bat",
        "",
        "ПРИМЕЧАНИЕ",
        "  Это приложение — локальный сервер, а не сайт в интернете.",
        "  Оно доступно только на этом компьютере (127.0.0.1).",
        "",
    ]
    return "\n".join(lines).encode("utf-8-sig")


def build_app_bundle(
    project: dict[str, Any],
    tables: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    """Данные приложения: проект, таблицы и шаблон подключения."""
    connection = _connection_template(config)
    return {
        "project": project,
        "tables": [item for item in tables if isinstance(item, dict)],
        "exported_by": "DB2UI Studio",
        "connection": {
            "host": connection["host"],
            "port": connection["port"],
            "dbname": connection["dbname"],
            "user": connection["user"],
        },
    }


def connection_template(config: dict[str, Any]) -> dict[str, Any]:
    """Параметры подключения без пароля (для data/config.json)."""
    return _connection_template(config)


def build_app_zip(
    project: dict[str, Any],
    tables: list[dict[str, Any]],
    config: dict[str, Any],
) -> bytes:
    """Собрать ZIP-пакет готового приложения и вернуть его содержимое."""
    runtime_app = RUNTIME_DIR / "app.py"
    if not runtime_app.exists():
        raise RuntimeError(
            "Не найден шаблон портативного приложения portable_runtime/app.py."
        )

    project_name = str(project.get("name") or config.get("dbname") or "DB2UI App")
    forms = project.get("forms") if isinstance(project.get("forms"), list) else []
    bundle = build_app_bundle(project, tables, config)
    normalized_tables = bundle["tables"]
    connection = connection_template(config)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        def add(name: str, data: bytes) -> None:
            info = zipfile.ZipInfo(name, date_time=(2024, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)

        add("app.py", runtime_app.read_bytes())
        add("templates/index.html", (RUNTIME_DIR / "templates" / "index.html").read_bytes())
        add("static/runtime.css", (RUNTIME_DIR / "static" / "runtime.css").read_bytes())
        add("static/app.js", (RUNTIME_DIR / "static" / "app.js").read_bytes())
        # Стили элементов интерфейса общие с конструктором.
        add("static/style.css", (BASE_DIR / "static" / "style.css").read_bytes())

        add("data/project.json", _json_bytes(bundle))
        add("data/config.json", _json_bytes(connection))
        add("project.db2ui.json", _json_bytes(project))

        add("requirements.txt", _requirements())
        add("run.bat", _run_bat())
        add("run.sh", _run_sh(project_name))
        add("README.txt", _readme(project_name, connection, len(normalized_tables), len(forms)))

    return buffer.getvalue()


_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def transliterate(value: str) -> str:
    result = []
    for char in str(value or ""):
        lower = char.lower()
        if lower in _TRANSLIT:
            piece = _TRANSLIT[lower]
            result.append(piece.capitalize() if char.isupper() else piece)
        elif char.isascii():
            result.append(char)
        else:
            result.append("_")
    return "".join(result)


def app_zip_filename(project_name: str, fallback: str = "app") -> str:
    """Безопасное имя файла архива."""
    raw = str(project_name or fallback).strip() or fallback
    cleaned = "".join(
        "_" if char in '\\/:*?"<>|' or ord(char) < 32 else char for char in raw
    ).strip(" .")
    if not cleaned:
        cleaned = fallback
    return cleaned[:60] + ".app.zip"


def app_zip_ascii_filename(project_name: str, fallback: str = "app") -> str:
    """ASCII-имя для заголовка Content-Disposition (запасной вариант)."""
    raw = transliterate(project_name)
    cleaned = "".join(
        "_" if char in '\\/:*?"<>|' or ord(char) < 32 else char for char in raw
    ).strip(" ._-")
    return (cleaned[:60] or fallback) + ".app.zip"
