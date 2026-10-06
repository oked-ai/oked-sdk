import { inflateRawSync } from "node:zlib";

/**
 * Read the files of a zip (stored or deflate entries, no zip64) through its
 * central directory. Enough for OKed export bundles.
 */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = buf.lastIndexOf(sig);
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 8) files.set(name, inflateRawSync(data));
    else if (method === 0) files.set(name, Buffer.from(data));
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
