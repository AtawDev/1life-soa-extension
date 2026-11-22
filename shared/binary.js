/**
 * Shared binary, URL, and formatting helpers for 1Life SOA Diagnosis Filter.
 */

export const ONELIFE_BLOB_PREFIXES = [
  'blob:https://1life.ph/',
  'blob:https://www.1life.ph/',
];

export function isOneLifeBlobUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('blob:https://')) {
    return false;
  }
  try {
    const inner = new URL(url.slice('blob:'.length));
    const host = inner.hostname.toLowerCase();
    return host === '1life.ph' || host.endsWith('.1life.ph');
  } catch {
    return false;
  }
}

export function isOneLifeOriginUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === '1life.ph' || host.endsWith('.1life.ph');
  } catch {
    return false;
  }
}

export function shortBlobId(url) {
  if (!url) return 'PDF';
  try {
    const parts = url.split('/');
    const last = parts[parts.length - 1] || url;
    return last.length > 18 ? `${last.slice(0, 8)}...${last.slice(-6)}` : last;
  } catch {
    return 'PDF';
  }
}

export function isPdfBytes(bytes) {
  if (!bytes || bytes.length < 5) return false;
  // "%PDF-" may appear within the first 1024 bytes per PDF spec
  const limit = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === 0x25 &&     // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d    // -
    ) {
      return true;
    }
  }
  return false;
}

export function uint8ToBase64(uint8) {
  const bytes = uint8 instanceof Uint8Array ? uint8 : new Uint8Array(uint8);
  const chunkSize = 0x8000; // 32KB chunks avoid stack overflow
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode.apply(null, slice));
  }
  return btoa(chunks.join(''));
}

export function base64ToUint8(base64) {
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(clean);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function escapeCsvCell(val) {
  const s = String(val ?? '');
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildExportFilename(category, patientCount) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const labelMap = {
    no_diagnosis: 'No_Diagnosis',
    zero_amount: 'Zero_Total_Amount',
    cleared: 'Cleared_Diagnosed',
  };
  const label = labelMap[category] || 'Filtered';
  return `1Life_SOA_${label}_${yyyy}-${mm}-${dd}_${patientCount}patients.pdf`;
}

export function randomId(prefix = 'exp') {
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  const hex = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${Date.now().toString(36)}_${hex}`;
}
