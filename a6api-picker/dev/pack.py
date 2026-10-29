#!/usr/bin/env python3
"""按官方 .cindy 包结构打包（zip，ghost.json 在根目录）。

本环境没有 ghost_forge_pack；这个脚本只做 Forge 的「把源目录压成 .cindy」那一步，
manifest 的硬约束由 dev/validate.mjs 先核对。
"""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = [
    "ghost.json",
    "main.js",
    "bridge.js",
    "panel.html",
    "panel.css",
    "panel.js",
    "settings.html",
    "settings.css",
    "settings.js",
    "node/worker.cjs",
    "node/core.mjs",
    "assets/icon.png",
    "README.md",
]

manifest = json.load(open(os.path.join(ROOT, "ghost.json"), encoding="utf-8"))
target = os.path.join(ROOT, f"{manifest['id']}-{manifest['version']}.cindy")

missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
if missing:
    raise SystemExit("缺文件: " + ", ".join(missing))

with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for rel in FILES:
        info = zipfile.ZipInfo(rel, date_time=(2026, 10, 29, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = (0o644 & 0xFFFF) << 16
        with open(os.path.join(ROOT, rel), "rb") as f:
            z.writestr(info, f.read())

with zipfile.ZipFile(target) as z:
    names = z.namelist()
    assert names[0] == "ghost.json", names[:3]
    assert "ghost.json" in names and all(f in names for f in FILES), names

print("wrote", target)
print("files", len(FILES), "bytes", os.path.getsize(target))
