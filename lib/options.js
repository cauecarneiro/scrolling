// Opções do usuário em chrome.storage.local (chave única "options").
export const DEFAULT_TEMPLATE = "captura-{url}-{date:yyyy-MM-dd-HH_mm_ss}";

export const DEFAULTS = {
  fmt: "png", // "png" | "jpg"
  filename_template: DEFAULT_TEMPLATE,
  save_as: false, // mostrar "salvar como" ao baixar um arquivo único
  fit_copies: true, // reduzir a imagem para 25 Mpx ao copiar (limite do Google Docs)
  auto_copy: true, // copiar a imagem sozinha ao abrir o resultado
};

export async function getOptions() {
  const { options } = await chrome.storage.local.get("options");
  return { ...DEFAULTS, ...(options || {}) };
}

export async function setOptions(patch) {
  const next = { ...(await getOptions()), ...patch };
  await chrome.storage.local.set({ options: next });
  return next;
}
