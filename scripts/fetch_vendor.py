"""Fetch pinned, self-hosted frontend assets and their licenses."""
from pathlib import Path
from urllib.request import urlopen

DEST = Path(__file__).resolve().parents[1] / "static" / "vendor"
ASSETS = {
    "98.css": "https://unpkg.com/98.css@0.1.21/dist/98.css",
    "98.css.map": "https://unpkg.com/98.css@0.1.21/dist/98.css.map",
    "ms_sans_serif.woff2": "https://unpkg.com/98.css@0.1.21/dist/ms_sans_serif.woff2",
    "ms_sans_serif.woff": "https://unpkg.com/98.css@0.1.21/dist/ms_sans_serif.woff",
    "ms_sans_serif_bold.woff2": "https://unpkg.com/98.css@0.1.21/dist/ms_sans_serif_bold.woff2",
    "ms_sans_serif_bold.woff": "https://unpkg.com/98.css@0.1.21/dist/ms_sans_serif_bold.woff",
    "98-LICENSE.txt": "https://unpkg.com/98.css@0.1.21/LICENSE",
    "bootstrap-grid.min.css": "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap-grid.min.css",
    "bootstrap-grid.min.css.map": "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap-grid.min.css.map",
    "bootstrap-LICENSE.txt": "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/LICENSE",
}
DEST.mkdir(parents=True, exist_ok=True)
for name, url in ASSETS.items():
    with urlopen(url, timeout=30) as response:
        (DEST / name).write_bytes(response.read())
    print(name)
