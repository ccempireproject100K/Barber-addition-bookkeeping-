"""Owner-only download of this app's source as a zip (secrets and build artefacts excluded)."""

import io
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from lib.auth import Principal, require

router = APIRouter()
ROOT = Path(__file__).resolve().parents[2]
SKIP_DIRS = {"node_modules", ".git", "dist", "__pycache__", ".venv", "venv", ".pytest_cache", ".emergent", "test_reports",
             ".screenshots", ".mypy_cache", ".ruff_cache"}
SKIP_FILES = {".env", ".env.local", ".env.production"}
INCLUDE = ("backend", "frontend", "memory", "README.md", "CHATGPT_HANDOFF.md", "docker-compose.yml", "auth_testing.md", "design_guidelines.json")


def build_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in INCLUDE:
            base = ROOT / name
            paths = [base] if base.is_file() else (base.rglob("*") if base.exists() else [])
            for f in paths:
                rel = f.relative_to(ROOT)
                if not f.is_file() or f.name in SKIP_FILES or any(part in SKIP_DIRS for part in rel.parts):
                    continue
                if f.stat().st_size > 2_000_000:
                    continue
                z.write(f, Path("barbers-ledger") / rel)
        if (ROOT / ".emergent" / "crons.yml").exists():  # schedule definition is useful; nothing secret in it
            z.write(ROOT / ".emergent" / "crons.yml", "barbers-ledger/.emergent/crons.yml")
    return buf.getvalue()


@router.get("/source/download")
async def download_source(p: Principal = Depends(require("settings:write"))):
    data = build_zip()
    return StreamingResponse(io.BytesIO(data), media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="barbers-ledger-source.zip"'})
