# -*- mode: python ; coding: utf-8 -*-
"""Сборка DB2UI Studio в один exe через PyInstaller.

Запуск:  python -m PyInstaller --noconfirm --clean desktop.spec
"""

from pathlib import Path

ROOT = Path(SPECPATH)

datas = [
    (str(ROOT / "templates"), "templates"),
    (str(ROOT / "static"), "static"),
    (str(ROOT / "portable_runtime"), "portable_runtime"),
    (str(ROOT / "assets"), "assets"),
    (str(ROOT / "schema.sql"), "."),
    (str(ROOT / ".env.example"), "."),
    (str(ROOT / "README.md"), "."),
]

analysis = Analysis(
    ["desktop.py"],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        "clr_loader",
        "pythonnet",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "matplotlib",
        "numpy",
        "pandas",
        "pytest",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="DB2UI Studio",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "assets" / "db2ui.ico"),
    version=str(ROOT / "installer" / "version_info.txt"),
)
