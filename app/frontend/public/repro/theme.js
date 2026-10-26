// Light / dark switch. "auto" follows the system; the choice is kept in localStorage.
(() => {
  const KEY = "repro.theme", root = document.documentElement;
  const get = () => { try { return localStorage.getItem(KEY) || "auto"; } catch (e) { return "auto"; } };
  const set = (v) => { try { localStorage.setItem(KEY, v); } catch (e) {} };
  const sys = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const apply = () => { const v = get(); if (v === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", v); };
  apply();
  const label = () => { const eff = get() === "auto" ? sys() : get(); return eff === "dark" ? "☀" : "☾"; };
  addEventListener("DOMContentLoaded", () => {
    const host = document.querySelector(".toprt") || document.querySelector(".top");
    if (!host) return;
    const b = document.createElement("button");
    b.className = "ghost"; b.id = "themeBtn"; b.type = "button";
    const refresh = () => { b.textContent = label(); const eff = get() === "auto" ? sys() : get(); b.setAttribute("aria-label", eff === "dark" ? "Switch to light mode" : "Switch to dark mode"); b.title = b.getAttribute("aria-label"); };
    b.onclick = () => { const eff = get() === "auto" ? sys() : get(); set(eff === "dark" ? "light" : "dark"); apply(); refresh(); };
    host.insertBefore(b, host.firstChild); refresh();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { apply(); refresh(); });
  });
})();
