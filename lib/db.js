// IndexedDB compartilhado entre o service worker e as páginas da extensão.
// Cada captura é um registro com os blobs das imagens (uma por bloco, se a página foi dividida).
const DB_NAME = "captura-total";
const DB_VERSION = 2;
const STORE = "captures";

const open = () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains("shots")) db.deleteObjectStore("shots"); // versão 1
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true }).createIndex("time", "time");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      Promise.resolve(fn(tx.objectStore(STORE))).then((r) => (result = r), reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** Grava um registro novo e devolve o id. */
export const addCapture = (record) => run("readwrite", (s) => req(s.add(record)));

export const getCapture = (id) => run("readonly", (s) => req(s.get(Number(id))));

/** Mais recente primeiro. */
export const listCaptures = async () => {
  const all = await run("readonly", (s) => req(s.getAll()));
  return all.sort((a, b) => b.time - a.time);
};

export const deleteCaptures = (ids) =>
  run("readwrite", (s) => Promise.all(ids.map((id) => req(s.delete(Number(id))))));
