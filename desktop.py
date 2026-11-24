"""Запуск DB2UI Studio как обычного десктопного приложения.

Сервер Flask работает только на локальном адресе и обслуживает окно
приложения. Наружу ничего не открывается: это не веб-версия, а обычная
программа для Windows с одним exe и установщиком.
"""

from __future__ import annotations

import argparse
import ctypes
import logging
import os
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

APP_TITLE = "DB2UI Studio"
MUTEX_NAME = "Local\\DB2UIStudioDesktop"
DEFAULT_PORT = 8501


def _message_box(text: str, title: str = APP_TITLE, error: bool = True) -> None:
    if os.name != "nt":
        return
    try:
        flags = 0x10 if error else 0x40  # MB_ICONERROR / MB_ICONINFORMATION
        ctypes.windll.user32.MessageBoxW(None, text, title, flags)
    except Exception:
        pass


def _acquire_single_instance() -> bool:
    """Не даёт запустить две копии: они делили бы одни и те же проекты."""
    if os.name != "nt":
        return True
    try:
        handle = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
        if not handle:
            return True
        already_running = ctypes.windll.kernel32.GetLastError() == 183
        if already_running:
            ctypes.windll.kernel32.CloseHandle(handle)
            return False
        # Хэндл живёт до конца процесса — специально не закрываем.
        return True
    except Exception:
        return True


def _pick_port(preferred: int) -> int:
    """Берёт предпочитаемый порт, а если он занят — любой свободный."""
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return sock.getsockname()[1]
    raise RuntimeError("Не удалось найти свободный локальный порт.")


def _wait_until_ready(url: str, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as response:
                if response.status < 500:
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.1)
    return False


def _log_path() -> Path:
    if getattr(sys, "frozen", False):
        root = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(root) / "DB2UI Studio" / "desktop.log"
    return Path(__file__).resolve().parent / "desktop.log"


def _setup_logging() -> None:
    try:
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            str(path),
            maxBytes=512 * 1024,
            backupCount=2,
            encoding="utf-8",
        )
        logging.basicConfig(
            handlers=[handler],
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(message)s",
        )
        # Не засоряем журнал каждой HTTP-заявкой встроенного окна.
        logging.getLogger("werkzeug").setLevel(logging.WARNING)
        logging.info("starting %s (frozen=%s)", APP_TITLE, getattr(sys, "frozen", False))
    except Exception:
        pass


def _resource_icon() -> str | None:
    for base in (
        Path(__file__).resolve().parent,
        Path(getattr(sys, "_MEIPASS", "")),
    ):
        candidate = base / "assets" / "db2ui.ico"
        if candidate.exists():
            return str(candidate)
    return None


def main() -> int:
    _setup_logging()
    parser = argparse.ArgumentParser(description=APP_TITLE)
    parser.add_argument("--port", type=int, default=int(os.getenv("DB2UI_PORT", DEFAULT_PORT)))
    parser.add_argument("--no-window", action="store_true", help="только сервер, без окна")
    parser.add_argument("--debug", action="store_true", help="окно с инструментами разработчика")
    args = parser.parse_args()

    if not args.no_window and not _acquire_single_instance():
        _message_box(
            "DB2UI Studio уже запущен.\n\n"
            "Закройте открытое окно приложения или завершите его в диспетчере задач.",
            error=False,
        )
        return 0

    # Отдельный идентификатор, чтобы Windows показывала иконку приложения,
    # а не иконку python.exe, на панели задач.
    if os.name == "nt":
        try:
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("DB2UI.Studio.1")
        except Exception:
            pass

    import app as builder
    from werkzeug.serving import make_server

    port = _pick_port(args.port)
    try:
        server = make_server("127.0.0.1", port, builder.app, threaded=True)
    except OSError as exc:
        _message_box(f"Не удалось запустить локальный сервер:\n{exc}")
        return 1

    server_thread = threading.Thread(
        target=server.serve_forever,
        name="db2ui-http",
        daemon=True,
    )
    server_thread.start()

    url = f"http://127.0.0.1:{server.server_port}/"
    if not _wait_until_ready(url):
        server.shutdown()
        _message_box("Приложение не успело запуститься.\nПопробуйте открыть его ещё раз.")
        return 1

    if args.no_window:
        print(f"{APP_TITLE}: {url}")
        print("Сервер работает. Для остановки нажмите Ctrl+C.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            server.shutdown()
        return 0

    try:
        import webview
    except Exception:
        # Без WebView2 приложение всё равно должно открыться.
        webbrowser.open(url)
        print(f"{APP_TITLE}: {url}")
        try:
            server_thread.join()
        except KeyboardInterrupt:
            pass
        return 0

    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True

    storage = Path(builder.DATA_DIR) / "webview"
    storage.mkdir(parents=True, exist_ok=True)

    window = webview.create_window(
        APP_TITLE,
        url,
        width=1480,
        height=920,
        min_size=(1120, 720),
        background_color="#11151c",
        text_select=True,
        zoomable=True,
    )
    logging.info("window created, url=%s", url)

    icon = _resource_icon()
    try:
        webview.start(
            debug=args.debug,
            private_mode=False,
            storage_path=str(storage),
            icon=icon,
        )
    except Exception:
        # WebView2 может отсутствовать на старых сборках Windows.
        logging.exception("webview start failed, falling back to browser")
        traceback.print_exc()
        webbrowser.open(url)
        try:
            server_thread.join()
        except KeyboardInterrupt:
            pass
        return 0
    finally:
        try:
            server.shutdown()
        except Exception:
            pass
        logging.info("application closed")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        traceback.print_exc()
        _message_box(f"Не удалось запустить {APP_TITLE}:\n\n{exc}")
        raise SystemExit(1)
