// Divide a imagem final em blocos que o navegador consegue desenhar e codificar.
// Regra de divisão: lado > 28.800 px ou área > 259,2 Mpx => blocos de 9.000 x 28.800.
export const MAX_SIDE = 28800;
export const MIN_SIDE = 9000;
export const MAX_AREA = 259_200_000;

/** Quantos blocos (e portanto quantas imagens) uma captura de W x H pixels vai gerar. */
export function planTiles(W, H) {
  const needSplit = H > MAX_SIDE || W > MAX_SIDE || W * H > MAX_AREA;
  const landscape = W > H;
  const tw = needSplit ? (landscape ? MAX_SIDE : MIN_SIDE) : W;
  const th = needSplit ? (landscape ? MIN_SIDE : MAX_SIDE) : H;
  const cols = Math.ceil(W / tw);
  const rows = Math.ceil(H / th);
  return { tw, th, cols, rows, count: cols * rows };
}

/**
 * Acumula as fatias numa grade de blocos. Como as fatias chegam de cima para baixo,
 * uma faixa de blocos fica pronta cedo: ela é codificada e liberada na hora,
 * então só uma ou duas faixas ocupam memória ao mesmo tempo.
 */
export class TileWriter {
  constructor({ width, height, background = "#fff", type = "image/png", quality }) {
    this.W = width;
    this.H = height;
    this.bg = background;
    this.type = type;
    this.quality = quality;
    Object.assign(this, planTiles(width, height));
    this.canvases = new Map(); // "r,c" -> { canvas, ctx }
    this.doneRows = 0;
    this.images = [];
  }

  tile(r, c) {
    const key = `${r},${c}`;
    let t = this.canvases.get(key);
    if (!t) {
      const w = Math.min(this.tw, this.W - c * this.tw);
      const h = Math.min(this.th, this.H - r * this.th);
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Memória insuficiente para criar a imagem desta página.");
      ctx.fillStyle = this.bg;
      ctx.fillRect(0, 0, w, h);
      t = { canvas, ctx, w, h };
      this.canvases.set(key, t);
    }
    return t;
  }

  /** Desenha a região (sx,sy,sw,sh) do bitmap em (dx,dy,dw,dh), repartida entre os blocos que ela toca. */
  draw(bmp, sx, sy, sw, sh, dx, dy, dw, dh) {
    const kx = sw / dw;
    const ky = sh / dh;
    const r0 = Math.max(0, Math.floor(dy / this.th));
    const r1 = Math.min(this.rows - 1, Math.floor((dy + dh - 1) / this.th));
    const c0 = Math.max(0, Math.floor(dx / this.tw));
    const c1 = Math.min(this.cols - 1, Math.floor((dx + dw - 1) / this.tw));
    for (let r = Math.max(r0, this.doneRows); r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const t = this.tile(r, c);
        const left = c * this.tw;
        const top = r * this.th;
        // interseção em coordenadas globais
        const ix = Math.max(dx, left);
        const iy = Math.max(dy, top);
        const ix2 = Math.min(dx + dw, left + t.w);
        const iy2 = Math.min(dy + dh, top + t.h);
        if (ix2 <= ix || iy2 <= iy) continue;
        t.ctx.drawImage(
          bmp,
          sx + (ix - dx) * kx,
          sy + (iy - dy) * ky,
          (ix2 - ix) * kx,
          (iy2 - iy) * ky,
          ix - left,
          iy - top,
          ix2 - ix,
          iy2 - iy,
        );
      }
    }
  }

  async encodeRow(r) {
    for (let c = 0; c < this.cols; c++) {
      const t = this.tile(r, c);
      const blob = await t.canvas.convertToBlob({ type: this.type, quality: this.quality });
      this.images.push({ blob, size: blob.size, width: t.w, height: t.h });
      this.canvases.delete(`${r},${c}`);
    }
  }

  /** Codifica as faixas que já foram desenhadas por completo (até a linha yEnd). */
  async flush(yEnd) {
    while (this.doneRows < this.rows && (this.doneRows + 1) * this.th <= yEnd) {
      await this.encodeRow(this.doneRows++);
    }
  }

  async finish() {
    while (this.doneRows < this.rows) await this.encodeRow(this.doneRows++);
    return this.images;
  }
}
