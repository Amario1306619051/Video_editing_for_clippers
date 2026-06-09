"""Pexels stock-image search for the manual illustration cutaways.

Ported from illustrator's search/download. Self-loads the project-root .env
(clipper has no config.py) for PEXELS_API_KEY. Candidates are URLs streamed
straight to the browser — nothing is stored server-side until a picked image is
downloaded at render time (deduped by URL hash into temp/{job}_ill_*.jpg, which
`cleanup_job` already removes with the rest of the job's temp files).
"""
import hashlib
import logging
import os
from pathlib import Path
from typing import Optional

import requests

log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
TEMP_DIR = BASE_DIR / "temp"
TEMP_DIR.mkdir(exist_ok=True)

PEXELS_SEARCH = "https://api.pexels.com/v1/search"


def _load_dotenv() -> None:
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()

PEXELS_API_KEY = os.getenv("PEXELS_API_KEY", "").strip()
try:
    CANDIDATES = int(os.getenv("CLIPPER_CANDIDATES", os.getenv("ILLUSTRATOR_CANDIDATES", "12")) or 12)
except ValueError:
    CANDIDATES = 12


def enabled() -> bool:
    """True when a Pexels key is configured — gates the illustration search UI."""
    return bool(PEXELS_API_KEY)


def search(query: str, per_page: Optional[int] = None) -> list[dict]:
    """Return candidate dicts {id, thumb, full, alt, photographer}. Empty list
    when no key is configured or the request fails (UI shows 'no results')."""
    if not PEXELS_API_KEY:
        log.warning("PEXELS_API_KEY not set — returning no candidates")
        return []
    per_page = per_page or CANDIDATES
    try:
        resp = requests.get(
            PEXELS_SEARCH,
            headers={"Authorization": PEXELS_API_KEY},
            params={"query": query or "abstract", "per_page": per_page, "orientation": "portrait"},
            timeout=15,
        )
        resp.raise_for_status()
        photos = resp.json().get("photos", [])
    except Exception as e:  # noqa: BLE001
        log.warning("Pexels search failed for %r: %s", query, e)
        return []

    out: list[dict] = []
    for p in photos:
        src = p.get("src", {})
        out.append({
            "id": str(p.get("id", "")),
            "thumb": src.get("medium") or src.get("small") or src.get("tiny", ""),
            # `portrait` (~800x1200) is close to 9:16 already → small download,
            # cover-cropped to the full 1080x1920 frame at render.
            "full": src.get("portrait") or src.get("large") or src.get("original", ""),
            "alt": p.get("alt", ""),
            "photographer": p.get("photographer", ""),
        })
    return out


def download_pick(job_id: str, url: str) -> Path:
    """Download one picked image to temp/, deduped by URL hash. Returns the path."""
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
    dest = TEMP_DIR / f"{job_id}_ill_{digest}.jpg"
    if dest.exists():
        return dest
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return dest
