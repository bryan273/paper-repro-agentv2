"""9:16 cut of a finished explainer for Douyin / Xiaohongshu / Reels / Shorts.
usage: python vertical.py 1706.03762 en"""
import sys, os, json, subprocess, textwrap
from PIL import Image, ImageDraw, ImageFont
ROOT = os.path.dirname(os.path.abspath(__file__))
arxiv, lang = sys.argv[1], sys.argv[2]
d = os.path.join(ROOT, "out", arxiv)
try: LABEL = json.load(open(os.path.join(d, "scenes.json"), encoding="utf-8")).get("label") or f"arXiv:{arxiv}"
except Exception: LABEL = f"arXiv:{arxiv}"
sc = json.load(open(os.path.join(d, "scenes.json"), encoding="utf-8"))
src = os.path.join(d, f"{arxiv}_{lang}.mp4")
# drawn at 1080x1920 and scaled to 720x1280 on output: the picture is flat vector graphics, so the smaller frame looks the same and the file is a quarter of the size
W, H = 1080, 1920
VH = 608                       # 16:9 video scaled to full width
VY = (H - VH) // 2 - 40
pick = lambda *c: next(x for x in c if os.path.exists(x))   # Windows laptop or the Linux renderer (fonts-noto-cjk)
F = pick("C:/Windows/Fonts/msyhbd.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc")
FR = pick("C:/Windows/Fonts/msyh.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
big, mid, small = ImageFont.truetype(F, 64), ImageFont.truetype(F, 40), ImageFont.truetype(FR, 34)

im = Image.new("RGB", (W, H), (6, 10, 18))
g = ImageDraw.Draw(im)
badge, bf = ("PAPER EXPLAINER" if lang == "en" else "论文讲解 · Paper Explainer"), ImageFont.truetype(F, 28)
bw = g.textlength(badge, font=bf)
g.rounded_rectangle((60, 120, 60 + bw + 56, 184), 32, outline=(52, 211, 153), width=3)
g.text((60 + 28, 152), badge, font=bf, fill=(52, 211, 153), anchor="lm")
title = sc["paper_title"]
lines = textwrap.wrap(title, 28)
if len(lines) > 3: lines = lines[:3]; lines[2] = lines[2][:25].rstrip() + "..."
big = ImageFont.truetype(F, 58)
y = 220
for ln in lines:
    g.text((60, y), ln, font=big, fill=(240, 244, 250)); y += 74
hook = {"en": "The whole paper in under a minute", "zh": "一分钟看懂这篇论文", "vi": "Cả bài báo trong chưa đầy một phút", "id": "Seluruh makalah dalam kurang dari semenit"}.get(lang) or "The whole paper in under a minute"
g.text((60, y + 18), hook, font=mid, fill=(148, 163, 184))
by = VY + VH + 90
foot = {"en": ["Every quote and number on screen", "is checked against the paper text.", "", LABEL, "bryan273.github.io/repro-suite/explainer"],
        "zh": ["画面里的每句引文和每个数字", "都和论文原文核对过。", "", LABEL, "bryan273.github.io/repro-suite/explainer"],
        "vi": ["Mọi trích dẫn và con số trên màn hình", "đều được đối chiếu với bài báo.", "", LABEL, "bryan273.github.io/repro-suite/explainer"],
        "id": ["Setiap kutipan dan angka di layar", "dicek terhadap teks makalah.", "", LABEL, "bryan273.github.io/repro-suite/explainer"]}[lang if lang in ("zh", "vi", "id") else "en"]
for i, ln in enumerate(foot):
    g.text((60, by), ln, font=small if i < 3 else mid, fill=(203, 213, 225) if i < 3 else (52, 211, 153)); by += 54 if i < 3 else 62
bg = os.path.join(d, f"vbg_{lang}.png"); im.save(bg)
out = os.path.join(d, f"{arxiv}_{lang}_vertical.mp4")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", bg, "-i", src, "-filter_complex",
                f"[1:v]scale={W}:{VH}[v];[0:v][v]overlay=0:{VY}:shortest=1,scale=720:1280,format=yuv420p[o]", "-map", "[o]", "-map", "1:a",
                "-c:v", "libx264", "-preset", "slow", "-crf", "28", "-r", "30", "-c:a", "copy", "-movflags", "+faststart", out], check=True)
print(out, round(os.path.getsize(out) / 1e6, 1), "MB")
