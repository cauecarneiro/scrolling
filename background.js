import { addCapture } from "./lib/db.js";
import { getOptions } from "./lib/options.js";
import { TileWriter } from "./lib/tiles.js";

// O Chrome limita captureVisibleTab a ~2 chamadas por segundo.
const MIN_GAP_MS = 550;
const MAX_FRAME_DEPTH = 4;
const HUGE_SPLIT = 10; // acima disso o popup avisa que a captura é enorme

const jobs = new Map(); // tabId -> { progress, splitCount }
const pendingFrames = new Map();
let lastShot = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toFrame = async (tabId, frameId, msg) => {
  const res = await chrome.tabs.sendMessage(tabId, { target: "captura-total", ...msg }, { frameId });
  if (res?.error) throw new Error(res.error);
  return res;
};

// Avisa o popup (se estiver aberto) do andamento.
const emit = (tabId, payload) =>
  chrome.runtime.sendMessage({ target: "captura-total-popup", tabId, ...payload }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "captura-total-bg") return;
  if (msg.type === "frameHello") {
    pendingFrames.get(msg.nonce)?.(sender.frameId);
  } else if (msg.type === "start") {
    // O popup pediu para capturar. Se já há uma captura em andamento nessa aba, só devolve o estado.
    const job = jobs.get(msg.tabId);
    if (job) {
      sendResponse({ running: true, ...job });
    } else {
      chrome.tabs.get(msg.tabId).then((tab) => runJob(tab, msg.mode || "full"));
      sendResponse({ running: false });
    }
    return;
  }
});

function expectFrame(nonce, ms = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => (pendingFrames.delete(nonce), resolve(null)), ms);
    pendingFrames.set(nonce, (frameId) => (clearTimeout(timer), pendingFrames.delete(nonce), resolve(frameId)));
  });
}

const intersect = (a, b) => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
};

// Desce pela cadeia de iframes até o frame que realmente rola.
// Devolve também a região a capturar em coordenadas da janela principal.
async function locateScroller(tabId, prepared) {
  let frameId = 0;
  let origin = { x: 0, y: 0 };
  let clip = null;
  let topViewport = null;

  for (let depth = 0; ; depth++) {
    const nonce = crypto.randomUUID();
    const hello = expectFrame(nonce);
    let info;
    try {
      info = await toFrame(tabId, frameId, { type: "prepare", nonce });
    } finally {
      prepared.push(frameId);
    }
    if (!topViewport) {
      topViewport = { w: info.viewportWidth, h: info.viewportHeight };
      clip = { x: 0, y: 0, w: topViewport.w, h: topViewport.h };
    }

    if (info.mode !== "frame") {
      pendingFrames.delete(nonce);
      const region = intersect(
        { x: origin.x + info.region.x, y: origin.y + info.region.y, w: info.region.w, h: info.region.h },
        clip,
      );
      return { frameId, info, region, prepared, topViewport };
    }

    const childId = depth < MAX_FRAME_DEPTH ? await hello : null;
    const box = { x: origin.x + info.rect.x, y: origin.y + info.rect.y, w: info.rect.w, h: info.rect.h };
    if (childId == null) {
      // Não achamos o frame (sem acesso ou sem script): captura só o que está visível.
      const region = intersect(box, clip);
      return { frameId, info: { ...info, totalHeight: region.h }, region, prepared, topViewport, singleShot: true };
    }
    origin = { x: box.x, y: box.y };
    clip = intersect(clip, box);
    frameId = childId;
  }
}

async function grab(windowId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const wait = lastShot + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastShot = Date.now();
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      return await createImageBitmap(await (await fetch(dataUrl)).blob());
    } catch (e) {
      if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(e?.message))) throw e;
      await sleep(300);
    }
  }
  throw new Error("Limite de capturas do Chrome excedido.");
}

const badge = (tabId, text, color) => {
  chrome.action.setBadgeText({ tabId, text });
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color });
};

const setProgress = (tab, job, p) => {
  job.progress = p;
  badge(tab.id, `${Math.min(99, Math.round(p * 100))}%`);
  emit(tab.id, { type: "progress", progress: p });
};

const encoding = (fmt) =>
  fmt === "jpg" ? { type: "image/jpeg", quality: 0.92 } : { type: "image/png", quality: undefined };

// Captura a página inteira, fatia por fatia.
async function captureFull(tab, job, opts) {
  await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
  job.prepared = [];
  const found = await locateScroller(tab.id, job.prepared);
  const { frameId, info, region, topViewport, singleShot } = found;
  if (region.w <= 0 || region.h <= 0) throw new Error("Área de captura vazia.");
  const totalHeight = singleShot ? region.h : info.totalHeight;
  const { type, quality } = encoding(opts.fmt);

  let writer;
  let scale = 1;
  let y = 0;
  let prevY = -1;

  for (let i = 0; ; i++) {
    const res = singleShot ? { y: 0 } : await toFrame(tab.id, frameId, { type: "step", y, hide: i === 0 ? "bottom" : "all" });
    const bmp = await grab(tab.windowId);

    if (!writer) {
      scale = bmp.width / topViewport.w; // pixels reais por px CSS (DPR/zoom)
      const W = Math.round(region.w * scale);
      const H = Math.round(totalHeight * scale);
      writer = new TileWriter({ width: W, height: H, background: info.bg || "#fff", type, quality });
      job.splitCount = writer.count;
      if (writer.count > 1) emit(tab.id, { type: "split", count: writer.count, huge: writer.count > HUGE_SPLIT });
    }

    // Arredondar as duas bordas do mesmo jeito evita frestas entre fatias.
    const dy = Math.round(res.y * scale);
    const dh = Math.round((res.y + region.h) * scale) - dy;
    writer.draw(bmp, region.x * scale, region.y * scale, region.w * scale, region.h * scale, 0, dy, writer.W, dh);
    bmp.close();
    await writer.flush(dy + dh);

    setProgress(tab, job, (res.y + region.h) / totalHeight);

    const reachedEnd = res.y + region.h >= totalHeight - 1;
    const stuck = i > 0 && res.y <= prevY;
    if (reachedEnd || stuck) break;
    prevY = res.y;
    y = res.y + region.h;
  }

  const images = await writer.finish();
  return {
    images,
    scale,
    captureMode: "full",
    truncated: info.truncated,
    meta: { ww: topViewport.w, wh: topViewport.h, dpr: info.dpr },
  };
}

// Só o que está visível na aba (páginas restritas ou a pedido).
async function captureVisible(tab, job, opts) {
  const bmp = await grab(tab.windowId);
  const { type, quality } = encoding(opts.fmt);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  const blob = await canvas.convertToBlob({ type, quality });
  const dpr = bmp.width / (tab.width || bmp.width);
  const images = [{ blob, size: blob.size, width: bmp.width, height: bmp.height }];
  bmp.close();
  return { images, scale: dpr, captureMode: "visible", meta: { dpr } };
}

async function runJob(tab, mode = "full") {
  if (jobs.has(tab.id)) return;
  const job = { progress: 0, splitCount: 1, prepared: [0] };
  jobs.set(tab.id, job);
  badge(tab.id, "…", "#2563eb");
  try {
    const opts = await getOptions();
    emit(tab.id, { type: "progress", progress: 0 });
    let result;
    try {
      result = mode === "visible" ? await captureVisible(tab, job, opts) : await captureFull(tab, job, opts);
    } catch (e) {
      // Falha ao injetar o script = página restrita (chrome://, Web Store, etc.).
      if (mode !== "visible" && job.prepared.length <= 1 && /Cannot access|cannot be scripted|Extension manifest|showing error page|chrome-error|No tab with id|Receiving end/i.test(String(e?.message))) {
        emit(tab.id, { type: "restricted" });
        badge(tab.id, "");
        return;
      }
      throw e;
    }

    const id = await addCapture({
      url: tab.url || "unknown",
      title: tab.title || "",
      format: opts.fmt,
      time: Date.now(),
      ...result,
    });
    const url = chrome.runtime.getURL(`capture.html?id=${id}&url=${encodeURIComponent(tab.url || "")}`);
    await chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id, active: true });
    badge(tab.id, "");
    emit(tab.id, { type: "done", id });
  } catch (e) {
    console.error("[captura-total]", e);
    badge(tab.id, "ERR", "#dc2626");
    chrome.action.setTitle({ tabId: tab.id, title: `Falhou: ${e?.message || e}` });
    emit(tab.id, { type: "error", message: String(e?.message || e) });
  } finally {
    for (const frameId of job.prepared) {
      try {
        await toFrame(tab.id, frameId, { type: "restore" });
      } catch {}
    }
    jobs.delete(tab.id);
  }
}
