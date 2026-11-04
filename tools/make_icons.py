"""Generate the PWA icon set.

Dev-only: run once, commit the output. Nothing at runtime depends on this.

The mark is the same crown the app draws in SVG, with a down arrow through it,
since the joke in the name is that a parlay is a donation. Drawn here rather
than borrowed: a real sportsbook's logo on a home screen would be passing the
app off as theirs.

Run: python -I tools/make_icons.py
"""
import io
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "icons"))

BG = (0, 0, 0)
GREEN = (83, 211, 55)
DARK = (10, 31, 5)

# Everything is drawn at 512 and scaled, so one set of coordinates serves
# every size and the shapes stay crisp.
BASE = 512


def crown(draw, u, cx, cy, scale=1.0, fill=GREEN):
    """The crown, centred on (cx, cy). `u` scales from the 512 design grid."""
    s = u * scale

    def p(x, y):
        return (cx + x * s, cy + y * s)

    # Outer points at the sides, a taller one in the middle, dipping between.
    body = [
        p(-115, 95), p(-130, -60), p(-40, 0), p(0, -105),
        p(40, 0), p(130, -60), p(115, 95),
    ]
    draw.polygon(body, fill=fill)
    # The band below it.
    draw.rounded_rectangle([p(-115, 110), p(115, 160)], radius=22 * s, fill=fill)

    # The down arrow, cut through the crown in the background colour so it
    # reads at small sizes instead of turning to mush.
    w = 17 * s
    draw.line([p(0, -35), p(0, 55)], fill=DARK, width=int(w), joint="curve")
    draw.line([p(-38, 18), p(0, 60)], fill=DARK, width=int(w), joint="curve")
    draw.line([p(38, 18), p(0, 60)], fill=DARK, width=int(w), joint="curve")


def make(size, maskable=False, rounded=False):
    img = Image.new("RGB", (BASE, BASE), BG)
    d = ImageDraw.Draw(img)
    if rounded:
        # iOS already rounds the corners, so this is only for the favicon.
        img = Image.new("RGB", (BASE, BASE), BG)
        d = ImageDraw.Draw(img)

    # A maskable icon can be cropped to a circle by the launcher, so the mark
    # has to sit inside the safe zone, which is the middle 80%.
    scale = 0.72 if maskable else 0.95
    crown(d, BASE / 320.0, BASE / 2, BASE / 2 - 10 * (BASE / 512.0), scale)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, False),
        ("favicon-32.png", 32, False),
    ]
    for name, size, maskable in jobs:
        img = make(size, maskable=maskable)
        path = os.path.join(OUT, name)
        img.save(path, "PNG", optimize=True)
        print("  %-26s %dx%d  %5.1f KB" % (name, size, size, os.path.getsize(path) / 1024.0))
    print("done ->", OUT)
