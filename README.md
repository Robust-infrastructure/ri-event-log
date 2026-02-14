# ri-event-log

Append-only immutable event log with hash chain integrity, temporal queries, and tiered storage.

## Status

**M8: Export & Import (Tiered Storage)** — Complete

| Milestone | Status |
|-----------|--------|
| M1: Project Scaffolding | Complete |
| M2: Core Types & Event Schema | Complete |
| M3: Event Storage & Hash Chain | Complete |
| M4: Query Engine | Complete |
| M5: Integrity Verification | Complete |
| M6: Snapshots & State Reconstruction | Complete |
| M7: Storage Budget & Monitoring | Complete |
| M8: Export & Import (Tiered Storage) | Complete |

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

## Quick Start

```typescript
import { createEventLog } from 'ri-event-log';

const log = createEventLog({ databaseName: 'my-app-log' });

// Write an event
const result = await log.writeEvent({
  spaceId: 'space-1',
  type: 'state_changed',
  timestamp: new Date().toISOString(),
  version: 1,
  payload: { key: 'value' },
});

if (result.ok) {
  console.log('Event written:', result.value.id);
  console.log('Hash:', result.value.hash);
  console.log('Sequence:', result.value.sequenceNumber);
}

// Query events by space
const events = await log.queryBySpace('space-1', { limit: 50, order: 'desc' });
if (events.ok) {
  console.log(`Found ${String(events.value.total)} events`);
  for (const event of events.value.items) {
    console.log(event.id, event.type, event.timestamp);
  }
  // Fetch next page
  if (events.value.nextCursor) {
    const page2 = await log.queryBySpace('space-1', {
      limit: 50,
      cursor: events.value.nextCursor,
    });
  }
}

// Query by type or time range
const actions = await log.queryByType('action_invoked');
const recent = await log.queryByTime('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');

// Create a snapshot and reconstruct state
const snapshot = await log.createSnapshot('space-1');
if (snapshot.ok) {
  console.log('Snapshot at sequence:', snapshot.value.eventSequenceNumber);
}

// Reconstruct state at a specific point in time
const state = await log.reconstructState('space-1', '2026-01-15T12:00:00Z');
if (state.ok) {
  console.log('State at timestamp:', state.value);
}

// Reconstruct latest state (uses nearest snapshot + replay)
const latest = await log.reconstructState('space-1');

// Custom state reducer for domain-specific state
const log2 = createEventLog({
  stateReducer: (state, event) => {
    const s = (state ?? { count: 0 }) as { count: number };
    return { count: s.count + 1, lastType: event.type };
  },
});
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
