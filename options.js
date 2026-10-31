import { DEFAULTS, DEFAULT_TEMPLATE, getOptions, setOptions } from "./lib/options.js";
import { buildFilename } from "./lib/names.js";
import { hydrateIcons, svg } from "./lib/icons.js";

const $ = (id) => document.getElementById(id);
hydrateIcons();

const id = new URLSearchParams(location.search).get("id");
if (id) {
  $("btn-back").href = `capture.html?id=${id}`;
  $("btn-back").hidden = false;
}

let savedTimer = 0;
function flash(text, error = false) {
  const s = $("saved");
  s.innerHTML = svg(error ? "circleX" : "check", "14");
  s.append(text);
  s.className = error ? "error" : "";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => s.replaceChildren(), error ? 4000 : 1400);
}

async function save(patch) {
  try {
    await setOptions(patch);
    flash("Salvo");
  } catch {
    flash("Não salvo", true);
  }
}

const sample = { url: "https://exemplo.com.br/artigos/ação-rápida?id=7", title: "Título de exemplo", time: Date.now() };
function preview() {
  $("preview").textContent = buildFilename($("filename_template").value, sample, $("fmt-jpg").checked ? "jpg" : "png");
}

// ---------- Busca e navegação (como um command menu) ----------
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const items = [...document.querySelectorAll(".cmd-item")];
let selected = -1;

const visibleItems = () => items.filter((it) => !it.hidden);

function select(item) {
  for (const it of items) it.removeAttribute("data-selected");
  if (!item) return;
  item.setAttribute("data-selected", "true");
  item.scrollIntoView({ block: "nearest" });
  selected = visibleItems().indexOf(item);
}

function filter() {
  const term = norm($("search").value.trim());
  for (const it of items) {
    const hay = norm(`${it.textContent} ${it.dataset.keywords || ""}`);
    it.hidden = !!term && !term.split(/\s+/).every((t) => hay.includes(t));
  }
  const groups = [...document.querySelectorAll(".cmd-group")];
  for (const g of groups) g.hidden = !g.querySelector(".cmd-item:not([hidden])");
  const shown = groups.filter((g) => !g.hidden).length;
  document.querySelector(".cmd-sep").hidden = shown < 2;
  $("empty").hidden = shown > 0;
  select(visibleItems()[0] || null);
}

function activate(item) {
  if (!item) return;
  const sw = item.querySelector(".switch");
  if (sw) return void sw.click();
  if (item.querySelector('input[name="fmt"]')) {
    const next = $("fmt-png").checked ? $("fmt-jpg") : $("fmt-png");
    return void next.click();
  }
  $("filename_template").focus();
}

$("search").addEventListener("input", filter);
document.addEventListener("keydown", (e) => {
  const typingTemplate = e.target === $("filename_template");
  if (e.key === "/" && e.target.tagName !== "INPUT") return void (e.preventDefault(), $("search").focus());
  if (e.key === "Escape") {
    if ($("search").value) {
      $("search").value = "";
      return void filter();
    }
    return void document.activeElement?.blur();
  }
  if (typingTemplate) return;
  const vis = visibleItems();
  if (!vis.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const dir = e.key === "ArrowDown" ? 1 : -1;
    select(vis[(Math.max(selected, 0) + (selected < 0 ? 0 : dir) + vis.length) % vis.length]);
  } else if (e.key === "Enter" && e.target.tagName !== "BUTTON") {
    e.preventDefault();
    activate(vis[Math.max(selected, 0)]);
  }
});
for (const it of items) it.addEventListener("mousemove", () => it.getAttribute("data-selected") !== "true" && select(it));

(async function init() {
  const o = await getOptions();
  for (const input of document.querySelectorAll('input[name="fmt"]')) {
    input.checked = input.value === o.fmt;
    input.id = `fmt-${input.value}`;
    input.addEventListener("change", () => (save({ fmt: input.value }), preview()));
  }
  for (const key of ["auto_copy", "fit_copies", "save_as"]) {
    $(key).checked = o[key];
    $(key).addEventListener("change", () => save({ [key]: $(key).checked }));
  }

  const tpl = $("filename_template");
  tpl.value = o.filename_template;
  tpl.addEventListener("input", () => {
    preview();
    save({ filename_template: tpl.value.trim() || DEFAULT_TEMPLATE });
  });
  for (const b of document.querySelectorAll("[data-insert]")) {
    b.addEventListener("click", () => {
      const start = tpl.selectionStart ?? tpl.value.length;
      const end = tpl.selectionEnd ?? start;
      tpl.setRangeText(b.dataset.insert, start, end, "end");
      tpl.focus();
      tpl.dispatchEvent(new Event("input"));
    });
  }
  $("reset-template").addEventListener("click", () => {
    tpl.value = DEFAULTS.filename_template;
    tpl.dispatchEvent(new Event("input"));
  });
  preview();
  filter();
})();
