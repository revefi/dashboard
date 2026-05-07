// Event delegation. Idempotent — wireDelegates() is called after every
// render; per-element flags (`_xxxWired`) prevent re-binding.

import { $$ } from "./dom.js";
import { store } from "./store.js";
import {
  JIRA_REMARKS_PREFIX,
  toggleCompleted,
  setStackNameOverride,
} from "./storage.js";
import { wireMarkdownRemarks } from "./notepad.js";
import { handleRestackClick } from "./restack-action.js";
import { openStateMenu } from "./jira-state.js";
import { updateCollapseAllLabel } from "./refresh.js";

export function wireDelegates() {
  // Stack-card toggle: click the .stack-summary to flip the `expanded` class on
  // the parent .stack-card. We use a custom toggle (not <details>/<summary>)
  // because contenteditable inside <summary> has too many focus / Space-key
  // edge cases to fight with.
  $$("[data-toggle-card]").forEach((el) => {
    if (el._toggleWired) return;
    el._toggleWired = true;
    el.addEventListener("click", (e) => {
      // Defensive: if the click came from a child that wasn't supposed to
      // bubble, bail. Buttons and copy chips already call stopPropagation,
      // but if we ever miss one, this skips the toggle for any element that
      // has its own onclick.
      if (e.target.closest("[data-stop-toggle]")) return;
      const card = el.closest(".stack-card");
      if (!card) return;
      card.classList.toggle("expanded");
      updateCollapseAllLabel();
    });
  });

  // Stack remarks (markdown persisted to localStorage). On first sight of
  // a stack, we migrate any Untouched-Jira remarks for this stack's Jira keys
  // into the stack remarks so notes you wrote before the PR existed don't get
  // stranded. Migration is one-time per Jira key — the source entry is removed
  // after merging, so subsequent renders don't double-migrate.
  $$(".stack-remarks").forEach((el) => {
    const storeKey = el.dataset.mdKey;
    const card = el.closest(".stack-card");
    const stack = card
      ? store.currentData?.stacks?.find((s) => s.stack_key === card.dataset.stackKey)
      : null;
    let stored = localStorage.getItem(storeKey) || "";
    if (stack && Array.isArray(stack.jira_keys)) {
      const migrated = [];
      for (const jk of stack.jira_keys) {
        const jiraStored = localStorage.getItem(JIRA_REMARKS_PREFIX + jk);
        if (jiraStored && jiraStored.trim()) {
          migrated.push(`*↳ from ${jk}*\n\n${jiraStored}`);
          localStorage.removeItem(JIRA_REMARKS_PREFIX + jk);
        }
      }
      if (migrated.length > 0) {
        const merged = migrated.join("\n\n---\n\n");
        stored = stored ? `${stored}\n\n---\n\n${merged}` : merged;
        localStorage.setItem(storeKey, stored);
      }
    }

    wireMarkdownRemarks(el, storeKey, {
      placeholder: "Add a note for this stack…",
    });
  });

  // Jira row remarks.
  $$("tr.jira-row").forEach((row) => {
    const rem = row.querySelector(".remarks");
    if (rem) {
      wireMarkdownRemarks(rem, rem.dataset.mdKey, { placeholder: "Add note…" });
    }
  });

  // Copy buttons. Stop propagation so clicks don't toggle the parent card
  // when this button lives inside the card summary.
  $$("[data-copy]").forEach((el) => {
    if (el._copyWired) return;
    el._copyWired = true;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cmd = el.dataset.cmd;
      navigator.clipboard.writeText(cmd).then(() => {
        const cp = el.querySelector(".cp");
        if (cp) {
          const orig = cp.textContent;
          cp.textContent = "copied!";
          cp.style.color = "var(--success)";
          setTimeout(() => {
            cp.textContent = orig;
            cp.style.color = "";
          }, 1200);
        } else {
          // Icon-only buttons: brief class + glyph swap for feedback.
          const orig = el.textContent;
          el.classList.add("copied");
          el.textContent = "✓";
          setTimeout(() => {
            el.classList.remove("copied");
            el.textContent = orig;
          }, 1000);
        }
      });
    });
  });

  // Restack buttons (trunk row).
  $$("[data-restack-stack]").forEach((el) => {
    if (el._restackWired) return;
    el._restackWired = true;
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await handleRestackClick(el);
    });
  });

  // State pill click → fetch valid transitions → menu → confirm → POST.
  $$("[data-state-pill]").forEach((el) => {
    if (el._statePillWired) return;
    el._statePillWired = true;
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await openStateMenu(el);
    });
  });

  // Mark-complete / Restore buttons.
  $$('[data-action="complete"], [data-action="restore"]').forEach((el) => {
    if (el._actionWired) return;
    el._actionWired = true;
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCompleted(el.dataset.key);
      const { render } = await import("./render.js");
      render(store.currentData);
    });
  });

  // Anything tagged data-stop-toggle: swallow pointer + key events so
  // interacting with content inside <summary> doesn't bubble up and toggle
  // the card open/closed.
  $$("[data-stop-toggle]").forEach((el) => {
    if (el._stopToggleWired) return;
    el._stopToggleWired = true;
    const stop = (e) => e.stopPropagation();
    for (const evt of ["click", "mousedown", "keydown", "keypress", "keyup"]) {
      el.addEventListener(evt, stop);
    }
  });

  // Pencil icon next to stack name: click to inline-edit. Override is keyed
  // by stack_key in localStorage and takes priority over `stack.name` (the
  // Claude-generated default).
  $$("[data-edit-name]").forEach((btn) => {
    if (btn._editNameWired) return;
    btn._editNameWired = true;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest(".stack-card");
      if (!card) return;
      const stackKey = card.dataset.stackKey;
      const nameDiv = btn.parentElement;
      const textSpan = nameDiv.querySelector(".stack-name-text");
      if (!textSpan) return;
      const original = textSpan.textContent;

      const input = document.createElement("input");
      input.type = "text";
      input.className = "stack-name-input";
      input.value = original;
      input.setAttribute("data-stop-toggle", "");
      const stop = (ev) => ev.stopPropagation();
      for (const evt of ["click", "mousedown", "keydown", "keypress", "keyup"]) {
        input.addEventListener(evt, stop);
      }

      const { rebuildSidebar } = await import("./render.js");
      let finalized = false;
      const finish = (save) => {
        if (finalized) return;
        finalized = true;
        const next = input.value.trim();
        const changed = save && next && next !== original;
        if (changed) {
          setStackNameOverride(stackKey, next);
          textSpan.textContent = next;
        }
        input.replaceWith(textSpan);
        btn.style.display = "";
        if (changed) rebuildSidebar(store.currentData);
      };

      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          finish(true);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          finish(false);
        }
      });

      textSpan.replaceWith(input);
      btn.style.display = "none";
      input.focus();
      input.select();
    });
  });

  // Cards default to collapsed; sync the header button's label to match.
  updateCollapseAllLabel();
}
