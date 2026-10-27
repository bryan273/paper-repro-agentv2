// Light / dark switch. Light is the first impression; a visitor's choice is kept in localStorage.
(() => {
  const KEY = "repro.theme2", root = document.documentElement;
  const get = () => { try { return localStorage.getItem(KEY) || "light"; } catch (e) { return "light"; } };
  const set = (v) => { try { localStorage.setItem(KEY, v); } catch (e) {} };
  const apply = () => root.setAttribute("data-theme", get());
  apply();
  addEventListener("DOMContentLoaded", () => {
    const host = document.querySelector("#themeSlot") || document.querySelector(".toprt") || document.querySelector(".top");
    if (!host) return;
    const b = document.createElement("button");
    b.className = "ghost icon"; b.id = "themeBtn"; b.type = "button";
    const refresh = () => { const dark = get() === "dark"; b.textContent = dark ? "☀" : "☾"; b.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode"); b.title = b.getAttribute("aria-label"); };
    b.onclick = () => { set(get() === "dark" ? "light" : "dark"); apply(); refresh(); };
    host.insertBefore(b, host.firstChild); refresh();
  });
})();
