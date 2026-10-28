"""Copy the finished vertical and 16:9 videos into a folder with a caption file per platform. Captions come from each
video's own checked script (scenes.json), so every claim in a post is one the video already shows."""
import os, sys, json, shutil
sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
SITE = "https://paperexplainer-aiid.pub.atoms.world"
os.makedirs(OUT, exist_ok=True)
lines = ["# Paper Explainer social kit", "", "Each paper has a 9:16 video for Douyin, Xiaohongshu, Bilibili, Reels and Shorts, and a 16:9 video for X, LinkedIn and Bilibili.",
         "Captions use only what the video says; every quote and number in it was checked against the paper.", ""]
for a in sys.argv[2:]:
    d = os.path.join(ROOT, "out", a)
    sc = json.load(open(os.path.join(d, "scenes.json"), encoding="utf-8"))
    s = sc["scenes"]
    num = next((x for x in s if x["type"] == "number"), None)
    title = sc.get("paper_title") or sc["title"]
    for f in (f"{a}_en_vertical.mp4", f"{a}_zh_vertical.mp4", f"{a}_en.mp4", f"{a}_zh.mp4"):
        shutil.copy(os.path.join(d, f), os.path.join(OUT, f))
    link = f"{SITE}/?v={a}"
    en = [s[0]["en"], s[2]["en"] if len(s) > 2 else ""]
    zh = [s[0]["zh"], s[2]["zh"] if len(s) > 2 else ""]
    if num: en.append(num["en"]); zh.append(num["zh"])
    lines += [f"## {title} (arXiv:{a})", "",
              f"Files: `{a}_en_vertical.mp4`, `{a}_zh_vertical.mp4`, `{a}_en.mp4`, `{a}_zh.mp4`", "",
              "**X / LinkedIn (English)**", "", "> " + " ".join(x for x in en if x), ">",
              f"> 40 seconds, every quote and number checked against the paper. Make one for any arXiv paper: {link}", ">",
              "> #AI #MachineLearning #research #arXiv", "",
              "**小红书 / 抖音 / B站 (中文)**", "", f"> 一分钟看懂《{title}》", ">", "> " + " ".join(x for x in zh if x), ">",
              f"> 视频里的每句引文和每个数字都和论文原文核对过。任何 arXiv 论文都可以生成：{link}", ">",
              "> #人工智能 #论文解读 #机器学习 #科研 #AI", ""]
    print("kit", a)
open(os.path.join(OUT, "captions.md"), "w", encoding="utf-8").write("\n".join(lines))
print(OUT)
