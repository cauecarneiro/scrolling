// Injetado na aba sob demanda. Prepara a página, rola e desfaz tudo no fim.
// O service worker conduz o fluxo; aqui só medimos, rolamos e ajustamos o CSS.
(() => {
  if (window.__capturaTotal) return;
  window.__capturaTotal = true;

  const MAX_HEIGHT = 60000; // px CSS; evita páginas de rolagem infinita sem fim
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () =>
    new Promise((r) => {
      const t = setTimeout(r, 100);
      requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(t), r())));
    });

  let state = null;
  let uid = 0;

  const pageHeight = () =>
    Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);

  // Registra o estilo inline anterior para poder desfazer.
  function setStyle(el, props) {
    const prev = el.getAttribute("style");
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
    state.undo.push(() => (prev === null ? el.removeAttribute("style") : el.setAttribute("style", prev)));
  }

  function setAttr(el, name, value) {
    const prev = el.getAttribute(name);
    el.setAttribute(name, value);
    state.undo.push(() => (prev === null ? el.removeAttribute(name) : el.setAttribute(name, prev)));
  }

  function addStyleSheet(css) {
    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    state.undo.push(() => style.remove());
  }

  function findInnerScroller() {
    const vw = innerWidth;
    const vh = innerHeight;
    let best = null;
    let bestArea = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if (el.clientHeight < 100 || el.scrollHeight <= el.clientHeight + 20) continue;
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY) || cs.visibility === "hidden" || cs.display === "none") continue;
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, vw) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (w <= 0 || h <= 0) continue;
      if (w * h > bestArea) {
        bestArea = w * h;
        best = el;
      }
    }
    return bestArea > vw * vh * 0.4 ? best : null;
  }

  // Iframe grande e visível (conteúdo de apps que rolam dentro de um iframe).
  function findFrame() {
    const vw = innerWidth;
    const vh = innerHeight;
    const tol = 18;
    let best = null;
    let bestArea = (vw * vh) / 4;
    for (const f of document.querySelectorAll("iframe, frame")) {
      const cs = getComputedStyle(f);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = f.getBoundingClientRect();
      const x = r.left + f.clientLeft;
      const y = r.top + f.clientTop;
      const w = f.clientWidth;
      const h = f.clientHeight;
      if (w * h <= bestArea) continue;
      if (x < -tol || y < -tol || x + w > vw + tol || y + h > vh + tol) continue;
      best = { el: f, x, y, w, h };
      bestArea = w * h;
    }
    return best;
  }

  function makeScroller(el) {
    if (!el) {
      return {
        getHeight: pageHeight,
        get: () => window.scrollY,
        set: (y) => window.scrollTo(0, y),
        region: () => ({ x: 0, y: 0, w: innerWidth, h: innerHeight }),
      };
    }
    return {
      getHeight: () => el.scrollHeight,
      get: () => el.scrollTop,
      set: (y) => (el.scrollTop = y),
      region: () => {
        const r = el.getBoundingClientRect();
        const x = Math.max(r.left, 0);
        const y = Math.max(r.top, 0);
        return {
          x,
          y,
          w: Math.min(r.right, innerWidth) - x,
          h: Math.min(r.bottom, innerHeight) - y,
        };
      },
    };
  }

  // Dispara lazy-load: desce a página em passos e volta ao topo.
  async function warmup(sc, viewportH) {
    let y = 0;
    while (y < sc.getHeight() - viewportH && y < MAX_HEIGHT) {
      y += viewportH;
      sc.set(y);
      await sleep(80);
    }
    await sleep(150);
    sc.set(0);
    await sleep(100);
  }

  // Cor de fundo da página (o bloco do canvas começa com ela, para não aparecer branco em páginas escuras).
  function bodyBg() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const c = getComputedStyle(el).backgroundColor || "";
      if (c !== "transparent" && !/^rgba\(\d+,\s*\d+,\s*\d+,\s*0\)$/.test(c)) return c;
    }
    return "#ffffff";
  }

  // Animações e efeitos de rolagem que mexeriam no conteúdo entre uma fatia e outra.
  function calmPage() {
    addStyleSheet(
      "html{scroll-behavior:auto!important}" +
        "html::-webkit-scrollbar,body::-webkit-scrollbar,[data-captura-total]::-webkit-scrollbar{width:0!important;height:0!important}" +
        "html,body,[data-captura-total]{scrollbar-width:none!important}" +
        "*{transition:none!important;transition-delay:0s!important;animation-duration:0s!important;animation-delay:0s!important}" +
        "[data-captura-total-hidden]{opacity:0!important}" +
        "[data-captura-total-hidden],[data-captura-total-hidden] *,[data-captura-total-hidden]::before,[data-captura-total-hidden]::after,[data-captura-total-hidden] *::before,[data-captura-total-hidden] *::after{visibility:hidden!important}",
    );
    // AOS ("animate on scroll") deixa elementos invisíveis até rolar até eles.
    document.querySelectorAll("[data-aos]").forEach((el) => {
      const v = el.getAttribute("data-aos");
      el.removeAttribute("data-aos");
      state.undo.push(() => el.setAttribute("data-aos", v));
    });
    // Imagens preguiçosas passam a carregar na hora.
    document.querySelectorAll('img[loading="lazy"]').forEach((el) => setAttr(el, "loading", "eager"));
    try {
      window.dispatchEvent(new CustomEvent("resize")); // layouts em JS recalculam sem a barra de rolagem
    } catch {}
  }

  // ::before/::after com position:fixed em elementos grandes (fundos de modal, gradientes de tela cheia).
  function fixPseudos() {
    const rules = [];
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0.75 * innerWidth || r.height <= 0.75 * innerHeight) continue;
      for (const p of ["::before", "::after"]) {
        if (getComputedStyle(el, p).position !== "fixed") continue;
        const id = String(++uid);
        setAttr(el, "data-captura-total-pseudo", id);
        rules.push(`[data-captura-total-pseudo="${id}"]${p}{position:absolute!important}`);
      }
    }
    if (rules.length) addStyleSheet(rules.join(""));
  }

  // Varre a página (de novo a cada passo, porque botões "voltar ao topo" e widgets só aparecem
  // depois de rolar): sticky vira relative (fica no lugar natural), fundos com
  // background-attachment:fixed viram scroll e elementos fixed são escondidos.
  //   hide = null     só ajusta sticky/fundos
  //   hide = "bottom" esconde só os fixos ancorados na metade de baixo (1ª fatia)
  //   hide = "all"    esconde todos os fixos visíveis (demais fatias)
  function scanPositioned(hide) {
    const all = [document.documentElement, document.body, ...document.body.querySelectorAll("*")];
    for (const el of all) {
      if (state.hidden.has(el)) continue;
      const cs = getComputedStyle(el);
      if (!state.seen.has(el)) {
        state.seen.add(el);
        if (cs.backgroundAttachment.includes("fixed")) setStyle(el, { "background-attachment": "scroll" });
        if (cs.position === "sticky") {
          setStyle(el, { position: "relative", top: "auto", bottom: "auto", left: "auto", right: "auto" });
        }
      }
      if (!hide || el === document.documentElement || el === document.body) continue;
      if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      const offscreen = r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight;
      if (r.width <= 0 || r.height <= 0 || offscreen) continue;
      if (hide === "bottom" && r.top <= innerHeight / 2) continue;
      // Marcador + folha de estilo (ver calmPage): esconde também os filhos que declaram
      // "visibility: visible", que escapariam de um visibility:hidden só no pai.
      setAttr(el, "data-captura-total-hidden", "");
      state.hidden.add(el);
    }
  }

  async function prepare({ nonce }) {
    // Se a janela não rola e não há contêiner interno, o conteúdo pode estar num iframe.
    // O iframe recebe um "probe"; o content script dele avisa o background, que descobre o frameId.
    if (nonce && pageHeight() <= innerHeight + 20 && document.body && !findInnerScroller()) {
      const f = findFrame();
      if (f) {
        try {
          f.el.contentWindow.postMessage({ __capturaTotalProbe: nonce }, "*");
          return {
            mode: "frame",
            rect: { x: f.x, y: f.y, w: f.w, h: f.h },
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
          };
        } catch {}
      }
    }

    state = {
      undo: [],
      seen: new WeakSet(),
      hidden: new WeakSet(),
      origX: scrollX,
      origY: scrollY,
      origInner: null,
      inner: null,
      scroller: null,
    };

    let inner = null;
    if (pageHeight() <= innerHeight + 20 && document.body) {
      inner = findInnerScroller();
      if (inner) {
        state.inner = inner;
        state.origInner = inner.scrollTop;
        setAttr(inner, "data-captura-total", "");
      }
    }
    calmPage();
    const sc = makeScroller(inner);
    state.scroller = sc;
    const region = sc.region();

    await warmup(sc, region.h);
    if (!inner) {
      fixPseudos();
      scanPositioned(null);
    }
    try {
      await Promise.race([document.fonts.ready, sleep(1000)]);
    } catch {}
    await nextFrame();

    return {
      mode: inner ? "element" : "window",
      region,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      dpr: window.devicePixelRatio,
      totalHeight: Math.min(sc.getHeight(), MAX_HEIGHT),
      truncated: sc.getHeight() > MAX_HEIGHT,
      bg: bodyBg(),
      title: document.title,
      url: location.href,
    };
  }

  async function step({ y, hide }) {
    state.scroller.set(y);
    await sleep(120);
    await nextFrame();
    // Depois de rolar e de a página reagir (widgets que aparecem só com a rolagem), esconde os fixos.
    if (hide && !state.inner) {
      scanPositioned(hide);
      await nextFrame();
    }
    return { y: state.scroller.get(), height: state.scroller.getHeight() };
  }

  async function restore() {
    if (!state) return {};
    while (state.undo.length) {
      try {
        state.undo.pop()();
      } catch {}
    }
    // Posição guardada uma única vez, no início: o usuário volta exatamente para onde estava.
    window.scrollTo(state.origX, state.origY);
    if (state.inner) state.inner.scrollTop = state.origInner;
    state = null;
    return {};
  }

  const handlers = { prepare, step, restore };

  // Resposta ao probe do frame pai: permite ao background mapear iframe -> frameId.
  window.addEventListener("message", (e) => {
    const nonce = e.data && e.data.__capturaTotalProbe;
    if (typeof nonce === "string" && e.source === window.parent) {
      chrome.runtime.sendMessage({ target: "captura-total-bg", type: "frameHello", nonce }).catch(() => {});
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== "captura-total" || !handlers[msg.type]) return;
    handlers[msg.type](msg).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  });
})();
