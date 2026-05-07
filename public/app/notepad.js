// Markdown remarks editor — used by the standalone notepad in the right
// column AND inline in stack cards / Jira rows. View mode renders markdown
// via the global `marked` library; clicking the view swaps in a textarea.

import { $, esc } from "./dom.js";

export function renderMarkdown(text) {
  if (!text) return "";
  if (typeof window.marked === "undefined") {
    // marked.min.js may still be loading on first paint — fall back to plain text.
    return esc(text).replace(/\n/g, "<br>");
  }
  return window.marked.parse(text, { breaks: true, gfm: true });
}

function wrapSelection(textarea, before, after) {
  const { selectionStart: s, selectionEnd: e, value } = textarea;
  const text = value.slice(s, e);
  textarea.setRangeText(`${before}${text}${after}`, s, e, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export function wireMarkdownRemarks(wrap, persistKey, opts = {}) {
  // Idempotent per element instance — call after every render.
  if (wrap._mdWired) return;
  wrap._mdWired = true;

  const placeholder = opts.placeholder || "Add a note…";
  const stored = localStorage.getItem(persistKey) || "";

  const view = document.createElement("div");
  view.className = "md-view";
  if (stored) view.innerHTML = renderMarkdown(stored);
  else view.innerHTML = `<span class="md-placeholder">${esc(placeholder)}</span>`;

  const editor = document.createElement("textarea");
  editor.className = "md-editor";
  editor.spellcheck = false;
  editor.hidden = true;
  editor.value = stored;
  editor.placeholder = placeholder;
  editor.rows = Math.max(1, stored.split("\n").length);

  view.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    e.stopPropagation();
    enterEdit();
  });

  function autoSize() {
    editor.style.height = "auto";
    editor.style.height = editor.scrollHeight + "px";
  }
  function enterEdit() {
    editor.value = localStorage.getItem(persistKey) || "";
    view.hidden = true;
    editor.hidden = false;
    autoSize();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }
  function exitEdit() {
    const next = editor.value;
    if (next === "") localStorage.removeItem(persistKey);
    else localStorage.setItem(persistKey, next);
    view.innerHTML = next
      ? renderMarkdown(next)
      : `<span class="md-placeholder">${esc(placeholder)}</span>`;
    editor.hidden = true;
    view.hidden = false;
  }

  editor.addEventListener("blur", exitEdit);
  editor.addEventListener("input", autoSize);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
      e.preventDefault();
      editor.blur();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      wrapSelection(editor, "**", "**");
    } else if (k === "i") {
      e.preventDefault();
      wrapSelection(editor, "*", "*");
    } else if (k === "k") {
      e.preventDefault();
      const url = prompt("Link URL:", "https://");
      if (url) {
        const { selectionStart: s, selectionEnd: e2, value } = editor;
        const text = value.slice(s, e2) || "link";
        editor.setRangeText(`[${text}](${url})`, s, e2, "end");
        autoSize();
      }
    }
  });

  wrap.innerHTML = "";
  wrap.appendChild(view);
  wrap.appendChild(editor);
}

const NOTEPAD_HIDDEN_KEY = "dashboard.notepad_hidden";

export function applyNotepadVisibility() {
  const hidden = localStorage.getItem(NOTEPAD_HIDDEN_KEY) === "1";
  document.querySelector(".layout")?.classList.toggle("notepad-hidden", hidden);
  const btn = $("#toggle-notepad-btn");
  if (btn) btn.textContent = hidden ? "📓 Show notepad" : "📓 Hide notepad";
}

export function toggleNotepad() {
  const cur = localStorage.getItem(NOTEPAD_HIDDEN_KEY) === "1";
  localStorage.setItem(NOTEPAD_HIDDEN_KEY, cur ? "0" : "1");
  applyNotepadVisibility();
}

export function initNotepad() {
  const el = $("#notepad-content");
  if (!el) return;
  wireMarkdownRemarks(el, el.dataset.mdKey, {
    placeholder: "Scratch space — markdown is welcome.",
  });
  // Saved-indicator hint: when the editor's blur fires (which is when
  // wireMarkdownRemarks persists), flash a brief "saved" label.
  const saved = $("#notepad-saved");
  let savedTimer = null;
  el.addEventListener(
    "blur",
    () => {
      if (!saved) return;
      saved.classList.add("show");
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => saved.classList.remove("show"), 1200);
    },
    true /* capture so we catch the textarea's blur from inside the wrap */
  );
}
