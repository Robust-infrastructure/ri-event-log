/**
 * ri-event-log — Archive format constants and utilities
 *
 * Defines the `.rblogs` binary archive format:
 *   [Header: 10 bytes] [Body: variable] [Footer: 64 bytes]
 *
 * Header (10 bytes):
 *   - Magic bytes: 5 bytes — ASCII "RBLOG"
 *   - Format version: 1 byte — uint8 (currently 1)
 *   - Event count: 4 bytes — uint32 big-endian
 *
 * Body (variable):
 *   - Deflate-compressed JSON array of events
 *
 * Footer (64 bytes):
 *   - SHA-256 hex hash of the UNCOMPRESSED JSON body
 */

/** Magic bytes identifying the archive format. */
export const ARCHIVE_MAGIC = new Uint8Array([0x52, 0x42, 0x4c, 0x4f, 0x47]); // "RBLOG"

/** Current format version. */
export const ARCHIVE_VERSION = 1;

/** Header size in bytes: 5 (magic) + 1 (version) + 4 (count). */
export const HEADER_SIZE = 10;

/** Footer size in bytes: 64 hex chars of SHA-256 hash. */
export const FOOTER_SIZE = 64;

/**
 * Encode a 10-byte header for the archive.
 */
export function encodeHeader(eventCount: number): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  // Magic bytes
  header.set(ARCHIVE_MAGIC, 0);
  // Version
  header[5] = ARCHIVE_VERSION;
  // Event count (big-endian uint32)
  const view = new DataView(header.buffer);
  view.setUint32(6, eventCount, false);
  return header;
}

/**
 * Parse and validate an archive header.
 * Returns the format version and event count, or an error string.
 */
export function parseHeader(
  data: Uint8Array,
): { readonly version: number; readonly eventCount: number } | string {
  if (data.length < HEADER_SIZE) {
    return 'Archive too small to contain a valid header';
  }

  // Verify magic bytes
  for (let i = 0; i < ARCHIVE_MAGIC.length; i++) {
    if (data[i] !== ARCHIVE_MAGIC[i]) {
      return 'Invalid archive: magic bytes do not match';
    }
  }

  const version = data[5];
  if (version === undefined || version !== ARCHIVE_VERSION) {
    return `Unsupported archive version: ${String(version ?? 'undefined')}`;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eventCount = view.getUint32(6, false);

  return { version, eventCount };
}

/**
 * Compress data using deflate.
 */
export async function compressData(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const writePromise = writer.write(data as ArrayBufferView<ArrayBuffer>).then(() => writer.close());

  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }

  await writePromise;

  // Concatenate chunks
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Decompress deflated data.
 */
export async function decompressData(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const writePromise = writer.write(data as ArrayBufferView<ArrayBuffer>).then(() => writer.close());

  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }

  await writePromise;

  // Concatenate chunks
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
