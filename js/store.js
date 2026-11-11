// Datenspeicher: Alles liegt nur auf diesem Gerät, im Speicher des Browsers (IndexedDB).
// Es gibt keinen Server und kein Konto.

const DB_NAME = 'worktimetracker';
const DB_VERSION = 1;
let db = null;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('blocks')) d.createObjectStore('blocks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function load() {
  db = await open();
  const blocks = await run('blocks', 'readonly', (s) => s.getAll());
  const settings = await run('meta', 'readonly', (s) => s.get('settings'));
  return { blocks: blocks || [], settings: settings || null };
}

export const putBlock = (block) => run('blocks', 'readwrite', (s) => s.put(block));
export const deleteBlock = (id) => run('blocks', 'readwrite', (s) => s.delete(id));
export const putSettings = (settings) => run('meta', 'readwrite', (s) => s.put(settings, 'settings'));

// Bittet den Browser, die Daten nicht von selbst zu löschen, wenn der Speicher knapp wird.
export function askPersistent() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
