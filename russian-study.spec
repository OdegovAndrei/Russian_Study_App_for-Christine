# PyInstaller recipe: one self-contained executable (Windows .exe / macOS binary).
# Build:  pyinstaller --noconfirm --clean russian-study.spec
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

hidden = collect_submodules("edge_tts") + collect_submodules("aiohttp")
datas = [("web", "web")] + collect_data_files("certifi") + collect_data_files("edge_tts")

a = Analysis(
    ["server.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "unittest", "pydoc"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="RussianStudy",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,  # keeps a window open: closing it stops the server
)
