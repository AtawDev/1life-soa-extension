/**
 * Minimal, standards-compliant ZIP builder (pure JS, zero dependencies).
 * Uses native CompressionStream('deflate-raw') when available, falling back to STORE (0).
 * Produces valid .docx / OpenXML ZIP archives compatible with Microsoft Word, LibreOffice, and Google Docs.
 */

const textEncoder = new TextEncoder();

// Precompute standard IEEE 802.3 CRC-32 lookup table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') {
    return null;
  }
  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    const writePromise = writer.write(bytes).then(() => writer.close());
    const chunks = [];
    const reader = cs.readable.getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await writePromise;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Create a ZIP archive Uint8Array from an array of { name: string, data: string | Uint8Array }.
 */
export async function createZip(entries) {
  const { dosTime, dosDate } = toDosTimeDate();
  const prepared = [];

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const rawBytes =
      typeof entry.data === 'string'
        ? textEncoder.encode(entry.data)
        : entry.data instanceof Uint8Array
          ? entry.data
          : new Uint8Array(entry.data);

    const crc = crc32(rawBytes);
    let method = 0;
    let payload = rawBytes;

    // Compress text/XML entries (skip already-compressed images like PNG/JPG)
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(entry.name);
    if (!isImage && rawBytes.byteLength > 64) {
      const deflated = await deflateRaw(rawBytes);
      if (deflated && deflated.byteLength < rawBytes.byteLength) {
        method = 8;
        payload = deflated;
      }
    }

    prepared.push({
      nameBytes,
      rawBytes,
      payload,
      crc,
      method,
      offset: 0,
    });
  }

  let localSize = 0;
  let centralSize = 0;
  for (const item of prepared) {
    item.offset = localSize;
    localSize += 30 + item.nameBytes.length + item.payload.length;
    centralSize += 46 + item.nameBytes.length;
  }

  const totalSize = localSize + centralSize + 22;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let pos = 0;

  // Write Local File Headers + File Data
  for (const item of prepared) {
    view.setUint32(pos, 0x04034b50, true); pos += 4; // Local file header signature
    view.setUint16(pos, 20, true); pos += 2;         // Version needed (2.0)
    view.setUint16(pos, 0x0800, true); pos += 2;     // General purpose bit flag (UTF-8)
    view.setUint16(pos, item.method, true); pos += 2;
    view.setUint16(pos, dosTime, true); pos += 2;
    view.setUint16(pos, dosDate, true); pos += 2;
    view.setUint32(pos, item.crc, true); pos += 4;
    view.setUint32(pos, item.payload.length, true); pos += 4;
    view.setUint32(pos, item.rawBytes.length, true); pos += 4;
    view.setUint16(pos, item.nameBytes.length, true); pos += 2;
    view.setUint16(pos, 0, true); pos += 2;          // Extra field length
    out.set(item.nameBytes, pos); pos += item.nameBytes.length;
    out.set(item.payload, pos); pos += item.payload.length;
  }

  const centralStart = pos;

  // Write Central Directory Headers
  for (const item of prepared) {
    view.setUint32(pos, 0x02014b50, true); pos += 4; // Central directory signature
    view.setUint16(pos, 20, true); pos += 2;         // Version made by
    view.setUint16(pos, 20, true); pos += 2;         // Version needed
    view.setUint16(pos, 0x0800, true); pos += 2;     // UTF-8 flag
    view.setUint16(pos, item.method, true); pos += 2;
    view.setUint16(pos, dosTime, true); pos += 2;
    view.setUint16(pos, dosDate, true); pos += 2;
    view.setUint32(pos, item.crc, true); pos += 4;
    view.setUint32(pos, item.payload.length, true); pos += 4;
    view.setUint32(pos, item.rawBytes.length, true); pos += 4;
    view.setUint16(pos, item.nameBytes.length, true); pos += 2;
    view.setUint16(pos, 0, true); pos += 2;          // Extra field length
    view.setUint16(pos, 0, true); pos += 2;          // File comment length
    view.setUint16(pos, 0, true); pos += 2;          // Disk number start
    view.setUint16(pos, 0, true); pos += 2;          // Internal file attributes
    view.setUint32(pos, 0, true); pos += 4;          // External file attributes
    view.setUint32(pos, item.offset, true); pos += 4;
    out.set(item.nameBytes, pos); pos += item.nameBytes.length;
  }

  // Write End of Central Directory Record (EOCD)
  view.setUint32(pos, 0x06054b50, true); pos += 4;
  view.setUint16(pos, 0, true); pos += 2;            // Disk number
  view.setUint16(pos, 0, true); pos += 2;            // Central dir start disk
  view.setUint16(pos, prepared.length, true); pos += 2;
  view.setUint16(pos, prepared.length, true); pos += 2;
  view.setUint32(pos, centralSize, true); pos += 4;
  view.setUint32(pos, centralStart, true); pos += 4;
  view.setUint16(pos, 0, true); pos += 2;            // Comment length

  return out;
}
