"""Сборка встроенного проигрывателя для экспорта приложения в один .exe.

Результат в assets/player:

  runtime.zip       — Python 3.12 (embeddable) + Flask + psycopg2 + рантайм;
  DB2UI-Player.exe  — нативный запускатор (C#, .NET Framework 4.x).

Запуск:

  .venv\\Scripts\\python.exe tools\\build_player.py

Скрипт вызывается автоматически из build-desktop.ps1 перед сборкой
DB2UI Studio. Готовые файлы попадают внутрь DB2UI Studio.exe и
используются кнопкой «Скачать» при экспорте.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAYER_DIR = ROOT / "assets" / "player"
CACHE_DIR = ROOT / "build" / "player_cache"

# Embeddable-дистрибутив должен совпадать с версией .venv,
# иначе бинарные колёса psycopg2 не подойдут.
PYTHON_VERSION = "3.12.10"
PTH_NAME = "python312._pth"
PYTHON_ZIP = "python312.zip"
EMBED_NAME = f"python-{PYTHON_VERSION}-embed-amd64"
EMBED_URL = (
    f"https://www.python.org/ftp/python/{PYTHON_VERSION}/{EMBED_NAME}.zip"
)
REQUIREMENTS = ("flask>=3.0,<4", "psycopg2-binary>=2.9.9,<3")


def log(message: str) -> None:
    print(message, flush=True)


def ensure_embed_zip() -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = CACHE_DIR / f"{EMBED_NAME}.zip"
    if target.exists() and target.stat().st_size > 1_000_000:
        return target
    log(f"      Скачивание {EMBED_NAME}.zip ...")
    tmp = target.with_suffix(".zip.tmp")
    with urllib.request.urlopen(EMBED_URL, timeout=180) as response:
        tmp.write_bytes(response.read())
    os.replace(tmp, target)
    return target


def prepare_runtime(embed_zip: Path) -> Path:
    runtime = CACHE_DIR / "runtime"
    if runtime.exists():
        shutil.rmtree(runtime)
    log("      Распаковка встроенного Python ...")
    with zipfile.ZipFile(embed_zip) as archive:
        archive.extractall(runtime)

    log("      Установка Flask и psycopg2 ...")
    site_packages = runtime / "Lib" / "site-packages"
    site_packages.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-warn-script-location",
            "--upgrade",
            "--target",
            str(site_packages),
            *REQUIREMENTS,
        ],
        check=True,
    )
    for extra in ("bin", "Scripts"):
        shutil.rmtree(runtime / extra, ignore_errors=True)

    pth = runtime / PTH_NAME
    if not pth.exists():
        candidates = sorted(runtime.glob("python*._pth"))
        if not candidates:
            raise RuntimeError("В embeddable-дистрибутиве нет файла python*._pth.")
        pth = candidates[0]
    pth.write_text(
        f"{PYTHON_ZIP}\n.\nLib\\site-packages\nimport site\n",
        encoding="ascii",
    )

    log("      Копирование рантайма приложения ...")
    shutil.copy2(ROOT / "portable_runtime" / "app.py", runtime / "app.py")
    shutil.copytree(
        ROOT / "portable_runtime" / "templates",
        runtime / "templates",
        dirs_exist_ok=True,
    )
    shutil.copytree(
        ROOT / "portable_runtime" / "static",
        runtime / "static",
        dirs_exist_ok=True,
    )
    shutil.copy2(ROOT / "static" / "style.css", runtime / "static" / "style.css")

    probe = subprocess.run(
        [str(runtime / "python.exe"), "-c", "import flask, psycopg2"],
        capture_output=True,
        text=True,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Встроенный Python не смог импортировать Flask/psycopg2:\n"
            + (probe.stderr or probe.stdout)
        )
    return runtime


def build_runtime_zip(runtime: Path) -> Path:
    PLAYER_DIR.mkdir(parents=True, exist_ok=True)
    target = PLAYER_DIR / "runtime.zip"
    tmp = target.with_suffix(".zip.tmp")
    log("      Упаковка runtime.zip ...")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(runtime.rglob("*")):
            if path.is_dir():
                continue
            relative = path.relative_to(runtime).as_posix()
            if "__pycache__" in relative.split("/"):
                continue
            info = zipfile.ZipInfo(relative, date_time=(2024, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    os.replace(tmp, target)
    return target


def find_csc() -> Path:
    windows = Path(os.environ.get("WINDIR") or r"C:\Windows")
    for folder in ("Framework64", "Framework"):
        candidate = windows / "Microsoft.NET" / folder / "v4.0.30319" / "csc.exe"
        if candidate.exists():
            return candidate
    raise RuntimeError(
        "Не найден csc.exe (.NET Framework 4.x). Установите .NET Framework 4.8."
    )


def build_launcher() -> Path:
    csc = find_csc()
    target = PLAYER_DIR / "DB2UI-Player.exe"
    log("      Компиляция запускатора ...")
    subprocess.run(
        [
            str(csc),
            "/nologo",
            "/target:winexe",
            "/optimize+",
            f"/out:{target}",
            f"/win32icon:{ROOT / 'assets' / 'db2ui.ico'}",
            "/r:System.IO.Compression.dll",
            "/r:System.IO.Compression.FileSystem.dll",
            "/r:System.Windows.Forms.dll",
            str(ROOT / "tools" / "player" / "Program.cs"),
        ],
        check=True,
    )
    return target


def main() -> int:
    log("[player] Сборка встроенного проигрывателя для экспорта в .exe")
    if ".".join(map(str, sys.version_info[:3])) != PYTHON_VERSION:
        raise SystemExit(
            "Версия Python в .venv не совпадает с embeddable-дистрибутивом: "
            f"{sys.version} != {PYTHON_VERSION}. Обновите PYTHON_VERSION "
            "в tools/build_player.py."
        )
    embed_zip = ensure_embed_zip()
    runtime = prepare_runtime(embed_zip)
    runtime_zip = build_runtime_zip(runtime)
    launcher = build_launcher()
    size_mb = lambda path: round(path.stat().st_size / (1024 * 1024), 1)
    log(
        f"      Готово: {runtime_zip.name} ({size_mb(runtime_zip)} МБ), "
        f"{launcher.name} ({size_mb(launcher)} МБ)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
