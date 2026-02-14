# Integration Guide

> ri-event-log v1.0.0 — How to integrate the event log into your application

## Installation

```bash
npm install ri-event-log
```

The package ships ESM and CJS bundles with TypeScript declarations.

## Quick Start

```typescript
import { createEventLog } from 'ri-event-log';

const log = createEventLog();

// Write an event
const result = await log.writeEvent({
  type: 'state_changed',
  spaceId: 'my-space',
  timestamp: new Date().toISOString(),
  version: 1,
  payload: { count: 42 },
});

if (result.ok) {
  console.log('Event written:', result.value.id);
} else {
  console.error('Write failed:', result.error.code);
}
```

## Configuration

All configuration is optional with sensible defaults:

```typescript
const log = createEventLog({
  databaseName: 'my-app-events',   // IndexedDB database name (default: "event-log")
  schemaVersion: 1,                // Database schema version (default: 1)
  maxEventsPerQuery: 500,          // Max items per query page (default: 1000)
  snapshotInterval: 50,            // Auto-snapshot every N events per space (default: 100)
  hashAlgorithm: 'SHA-256',       // Hash algorithm (default, only option)
  stateReducer: myReducer,        // Custom state reducer (default: last-write-wins)
  idGenerator: () => uuid(),      // Custom ID generator (default: crypto.randomUUID())
});
```

## Error Handling

Every method returns `Result<T, EventLogError>` — a discriminated union. No methods throw.

```typescript
const result = await log.writeEvent({ ... });

if (result.ok) {
  // result.value is the Event
  const event = result.value;
} else {
  // result.error is an EventLogError
  switch (result.error.code) {
    case 'INVALID_EVENT':
      console.error(`Invalid field: ${result.error.field}`);
      break;
    case 'INTEGRITY_VIOLATION':
      console.error(`Hash chain broken at: ${result.error.eventId}`);
      break;
    case 'DATABASE_ERROR':
      console.error(`DB error: ${result.error.reason}`);
      break;
    // ... handle other error codes
  }
}
```

### Error Codes

| Code | When |
|------|------|
| `INTEGRITY_VIOLATION` | Hash chain link is broken |
| `STORAGE_FULL` | Storage quota exceeded |
| `INVALID_QUERY` | Bad query parameters (invalid cursor, bad dates) |
| `INVALID_EVENT` | Invalid event data (missing fields, wrong types) |
| `SNAPSHOT_FAILED` | Snapshot creation failed (no events, already up to date) |
| `IMPORT_FAILED` | Archive import failed (bad format, hash mismatch) |
| `DATABASE_ERROR` | IndexedDB error |

## Querying Events

Three query methods with cursor-based pagination:

```typescript
// Query by space
const page1 = await log.queryBySpace('my-space', { limit: 50 });
if (page1.ok) {
  console.log(`${page1.value.total} total events`);
  for (const event of page1.value.items) {
    console.log(event.type, event.timestamp);
  }
  // Fetch next page
  if (page1.value.nextCursor !== undefined) {
    const page2 = await log.queryBySpace('my-space', {
      limit: 50,
      cursor: page1.value.nextCursor,
    });
  }
}

// Query by event type
const actions = await log.queryByType('action_invoked', { limit: 100 });

// Query by time range (from inclusive, to exclusive)
const recent = await log.queryByTime(
  '2025-01-01T00:00:00.000Z',
  '2025-02-01T00:00:00.000Z',
  { order: 'desc', limit: 20 },
);
```

## State Reconstruction

Reconstruct the aggregated state of a space at any point in time:

```typescript
// Define a custom state reducer
function counterReducer(state: unknown, event: Event): unknown {
  const current = (state as { count: number } | null)?.count ?? 0;
  const delta = (event.payload as { delta: number }).delta;
  return { count: current + delta };
}

const log = createEventLog({ stateReducer: counterReducer });

// Write some events
await log.writeEvent({
  type: 'state_changed',
  spaceId: 'counter',
  timestamp: '2025-01-01T00:00:00.000Z',
  version: 1,
  payload: { delta: 1 },
});
await log.writeEvent({
  type: 'state_changed',
  spaceId: 'counter',
  timestamp: '2025-01-02T00:00:00.000Z',
  version: 1,
  payload: { delta: 5 },
});

// Reconstruct at latest
const state = await log.reconstructState('counter');
// state.value === { count: 6 }

// Reconstruct at a specific time
const earlier = await log.reconstructState('counter', '2025-01-01T12:00:00.000Z');
// earlier.value === { count: 1 }
```

## Integrity Verification

Verify that no events have been tampered with:

```typescript
// Verify one space
const report = await log.verifyIntegrity('my-space');
if (report.ok && report.value.valid) {
  console.log(`All ${report.value.checkedEvents} events verified`);
}

// Verify entire database
const full = await log.verifyIntegrity();
```

## Snapshots & Compaction

Snapshots accelerate state reconstruction by caching intermediate state:

```typescript
// Manual snapshot
await log.createSnapshot('my-space');

// Compaction: create a snapshot at the latest event
await log.compact('my-space');
```

Auto-snapshots are created automatically every `snapshotInterval` events (default: 100).

## Storage Monitoring

```typescript
import { getStoragePressure } from 'ri-event-log';

const usage = await log.getStorageUsage();
if (usage.ok) {
  console.log(`${usage.value.totalEvents} events, ~${usage.value.estimatedBytes} bytes`);

  // Check storage pressure (pure function, no DB needed)
  const pressure = getStoragePressure(usage.value, 50_000_000); // 50 MB budget
  console.log(`Pressure level: ${pressure.level}`);   // NORMAL, COMPACT, etc.
  console.log(`Recommendation: ${pressure.recommendation}`);
}
```

## Export & Import

Archive old events to free space, import them later:

```typescript
// Export events older than a date
const archive = await log.exportArchive('my-space', '2025-01-01T00:00:00.000Z');
if (archive.ok) {
  // Save archive.value (Uint8Array) to disk, cloud, etc.
  await saveToFile('backup.rblogs', archive.value);
}

// Import events from an archive
const data = await loadFromFile('backup.rblogs');
const report = await log.importArchive(data);
if (report.ok) {
  console.log(`Imported: ${report.value.importedEvents}`);
  console.log(`Skipped duplicates: ${report.value.skippedDuplicates}`);
}
```

## Deterministic Mode

For testing or reproducible pipelines, inject a deterministic ID generator:

```typescript
let counter = 0;
const log = createEventLog({
  idGenerator: () => `deterministic-${counter++}`,
  stateReducer: myReducer,
});

// All event and snapshot IDs will be predictable
// Timestamps are always caller-provided (never auto-generated)
```

This ensures identical inputs produce identical outputs — events have the same IDs, hashes, and chain structure.

## AST Diff Storage

For source code tracking, use the diff helpers:

```typescript
import { writeGenesisEvent, writeDiffEvent, reconstructSource } from 'ri-event-log';

// Initial source
await writeGenesisEvent(db, 'my-space', timestamp, source, sourceHash, wasmHash);

// Subsequent changes (store only the diff)
await writeDiffEvent(db, 'my-space', timestamp, astDiff, scopeMetadata, sourceHash);

// Reconstruct full source at any point
const result = await reconstructSource(db, 'my-space', atTimestamp);
```

See [ast-diff-storage.md](ast-diff-storage.md) for details.

## Multiple Spaces

Each space maintains its own independent event chain:

```typescript
const log = createEventLog();

await log.writeEvent({ type: 'space_created', spaceId: 'space-a', ... });
await log.writeEvent({ type: 'space_created', spaceId: 'space-b', ... });

// Events in space-a don't affect space-b
// Queries, snapshots, and integrity checks can be scoped to a single space
```

## Browser Compatibility

The library uses:

- **IndexedDB**: All modern browsers
- **Web Crypto API**: All modern browsers, Node.js 15+
- **CompressionStream**: Chrome 80+, Firefox 113+, Safari 16.4+, Node.js 18+

For Node.js testing, use `fake-indexeddb` to polyfill IndexedDB.

---

*See also: [reference.md](reference.md) · [architecture.md](architecture.md)*
