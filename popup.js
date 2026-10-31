// Popup: dispara a captura no service worker e mostra o andamento.
import { createLoadingState } from "./lib/loading-state.js";
import { hydrateIcons, svg } from "./lib/icons.js";

const $app = document.getElementById("app");
const params = new URLSearchParams(location.search);
hydrateIcons();
if (/Mac|iPhone|iPad/.test(navigator.platform)) document.getElementById("shortcut").textContent = "⌘⇧F";

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};

const callout = (kind, text) => {
  const box = el("div", { className: `callout ${kind}` }, el("p", {}, text));
  box.prepend(Object.assign(el("span"), { innerHTML: svg("alert", "14") }));
  return box;
};

// ---------- Páginas restritas ----------
const RESTRICTED = [
  [/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)\//, "A política do Chrome não permite que extensões acessem a galeria da Chrome Web Store por riscos de segurança."],
  [/^chrome:\/\/newtab\//, "A política do Chrome não permite que extensões acessem a página de nova aba por riscos de segurança."],
  [/^chrome:\/\//, "A política do Chrome não permite que extensões acessem URLs que começam com “chrome://” por riscos de segurança."],
  [/^chrome-extension:\/\//, "Extensões não podem acessar páginas de outras extensões (e as versões recentes do Chrome também impedem que uma extensão capture a si mesma)."],
  [/^https:\/\/microsoftedge\.microsoft.com\//, "A política do Edge não permite que extensões acessem a loja de complementos por riscos de segurança."],
  [/^edge:\/\//, "A política do Edge não permite que extensões acessem URLs que começam com “edge://” por riscos de segurança."],
];
const RESTRICTED_DEFAULT =
  "Seu navegador restringe o acesso de scripts a certas páginas (como nova aba, páginas de configurações, a loja de extensões ou outra extensão). Ele consegue percorrer páginas comuns da web normalmente.";

const explain = (url) => (RESTRICTED.find(([re]) => re.test(url || "")) || [, RESTRICTED_DEFAULT])[1];

// ---------- Telas ----------
let tab;
let loader = null;
const state = { splitCount: 1, huge: false };

function render(...children) {
  loader?.stop();
  loader = null;
  document.querySelector(".close-btn")?.remove();
  $app.replaceChildren(el("div", { className: "stack" }, ...children));
}

function showLoading() {
  loader = null;
  const instance = createLoadingState({ label: "Capturando página", variant: "Drive", size: "lg" });
  $app.replaceChildren(el("div", { className: "stack" }, instance.el, el("div", { className: "stack", id: "warnings" })));
  loader = instance;
  updateWarnings();
}

function updateWarnings() {
  const box = document.getElementById("warnings");
  if (!box) return;
  const items = [];
  if (state.splitCount > 1) {
    items.push(
      callout("warning", `Esta página é grande demais para o navegador capturar como uma única imagem. Ela será dividida em ${state.splitCount} imagens.`),
    );
  }
  if (state.huge) {
    items.push(
      callout("error", "A extensão não foi projetada para capturas extremamente grandes. Pode falhar ao concluir a captura desta página."),
    );
  }
  box.replaceChildren(...items);
}

function showRestricted() {
  const explanation = explain(tab?.url);
  const button = el("button", { className: "btn-ui primary block", type: "button" }, "Capturar aba visível");
  button.addEventListener("click", () => start("visible"));
  render(
    el("p", { className: "title-strong" }, "Página restrita"),
    el("p", { className: "muted" }, "A extensão não consegue percorrer esta página, mas ainda pode capturar o conteúdo visível."),
    el("details", {}, el("summary", {}, "Saiba mais"), el("p", {}, explanation)),
    button,
  );
}

function showError(message) {
  const retry = el("button", { className: "btn-ui primary block", type: "button" }, "Capturar aba visível");
  retry.addEventListener("click", () => start("visible"));
  render(
    el("p", { className: "title-strong" }, "Algo deu errado"),
    el("p", { className: "muted" }, "Atualize a página e tente novamente. Se o problema persistir, tente capturar só a aba visível."),
    message ? callout("error", message) : "",
    retry,
  );
  const close = el("button", { className: "close-btn", type: "button", title: "Fechar", ariaLabel: "Fechar" });
  close.innerHTML = svg("x", "14");
  close.addEventListener("click", () => window.close());
  document.getElementById("wrap").append(close);
}

// ---------- Fluxo ----------
function start(mode) {
  showLoading();
  chrome.runtime
    .sendMessage({ target: "captura-total-bg", type: "start", tabId: tab.id, mode })
    .then((res) => {
      if (res?.running) {
        loader?.setExtra(`${Math.round((res.progress || 0) * 100)}%`);
        state.splitCount = res.splitCount || 1;
        updateWarnings();
      }
    })
    .catch((e) => showError(String(e?.message || e)));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "captura-total-popup" || !tab || msg.tabId !== tab.id) return;
  switch (msg.type) {
    case "progress":
      loader?.setExtra(`${Math.round(msg.progress * 100)}%`);
      break;
    case "split":
      state.splitCount = msg.count;
      state.huge = msg.huge;
      updateWarnings();
      break;
    case "restricted":
      showRestricted();
      break;
    case "error":
      showError(msg.message);
      break;
    case "done":
      window.close();
      break;
  }
});

(async function init() {
  try {
    tab = params.has("tabId")
      ? await chrome.tabs.get(Number(params.get("tabId"))) // usado nos testes
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab) throw new Error("Nenhuma aba ativa.");
    const url = tab.url || "";
    const own = url.startsWith(chrome.runtime.getURL(""));
    if (!own && (RESTRICTED.some(([re]) => re.test(url)) || !url || url === "about:blank")) {
      showRestricted();
      return;
    }
    start("full");
  } catch (e) {
    showError(String(e?.message || e));
  }
})();
