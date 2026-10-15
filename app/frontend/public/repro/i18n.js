/* English / 中文 switch. The page is written in English; Chinese is looked up by exact text, so every
   string that is not in the table simply stays English. Static HTML and generated markup are both
   covered (a MutationObserver translates what the app inserts later). */
(function () {
  "use strict";
  const ZH = {
    "paper in, checked result out": "输入论文，输出经过核验的结果",
    "Drop a paper. Watch an agent reproduce it.": "上传论文，看智能体把它复现出来。",
    "It reads the PDF, decides what to check, writes and runs the code in a sandbox, then re-runs everything from scratch before it gives a verdict. You see what it reads, what it runs, how long it takes and what it costs.":
      "它会阅读 PDF，决定要核验什么，在沙箱里编写并运行代码，最后从头重新运行一遍再给出结论。你可以看到它读了什么、跑了什么、耗时多久、花了多少钱。",
    "Drop a paper PDF here": "把论文 PDF 拖到这里",
    "or click to choose a file": "或点击选择文件",
    "paste an arXiv ID or URL": "粘贴 arXiv 编号或链接",
    "or": "或",
    "Reading PDF": "正在读取 PDF",
    "arXiv ID or PDF URL": "arXiv 编号或 PDF 链接",
    "Code repository": "代码仓库", "optional": "可选",
    "Which result should it check?": "要核验哪个结果？",
    "Access key": "访问密钥", "needed to start a run on this runner": "在此运行器上启动任务需要",
    "Models and budget": "模型与预算",
    "Same model for every agent": "所有智能体使用同一模型",
    "Max cost (¥)": "费用上限（¥）", "Max minutes": "时间上限（分钟）", "Max steps": "步数上限",
    "Find a paper on arXiv": "在 arXiv 上查找论文",
    "Browse by research group": "按课题组浏览",
    "Research group": "课题组", "Author (A to Z)": "作者（A 到 Z）", "All authors": "全部作者",
    "Filter by title or keyword": "按标题或关键词筛选",
    "Search by author (name in Latin letters, e.g. Yujiu Yang) or by title words. Papers already reproduced on this runner show their verdict; select it to open that run.":
      "可按作者（拉丁字母姓名，如 Yujiu Yang）或标题关键词搜索。已复现过的论文会显示结论，点击即可打开那次运行。",
    "Papers are grouped by research group, each paper once with all its authors. Pick a group, then an author from the A to Z list. Papers already reproduced show their verdict.":
      "论文按课题组归类，每篇只出现一次并列出全部作者。先选课题组，再从 A 到 Z 的列表里选作者。已复现的论文会显示结论。",
    "Author": "作者", "Title or keywords": "标题或关键词", "Search": "搜索",
    "Searching needs a running runner.": "联网搜索需要运行器在线。",
    "Or try a sample paper": "或试试示例论文",
    "One paper for each situation the agent handles: the authors' code works, the code exists but is broken, or there is no code at all.":
      "每种情形各一篇：作者代码可用、代码存在但已损坏、完全没有代码。",
    "How it works": "工作原理",
    "Reader": "阅读者", "Router": "路由者", "Planner": "规划者", "Implementer": "实现者", "Verifier": "核验者",
    "Reads the PDF and writes a claim contract: the number to check, where it is, a tolerance fixed before any run, what a faithful implementation needs, and every detail the paper leaves open.":
      "阅读 PDF 并写出“论断合同”：要核验的数值、它在哪里、运行前就定好的容差、忠实实现所需的条件，以及论文没有交代清楚的每个细节。",
    "Checks what the authors released (full code, partial, or nothing) and whether this machine can run it, including whether a GPU is needed.":
      "检查作者发布了什么（完整代码、部分代码或没有），以及这台机器能否运行，包括是否需要 GPU。",
    "Lays out the files, one config, a smoke test and the checks to run before the full experiment.":
      "列出文件结构、统一配置、冒烟测试，以及完整实验之前要做的检查。",
    "Writes and runs code in a sandbox, alone, until one command re-creates the number. It is never shown the paper's value. A repair manager steps in when it gets stuck.":
      "在沙箱中独立编写并运行代码，直到一条命令就能重现该数值。它从不会看到论文给出的数值。卡住时由修复管理者介入。",
    "Deletes the results, re-runs everything from scratch, searches the code for copied numbers and checks it against the requirements. The verdict comes from that re-run.":
      "删除结果，从头重新运行，检查代码里有没有照抄的数字，并对照要求逐项核对。结论来自这次重新运行。",
    "Recent runs": "最近的运行", "No runs yet.": "还没有运行记录。",
    "Replay mode: no runner connected, recorded runs only": "回放模式：未连接运行器，仅可查看已录制的运行",
    "connecting": "连接中",
    "Reproduced": "已复现", "Partially reproduced": "部分复现", "Not reproduced": "未复现", "Could not run": "无法运行",
    "reproduced": "已复现", "partially reproduced": "部分复现", "not reproduced": "未复现",
    "full release": "完整发布", "partial release": "部分发布", "paper only": "仅论文",
    "running": "运行中",
    "Starting a new run needs a running runner. Try a sample paper to see a recorded run.":
      "启动新运行需要运行器在线。可先点开示例论文查看已录制的运行。",
    "Reproduce this paper": "复现这篇论文",
    "Abstract": "摘要",
    "Load more papers": "加载更多论文",
    "Stop run": "停止运行", "Download report": "下载报告",
    "Reproduction target": "复现目标", "Result": "结果", "Paper and reproduction": "论文与复现对比", "Time and cost": "时间与费用",
    "Defined after the paper has been analysed.": "论文分析完成后给出。", "Pending.": "等待中。",
    "Hide process details": "收起过程详情", "Show process details": "展开过程详情",
    "Annotated paper, execution timeline, agent log and verification audit": "带标注的论文、执行时间线、智能体日志与核验审计",
    "Process summary": "过程摘要", "Time allocation": "时间分配", "Execution timeline": "执行时间线",
    "Scroll horizontally. Select a bar to open that step in the log.": "左右滚动。点选某个条形即可在日志中打开该步骤。",
    "Annotated paper": "带标注的论文", "Waiting for the paper": "等待论文",
    "target result": "目标结果", "requirements": "要求", "unspecified details": "未说明的细节",
    "The PDF appears here.": "PDF 会显示在这里。",
    "Agent log": "智能体日志", "key events": "关键事件", "all events": "全部事件", "model reasoning": "模型推理",
    "Status": "状态", "Filled in as the run progresses.": "随运行进展填写。",
    "Pick a paper first.": "请先选择一篇论文。", "Preparing the kit...": "正在准备任务包……",
    "Kit link": "任务包链接", "Copy as a prompt": "复制为提示词", "Open the kit": "打开任务包",
    "Paste it into Claude Code, Codex or any agent that can read a URL and run commands. It does the experiment on your machine and posts the result back here.":
      "把它粘贴到 Claude Code、Codex 或任何能读取网址并执行命令的智能体里。它会在你的机器上做实验，并把结果送回这里。",
    "Could not prepare the kit:": "无法准备任务包：",
    "Get a link that holds the full instructions. Give it to any agent; the run happens on your own machine.": "生成一个包含完整说明的链接。交给任意智能体即可，运行发生在你自己的机器上。",
    "Make the link": "生成链接",
    "Waiting for an agent to pick it up": "等待智能体领取", "An agent is working on it": "智能体正在处理", "Finished": "已完成", "Failed": "失败",
    "Run it on your own agent": "用你自己的智能体运行",
    "Copy the link": "复制链接", "Copied": "已复制"
  };
  const PAT = [
    [/^([0-9]+) recorded runs?: (.+)$/, (m) => m[1] + " 次录制：" + m[2]],
    [/^([0-9]+) recorded runs?$/, (m) => m[1] + " 次录制"],
    [/^Show all ([0-9]+) runs$/, (m) => "显示全部 " + m[1] + " 次运行"],
    [/^([0-9]+) papers in this group$/, (m) => "本组共 " + m[1] + " 篇论文"],
    [/^([0-9]+) papers shown$/, (m) => "显示 " + m[1] + " 篇论文"],
    [/^Runner online · ([0-9]+) CPU cores · ([0-9.]+) GB RAM · GPU ([^ ]+) · spent ¥([0-9.]+)$/, (m) => "运行器在线 · " + m[1] + " 个 CPU 核 · " + m[2] + " GB 内存 · GPU " + m[3] + " · 已花费 ¥" + m[4]]
  ];
  let lang = "en";
  try { lang = localStorage.getItem("lang") || (/^zh/i.test(navigator.language) ? "zh" : "en"); } catch (e) {}
  const orig = new WeakMap();
  const tr = (s) => {
    const k = s.trim();
    if (!k) return null;
    if (ZH[k]) return s.replace(k, ZH[k]);
    for (const [re, f] of PAT) { const m = k.match(re); if (m) return s.replace(k, f(m)); }
    return null;
  };
  function node(n) {
    if (n.nodeType === 3) {
      if (!orig.has(n)) orig.set(n, n.nodeValue);
      const o = orig.get(n);
      const z = lang === "zh" ? tr(o) : null;
      const want = z == null ? o : z;
      if (n.nodeValue !== want) n.nodeValue = want;
    } else if (n.nodeType === 1) {
      if (/^(SCRIPT|STYLE|CANVAS|PRE|CODE|TEXTAREA)$/.test(n.tagName)) return;
      for (const a of ["placeholder", "aria-label", "title"]) {
        if (!n.hasAttribute(a) && !n.hasAttribute("data-en-" + a)) continue;
        const key = "data-en-" + a;
        if (!n.hasAttribute(key)) n.setAttribute(key, n.getAttribute(a));
        const o = n.getAttribute(key), z = lang === "zh" ? tr(o) : null;
        n.setAttribute(a, z == null ? o : z);
      }
      n.childNodes.forEach(node);
    }
  }
  let busy = false;
  const mo = new MutationObserver((muts) => {
    if (busy) return;
    busy = true;
    for (const m of muts) {
      m.addedNodes.forEach((a) => node(a));
      if (m.type === "characterData") { orig.delete(m.target); node(m.target); }
    }
    busy = false;
  });
  function apply() {
    busy = true; node(document.body); busy = false;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    const b = document.getElementById("langBtn");
    if (b) b.textContent = lang === "zh" ? "EN" : "中文";
  }
  window.t = (s) => (lang === "zh" ? tr(s) || s : s);
  window.getLang = () => lang;
  function init() {
    const b = document.getElementById("langBtn");
    if (b) b.onclick = () => { lang = lang === "zh" ? "en" : "zh"; try { localStorage.setItem("lang", lang); } catch (e) {} apply(); };
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    apply();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
