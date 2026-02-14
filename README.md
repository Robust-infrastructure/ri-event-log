# ri-event-log

Append-only immutable event log with hash chain integrity, temporal queries, and tiered storage.

## Status

**M1: Project Scaffolding** — In Progress

See [ROADMAP.md](ROADMAP.md) for the full development plan.

## Overview

`ri-event-log` is a standalone TypeScript library that provides:

- **Append-only storage** — events are never modified or deleted
- **SHA-256 hash chain** — every event links to its predecessor; tampering is always detected
- **Temporal queries** — query by space, type, or time range with cursor-based pagination
- **Snapshots & state reconstruction** — reconstruct any space's state at any point in time
- **AST diff storage** — store compact diffs instead of full source (~10x savings)
- **Tiered storage** — hot data in IndexedDB, old data exportable to `.rblogs` archives
- **Storage budget monitoring** — threshold-based pressure levels

## Install

```bash
npm install ri-event-log
```

## API Surface

```typescript
interface EventLog {
  writeEvent(event): Promise<Result<Event>>;
  queryBySpace(spaceId, options?): Promise<Result<PaginatedResult<Event>>>;
  queryByType(type, options?): Promise<Result<PaginatedResult<Event>>>;
  queryByTime(from, to, options?): Promise<Result<PaginatedResult<Event>>>;
  reconstructState(spaceId, atTimestamp?): Promise<Result<unknown>>;
  verifyIntegrity(spaceId?): Promise<Result<IntegrityReport>>;
  createSnapshot(spaceId): Promise<Result<Snapshot>>;
  getStorageUsage(): Promise<Result<StorageReport>>;
  exportArchive(spaceId, beforeDate): Promise<Result<Uint8Array>>;
  importArchive(archive): Promise<Result<ImportReport>>;
}
```

## Public Types

| Type | Description |
|------|-------------|
| `Event` | An immutable record in the log |
| `EventType` | Union of 11 supported event categories |
| `QueryOptions` | Pagination options: `limit`, `cursor`, `order` |
| `PaginatedResult<T>` | Paginated result with `items`, `nextCursor`, `total` |
| `Snapshot` | Compacted state at a point in the event chain |
| `IntegrityReport` | Hash chain verification result |
| `StorageReport` | Storage utilization with per-space breakdown |
| `ImportReport` | Archive import result with success/skip/error counts |
| `EventLogConfig` | Configuration: database name, snapshot interval, state reducer |
| `EventLogError` | Discriminated union of 7 error types |
| `Result<T, E>` | `{ ok: true; value: T } \| { ok: false; error: E }` |

## Error Types

All errors use a discriminated union with a `code` field:

| Code | Meaning |
|------|---------|
| `INTEGRITY_VIOLATION` | Hash chain link broken |
| `STORAGE_FULL` | Storage quota exceeded |
| `INVALID_QUERY` | Malformed query parameters |
| `INVALID_EVENT` | Invalid event data |
| `SNAPSHOT_FAILED` | Snapshot creation failed |
| `IMPORT_FAILED` | Archive import failed |
| `DATABASE_ERROR` | IndexedDB operation failed |

## Development

```bash
npm run build       # Build ESM + CJS + types
npm run test        # Run tests
npm run test:watch  # Run tests in watch mode
npm run lint        # Lint source files
npm run typecheck   # TypeScript type checking
npm run format      # Format with Prettier
```

## Technology

- **TypeScript** (strict mode)
- **Vitest** (testing)
- **tsup** (build — ESM + CJS dual output)
- **Dexie.js** (IndexedDB wrapper)
- **Web Crypto API** (SHA-256 hashing)

## Performance Targets

| Operation | Target |
|-----------|--------|
| Write event | < 5ms |
| Query (10,000 events) | < 50ms |
| State reconstruction (with snapshots) | < 100ms |
| Integrity verification (10,000 events) | < 5s |

## Invariants

- Events are **never** modified or deleted after write (append-only)
- Hash chain links every event to its predecessor via SHA-256
- Sequence numbers are monotonically increasing per space
- Genesis event (first event per space) has `previousHash: null`
- Same events written in same order produce identical hashes (determinism)

## License

[MIT](LICENSE)
