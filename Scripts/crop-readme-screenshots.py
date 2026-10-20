#!/usr/bin/env python3
"""Make only the exterior of native rounded corners transparent in real captures."""

import argparse
from collections import deque
from pathlib import Path

from PIL import Image

LANGUAGES = ("en", "pt", "es", "fr", "de", "it")
CORNER_REGION = 96


def remove_corner_matte(original):
    """Follow the captured contour, preserving the full frame and every RGB pixel."""
    result = original.convert("RGBA")
    width, height = result.size
    pixels = result.load()
    corners = ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1))
    pending = deque(corners)
    visited = set()
    changed = 0
    while pending:
        x, y = pending.popleft()
        if (x, y) in visited or not (0 <= x < width and 0 <= y < height):
            continue
        visited.add((x, y))
        if not ((x < CORNER_REGION or x >= width - CORNER_REGION)
                and (y < CORNER_REGION or y >= height - CORNER_REGION)):
            continue
        red, green, blue, _ = pixels[x, y]
        if min(red, green, blue) < 150 or max(red, green, blue) - min(red, green, blue) > 12:
            continue
        value = (red + green + blue) / 3
        alpha = 0 if value >= 245 else round(255 * (245 - value) / 95)
        pixels[x, y] = (red, green, blue, max(0, min(255, alpha)))
        changed += alpha < 255
        pending.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))

    if result.convert("RGB").tobytes() != original.convert("RGB").tobytes():
        raise RuntimeError("The screenshot colors were changed.")
    if not all(pixels[point][3] == 0 for point in corners):
        raise ValueError("Unexpected corner background; inspect the screenshot before editing.")
    alpha = result.getchannel("A")
    if (alpha.crop((CORNER_REGION, 0, width - CORNER_REGION, height)).getextrema() != (255, 255)
            or alpha.crop((0, CORNER_REGION, width, height - CORNER_REGION)).getextrema() != (255, 255)):
        raise RuntimeError("Transparency reached the panel interior.")
    if not 0 < changed < 6000:
        raise ValueError("Unexpected corner area; inspect the screenshot before editing.")
    return result, changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Folder with the six original panel-<language>.jpg screenshots")
    parser.add_argument("--output", type=Path, default=Path("docs/assets"))
    arguments = parser.parse_args()

    captures = []
    for language in LANGUAGES:
        with Image.open(arguments.source / f"panel-{language}.jpg") as image:
            if image.size != (840, 1300):
                parser.error(f"Unexpected {language} capture size: {image.size}; inspect before editing.")
            captures.append((language, image.convert("RGB")))

    arguments.output.mkdir(parents=True, exist_ok=True)
    for language, original in captures:
        rounded, changed = remove_corner_matte(original)
        destination = arguments.output / f"panel-{language}.png"
        rounded.save(destination, optimize=True)
        with Image.open(destination) as saved:
            if saved.size != original.size or saved.tobytes() != rounded.tobytes():
                raise RuntimeError(f"Pixel verification failed: {destination}")
            if saved.info.get("icc_profile") != original.info.get("icc_profile"):
                raise RuntimeError(f"Color profile was not preserved: {destination}")
        print(f"{destination}: {original.width}×{original.height} preserved; only {changed} exterior corner alpha values changed")


if __name__ == "__main__":
    main()
