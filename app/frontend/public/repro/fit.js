/* Will this paper run on my machine, and how long will it take?  Same numbers as repro/probe.py (tests/test_core.py
   checks that the two agree). Pure functions on the Router's `compute` object; no network, no DOM. */
(function () {
  "use strict";
  const G_REF_CPU = 70, G_REF_GPU = 9;
  // Typical machines, with the speeds our probe reads on them (float32 matrix multiply). Rough, and meant to be.
  const CLASSES = [
    { id: "laptop-4c", name: "Laptop, 4 cores", cpu: 35, ram: 8 },
    { id: "laptop-8c", name: "Laptop, 8 cores (reference)", cpu: 70, ram: 16 },
    { id: "desktop-16c", name: "Desktop, 16 cores", cpu: 125, ram: 32 },
    { id: "apple-m", name: "Apple M-series laptop", cpu: 90, ram: 16, gpu: 5, vram: 12 },
    { id: "gpu-entry", name: "Laptop with a small GPU (4 GB)", cpu: 70, ram: 16, gpu: 3, vram: 4 },
    { id: "gpu-mid", name: "Gaming PC (RTX 3060 class)", cpu: 100, ram: 32, gpu: 9, vram: 12 },
    { id: "gpu-high", name: "Workstation (RTX 4090 class)", cpu: 150, ram: 64, gpu: 40, vram: 24 },
    { id: "server-gpu", name: "Cloud GPU server (A100 class)", cpu: 150, ram: 128, gpu: 25, vram: 40 },
  ];
  const overhead = (d) => 8 + 3 * (d || 3);

  function estimate(compute, m) {
    const c = compute || {};
    if (c.ref_minutes == null) return { known: false };
    const d = c.difficulty || 3, ov = overhead(d), paths = {}, problems = [];
    if (!c.needs_gpu) paths.cpu = ov + c.ref_minutes / Math.max(m.cpu / G_REF_CPU, 0.05);
    if (m.gpu && c.gpu_speedup && (c.vram_gb == null || m.vram == null || m.vram >= c.vram_gb)) {
      paths.gpu = ov + c.ref_minutes / Math.max(c.gpu_speedup * m.gpu / G_REF_GPU, 0.05);
    }
    if (c.needs_gpu && !paths.gpu) problems.push("gpu");
    if (c.ram_gb && m.ram && m.ram < c.ram_gb) problems.push("ram");
    if (!Object.keys(paths).length || problems.length) return { known: true, feasible: false, problems, difficulty: d };
    const path = Object.keys(paths).reduce((a, b) => (paths[a] <= paths[b] ? a : b)), v = paths[path];
    const r1 = (x) => Math.round(x * 10) / 10;
    return { known: true, feasible: true, path, minutes: r1(v), low: r1(v * 0.6), high: r1(v * 1.8), difficulty: d, overhead: r1(ov) };
  }

  function tier(compute) {
    const e = estimate(compute, CLASSES[1]);
    if (!e.known) return null;
    if (!e.feasible) return "heavy";
    return e.minutes <= 30 ? "light" : e.minutes <= 90 ? "medium" : "heavy";
  }

  const forClasses = (compute) => CLASSES.map((m) => ({ ...m, est: estimate(compute, m) }));

  function fmt(min) {
    const zh = window.getLang && window.getLang() === "zh";
    if (min < 90) return Math.round(min) + (zh ? " 分钟" : " min");
    const h = min / 60;
    return (h < 10 ? h.toFixed(1) : Math.round(h)) + (zh ? " 小时" : " h");
  }

  // What the browser can tell us without asking: cores and, when it allows, the graphics card name.
  function browserGuess() {
    const cores = navigator.hardwareConcurrency || null;
    let gpu = null;
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    } catch (e) {}
    let cls = cores && cores <= 4 ? "laptop-4c" : cores && cores <= 8 ? "laptop-8c" : "desktop-16c";
    if (gpu) {
      if (/apple/i.test(gpu)) cls = "apple-m";
      else if (/rtx\s?(40[7-9]0|50)|a100|h100/i.test(gpu)) cls = "gpu-high";
      else if (/rtx|geforce (gtx )?(1[6-9]|20|30|40)|radeon rx (6|7)/i.test(gpu) && !/intel/i.test(gpu)) cls = "gpu-mid";
      else if (/gtx|mx\d|nvidia/i.test(gpu)) cls = "gpu-entry";
    }
    return { cores, gpu, cls };
  }

  window.Fit = { G_REF_CPU, G_REF_GPU, CLASSES, overhead, estimate, tier, forClasses, fmt, browserGuess };
})();
