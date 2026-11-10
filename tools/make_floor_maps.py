"""Floor textures: normal maps derived from the colour maps, and the indoor deck plate.

    python tools/make_floor_maps.py

- public/assets/textures/floor_plates_n.jpg  relief for the existing plate texture (grooves and bolts only)
- public/assets/textures/floor_deck.jpg      indoor tread plate (from assets_src/higgs/floor_deck.png)
- public/assets/textures/floor_deck_n.jpg    its relief (grooves, bolts and the tread pattern)

Everything wraps: blurs and gradients are taken on a 3x3 tiling so the maps stay seamless.
"""
import os

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX = os.path.join(ROOT, 'public', 'assets', 'textures')


def blur_wrap(a, sigma):
    """Gaussian blur of a 2D float array with wrap-around edges."""
    h, w = a.shape
    im = Image.fromarray(np.clip(np.tile(a, (3, 3)) * 255, 0, 255).astype(np.uint8))
    out = np.asarray(im.filter(ImageFilter.GaussianBlur(sigma)), dtype=np.float32) / 255
    return out[h:2 * h, w:2 * w]


def normal_from_height(hgt, strength):
    dx = (np.roll(hgt, -1, axis=1) - np.roll(hgt, 1, axis=1)) * strength
    dy = (np.roll(hgt, -1, axis=0) - np.roll(hgt, 1, axis=0)) * strength
    # Image rows run downward; the green channel of a tangent-space normal map points up (OpenGL convention)
    n = np.dstack([-dx, dy, np.ones_like(hgt)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))


def luminance(im):
    a = np.asarray(im.convert('RGB'), dtype=np.float32) / 255
    return 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]


def groove_height(lum, lo_pct, hi_pct):
    """Dark seams sink, everything brighter than the plate tone stays level (paint and scratches do not rise)."""
    lo, hi = np.percentile(lum, lo_pct), np.percentile(lum, hi_pct)
    t = np.clip((lum - lo) / max(hi - lo, 1e-4), 0, 1)
    return t * t * (3 - 2 * t)


def main():
    plates = Image.open(os.path.join(TEX, 'floor_plates.jpg'))
    lum = luminance(plates)
    hgt = blur_wrap(groove_height(lum, 1.0, 30.0), 1.2)
    normal_from_height(hgt, 5.0).save(os.path.join(TEX, 'floor_plates_n.jpg'), quality=88)

    deck = Image.open(os.path.join(ROOT, 'assets_src', 'higgs', 'floor_deck.png')).convert('RGB')
    deck = deck.resize((1024, 1024), Image.LANCZOS)
    deck.save(os.path.join(TEX, 'floor_deck.jpg'), quality=86)
    lum = luminance(deck)
    seams = blur_wrap(groove_height(lum, 0.5, 25.0), 1.0)
    tread = np.clip((lum - blur_wrap(lum, 6.0)) * 6.0, -1, 1) * 0.5 + 0.5
    hgt = 0.65 * seams + 0.35 * blur_wrap(tread, 0.7)
    normal_from_height(hgt, 5.0).save(os.path.join(TEX, 'floor_deck_n.jpg'), quality=88)
    for f in ('floor_plates_n.jpg', 'floor_deck.jpg', 'floor_deck_n.jpg'):
        print(f, os.path.getsize(os.path.join(TEX, f)))


if __name__ == '__main__':
    main()
