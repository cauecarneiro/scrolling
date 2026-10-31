// Loading state em grade de pixels (port em JS puro do componente LoadingState).
//   Drive: células quadradas, frente de onda em chevron avançando para a direita
//   Dots:  mesma onda, células circulares
//   Orbit: um cometa percorrendo o perímetro da grade
// Acompanha um label com brilho e um timer decorrido em fonte mono.
// Estilos e keyframes (pixel-on, shimmer-text) estão em ui.css.
const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS = {
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
};

const formatElapsed = (ds) => {
  const total = ds / 10;
  return total < 60 ? `${total.toFixed(1)}s` : `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
};

/**
 * @param {{label?: string, variant?: "Drive"|"Dots"|"Orbit", size?: "md"|"lg", showTime?: boolean}} opts
 * @returns {{el: HTMLElement, setLabel(t: string): void, setExtra(t: string): void, stop(): void}}
 */
export function createLoadingState({ label = "Carregando", variant = "Drive", size = "md", showTime = true } = {}) {
  const { delays, dur, round } = PATTERNS[variant] || PATTERNS.Drive;

  const grid = document.createElement("span");
  grid.className = "ls-grid";
  grid.setAttribute("aria-hidden", "true");
  for (const d of delays) {
    const cell = document.createElement("span");
    cell.className = `ls-cell${round ? " round" : ""}`;
    cell.style.opacity = d === null ? "0.07" : "0.15";
    cell.style.animation = d === null ? "none" : `pixel-on ${dur}ms ease-in-out ${d}ms infinite`;
    grid.append(cell);
  }

  const text = document.createElement("span");
  text.className = "ls-label";
  text.textContent = label;

  const time = document.createElement("span");
  time.className = "ls-time";
  time.textContent = formatElapsed(0);

  const extra = document.createElement("span");
  extra.className = "ls-extra";

  const el = document.createElement("div");
  el.className = `ls ${size === "lg" ? "lg" : ""}`;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.append(grid, text);
  if (showTime) el.append(time);
  el.append(extra);

  let ds = 0;
  const timer = setInterval(() => {
    ds += 1;
    time.textContent = formatElapsed(ds);
  }, 100);

  return {
    el,
    setLabel: (t) => (text.textContent = t),
    setExtra: (t) => (extra.textContent = t),
    stop: () => clearInterval(timer),
  };
}
