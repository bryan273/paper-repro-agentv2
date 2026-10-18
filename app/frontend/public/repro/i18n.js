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
    "Reproduction status": "复现状态", "All papers": "全部论文", "Already reproduced": "已复现", "Not reproduced yet": "尚未复现",
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
    "Get the link": "获取链接", "Skip: my own agent does steps 1 to 3": "跳过：由我自己的智能体完成第 1 到 3 步",
    "Running steps 1 to 3 on the server. The link appears when they are done (about 2 minutes).": "正在服务器上运行第 1 到 3 步，完成后会出现链接（约 2 分钟）。",
    "Steps 1 to 3 are left to your agent.": "第 1 到 3 步留给你的智能体完成。", "Steps 1 to 3 are done.": "第 1 到 3 步已完成。",
    "Steps 1 to 3 were reused from an earlier run of this paper": "第 1 到 3 步沿用了这篇论文之前的结果", "Run steps 1 to 3 again": "重新运行第 1 到 3 步",
    "Steps 1 to 3 did not finish; your agent will do the missing ones.": "第 1 到 3 步未完成，缺少的部分由你的智能体补做。",
    "Critic": "审阅者", "Publishing the link": "发布链接", "Reusing the earlier steps 1 to 3 of this paper": "正在沿用这篇论文之前的第 1 到 3 步",
    "Already reproduced": "已复现", "Not reproduced yet": "尚未复现",
    "Open a recorded run, or get the link below to run it again on your own agent.": "可打开已录制的运行，或用下面的链接在你自己的智能体上重新运行。",
    "Get the link below, give it to your agent, and the result is saved here.": "获取下面的链接交给你的智能体，结果会保存在这里。",
    "We read and plan the paper for you (about 2 minutes, instant if this paper was done before). You then get one link to paste into any agent. The experiment runs on your own machine.": "我们为你阅读并规划这篇论文（约 2 分钟，做过的论文则立即完成），然后给你一个链接，粘贴到任意智能体即可。实验在你自己的机器上运行。",
    "Get the link now (uses the saved steps 1 to 3)": "立即获取链接（使用已保存的第 1 到 3 步）",
    "Read and plan the paper again first (about 2 minutes)": "先重新阅读并规划论文（约 2 分钟）",
    "Get the link (reads and plans the paper first, about 2 minutes)": "获取链接（先阅读并规划论文，约 2 分钟）",
    "We read and plan the paper for you. You then get one link to paste into any agent. The experiment runs on your own machine.": "我们为你阅读并规划论文，然后给你一个链接，粘贴到任意智能体即可。实验在你自己的机器上运行。",
    "Paste this into your agent": "把这段话粘贴给你的智能体", "Copy this prompt": "复制这段提示词", "Copy only the link": "只复制链接", "Press Ctrl+C to copy": "请按 Ctrl+C 复制",
    "Runs from users' own agents": "用户自己的智能体完成的运行",
    "Back to the papers": "返回论文列表",
    "← Back to the papers": "← 返回论文列表",
    "ago": "前",
    "Waiting for an agent": "等待智能体",
    "In progress": "进行中",
    "Finished": "已完成",
    "Failed": "失败",
    "Loading...": "加载中……",
    "Verdict": "结论",
    "Checked": "核验内容",
    "Paper value": "论文数值",
    "Measured": "实测值",
    "within the band": "在容差内",
    "outside the band": "超出容差",
    "rule": "规则",
    "contract said": "合同写的是",
    "Scaled down": "是否缩小规模",
    "yes": "是",
    "no": "否",
    "none": "无",
    "Flags": "标记",
    "Command": "命令",
    "Run time": "运行时间",
    "Posted": "提交时间",
    "Requirement check": "要求核对",
    "Assumptions the agent made": "智能体做出的假设",
    "End of the clean re-run log": "干净重跑日志的结尾",
    "Everything the agent posted": "智能体提交的全部内容",
    "Independent audit": "独立审计",
    "The audit did not finish yet; the page asks again.": "审计尚未完成，页面会再次请求。",
    "Not done yet. It starts when the result is in.": "尚未进行，结果提交后自动开始。",
    "Paper value written in the code": "代码中写入了论文数值",
    "yes, a warning sign": "是，这是警示信号",
    "Code uploaded": "已上传代码",
    "Right experiment": "实验正确",
    "Code the agent uploaded": "智能体上传的代码",
    "characters": "个字符",
    "Download": "下载",
    "Steps 1 to 3: what the agent was given": "第 1 到 3 步：交给智能体的内容",
    "Claim contract": "论断合同",
    "corrections by the critic": "处审阅修正",
    "Claims": "论断",
    "Route": "路由",
    "Plan": "计划",
    "History": "历史记录",
    "No such run.": "找不到这次运行。",
    "run": "运行",
    "Started": "开始于",
    "last activity": "最近活动",
    "updating": "自动更新中",
    "No agent has started on this run yet.": "还没有智能体开始这次运行。",
    "The agent is still working. The history below updates by itself.": "智能体仍在工作，下面的历史记录会自动更新。",
    "Could not load this run:": "无法加载这次运行：",
    "Open the full run page (history, result, code)": "打开完整运行页面（历史、结果、代码）",
    "Target": "目标",
    "Tolerance": "容差",
    "Difference": "差值",
    "Your name (optional, shown on the run)": "你的名字（可选，会显示在这次运行上）",
    "Who ran it": "运行者信息",
    "Agent app": "智能体应用",
    "Model": "模型",
    "Machine": "机器",
    "Requested by": "发起人",
    "Link created": "链接创建于",
    "Agent started": "智能体开始于",
    "Result posted": "结果提交于",
    "Agent working time": "智能体工作时长",
    "not reported": "未报告",
    "Run on a user's own agent": "用户自己的智能体完成了一次运行",
    "runs on users' own agents": "次用户自己的智能体运行",
    "See the full history, day by day": "查看完整历史记录（按天分组）",
    "No runs from users' agents yet.": "还没有用户智能体的运行记录。",
    "Run history": "运行历史",
    "Every run, newest first, grouped by day: runs on users' own agents and the recorded runs of the built-in agent.": "所有运行，最新的在前，按天分组：用户自己智能体的运行，以及内置智能体的录制运行。",
    "Paper or text": "论文或文字",
    "All results": "全部结论",
    "Not finished": "未完成",
    "Agent": "智能体",
    "All agents": "全部智能体",
    "Today": "今天",
    "Yesterday": "昨天",
    "Earlier sample runs": "更早的示例运行",
    "run": "次运行",
    "runs": "次运行",
    "in progress": "进行中",
    "recorded run": "录制的运行",
    "No runs match.": "没有符合条件的运行。",
    "Could not load the history:": "无法加载历史记录：",
    "run id": "运行编号",
    "Make the link": "生成链接", "Run steps 1 to 3 here, then make the link": "先在这里运行第 1 到 3 步，再生成链接", "Only make the link (my agent does steps 1 to 3)": "只生成链接（第 1 到 3 步由我的智能体完成）",
    "Run steps 1 to 3 here first": "先在这里运行第 1 到 3 步", "Steps 1 to 3 could not start:": "第 1 到 3 步无法启动：",
    "Waiting for an agent to pick it up": "等待智能体领取", "An agent is working on it": "智能体正在处理", "Finished": "已完成", "Failed": "失败",
    "Run it on your own agent": "用你自己的智能体运行",
    "Metric": "指标",
    "(higher is better)": "（越高越好）",
    "(lower is better)": "（越低越好）",
    "Reported value": "论文报告值",
    "Source": "出处",
    "Acceptance criterion": "验收标准",
    "Code availability": "代码可用性",
    "Compute required": "所需算力",
    "Summary of the paper": "论文摘要",
    "based on an independent clean re-run": "基于独立的干净重跑",
    "Reported (paper)": "论文报告值",
    "clean re-run": "干净重跑",
    "Difference": "差值",
    "Dataset": "数据集",
    "Evaluation": "评估",
    "Value": "数值",
    "Setup": "设置",
    "Compute": "算力",
    "Paper": "论文",
    "Reproduction": "复现",
    "wall-clock time": "总耗时",
    "model cost": "模型费用",
    "model calls": "模型调用",
    "tokens in / out": "输入/输出 token",
    "commands executed": "已执行命令",
    "hardware": "硬件",
    "Wall-clock time by stage": "各阶段耗时",
    "Paper analysis": "论文分析",
    "Implementation": "实现",
    "Supervision": "监督",
    "Independent verification": "独立验证",
    "Command execution": "命令执行",
    "Model inference": "模型推理",
    "Other": "其他",
    "Stages": "阶段",
    "Model calls": "模型调用",
    "Commands": "命令",
    "paper analysis": "论文分析",
    "release and compute check": "发布与算力检查",
    "implementation plan": "实现计划",
    "code and experiments": "代码与实验",
    "independent re-run and audit": "独立重跑与审计",
    "jump to end": "跳到结尾",
    "rationale": "理由",
    "✓ consistent": "✓ 一致",
    "CPU only; no GPU required": "仅需 CPU，无需 GPU",
    "installs, downloads, training, evaluation, clean re-run": "安装、下载、训练、评估、干净重跑",
    "file operations, connection retries, waiting": "文件操作、连接重试、等待",
    "Not run": "未运行",
    "Pending": "等待中",
    "Download": "下载",
    "Audit": "审计", "paper value found in the code": "代码中发现论文数值", "flags": "标记", "no flags": "无标记",
    "Copy the link": "复制链接", "Copied": "已复制"
  };
  const PAT = [
    [/^([0-9]+) recorded runs?: (.+)$/, (m) => m[1] + " 次录制：" + m[2]],
    [/^([0-9]+) recorded runs?$/, (m) => m[1] + " 次录制"],
    [/^Show all ([0-9]+) runs$/, (m) => "显示全部 " + m[1] + " 次运行"],
    [/^([0-9]+) papers in this group(, ([0-9]+) reproduced)?$/, (m) => "本组共 " + m[1] + " 篇论文" + (m[3] ? "，其中 " + m[3] + " 篇已复现" : "")],
    [/^([0-9]+) papers shown$/, (m) => "显示 " + m[1] + " 篇论文"],
    [/^Runner online · ([0-9]+) CPU cores · ([0-9.]+) GB RAM · GPU ([^ ]+) · spent ¥([0-9.]+)$/, (m) => "运行器在线 · " + m[1] + " 个 CPU 核 · " + m[2] + " GB 内存 · GPU " + m[3] + " · 已花费 ¥" + m[4]]
  ];
  let lang = "en";
  try { lang = localStorage.getItem("lang") || (/^zh/i.test(navigator.language) ? "zh" : "en"); } catch (e) {}
  const orig = new WeakMap();
  const wrote = new WeakMap();   // what this file last wrote into a text node, so its own change is not taken for the app's
  const REV = {};
  for (const k in ZH) if (!(ZH[k] in REV)) REV[ZH[k]] = k;
  // text the app rendered already in Chinese (through window.t) gets its English source back
  const en = (s) => { const k = s.trim(); return k && REV[k] ? s.replace(k, REV[k]) : s; };
  const tr = (s) => {
    const k = s.trim();
    if (!k) return null;
    if (ZH[k]) return s.replace(k, ZH[k]);
    for (const [re, f] of PAT) { const m = k.match(re); if (m) return s.replace(k, f(m)); }
    return null;
  };
  function node(n) {
    if (n.nodeType === 3) {
      if (!orig.has(n)) orig.set(n, en(n.nodeValue));
      const o = orig.get(n);
      const z = lang === "zh" ? tr(o) : null;
      const want = z == null ? o : z;
      if (n.nodeValue !== want) n.nodeValue = want;
      wrote.set(n, n.nodeValue);
    } else if (n.nodeType === 1) {
      if (/^(SCRIPT|STYLE|CANVAS|PRE|CODE|TEXTAREA)$/.test(n.tagName)) return;
      for (const a of ["placeholder", "aria-label", "title"]) {
        if (!n.hasAttribute(a) && !n.hasAttribute("data-en-" + a)) continue;
        const key = "data-en-" + a;
        if (!n.hasAttribute(key)) n.setAttribute(key, en(n.getAttribute(a)));
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
      if (m.type === "characterData" && wrote.get(m.target) !== m.target.nodeValue) { orig.delete(m.target); node(m.target); }
    }
    busy = false;
  });
  function apply() {
    busy = true; node(document.body); busy = false;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    const b = document.getElementById("langBtn");
    if (b) b.textContent = lang === "zh" ? "EN" : "中文";
    document.dispatchEvent(new CustomEvent("langchange", { detail: lang }));
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
