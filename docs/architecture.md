# Architecture

> ri-event-log v1.0.0 — Phase 0 (IndexedDB / browser)

## Module Dependency Graph

```
event-log.ts (factory)
├── storage/database.ts        Dexie schema + conversion
├── storage/event-writer.ts    Append-only writes + hash chain
├── storage/budget.ts          Storage usage tracking
├── storage/compaction.ts      Snapshot-based compaction
├── queries/query-engine.ts    Cursor-paginated queries
├── integrity/verifier.ts      Hash chain verification
├── snapshots/
│   ├── snapshot-manager.ts    Snapshot creation + auto-snapshot
│   └── state-reconstructor.ts Replay from snapshot + events
├── archive/
│   ├── exporter.ts            Export to .rblogs
│   └── importer.ts            Import and deduplicate
├── hash-chain/
│   ├── hash.ts                SHA-256 via Web Crypto
│   └── chain.ts               Chain linking + validation
└── diff/
    ├── diff-storage.ts        Diff-aware event helpers
    └── diff-reconstructor.ts  Source reconstruction
```

Cross-module dependencies are **one-directional**. No module imports from a module that imports from it. The factory (`event-log.ts`) is the only file that pulls together all modules.

## Storage Schema (IndexedDB via Dexie)

Three tables with compound indexes:

```
┌──────────────────────────────────────────────────┐
│ events                                           │
│  PK: id                                          │
│  Indexes: spaceId, type, timestamp,              │
│           sequenceNumber, [spaceId+sequenceNumber]│
├──────────────────────────────────────────────────┤
│ snapshots                                        │
│  PK: id                                          │
│  Indexes: spaceId, eventSequenceNumber,          │
│           [spaceId+eventSequenceNumber]           │
├──────────────────────────────────────────────────┤
│ metadata                                         │
│  PK: key                                         │
└──────────────────────────────────────────────────┘
```

The compound indexes `[spaceId+sequenceNumber]` enable efficient range queries scoped to a single space — the most common access pattern.

## Write Path

```
writeEvent(input)
  ├── Validate input fields (type, spaceId, timestamp)
  ├── Transaction: {
  │     1. Read latest event for space (by [spaceId+sequenceNumber] desc)
  │     2. Compute sequenceNumber = prev.seq + 1 (or 1 for genesis)
  │     3. Set previousHash = prev.hash (or null for genesis)
  │     4. Generate id via idGenerator()
  │     5. Compute hash = SHA-256(deterministicSerialize(event))
  │     6. Put event into events table
  │   }
  ├── Auto-snapshot check:
  │     If (seq % snapshotInterval === 0) → createSnapshot()
  └── Return Result<Event>
```

All writes are transactional — if any step fails, no data is persisted. The hash chain is validated implicitly on every write (step 3 reads the predecessor).

## Query Path

```
queryBySpace(spaceId, options?)
  ├── Parse cursor (if provided) → { seq, id }
  ├── Validate options (limit clamping, ISO 8601 dates)
  ├── Open Dexie collection on [spaceId+sequenceNumber]
  │     With bounds: lower = cursor.seq, upper = +Infinity
  │     Direction: ascending or descending (from options.order)
  ├── Collect up to limit+1 items
  ├── If items.length > limit:
  │     Pop extra → compute nextCursor
  ├── Count total matching events
  └── Return PaginatedResult<Event>
```

Cursor-based pagination ensures stable iteration even when new events are written between pages. The cursor encodes `(sequenceNumber, id)` as base64 JSON.

## Snapshot & Reconstruction Path

```
createSnapshot(spaceId)
  ├── Find latest snapshot for space (if any)
  ├── Load events after snapshot's sequenceNumber
  ├── If no events → return SNAPSHOT_FAILED error
  ├── Fold events: state = reduce(state, event) for each
  ├── Compute hash = SHA-256(deterministicSerialize(state))
  ├── Derive timestamp from last included event
  ├── Generate id via idGenerator()
  └── Put snapshot into snapshots table

reconstructState(spaceId, atTimestamp?)
  ├── Find nearest snapshot BEFORE atTimestamp
  │     (or latest snapshot if no timestamp given)
  ├── Load snapshot state (or empty if no snapshot)
  ├── Query events AFTER snapshot up to atTimestamp
  ├── Fold events over snapshot state
  └── Return reconstructed state
```

Snapshots accelerate reconstruction by providing a checkpoint. Without snapshots, reconstruction replays from genesis.

## Archive Path

```
exportArchive(spaceId, beforeDate)
  ├── Query events older than beforeDate
  ├── Verify hash chain of selected events
  ├── Serialize to JSON array
  ├── Compress with CompressionStream (deflate)
  ├── Build: header(10) + compressed(N) + SHA-256(64)
  └── Return Uint8Array

importArchive(archive)
  ├── Validate header (magic, version, count)
  ├── Decompress body
  ├── Verify SHA-256 footer
  ├── Parse events from JSON
  ├── Deduplicate against existing events
  ├── Verify hash chain of imported events
  ├── Write non-duplicate events
  └── Return ImportReport
```

See [storage-format.md](storage-format.md) for the byte-level `.rblogs` specification.

## Concurrency Model

IndexedDB provides transaction isolation. Dexie wraps IndexedDB transactions with a promise-based API:

- **Writes**: Single-writer per space. The `writeEvent` transaction locks the `events` table for the duration of the read-compute-write cycle. Concurrent writes to the same space are serialized by IndexedDB.
- **Reads**: Multiple concurrent read transactions are allowed. Queries operate on a consistent snapshot of the database at transaction start time.
- **Snapshots**: Creating a snapshot reads events and writes a snapshot record within a single transaction.

There is no explicit locking — IndexedDB's transaction isolation handles concurrent access.

## Determinism Design

The library is designed for deterministic outputs given identical inputs:

| Concern | Approach |
|---------|----------|
| Event IDs | Generated by injectable `idGenerator` (default: `crypto.randomUUID()`) |
| Snapshot IDs | Same injectable `idGenerator` |
| Snapshot timestamps | Derived from last included event's timestamp (no `Date.now()`) |
| Event timestamps | Caller-provided — never generated by the library |
| Hashing | SHA-256 with deterministic serialization (sorted keys) |

For fully deterministic operation, inject a custom `idGenerator` via `EventLogConfig`:

```typescript
let counter = 0;
const log = createEventLog({
  idGenerator: () => `test-id-${counter++}`,
});
```

## Error Strategy

All public methods return `Result<T, EventLogError>` — never throw. Errors are discriminated unions on the `code` field (7 codes). Callers pattern-match on `result.ok` and `error.code`.

Internal errors from Dexie/IndexedDB are caught and wrapped in `DATABASE_ERROR`. Validation errors return `INVALID_EVENT` or `INVALID_QUERY`. Hash chain breaks return `INTEGRITY_VIOLATION`.

---

*See also: [reference.md](reference.md) · [hash-chain.md](hash-chain.md) · [storage-format.md](storage-format.md)*
