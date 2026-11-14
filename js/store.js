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

// Sicherung einlesen: Arbeitsblöcke und Einstellungen in einem Schritt speichern.
// replace = true: Alle bisherigen Arbeitsblöcke werden vorher entfernt.
// Geht etwas schief, bleibt alles wie vorher (alles oder nichts).
export function saveAll(blocks, settings, replace) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['blocks', 'meta'], 'readwrite');
    const bs = tx.objectStore('blocks');
    if (replace) bs.clear();
    for (const b of blocks) bs.put(b);
    tx.objectStore('meta').put(settings, 'settings');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Mehrere Arbeitsblöcke auf einmal löschen (alte Daten)
export function deleteBlocks(ids) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('blocks', 'readwrite');
    const bs = tx.objectStore('blocks');
    for (const id of ids) bs.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Bittet den Browser, die Daten nicht von selbst zu löschen, wenn der Speicher knapp wird.
export function askPersistent() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
