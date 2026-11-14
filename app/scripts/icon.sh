#!/usr/bin/env bash
# Regenerates resources/icon.png (1024x1024) from resources/icon.svg, the crow logo, then the Linux icon set
# resources/icons/<size>x<size>.png from it (ImageMagick): the deb, rpm and AppImage install every size, and the
# Flatpak takes none above 512, and the Android launcher icons and splash screens (android-icons.py). `--sizes` only
# remakes the sets from the current icon.png.
set -euo pipefail
cd "$(dirname "$0")/.." # -> app/
if [ "${1:-}" != "--sizes" ]; then
  npx electron --no-sandbox --user-data-dir="$(mktemp -d)" scripts/icon.cjs resources/icon.svg resources/icon.png 1024
fi
magick=$(command -v magick || command -v convert)
mkdir -p resources/icons
for size in 16 32 48 64 128 256 512; do
  "$magick" resources/icon.png -filter Lanczos -resize "${size}x${size}" -strip "resources/icons/${size}x${size}.png"
done
python3 scripts/android-icons.py
