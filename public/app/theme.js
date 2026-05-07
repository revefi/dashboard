// Theme cycle button: Auto (follow OS) → Light → Dark → Auto.
//
// "Auto" = no localStorage entry, no `data-theme` attribute on <html>; the
// OS preference drives the @media query in base.css.
//
// "Light" / "Dark" = stored under `dashboard.theme` and reflected as
// `data-theme="light|dark"` on <html>. CSS rules in base.css and stacks.css
// override the OS @media query when the attribute is present.
//
// First-paint application of a stored choice happens via an inline <script>
// in index.html's <head> — that runs before stylesheets load, so there's
// no flash of OS theme before the user's preference snaps in. This module
// only handles the toggle button + its label.

import { $ } from "./dom.js";
import { THEME_KEY } from "./storage.js";

const CYCLE = ["auto", "light", "dark"];

function getTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" ? stored : "auto";
}

function setTheme(theme) {
  if (theme === "auto") {
    localStorage.removeItem(THEME_KEY);
    document.documentElement.removeAttribute("data-theme");
  } else {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.setAttribute("data-theme", theme);
  }
}

function labelFor(theme) {
  if (theme === "light") return "☀️ Light";
  if (theme === "dark") return "🌙 Dark";
  return "💻 Auto";
}

function refreshButton() {
  const btn = $("#toggle-theme-btn");
  if (!btn) return;
  btn.textContent = labelFor(getTheme());
}

export function initTheme() {
  refreshButton();
  const btn = $("#toggle-theme-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const cur = getTheme();
    const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
    setTheme(next);
    refreshButton();
  });
}
