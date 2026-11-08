/**
 * Minimal ZIP reader for knowledge packages produced by `zip.ts`.
 *
 * Mirrors the writer: local file headers carry sizes, no data descriptors,
 * no ZIP64. Anything outside that shape is rejected instead of guessed.
 */
import { inflateRawSync } from "node:zlib";

export interface ZipReadEntry {
  path: string;
  bytes: Buffer;
}

export function readZipArchive(archive: Buffer): ZipReadEntry[] {
  const entries: ZipReadEntry[] = [];
  let offset = 0;
  while (offset + 30 <= archive.byteLength && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.byteLength) {
      throw new Error("truncated zip entry");
    }
    const path = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const stored = archive.subarray(dataStart, dataEnd);
    const bytes = method === 8 ? inflateRawSync(stored) : Buffer.from(stored);
    if (bytes.byteLength !== uncompressedSize) {
      throw new Error(`zip entry size mismatch: ${path}`);
    }
    entries.push({ path, bytes });
    offset = dataEnd;
  }
  if (entries.length === 0) {
    throw new Error("empty or unsupported zip archive");
  }
  return entries;
}
