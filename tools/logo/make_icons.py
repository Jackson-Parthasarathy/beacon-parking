"""Build app icons from Beau's photo: face in a circle with a white ring on navy.

Run: python tools/logo/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

HERE = Path(__file__).resolve().parent
ICONS = HERE.parent.parent / "app" / "icons"
NAVY = (15, 42, 71)
FACE_BOX = (450, 535, 960, 1045)   # square around Beau's face in beau.webp

face = Image.open(HERE / "beau.webp").convert("RGB").crop(FACE_BOX)
face = ImageEnhance.Contrast(face).enhance(1.08)
face = ImageEnhance.Color(face).enhance(1.12)
face = face.filter(ImageFilter.UnsharpMask(radius=3, percent=60, threshold=2))


def icon(size, face_frac, ring_frac=0.035, bg=NAVY):
    s = 4                                   # supersample for smooth edges
    n = size * s
    out = Image.new("RGB", (n, n), bg)
    d = int(n * face_frac)
    ring = int(n * ring_frac)
    off = (n - d) // 2
    draw = ImageDraw.Draw(out)
    draw.ellipse([off - ring, off - ring, off + d + ring, off + d + ring], fill=(255, 255, 255))
    mask = Image.new("L", (d, d), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, d, d], fill=255)
    out.paste(face.resize((d, d), Image.LANCZOS), (off, off), mask)
    return out.resize((size, size), Image.LANCZOS)


ICONS.mkdir(parents=True, exist_ok=True)
icon(180, 0.80).save(ICONS / "icon-180.png")             # iOS home screen (corners get rounded)
icon(192, 0.80).save(ICONS / "icon-192.png")
icon(512, 0.80).save(ICONS / "icon-512.png")
icon(512, 0.62).save(ICONS / "icon-maskable-512.png")    # Android safe zone
# Header badge and favicon: just the face, transparent outside the circle.
badge = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
m = Image.new("L", (512, 512), 0)
ImageDraw.Draw(m).ellipse([0, 0, 511, 511], fill=255)
f = face.resize((512, 512), Image.LANCZOS).convert("RGBA")
f.putalpha(m)
badge = f.resize((128, 128), Image.LANCZOS)
badge.save(ICONS / "beau-128.png")
badge.resize((32, 32), Image.LANCZOS).save(ICONS / "favicon-32.png")
print("icons written to", ICONS)
