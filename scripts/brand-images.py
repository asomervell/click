"""Rasterise the brand SVGs (all rects) and build the OG card base. Run from the repo root."""
import re
from PIL import Image, ImageDraw

def raster(svg_path, scale, out):
    svg = open(svg_path).read()
    vb = [int(float(v)) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split()]
    w, h = vb[2], vb[3]
    img = Image.new("RGB", (w * scale, h * scale))
    draw = ImageDraw.Draw(img)
    fill = "#000000"
    for tag in re.finditer(r'<(g|rect)\b([^>]*)>', svg):
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', tag.group(2)))
        if tag.group(1) == "g":
            fill = attrs.get("fill", fill)
            continue
        if attrs.get("width") == "100%":
            draw.rectangle([0, 0, w * scale, h * scale], fill=attrs.get("fill", "#000000"))
            continue
        x, y = float(attrs["x"]), float(attrs["y"])
        rw, rh = float(attrs["width"]), float(attrs["height"])
        draw.rectangle([x * scale, y * scale, (x + rw) * scale - 1, (y + rh) * scale - 1], fill=attrs.get("fill", fill))
    img.save(out, optimize=True)
    return img

raster("brand/logos/lockup-magenta.svg", 2, "brand/generated/lockup-magenta-208.png")
icons = [raster("brand/logos/favicon-16.svg", s, f"brand/generated/favicon-{16*s}.png") for s in (1, 2, 3)]
icons[2].save("brand/generated/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=icons[:2])
raster("brand/logos/favicon-16.svg", 12, "brand/generated/apple-touch-icon-192.png")
Image.open("brand/hero-campfire.png").convert("RGB").save("brand/generated/hero-frame0.png")
