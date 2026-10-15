"""Contact sheets for the product-demo review stills (host-side, Python 3 + Pillow).

out/demo-stills/<n>/*.png -> out/demo-stills/<n>-sheet.png: 3 columns of 640x360 thumbnails, each labelled with its
file name. Run after `bash scripts/video.sh node scripts/demo-stills.mjs`:
    python video/scripts/demo-sheet.py [1 2 3 4]
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent / "out" / "demo-stills"
COLS, W, H, LABEL, GAP = 3, 640, 360, 30, 12
BG, FG = (7, 12, 29), (244, 242, 236)


def font(size: int) -> ImageFont.ImageFont:
    for name in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def sheet(n: str) -> Path:
    shots = sorted((ROOT / n).glob("*.png"))
    if not shots:
        raise SystemExit(f"no stills in {ROOT / n}")
    rows = (len(shots) + COLS - 1) // COLS
    out = Image.new("RGB", (COLS * W + (COLS + 1) * GAP, rows * (H + LABEL) + (rows + 1) * GAP), BG)
    draw, f = ImageDraw.Draw(out), font(20)
    for i, p in enumerate(shots):
        x, y = GAP + (i % COLS) * (W + GAP), GAP + (i // COLS) * (H + LABEL + GAP)
        with Image.open(p) as im:
            out.paste(im.convert("RGB").resize((W, H), Image.LANCZOS), (x, y))
        draw.text((x + 4, y + H + 4), p.stem, fill=FG, font=f)
    dest = ROOT / f"{n}-sheet.png"
    out.save(dest)
    return dest


if __name__ == "__main__":
    for n in sys.argv[1:] or sorted(d.name for d in ROOT.iterdir() if d.is_dir()):
        print(sheet(n))
