#!/usr/bin/env python3
"""Crop the outside frame from real window screenshots without redrawing pixels."""

import argparse
from pathlib import Path

from PIL import Image

LANGUAGES = ("en", "pt", "es", "fr", "de", "it")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Folder with the six original panel-<language>.jpg screenshots")
    parser.add_argument("--output", type=Path, default=Path("docs/assets"))
    parser.add_argument("--inset", type=int, default=16, help="Pixels removed from each edge of the 2× capture")
    arguments = parser.parse_args()
    if not 0 <= arguments.inset <= 24:
        parser.error("Use an inset between 0 and 24 pixels to preserve the panel content.")

    captures = []
    for language in LANGUAGES:
        with Image.open(arguments.source / f"panel-{language}.jpg") as image:
            if image.size != (840, 1300):
                parser.error(f"Unexpected {language} capture size: {image.size}; inspect before cropping.")
            captures.append((language, image.convert("RGB")))

    arguments.output.mkdir(parents=True, exist_ok=True)
    for language, original in captures:
        inset = arguments.inset
        cropped = original.crop((inset, inset, original.width - inset, original.height - inset))
        destination = arguments.output / f"panel-{language}.png"
        cropped.save(destination, optimize=True)
        with Image.open(destination) as saved:
            if saved.tobytes() != cropped.tobytes():
                raise RuntimeError(f"Pixel verification failed: {destination}")
        print(f"{destination}: {original.width}×{original.height} → {cropped.width}×{cropped.height}; original pixels preserved")


if __name__ == "__main__":
    main()
