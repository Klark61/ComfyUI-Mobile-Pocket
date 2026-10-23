"""Generate neutral demo images (gradients, shapes, color bands) for the README screenshots.

  python tests/make_demo_images.py <out_dir>                       generate the demo images
  python tests/make_demo_images.py optimize <png> <max_kb>         shrink a screenshot in place (optimize, then quantize, then downscale)
  python tests/make_demo_images.py hero <out.png> <a.png> <b.png> <c.png>   side-by-side montage on #0f1115

Writes ~24 PNGs named like ComfyUI output (ComfyUI_00001_.png, plus a couple of subfolders). Some carry a generic
ComfyUI-style "prompt" text chunk so the viewer's details panel has something to show. Nothing here is real content.
"""
import json
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter
from PIL.PngImagePlugin import PngInfo

PROMPTS = [
    "a lighthouse on a cliff at sunset, watercolor",
    "a quiet mountain lake at dawn, soft mist, pastel colors",
    "abstract geometric shapes, minimal, warm palette",
    "a small cabin in a snowy forest, cozy, golden hour",
    "rolling green hills under a wide sky, oil painting",
    "a paper boat on calm water, soft light",
]
NEG = "blurry, low quality, watermark"


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def palette(rng):
    h = rng.random()
    def hsv(h, s, v):
        import colorsys
        r, g, b = colorsys.hsv_to_rgb(h % 1, s, v)
        return (int(r * 255), int(g * 255), int(b * 255))
    return [hsv(h, .55, .95), hsv(h + .08, .6, .85), hsv(h + .5, .5, .9), hsv(h + .58, .45, .6)]


def gradient(w, h, c1, c2, angle):
    img = Image.new("RGB", (w, h))
    px = img.load()
    ca, sa = math.cos(angle), math.sin(angle)
    span = abs(w * ca) + abs(h * sa)
    for y in range(h):
        for x in range(w):
            t = ((x - w / 2) * ca + (y - h / 2) * sa) / span + .5
            px[x, y] = lerp(c1, c2, min(1, max(0, t)))
    return img


def make(kind, w, h, rng):
    p = palette(rng)
    if kind == "gradient":
        img = gradient(w // 4, h // 4, p[0], p[2], rng.random() * math.pi).resize((w, h), Image.BICUBIC)
    elif kind == "shapes":
        img = gradient(w // 4, h // 4, p[3], p[1], rng.random() * math.pi).resize((w, h), Image.BICUBIC)
        d = ImageDraw.Draw(img, "RGBA")
        for _ in range(rng.randint(4, 7)):
            c = rng.choice(p) + (rng.randint(150, 230),)
            x, y, s = rng.randint(0, w), rng.randint(0, h), rng.randint(min(w, h) // 8, min(w, h) // 3)
            (d.ellipse if rng.random() < .5 else d.rectangle)([x - s // 2, y - s // 2, x + s // 2, y + s // 2], fill=c)
        img = img.filter(ImageFilter.GaussianBlur(1.2))
    elif kind == "bands":   # landscape-like horizontal color bands with a sun
        img = gradient(w // 4, h // 4, p[2], p[0], math.pi / 2).resize((w, h), Image.BICUBIC)
        d = ImageDraw.Draw(img)
        r = min(w, h) // 7
        sx, sy = rng.randint(w // 4, 3 * w // 4), int(h * .45)
        d.ellipse([sx - r, sy - r, sx + r, sy + r], fill=(255, 238, 200))
        for i, base in enumerate([p[1], p[3], lerp(p[3], (20, 24, 40), .5)]):
            y0 = int(h * (.55 + i * .15))
            pts = [(0, h)] + [(x, y0 + int(math.sin(x / (w / (2 + i * 1.5)) + rng.random() * 6) * h * .04)) for x in range(0, w + 1, max(4, w // 80))] + [(w, h)]
            d.polygon(pts, fill=base)
    else:   # soft color field
        img = Image.new("RGB", (w, h), p[3])
        d = ImageDraw.Draw(img)
        for _ in range(8):
            c = rng.choice(p)
            x, y, s = rng.randint(0, w), rng.randint(0, h), rng.randint(min(w, h) // 3, min(w, h) // 2)
            d.ellipse([x - s, y - s, x + s, y + s], fill=c)
        img = img.filter(ImageFilter.GaussianBlur(min(w, h) // 8))
    return img


def api_prompt(text, seed, w, h, prefix):
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "demo_model.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": text, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": NEG, "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "5": {"class_type": "KSampler", "inputs": {"seed": seed, "steps": 25, "cfg": 6.5, "sampler_name": "euler", "scheduler": "normal",
              "denoise": 1, "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0]}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": prefix}},
    }


def main(out):
    rng = random.Random(7)
    sizes = [(512, 768), (768, 512), (640, 640), (512, 896), (896, 512), (576, 768)]
    kinds = ["gradient", "shapes", "bands", "field"]
    os.makedirs(out, exist_ok=True)
    n = 24
    for i in range(n):
        w, h = sizes[i % len(sizes)]
        kind = kinds[(i * 3 + i // 4) % len(kinds)]
        if kind == "bands" and h > w:
            w, h = h, w
        img = make(kind, w, h, rng)
        sub = "" if i < 18 else ("studio" if i < 21 else "tests")
        name = f"ComfyUI_{i + 1:05d}_.png" if not sub else f"{sub}_{i + 1:05d}_.png"
        folder = os.path.join(out, sub) if sub else out
        os.makedirs(folder, exist_ok=True)
        info = None
        if i % 3 != 2:
            info = PngInfo()
            info.add_text("prompt", json.dumps(api_prompt(PROMPTS[i % len(PROMPTS)], 1000 + i * 37, w, h, "ComfyUI")))
        img.save(os.path.join(folder, name), pnginfo=info)
    print(f"wrote {n} images to {out}")


def optimize(path, max_kb):
    img = Image.open(path).convert("RGB")
    for scale in (1.0, 0.85, 0.75):
        im = img if scale == 1.0 else img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        im.save(path, optimize=True)
        if os.path.getsize(path) <= max_kb * 1024:
            return
        im.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(path, optimize=True)
        if os.path.getsize(path) <= max_kb * 1024:
            return
    print(f"warning: {path} is still {os.path.getsize(path) // 1024} KB")


def hero(out, files, gap=24, pad=24, max_w=1600, bg=(15, 17, 21)):
    ims = [Image.open(f).convert("RGB") for f in files]
    h = min(im.height for im in ims)
    ims = [im.resize((round(im.width * h / im.height), h), Image.LANCZOS) for im in ims]
    w = sum(im.width for im in ims) + gap * (len(ims) - 1) + 2 * pad
    canvas = Image.new("RGB", (w, h + 2 * pad), bg)
    x = pad
    for im in ims:
        canvas.paste(im, (x, pad))
        x += im.width + gap
    if canvas.width > max_w:
        canvas = canvas.resize((max_w, round(canvas.height * max_w / canvas.width)), Image.LANCZOS)
    canvas.save(out, optimize=True)
    if os.path.getsize(out) > 600 * 1024:
        canvas.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(out, optimize=True)


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["optimize"]:
        optimize(a[1], int(a[2]))
    elif a[:1] == ["hero"]:
        hero(a[1], a[2:5])
    else:
        main(a[0] if a else "demo_images")
