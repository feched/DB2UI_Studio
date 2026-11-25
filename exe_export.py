"""Экспорт готового приложения DB2UI в один .exe-файл.

Формат файла:

    [нативный запускатор DB2UI-Player.exe]
    [ZIP: встроенный Python, Flask, psycopg2 и рантайм]
    [ZIP: данные проекта — project.json, config.json]
    [40 байт трейлера]

Трейлер: <int64 off1><int64 len1><int64 off2><int64 len2><8 байт "DB2UIEXE">.

Запускатор при старте читает трейлер, распаковывает рантайм в
``%LOCALAPPDATA%\\DB2UI Player\\<hash>`` и запускает встроенный python.exe
с app.py. Python и зависимости на компьютере пользователя не нужны.
"""

from __future__ import annotations

import io
import json
import struct
import zipfile
from pathlib import Path
from typing import Any

from portable import build_app_bundle, connection_template, transliterate

MAGIC = b"DB2UIEXE"
TRAILER = struct.Struct("<QQQQ8s")
PLAYER_EXE = "DB2UI-Player.exe"
RUNTIME_ZIP = "runtime.zip"


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def player_files(base_dir: Path) -> tuple[Path, Path]:
    folder = Path(base_dir) / "assets" / "player"
    return folder / PLAYER_EXE, folder / RUNTIME_ZIP


def build_app_exe(
    project: dict[str, Any],
    tables: list[dict[str, Any]],
    config: dict[str, Any],
    base_dir: Path,
) -> bytes:
    """Собрать одиночный .exe с приложением и вернуть его содержимое."""
    launcher_path, runtime_path = player_files(base_dir)
    if not launcher_path.exists() or not runtime_path.exists():
        raise RuntimeError(
            "Встроенный проигрыватель не собран. Запустите build-desktop.ps1 "
            "(или tools/build_player.py) и повторите экспорт."
        )

    bundle = build_app_bundle(project, tables, config)
    connection = connection_template(config)

    runtime = runtime_path.read_bytes()
    data_buffer = io.BytesIO()
    with zipfile.ZipFile(
        data_buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=6
    ) as archive:
        for name, content in (
            ("data/project.json", _json_bytes(bundle)),
            ("data/config.json", _json_bytes(connection)),
            ("project.db2ui.json", _json_bytes(project)),
        ):
            entry = zipfile.ZipInfo(name, date_time=(2024, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, content)

    data = data_buffer.getvalue()
    launcher = launcher_path.read_bytes()
    runtime_offset = len(launcher)
    data_offset = runtime_offset + len(runtime)
    trailer = TRAILER.pack(
        runtime_offset,
        len(runtime),
        data_offset,
        len(data),
        MAGIC,
    )
    return launcher + runtime + data + trailer


def _clean_name(project_name: str, fallback: str = "app") -> str:
    raw = str(project_name or fallback).strip() or fallback
    cleaned = "".join(
        "_" if char in '\\/:*?"<>|' or ord(char) < 32 else char for char in raw
    ).strip(" .")
    return (cleaned or fallback)[:60]


def app_exe_filename(project_name: str, fallback: str = "app") -> str:
    """Имя скачиваемого .exe (может содержать кириллицу)."""
    return _clean_name(project_name, fallback) + ".exe"


def app_exe_ascii_filename(project_name: str, fallback: str = "app") -> str:
    """ASCII-имя для заголовка Content-Disposition."""
    raw = transliterate(project_name)
    cleaned = "".join(
        "_" if char in '\\/:*?"<>|' or ord(char) < 32 else char for char in raw
    ).strip(" ._-")
    return (cleaned[:60] or fallback) + ".exe"
