#!/usr/bin/env python3
"""Rasterize paper figure PDFs into web-ready WebP images.

Source of truth is the LaTeX project at $HOPE_PAPER (default /data/users/subin/hope).
Run from the project root:  python3 scripts/build_figures.py
"""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

PAPER = Path(os.environ.get("HOPE_PAPER", "/data/users/subin/hope"))
ASSETS = PAPER / "Main" / "Assets"
OUT = Path(__file__).resolve().parent.parent / "static" / "images"

# (source pdf, output stem, target width in px, optional crop box as fractions l,t,r,b)
FIGURES = [
    ("teaser.pdf", "fig1-teaser", 1900, None),
    ("method.pdf", "fig2-method", 1700, None),
    ("opentouch.pdf", "fig3-opentouch", 1500, None),
    ("pv.pdf", "fig4-pressurevision", 1700, None),
    # comparison_mow.pdf is not on the page — the MOW section was cut.
    ("ablation_dataset.pdf", "fig6-generalization", 2000, None),
]

RENDER_DPI = 400
WEBP_QUALITY = 88


def render(pdf: Path, tmpdir: Path) -> Image.Image:
    stem = tmpdir / pdf.stem
    subprocess.run(
        ["pdftoppm", "-png", "-r", str(RENDER_DPI), "-f", "1", "-l", "1",
         str(pdf), str(stem)],
        check=True,
    )
    pages = sorted(tmpdir.glob(f"{pdf.stem}-*.png"))
    if not pages:
        raise FileNotFoundError(f"pdftoppm produced nothing for {pdf}")
    return Image.open(pages[0]).convert("RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    if not shutil.which("pdftoppm"):
        raise SystemExit("pdftoppm not found (install poppler-utils)")

    with tempfile.TemporaryDirectory() as td:
        tmpdir = Path(td)
        for name, stem, width, crop in FIGURES:
            pdf = ASSETS / name
            if not pdf.exists():
                print(f"  !! missing {pdf}")
                continue
            img = render(pdf, tmpdir)
            if crop:
                w, h = img.size
                l, t, r, b = crop
                img = img.crop((int(w * l), int(h * t), int(w * r), int(h * b)))
            # 2x asset for retina, 1x for the srcset fallback
            for suffix, target in ((f"{stem}@2x", width), (stem, width // 2)):
                ratio = target / img.width
                resized = img.resize(
                    (target, max(1, round(img.height * ratio))), Image.LANCZOS
                )
                dest = OUT / f"{suffix}.webp"
                resized.save(dest, "WEBP", quality=WEBP_QUALITY, method=6)
                kb = dest.stat().st_size / 1024
                print(f"  {dest.name:32s} {resized.width}x{resized.height}  {kb:7.1f} KB")


if __name__ == "__main__":
    main()
