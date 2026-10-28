import sys, os, json, asyncio, subprocess
sys.stdout.reconfigure(encoding="utf-8")
import edge_tts
D = "C:/w/explainer/out/report"
S = [
 dict(type="title", big="Repro Suite", sub="Six tools that check and explain research claims",
      en="We built Repro Suite: six tools that check whether a research claim really holds.",
      zh="我们做了 Repro Suite：六个工具，检验并解释论文结论是否成立。", evidence=None),
 dict(type="cards", cards=[{"h":"Nobody re-checks","t":"Papers report numbers that stay unverified"},{"h":"Hours to rebuild","t":"Re-implementing a result is slow"},{"h":"Trust by default","t":"Readers guess instead of check"}],
      en="Many papers report numbers that nobody re-checks, and rebuilding them takes hours.",
      zh="很多论文的数字没人复核，而重新实现一遍要花好几个小时。", evidence="The problem we start from"),
 dict(type="flow", nodes=[{"h":"Read","t":"claim contract"},{"h":"Fix tolerance","t":"before any code"},{"h":"Write code","t":"sandbox run"},{"h":"Clean re-run","t":"from scratch"},{"h":"Audit","t":"verdict"}],
      en="The core agent reads a paper, fixes the tolerance before any code runs, writes code, re-runs it from scratch, and audits itself.",
      zh="核心智能体先读论文，在写代码之前固定容差，写代码，从头重跑，再自我审计。", evidence="Paper Repro Agent pipeline"),
 dict(type="number", value=281, unit="runs", label="6 models, 32 papers, one fixed verifier",
      bars=[{"label":"Top model, Repro Index","value":89.2},{"label":"Lowest, Repro Index","value":81.4}],
      en="We compared six models on thirty two papers in two hundred eighty one runs. Five of the six are statistically tied with the best, and run to run noise is about seven points.",
      zh="我们在 32 篇论文上比较了 6 个模型，共 281 次运行。六个模型中有五个与最佳模型在统计上持平，同一模型两次运行的波动约 7 分。", evidence="Benchmark page, data of 2026-10-23"),
 dict(type="cards", cards=[{"h":"Repro Lite","t":"Check one claim in the browser, about 40 seconds"},{"h":"Reading Companion","t":"Reads arXiv, cites every claim"},{"h":"IndexBoard","t":"Honest leaderboards, AI-built from text"}],
      en="Three small tools reuse the idea: Repro Lite checks one claim in your browser, Reading Companion cites every claim, and IndexBoard builds honest leaderboards.",
      zh="三个小工具沿用同一思路：Repro Lite 在浏览器里检验一条结论，阅读伙伴为每个论断给出引用，IndexBoard 生成诚实的排行榜。", evidence="Live on Atoms"),
 dict(type="cards", cards=[{"h":"Paper Explainer","t":"A paper becomes a short cinematic video"},{"h":"Repro Desk","t":"Tests if researchers want human-checked runs"},{"h":"Repro Suite hub","t":"One door to all six tools"}],
      en="Paper Explainer turns a paper into a short video, Repro Desk tests real demand, and one hub opens all six tools.",
      zh="Paper Explainer 把论文变成短视频，Repro Desk 验证真实需求，一个主页可以打开全部六个工具。", evidence="Live on Atoms"),
 dict(type="cards", cards=[{"h":"Fast to build","t":"A full app from one prompt in about 15 minutes"},{"h":"Rough spots","t":"No error reason, manual GitHub sync, no credit trace"},{"h":"Our ask","t":"Feedback, one real use case, quota direction"}],
      en="Atoms made building fast, with a few rough spots we documented. We would love your feedback, one real use case, and your view on where the next quota should go.",
      zh="Atoms 让搭建很快，也有几处不顺，我们已记录。希望听到你们的反馈、一个真实用例，以及下一步额度该投向哪个方向。", evidence="Atoms feedback report"),
 dict(type="end", big="Thank you", sub="reprosuite-aiid.atoms.world", note="Group 1, Tsinghua SIGS AIID capstone",
      en="Thank you. Everything is live at the Repro Suite hub.",
      zh="谢谢。全部工具都已上线，入口是 Repro Suite 主页。", evidence=None),
]
async def tts(text, voice, path):
    for k in range(6):
        try:
            await asyncio.wait_for(edge_tts.Communicate(text, voice, rate="-4%", proxy=None if k % 2 == 0 else "http://127.0.0.1:7897").save(path), 45)
            if os.path.getsize(path) > 2000: return
        except Exception: await asyncio.sleep(1.5)
    raise RuntimeError("tts failed " + path)
def dur(p): return float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",p]).decode().strip())*1000
async def main():
    for lang, voice in (("en","en-US-AriaNeural"),("zh","zh-CN-XiaoxiaoNeural")):
        sc = json.loads(json.dumps(S))
        for i, s in enumerate(sc):
            p = f"{D}/{lang}_{i}.mp3"
            if not (os.path.exists(p) and os.path.getsize(p) > 2000): await tts(s[lang], voice, p)
            s["audio"] = f"{lang}_{i}.mp3"; s["dur"] = int(max(dur(p) + 900, 3200))
            if s["type"] in ("cards","flow"): s["dur"] = max(s["dur"], 4600)
            if s["type"] == "number": s["dur"] = max(s["dur"], 6500)
            if s.get("evidence"): s["evidence"] = s["evidence"]
        json.dump({"title":"Repro Suite report","arxiv":"report","lang":lang,"scenes":sc,"total":sum(x["dur"] for x in sc)}, open(f"{D}/script_{lang}.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
        print(lang, round(sum(x["dur"] for x in sc)/1000,1), "s")
asyncio.run(main())
