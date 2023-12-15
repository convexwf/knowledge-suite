/**
 * Minimal ZIP writer used by `GET /api/items/:itemId/package`.
 *
 * Trade-off recorded in ROADMAP.md: this keeps the server dependency-free and
 * covers the package format we emit today (a handful of entries, no ZIP64, no
 * streaming, whole archive buffered in memory), but it is owned code with hard
 * limits — entries above 65535, files above 4 GB, or streaming writes would
 * need `fflate` (zero dependencies) or `yazl` (one dependency) instead.
 * Output is deterministic: fixed DOS timestamps, `/` separators, UTF-8 flag.
 */
import { deflateRawSync } from "node:zlib";

export interface ZipEntryInput {
  path: string;
  bytes: Buffer;
  compress?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeEntryPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Build a minimal ZIP archive.
 *
 * Entries are deflated by default; pass `compress: false` to store bytes
 * verbatim. Timestamps are fixed so the same input always produces the same
 * archive bytes, which keeps artifact comparison in tests meaningful.
 */
export function buildZipArchive(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(normalizeEntryPath(entry.path), "utf8");
    const compress = entry.compress ?? true;
    const deflated = compress ? deflateRawSync(entry.bytes) : entry.bytes;
    const stored = deflated.byteLength >= entry.bytes.byteLength ? entry.bytes : deflated;
    const method = stored === entry.bytes ? 0 : 8;
    const flags = name.some((byte) => byte > 0x7f) ? 0x0800 : 0x0000;
    const crc = crc32(entry.bytes);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(stored.byteLength, 18);
    localHeader.writeUInt32LE(entry.bytes.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, stored);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(stored.byteLength, 20);
    centralHeader.writeUInt32LE(entry.bytes.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, name);
    offset += localHeader.byteLength + name.byteLength + stored.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.byteLength, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}
