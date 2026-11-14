#!/usr/bin/env python3
# Makes the Android launcher icons and splash screens from resources/icon.png, the crow logo, on black with the logo's
# blue glow (Pillow). Run from app/.
# The adaptive icon's foreground keeps the crow inside the 66 dp circle every launcher mask leaves visible.
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

res = Path("android/app/src/main/res")
crow = Image.open("resources/icon.png").convert("RGBA")
crow = crow.crop(crow.getbbox())
background = (0, 0, 0, 255)
glow = (0x32, 0x76, 0xE2)
densities = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def fitted(box: int) -> Image.Image:
    scale = box / max(crow.size)
    art = crow.resize((round(crow.width * scale), round(crow.height * scale)), Image.LANCZOS)
    pad = max(2, round(box * 0.08))
    glowing = Image.new("RGBA", (art.width + 2 * pad, art.height + 2 * pad), (0, 0, 0, 0))
    shape = Image.new("L", glowing.size, 0)
    shape.paste(art.getchannel("A"), (pad, pad))
    spread = shape.filter(ImageFilter.MaxFilter(2 * max(1, round(box * 0.015)) + 1)).filter(ImageFilter.GaussianBlur(box * 0.04))
    halo = Image.new("RGBA", glowing.size, glow + (0,))
    halo.putalpha(ImageChops.multiply(spread, Image.new("L", glowing.size, 255)))
    glowing.alpha_composite(halo)
    glowing.alpha_composite(art, (pad, pad))
    return glowing


def centered(canvas: Image.Image, box: int) -> Image.Image:
    art = fitted(box)
    canvas.alpha_composite(art, ((canvas.width - art.width) // 2, (canvas.height - art.height) // 2))
    return canvas


def masked(size: int, shape: str) -> Image.Image:
    scale = 4
    mask = Image.new("L", (size * scale, size * scale), 0)
    draw = ImageDraw.Draw(mask)
    if shape == "round":
        draw.ellipse((0, 0, size * scale - 1, size * scale - 1), fill=255)
    else:
        draw.rounded_rectangle((0, 0, size * scale - 1, size * scale - 1), radius=size * scale // 6, fill=255)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.paste(Image.new("RGBA", (size, size), background), mask=mask.resize((size, size), Image.LANCZOS))
    return icon


for name, factor in densities.items():
    folder = res / f"mipmap-{name}"
    foreground = round(108 * factor)
    centered(Image.new("RGBA", (foreground, foreground), (0, 0, 0, 0)), round(60 * factor)).save(folder / "ic_launcher_foreground.png")
    legacy = round(48 * factor)
    centered(masked(legacy, "square"), round(legacy * 0.72)).save(folder / "ic_launcher.png")
    centered(masked(legacy, "round"), round(legacy * 0.62)).save(folder / "ic_launcher_round.png")

for splash in res.glob("drawable*/splash.png"):
    width, height = Image.open(splash).size
    canvas = Image.new("RGBA", (width, height), background)
    centered(canvas, round(min(width, height) * 0.35)).convert("RGB").save(splash)
