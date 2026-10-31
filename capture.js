// Página de resultado (?id=N) e histórico "Arquivos" (sem parâmetros).
import { getCapture, listCaptures, deleteCaptures } from "./lib/db.js";
import { getOptions } from "./lib/options.js";
import { buildFilename } from "./lib/names.js";
import { createLoadingState } from "./lib/loading-state.js";
import { hydrateIcons, svg } from "./lib/icons.js";

const $ = (id) => document.getElementById(id);
hydrateIcons();
// Enquanto a captura carrega: grade de pixels (Dots) com timer.
const loader = createLoadingState({ label: "Carregando captura", variant: "Dots", size: "lg", showTime: false });
$("image").append(loader.el);
const html = document.documentElement;
const params = new URLSearchParams(location.search);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const CLIPBOARD_MAX_PIXELS = 25_000_000; // limite de colar no Google Docs
const HEADER = 60;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};

// ---------- Avisos ----------
let noticeTimer = 0;
function notice(kind, title, body = "", autoHideMs = 0) {
  $("error").className = kind === "warning" ? "warning" : "";
  $("error-title").textContent = title;
  $("error-body").textContent = body;
  $("error-wrap").hidden = false;
  clearTimeout(noticeTimer);
  if (autoHideMs) noticeTimer = setTimeout(() => ($("error-wrap").hidden = true), autoHideMs);
}
document.querySelector(".error-dismiss").addEventListener("click", () => ($("error-wrap").hidden = true));

// Aviso rápido no rodapé. kind: "loading" (grade de pixels), "success", "error" ou vazio.
// detail: linhas extras em texto secundário.
let snackTimer = 0;
let snackLoader = null;
function hideSnackbar() {
  clearTimeout(snackTimer);
  snackLoader?.stop();
  snackLoader = null;
  $("snackbar").classList.remove("show");
}
function snackbar(title, { detail = "", kind = "", ms = 3000 } = {}) {
  clearTimeout(snackTimer);
  snackLoader?.stop();
  snackLoader = null;
  const inner = $("snackbar").querySelector(".notify-snackbar--inner");
  if (kind === "loading") {
    snackLoader = createLoadingState({ label: title, variant: "Dots", showTime: false });
    inner.replaceChildren(snackLoader.el);
  } else {
    const text = el("span", { className: "sn-text" }, el("span", { className: "sn-title" }, title));
    if (detail) text.append(el("span", { className: "sn-detail" }, detail));
    const parts = [text];
    if (kind) parts.unshift(Object.assign(el("span", { className: `sn-icon ${kind}` }), { innerHTML: svg(kind === "error" ? "circleX" : "circleCheck", "16") }));
    inner.replaceChildren(...parts);
  }
  $("snackbar").classList.add("show");
  snackTimer = setTimeout(hideSnackbar, ms);
}

const sizeLabel = (bytes) => {
  if (!bytes) return "0";
  const u = ["Bytes", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(2)} ${u[i]}`;
};

const extOf = (rec) => (rec.format === "jpg" ? "jpg" : "png");

// ---------- Download e cópia ----------
async function downloadBlobs(rec, urls, opts, saveAs) {
  const many = rec.images.length > 1;
  let failures = 0;
  for (let i = 0; i < rec.images.length; i++) {
    const filename = buildFilename(opts.filename_template, rec, extOf(rec), i);
    try {
      await chrome.downloads.download({
        url: urls[i],
        filename,
        conflictAction: "uniquify",
        saveAs: !many && (saveAs || opts.save_as),
      });
    } catch (e) {
      if (/canceled by the user/i.test(String(e?.message))) continue;
      failures++;
      console.error(e);
    }
  }
  return failures;
}

// Reduz o canvas para caber no limite de pixels da área de transferência.
function fitToMaxPixels(w, h, max) {
  if (w * h <= max) return [w, h, false];
  const f = Math.sqrt(max / (w * h));
  const nw = Math.floor(w * f);
  return [nw, Math.floor(nw * (h / w)), true];
}

async function pngBlobFor(image, fit) {
  const bmp = await createImageBitmap(image.blob);
  const [w, h, resized] = fit ? fitToMaxPixels(bmp.width, bmp.height, CLIPBOARD_MAX_PIXELS) : [bmp.width, bmp.height, false];
  if (!resized && image.blob.type === "image/png") {
    bmp.close();
    return { blob: image.blob, resized };
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { blob: await canvas.convertToBlob({ type: "image/png" }), resized };
}

async function copyImage(rec, index, opts) {
  if (!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem)) {
    snackbar("Seu navegador não suporta a área de transferência", {
      kind: "error",
      detail: "Atualize para a versão mais recente.",
      ms: 4000,
    });
    return false;
  }
  snackbar("Copiando imagem", { kind: "loading", ms: 30000 });
  try {
    const { blob, resized } = await pngBlobFor(rec.images[index], opts.fit_copies);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    const detail = [];
    if (rec.images.length > 1) detail.push(`Imagem ${index + 1} de ${rec.images.length}. Use o botão direito para copiar as outras.`);
    if (resized) detail.push("Reduzida para caber no limite do Google Docs. Dá para mudar em Opções.");
    snackbar("Imagem copiada", { kind: "success", detail: detail.join("\n"), ms: detail.length ? 6000 : 3000 });
    return true;
  } catch (e) {
    console.error(e);
    hideSnackbar();
    notice(
      "warning",
      "Não foi possível copiar a imagem",
      "Tente de novo e espere ver a mensagem “Imagem copiada” antes de trocar de janela. Se persistir, veja Opções ou baixe a imagem.",
    );
    return false;
  }
}


// ---------- Brilho granulado ----------
// Névoa branca com grão fino: cada pixel recebe um ruído de transparência baixa, multiplicado por uma curva
// que cai com a distância da borda da imagem e chega a zero. Como o grão é contínuo (não há máscara nem
// retângulo), não existe emenda visível em lugar nenhum.
const GLOW_PX = 32; // largura do brilho em px CSS (mantenha igual a --g em capture.css)
const GLOW_RADIUS = 20; // raio dos cantos do halo em px CSS (mantenha igual a --r em capture.css)
const GLOW_ALPHA = 0.085; // opacidade máxima do grão, colado na imagem
const GLOW_SPREAD = 3.6; // queda gaussiana: quanto maior, mais concentrado perto da imagem e mais rápido some
const GLOW_GRAIN = 0.45; // contraste do grão (0 = névoa lisa, 1 = grão forte)
const GLOW_TAIL = Math.exp(-GLOW_SPREAD);
const glowFade = (t) => (Math.exp(-GLOW_SPREAD * t * t) - GLOW_TAIL) / (1 - GLOW_TAIL); // 1 colado na imagem, 0 na ponta
function glowTile(w, h, distance) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = Math.min(1, distance(x, y));
      const fade = glowFade(t);
      const i = (y * w + x) * 4;
      data.data[i] = data.data[i + 1] = data.data[i + 2] = 255;
      data.data[i + 3] = Math.round(255 * fade * GLOW_ALPHA * (1 - GLOW_GRAIN + GLOW_GRAIN * Math.random() * 2));
    }
  }
  ctx.putImageData(data, 0, 0);
  return `url(${canvas.toDataURL("image/png")})`;
}
function glowTiles(frame) {
  const dpr = window.devicePixelRatio || 1;
  const G = Math.round(GLOW_PX * dpr);
  const R = Math.round(GLOW_RADIUS * dpr);
  const LEN = 512;
  frame.style.setProperty("--g", `${GLOW_PX}px`);
  frame.style.setProperty("--r", `${GLOW_RADIUS}px`);
  frame.style.setProperty("--tile-len", `${LEN / dpr}px`);
  // borda de cima: y = 0 é a parte de fora, y = G encosta na imagem
  frame.style.setProperty("--tile-h", glowTile(LEN, G, (_x, y) => (G - y) / G));
  // borda da esquerda: x = 0 é a parte de fora
  frame.style.setProperty("--tile-v", glowTile(G, LEN, (x) => (G - x) / G));
  // canto superior esquerdo: o halo acompanha um retângulo de cantos arredondados (raio R). O tile cobre o
  // brilho (G) mais os R px finais das bordas, e o centro do arco fica em (G+R, G+R), o canto inferior direito.
  const S = G + R;
  frame.style.setProperty("--tile-c", glowTile(S, S, (x, y) => (Math.hypot(S - x, S - y) - R) / G));
}

// ---------- Modo imagem ----------
async function imageMode() {
  html.classList.add("page-image");
  const id = params.get("id");
  const [rec, opts] = await Promise.all([getCapture(id), getOptions()]);
  if (!rec) {
    loader.stop();
    $("image").classList.remove("loading");
    $("image").replaceChildren();
    notice("error", "Captura não encontrada", "Ela pode ter sido excluída. Tire uma nova captura da página.");
    return;
  }

  const urls = rec.images.map((i) => URL.createObjectURL(i.blob));
  const stack = el("div", { id: "stack" });
  const imgs = rec.images.map((image, i) => {
    const img = el("img", { src: urls[i], alt: `Captura ${i + 1} de ${rec.images.length}`, title: "Captura de tela", draggable: false });
    stack.append(img);
    return img;
  });
  await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
  loader.stop();
  $("image").classList.remove("loading");
  // Brilho branco granulado nas bordas (só visual; o arquivo da captura não muda).
  const glows = ["n", "s", "e", "w", "nw", "ne", "sw", "se"].map((d) => el("span", { className: `glow ${d}`, ariaHidden: "true" }));
  const frame = el("div", { id: "frame" }, stack, ...glows);
  glowTiles(frame);
  $("image").replaceChildren(frame);

  const scale = rec.scale || 1; // px da imagem por px CSS no momento da captura
  const natW = Math.max(...rec.images.map((i) => i.width));
  const natH = rec.images.reduce((s, i) => s + i.height, 0);
  const cssW = natW / scale;
  const cssH = natH / scale;

  const name = buildFilename(opts.filename_template, rec, "");
  document.title = name;
  html.classList.add("show-img-btn");
  const many = rec.images.length > 1;
  document.querySelector("#btn-download .image-type").textContent = `(${extOf(rec).toUpperCase()}${many ? `, ${rec.images.length} imagens` : ""})`;
  $("btn-copy").querySelector(".tooltip").textContent = many ? "Copiar imagem 1" : "Copiar imagem";
  $("btn-history").href = `capture.html?oid=${id}`;
  $("btn-settings").href = `options.html?id=${id}`;

  // ----- Zoom: ajustar à tela (cabe inteira) <-> tamanho real (100%) -----
  let real = false;
  function setSizes(ratio) {
    rec.images.forEach((image, i) => {
      imgs[i].style.width = `${(image.width / scale) * ratio}px`;
      imgs[i].style.height = `${(image.height / scale) * ratio}px`;
    });
  }
  function applyView() {
    const wrap = $("image");
    const needsFit = cssW > innerWidth || cssH + 40 > innerHeight - HEADER;
    html.classList.remove("can-zoom-in", "can-zoom-out");
    if (!needsFit) {
      setSizes(1);
      wrap.style.padding = "20px 0 0";
    } else if (real) {
      setSizes(1);
      wrap.style.padding = "20px 10px";
      html.classList.add("can-zoom-out");
    } else {
      const availW = innerWidth - 40;
      const availH = innerHeight - HEADER - 40;
      const ratio = Math.min(availW / cssW, availH / cssH, 1);
      setSizes(ratio);
      wrap.style.padding = `${Math.floor((availH - cssH * ratio) / 2) + 20}px 0`;
      html.classList.add("can-zoom-in");
    }
  }
  function toggleZoom(e) {
    let fx = 0.5;
    let fy = 0.5;
    if (e) {
      const r = stack.getBoundingClientRect();
      fx = (e.clientX - r.left) / r.width;
      fy = (e.clientY - r.top) / r.height;
    }
    const wasFit = html.classList.contains("can-zoom-in");
    real = wasFit;
    applyView();
    if (wasFit) {
      const r = stack.getBoundingClientRect();
      scrollTo(scrollX + r.left + fx * r.width - innerWidth / 2, scrollY + r.top + fy * r.height - innerHeight / 2);
    }
  }
  applyView();
  addEventListener("resize", applyView);
  stack.addEventListener("click", (e) => {
    if (dragged) return void (dragged = false);
    if (html.classList.contains("can-zoom-in") || html.classList.contains("can-zoom-out")) toggleZoom(e);
  });

  // Arrastar com a barra de espaço (só em tamanho real).
  let space = false;
  let drag = null;
  let dragged = false;
  addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.target.closest?.("input, textarea, button") || !html.classList.contains("can-zoom-out")) return;
    e.preventDefault();
    space = true;
    html.classList.add("spacebar-down");
  });
  addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    space = false;
    html.classList.remove("spacebar-down", "dragging");
  });
  $("image").addEventListener("mousedown", (e) => {
    if (!space) return;
    drag = { x: e.clientX, y: e.clientY, sx: scrollX, sy: scrollY };
    html.classList.add("dragging");
    e.preventDefault();
  });
  addEventListener("mousemove", (e) => {
    if (!drag) return;
    dragged = true;
    scrollTo(drag.sx - (e.clientX - drag.x), drag.sy - (e.clientY - drag.y));
  });
  addEventListener("mouseup", () => {
    drag = null;
    html.classList.remove("dragging");
  });

  // ----- Ações -----
  const download = (saveAs = false) => downloadBlobs(rec, urls, opts, saveAs).then((fails) => {
    if (fails) notice("error", "Alguns arquivos não foram baixados", "Tente de novo ou use o botão direito na imagem para salvar.");
  });
  const copy = (i = 0) => copyImage(rec, i, opts);

  const click = (id, fn) =>
    $(id).addEventListener("click", (e) => {
      e.preventDefault();
      fn();
      setTimeout(() => $(id).blur(), 10);
    });
  click("btn-copy", () => copy(0));
  click("btn-download", () => download(false));
  click("btn-trash", async () => {
    if (!confirm("Excluir esta captura?\nEsta ação não pode ser desfeita.")) return;
    await deleteCaptures([rec.id]);
    urls.forEach((u) => URL.revokeObjectURL(u));
    $("image").replaceChildren();
    html.classList.remove("show-img-btn", "can-zoom-in", "can-zoom-out");
    notice("warning", "Imagem excluída", "", 3000);
  });

  const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);
  addEventListener("keydown", (e) => {
    if (!mod(e)) return;
    const k = e.key.toLowerCase();
    if (k === "s" && e.altKey) return void (e.preventDefault(), copy(0));
    if (k === "s") return void (e.preventDefault(), download(e.shiftKey));
    if (k === "c" && !e.shiftKey && !e.altKey) return void (e.preventDefault(), copy(0));
    if (k === "-" && html.classList.contains("can-zoom-out")) return void (e.preventDefault(), toggleZoom());
    if ((k === "+" || k === "=" || k === "0") && html.classList.contains("can-zoom-in")) return void (e.preventDefault(), toggleZoom());
  });

  // ----- Menu de contexto -----
  const ctx = $("ctx");
  const hideCtx = () => (ctx.hidden = true);
  const key = (s) => el("span", { className: "key" }, s);
  const modLabel = isMac ? "⌘" : "Ctrl+";
  $("image").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const restricted = /^(chrome|edge|chrome-extension):/.test(rec.url);
    const items = [
      ["Salvar imagem como…", `${modLabel}${isMac ? "⇧" : "Shift+"}S`, () => download(true)],
      ...rec.images.map((_, i) => [many ? `Copiar imagem ${i + 1}` : "Copiar imagem", i === 0 ? `${modLabel}C` : "", () => copy(i)]),
      "divider",
      ["Copiar URL original", "", async () => (await navigator.clipboard.writeText(rec.url), snackbar("URL copiada", { kind: "success" }))],
      ["Abrir URL original", "", () => window.open(rec.url, "_blank", "noopener"), restricted],
    ];
    ctx.replaceChildren(
      ...items.map((it) => {
        if (it === "divider") return el("div", { className: "divider", role: "separator" });
        const [label, shortcut, fn, disabled] = it;
        const b = el("button", { type: "button", role: "menuitem", disabled: !!disabled }, label, key(shortcut));
        if (disabled) b.title = "Não é possível abrir URLs internas do navegador";
        b.addEventListener("click", () => (hideCtx(), fn()));
        return b;
      }),
    );
    ctx.hidden = false;
    const w = ctx.offsetWidth;
    const h = ctx.offsetHeight;
    ctx.style.left = `${Math.max(0, e.clientX + w + 8 > innerWidth ? e.clientX - w - 4 : e.clientX + 2)}px`;
    ctx.style.top = `${Math.max(0, e.clientY + h + 10 > innerHeight ? innerHeight - h - 10 : e.clientY - 10)}px`;
  });
  addEventListener("mousedown", (e) => !ctx.contains(e.target) && hideCtx());
  addEventListener("keydown", (e) => e.key === "Escape" && hideCtx());
  addEventListener("scroll", hideCtx, { passive: true });

  // ----- Avisos da captura -----
  const notes = [];
  if (many) {
    notes.push(
      `Esta página é grande demais para o navegador gerar uma única imagem. Ela foi dividida em ${rec.images.length} imagens (aqui aparecem emendadas, de cima para baixo). O botão de download baixa todas.`,
    );
  }
  if (rec.truncated) notes.push("A página é muito longa e foi cortada no limite de altura da captura.");
  if (rec.captureMode === "visible") notes.push("Esta captura mostra só o conteúdo visível da aba.");
  if (notes.length) notice("warning", many ? "Captura dividida em várias imagens" : "Atenção", notes.join("\n\n"), many ? 0 : 8000);

  if (opts.auto_copy) await copy(0);
}

// ---------- Histórico ----------
async function historyMode() {
  loader.stop();
  $("image").classList.remove("loading");
  html.classList.add("page-history");
  document.title = "Arquivos";
  const oid = params.get("oid");
  if (oid) {
    $("btn-back").href = `capture.html?id=${oid}`;
    $("btn-back").hidden = false;
  }
  $("btn-history").href = "capture.html";
  $("btn-settings").href = oid ? `options.html?id=${oid}` : "options.html";
  $("image").hidden = true;
  const root = $("history");
  root.hidden = false;
  window.scrollTo(0, 0);

  const [list, opts] = await Promise.all([listCaptures(), getOptions()]);
  const total = (r) => r.images.reduce((s, i) => s + i.size, 0);
  const dateOf = (r) => new Date(r.time).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

  const all = el("input", { type: "checkbox", id: "check-all", className: "check-ui", ariaLabel: "Selecionar todas" });
  const note = el("span", { className: "checkbox-note" });
  const withIcon = (name, text) => Object.assign(el("span"), { innerHTML: `${svg(name, "14")} ${text}`, style: "display:inline-flex;align-items:center;gap:8px" });
  const btnDelete = el("button", { type: "button", className: "checkbox-button delete" }, withIcon("trash", "Excluir"));
  const btnDownload = el("button", { type: "button", className: "checkbox-button" }, withIcon("download", "Baixar"));
  const ul = el("ul", { id: "file-list" });
  const checks = [];
  let lastIdx = -1;

  list.forEach((rec, idx) => {
    const box = el("input", { type: "checkbox", className: "file-checkbox check-ui", ariaLabel: `Selecionar captura ${idx + 1}` });
    box.dataset.id = rec.id;
    box.addEventListener("click", (e) => {
      if (e.shiftKey && lastIdx >= 0) {
        const [a, b] = [Math.min(lastIdx, idx), Math.max(lastIdx, idx)];
        for (let i = a; i <= b; i++) checks[i].checked = box.checked;
      }
      lastIdx = idx;
      sync();
    });
    box.addEventListener("mousedown", (e) => e.shiftKey && e.preventDefault());
    checks.push(box);
    const imagesNote = rec.images.length > 1 ? ` (${rec.images.length} imagens)` : "";
    const link = el(
      "a",
      { href: `capture.html?id=${rec.id}&url=${encodeURIComponent(rec.url)}` },
      el("span", { className: "date" }, dateOf(rec)),
      el("span", { className: "size" }, sizeLabel(total(rec))),
      el("span", { className: "filename" }, buildFilename(opts.filename_template, rec, "")),
      el("span", { className: "url" }, rec.url + imagesNote),
    );
    ul.append(
      el("li", {}, el("div", { className: "container" }, el("label", { className: "file-checkbox-wrap" }, box), link)),
    );
  });

  const selected = () => checks.filter((c) => c.checked).map((c) => Number(c.dataset.id));
  function sync() {
    const n = selected().length;
    all.checked = n > 0 && n === checks.length;
    all.indeterminate = n > 0 && n < checks.length;
    note.textContent = n ? `(${n} selecionada${n > 1 ? "s" : ""})` : "";
    for (const b of [btnDelete, btnDownload]) {
      b.disabled = n === 0;
      b.title = n === 0 ? "Selecione 1 ou mais capturas para usar esta ação." : "";
    }
  }
  all.addEventListener("change", () => (checks.forEach((c) => (c.checked = all.checked)), sync()));

  btnDelete.addEventListener("click", async () => {
    const ids = selected();
    if (!ids.length) return;
    const msg = ids.length === 1 ? "Excluir 1 captura?" : `Excluir ${ids.length} capturas?`;
    if (!confirm(`${msg}\nEsta ação não pode ser desfeita.`)) return;
    try {
      await deleteCaptures(ids);
      notice("warning", "Arquivos removidos", ids.length === 1 ? "1 captura foi removida." : `${ids.length} capturas foram removidas.`, 3000);
      setTimeout(() => location.reload(), 400);
    } catch (e) {
      notice("error", "Erro ao excluir", String(e?.message || e));
    }
  });
  btnDownload.addEventListener("click", async () => {
    const ids = new Set(selected());
    let fails = 0;
    for (const rec of list.filter((r) => ids.has(r.id))) {
      const urls = rec.images.map((i) => URL.createObjectURL(i.blob));
      fails += await downloadBlobs(rec, urls, opts, false);
    }
    if (fails) notice("error", "Alguns arquivos não foram baixados", `${fails} arquivo(s) falharam.`);
  });

  const header = el(
    "div",
    { className: "history-intro" },
    el("h2", {}, "Arquivos"),
    el("p", {}, "Suas capturas ficam aqui e permanecem privadas neste computador."),
  );

  if (!list.length) {
    root.replaceChildren(
      el("div", { className: "history-page" }, header, el("div", { className: "big-card" }, el("div", { className: "empty" }, Object.assign(el("span"), { innerHTML: svg("image", "24") }), el("p", {}, "Nenhuma captura encontrada."), el("p", { className: "hint" }, "As capturas que você tirar aparecem aqui.")))),
    );
    return;
  }

  const controls = el(
    "div",
    { className: "controls" },
    el("label", { className: "checkbox-wrap" }, all),
    note,
    btnDownload,
    btnDelete,
  );
  root.replaceChildren(
    el("div", { className: "history-page" }, header, el("div", { className: "big-card" }, el("div", { className: "title-container" }, controls), ul)),
  );
  sync();
}

(params.has("id") ? imageMode : historyMode)().catch((e) => {
  console.error(e);
  notice("error", "Algo deu errado", String(e?.message || e));
});
