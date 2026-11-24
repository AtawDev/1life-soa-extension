/**
 * IndexedDB storage shared across Service Worker, Popup, and Viewer tabs.
 * Stores captured 1Life blob PDFs and generated filtered PDF exports.
 */

const DB_NAME = 'OneLifeSoaFilterDB';
const DB_VERSION = 1;
const STORE_CAPTURED = 'capturedPdfs';
const STORE_EXPORTS = 'exportedPdfs';

const MAX_CAPTURED = 8;
const MAX_EXPORTS = 10;
const MAX_CAPTURED_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_EXPORT_AGE_MS = 15 * 60 * 1000; // 15 minutes

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CAPTURED)) {
        const store = db.createObjectStore(STORE_CAPTURED, { keyPath: 'blobUrl' });
        store.createIndex('capturedAt', 'capturedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_EXPORTS)) {
        const store = db.createObjectStore(STORE_EXPORTS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function pruneStore(storeName, timeKey, maxCount, maxAgeMs) {
  try {
    const db = await openDb();
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const all = await reqPromise(store.getAll());
    const now = Date.now();

    all.sort((a, b) => (b[timeKey] || 0) - (a[timeKey] || 0));
    for (let i = 0; i < all.length; i++) {
      const rec = all[i];
      const tooOld = now - (rec[timeKey] || 0) > maxAgeMs;
      const overLimit = i >= maxCount;
      if (tooOld || overLimit) {
        const key = storeName === STORE_CAPTURED ? rec.blobUrl : rec.id;
        store.delete(key);
      }
    }
    await txPromise(tx);
  } catch {
    // Non-fatal cleanup
  }
}

export async function saveCapturedPdf({ blobUrl, bytes, tabId = null }) {
  const db = await openDb();
  const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const tx = db.transaction(STORE_CAPTURED, 'readwrite');
  tx.objectStore(STORE_CAPTURED).put({
    blobUrl,
    bytes: uint8,
    size: uint8.byteLength,
    tabId,
    capturedAt: Date.now(),
  });
  await txPromise(tx);
  await pruneStore(STORE_CAPTURED, 'capturedAt', MAX_CAPTURED, MAX_CAPTURED_AGE_MS);
}

export async function getCapturedPdf(blobUrl) {
  const db = await openDb();
  const tx = db.transaction(STORE_CAPTURED, 'readonly');
  const rec = await reqPromise(tx.objectStore(STORE_CAPTURED).get(blobUrl));
  if (!rec) return null;
  if (Date.now() - (rec.capturedAt || 0) > MAX_CAPTURED_AGE_MS) {
    return null;
  }
  // Normalize back to Uint8Array in case structured clone returned ArrayBufferView
  const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
  return { ...rec, bytes };
}

export async function listCapturedPdfs() {
  await pruneStore(STORE_CAPTURED, 'capturedAt', MAX_CAPTURED, MAX_CAPTURED_AGE_MS);
  const db = await openDb();
  const tx = db.transaction(STORE_CAPTURED, 'readonly');
  const all = await reqPromise(tx.objectStore(STORE_CAPTURED).getAll());
  return all
    .map(({ blobUrl, size, tabId, capturedAt }) => ({ blobUrl, size, tabId, capturedAt }))
    .sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
}

export async function saveExportedPdf(record) {
  const db = await openDb();
  const uint8 = record.bytes instanceof Uint8Array ? record.bytes : new Uint8Array(record.bytes);
  const tx = db.transaction(STORE_EXPORTS, 'readwrite');
  tx.objectStore(STORE_EXPORTS).put({
    id: record.id,
    bytes: uint8,
    size: uint8.byteLength,
    filename: record.filename || '',
    createdAt: record.createdAt || Date.now(),
  });
  await txPromise(tx);
  await pruneStore(STORE_EXPORTS, 'createdAt', MAX_EXPORTS, MAX_EXPORT_AGE_MS);
}

export async function getExportedPdf(id) {
  const db = await openDb();
  const tx = db.transaction(STORE_EXPORTS, 'readonly');
  const rec = await reqPromise(tx.objectStore(STORE_EXPORTS).get(id));
  if (!rec) return null;
  if (Date.now() - (rec.createdAt || 0) > MAX_EXPORT_AGE_MS) {
    return null;
  }
  const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
  return { ...rec, bytes };
}

export async function deleteExportedPdf(id) {
  if (!id) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_EXPORTS, 'readwrite');
    tx.objectStore(STORE_EXPORTS).delete(id);
    await txPromise(tx);
  } catch {
    // Non-fatal cleanup
  }
}

export async function clearAllPdfs() {
  const db = await openDb();
  const tx = db.transaction([STORE_CAPTURED, STORE_EXPORTS], 'readwrite');
  tx.objectStore(STORE_CAPTURED).clear();
  tx.objectStore(STORE_EXPORTS).clear();
  await txPromise(tx);
}
