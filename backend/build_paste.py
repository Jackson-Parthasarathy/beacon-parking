"""Merge config.local.gs into Code.gs, writing config.local.Code.gs (gitignored),
the single file to paste into the Apps Script editor.

Run: python backend/build_paste.py
"""
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
code = (HERE / "Code.gs").read_text(encoding="utf-8")
local = (HERE / "config.local.gs").read_text(encoding="utf-8")
config = re.search(r"var CONFIG = \{.*?\n\};", local, re.S).group(0)
merged, n = re.subn(r"var CONFIG = \{.*?\n\};", lambda _: config, code, count=1, flags=re.S)
assert n == 1, "CONFIG block not found in Code.gs"
(HERE / "config.local.Code.gs").write_text(merged, encoding="utf-8")
print("wrote", HERE / "config.local.Code.gs")
