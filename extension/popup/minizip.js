
window.MiniZip = class MiniZip {
  constructor() {
    this.files = [];
  }

  add(name, data) {
    let bytes;
    if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      bytes = data;
    }
    this.files.push({ name, bytes });
  }

  generate() {
    const encoder = new TextEncoder();
    const localHeaders = [];
    const centralDirectory = [];
    let offset = 0;

    for (const file of this.files) {
      const nameBytes = encoder.encode(file.name);
      const crc = crc32(file.bytes);
      const size = file.bytes.length;

      // Local file header
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);  // signature
      localView.setUint16(4, 20, true);            // version needed
      localView.setUint16(6, 0, true);             // flags
      localView.setUint16(8, 0, true);             // compression (stored)
      localView.setUint16(10, 0, true);            // mod time
      localView.setUint16(12, 0, true);            // mod date
      localView.setUint32(14, crc, true);          // crc32
      localView.setUint32(18, size, true);         // compressed size
      localView.setUint32(22, size, true);         // uncompressed size
      localView.setUint16(26, nameBytes.length, true); // name length
      localView.setUint16(28, 0, true);            // extra length
      localHeader.set(nameBytes, 30);

      const cdEntry = new Uint8Array(46 + nameBytes.length);
      const cdView = new DataView(cdEntry.buffer);
      cdView.setUint32(0, 0x02014b50, true);   // signature
      cdView.setUint16(4, 20, true);            // version made by
      cdView.setUint16(6, 20, true);            // version needed
      cdView.setUint16(8, 0, true);             // flags
      cdView.setUint16(10, 0, true);            // compression
      cdView.setUint16(12, 0, true);            // mod time
      cdView.setUint16(14, 0, true);            // mod date
      cdView.setUint32(16, crc, true);          // crc32
      cdView.setUint32(20, size, true);         // compressed size
      cdView.setUint32(24, size, true);         // uncompressed size
      cdView.setUint16(28, nameBytes.length, true); // name length
      cdView.setUint16(30, 0, true);            // extra length
      cdView.setUint16(32, 0, true);            // comment length
      cdView.setUint16(34, 0, true);            // disk number start
      cdView.setUint16(36, 0, true);            // internal attrs
      cdView.setUint32(38, 0, true);            // external attrs
      cdView.setUint32(42, offset, true);       // local header offset
      cdEntry.set(nameBytes, 46);

      localHeaders.push(localHeader, file.bytes);
      centralDirectory.push(cdEntry);
      offset += localHeader.length + size;
    }

    const cdSize = centralDirectory.reduce((s, e) => s + e.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);          // signature
    eocdView.setUint16(4, 0, true);                    // disk number
    eocdView.setUint16(6, 0, true);                    // start disk
    eocdView.setUint16(8, this.files.length, true);    // entries on disk
    eocdView.setUint16(10, this.files.length, true);   // total entries
    eocdView.setUint32(12, cdSize, true);              // cd size
    eocdView.setUint32(16, offset, true);              // cd offset
    eocdView.setUint16(20, 0, true);                   // comment length

    const parts = [...localHeaders, ...centralDirectory, eocd];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
      result.set(part instanceof Uint8Array ? part : new Uint8Array(part.buffer || part), pos);
      pos += part.length;
    }
    return result.buffer;
  }
};

function crc32(data) {
  const table = makeCRCTable();
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeCRCTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
}
