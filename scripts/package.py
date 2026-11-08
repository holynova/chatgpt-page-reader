"""Produce a deterministic, source-only Chrome extension ZIP."""
from pathlib import Path
import json
import zipfile
import hashlib

root = Path(__file__).resolve().parents[1]
ext = root / "extension"
manifest = json.loads((ext / "manifest.json").read_text())
target = root / "artifacts" / f"chatgpt-page-reader-{manifest['version']}.zip"
target.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(ext.rglob("*")):
        if file.is_file() and file.suffix in {".js", ".json", ".png"}:
            archive.write(file, file.relative_to(ext).as_posix())
with zipfile.ZipFile(target) as archive:
    assert "manifest.json" in archive.namelist()
    assert archive.testzip() is None
print(target)
print("SHA-256:", hashlib.sha256(target.read_bytes()).hexdigest())
