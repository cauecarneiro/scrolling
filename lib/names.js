// Nome de arquivo a partir de um modelo: {url} {domain} {path} {title} {date:yyyy-MM-dd-HH_mm_ss}
import { DEFAULT_TEMPLATE } from "./options.js";

const pad = (n, len = 2) => String(n).padStart(len, "0");

export function formatDate(date, fmt = "yyyy-MM-dd-HH_mm_ss") {
  const parts = {
    yyyy: pad(date.getFullYear(), 4),
    yy: pad(date.getFullYear() % 100),
    MM: pad(date.getMonth() + 1),
    dd: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  return fmt.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (t) => parts[t]);
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Remove acentos, ?query, #hash, protocolo e www.; troca o resto por "-".
const slug = (s) =>
  safeDecode(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[?#].*$/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/^([^/]+)\.com(?=\/|$)/i, "$1")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

function urlParts(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, ""), path: u.pathname + (u.search ? "" : "") };
  } catch {
    return { host: "", path: "" };
  }
}

const sanitize = (name) => {
  let out = name.replace(/[\\<>*?/":|]/g, "_").trim();
  if (/^(\.\.|~)/.test(out)) out = "_" + out.slice(1);
  return out;
};

/**
 * @param {string} template  modelo (ex.: "captura-{url}-{date:yyyy-MM-dd}")
 * @param {{url:string,title:string,time:number}} rec
 * @param {string} ext  "png" | "jpg" | "" (sem ponto)
 * @param {number} index  0 para a primeira imagem; as demais ganham "-2", "-3"...
 */
export function buildFilename(template, rec, ext = "png", index = 0) {
  const { host, path } = urlParts(rec.url || "");
  const date = new Date(rec.time || Date.now());
  const base = (template || DEFAULT_TEMPLATE).replace(/\{([^{}]*)\}/g, (_, token) => {
    const [name, arg] = [token.split(":")[0], token.includes(":") ? token.slice(token.indexOf(":") + 1) : undefined];
    switch (name.trim()) {
      case "url":
        return slug(rec.url || "");
      case "domain":
        return host;
      case "path":
        return slug(path);
      case "title":
        return rec.title || "";
      case "date":
        return formatDate(date, arg || undefined);
      default:
        return name;
    }
  });
  let name = sanitize(base).slice(0, 200) || "captura";
  if (index > 0) name += `-${index + 1}`;
  return ext ? `${name}.${ext}` : name;
}
