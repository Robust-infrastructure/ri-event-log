# `.rblogs` Archive Format

> ri-event-log v1.0.0 — Binary specification for event archives

## Overview

The `.rblogs` format is a compact binary archive for exporting and importing events. It uses a fixed header, deflate-compressed JSON body, and a SHA-256 integrity footer.

## Byte Layout

```
Offset   Size    Encoding       Content
──────── ─────── ────────────── ──────────────────────────────────
0        5       ASCII          Magic bytes: "RBLOG" (0x52 0x42 0x4C 0x4F 0x47)
5        1       uint8          Format version (currently 0x01)
6        4       uint32 BE      Event count
10       N       deflate        Compressed JSON body
10+N     64      ASCII hex      SHA-256 of uncompressed JSON body
```

Total size: `10 + N + 64` bytes

## Sections

### Header (10 bytes)

| Offset | Size | Type | Value | Description |
|--------|------|------|-------|-------------|
| 0 | 5 | `uint8[5]` | `[0x52, 0x42, 0x4C, 0x4F, 0x47]` | Magic bytes "RBLOG" — identifies the format |
| 5 | 1 | `uint8` | `0x01` | Format version. Only version 1 is defined. |
| 6 | 4 | `uint32 BE` | varies | Number of events in the archive (big-endian) |

### Body (variable length)

The body is a JSON array of `Event` objects, serialized with `JSON.stringify()`, then compressed using the Web Streams API `CompressionStream('deflate')`.

Each event in the JSON array has the full `Event` shape:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "type": "space_created",
    "spaceId": "my-space",
    "timestamp": "2025-01-01T00:00:00.000Z",
    "sequenceNumber": 1,
    "hash": "a1b2c3...64 hex chars",
    "previousHash": null,
    "version": 1,
    "payload": { "key": "value" }
  }
]
```

### Footer (64 bytes)

A SHA-256 hash of the **uncompressed** JSON body, encoded as a 64-character lowercase hexadecimal ASCII string.

This hash verifies the integrity of the decompressed content — not the compressed bytes.

## Compression

- **Algorithm**: `deflate` (RFC 1951)
- **API**: Web Streams API `CompressionStream('deflate')` / `DecompressionStream('deflate')`
- **Rationale**: Available in all modern browsers and Node.js 18+. Smaller output than raw JSON, fast decompression.

## Validation Rules

On import, the following checks are performed in order:

1. **Size check**: Archive must be at least 74 bytes (10 header + 0 body + 64 footer)
2. **Magic bytes**: First 5 bytes must be `RBLOG`
3. **Version**: Byte 5 must be `0x01`
4. **Event count**: Must be non-negative
5. **Decompress**: Body must decompress successfully
6. **Footer hash**: SHA-256 of decompressed body must match the 64-byte footer
7. **JSON parse**: Decompressed body must be valid JSON
8. **Event validation**: Each event must have the required fields with correct types
9. **Hash chain**: Events must form a valid hash chain (per space)

If any check fails, `IMPORT_FAILED` error is returned with a descriptive reason.

## Deduplication

On import, events with an `id` already present in the database are skipped. The `ImportReport.skippedDuplicates` field records how many events were skipped. This makes import idempotent — importing the same archive twice produces no duplicates.

## Round-Trip Guarantee

Export → import → export produces **byte-identical** archives for the same set of events. This is guaranteed by:

- Stable property order in serialized events (`toArchiveEvent` always produces fields in the same fixed order)
- Consistent event ordering (by space + sequence number)
- Stable compression output for identical input

Note: The archive body uses standard `JSON.stringify` (insertion-order keys), not the sorted-key `deterministicSerialize` used for individual event hashes.

## Version History

| Version | Status | Changes |
|---------|--------|---------|
| `0x01` | Current | Initial format |

---

*See also: [reference.md](reference.md) · [architecture.md](architecture.md)*
