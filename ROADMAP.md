# ri-event-log — ROADMAP

Append-only immutable event log with hash chain integrity, temporal queries, and tiered storage.

**Scope**: Phase 0 — everything needed to ship a production-ready npm package.

**Technology**: TypeScript, Vitest, tsup, Dexie.js (IndexedDB), Web Crypto API.

---

## M1: Project Scaffolding (Status: NOT STARTED)

**Goal**: Working TypeScript project with build, test, lint, and CI infrastructure.

**Depends on**: None

### Tasks

- [ ] Initialize npm project (`npm init`) with `"type": "module"`
- [ ] Install dev dependencies: `typescript`, `vitest`, `tsup`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `prettier`
- [ ] Create `tsconfig.json` (strict mode, ES2022 target, ESNext modules, bundler resolution)
- [ ] Create `vitest.config.ts` with v8 coverage provider, 90% line / 85% branch / 90% function thresholds
- [ ] Create `tsup.config.ts` — ESM + CJS dual output, entry `src/index.ts`, dts generation
- [ ] Create `.eslintrc.cjs` or `eslint.config.js` with @typescript-eslint strict rules
- [ ] Create `.prettierrc` (singleQuote, trailingComma, printWidth 100)
- [ ] Create `src/index.ts` with placeholder export
- [ ] Create `src/types.ts` with all public type definitions (see M2)
- [ ] Create `src/errors.ts` with error type union
- [ ] Create GitHub Actions workflow `.github/workflows/ci.yml` — runs lint, type-check, test on push/PR
- [ ] Create `README.md` — project description, API overview, install instructions, usage example
- [ ] Create `LICENSE` (MIT)
- [ ] Verify: `npx tsc --noEmit` passes
- [ ] Verify: `npx vitest run` passes (placeholder test)
- [ ] Verify: `npx tsup` produces `dist/` with ESM + CJS + types
- [ ] Commit and tag `v0.1.0`

### Done When

- [ ] `npm run build` produces working ESM + CJS output with `.d.ts` files
- [ ] `npm run test` runs Vitest with zero failures
- [ ] `npm run lint` passes with zero warnings
- [ ] `npm run typecheck` passes with zero errors
- [ ] CI workflow runs successfully on push
- [ ] README documents the project purpose and planned API

---

## M2: Core Types & Event Schema (Status: NOT STARTED)

**Goal**: All public types defined — the complete API contract before any implementation.

**Depends on**: M1

### Tasks

- [ ] Define `Event` interface — `id` (string, UUID v4), `type` (string), `spaceId` (string), `timestamp` (ISO 8601 string), `sequenceNumber` (number), `hash` (string, SHA-256 hex), `previousHash` (string | null for genesis), `version` (number, schema version), `payload` (Record<string, unknown>)
- [ ] Define `EventType` union — `space_created`, `space_evolved`, `space_forked`, `space_deleted`, `state_changed`, `action_invoked`, `intent_submitted`, `intent_queued`, `intent_resolved`, `user_feedback`, `system_event`
- [ ] Define `QueryOptions` — `limit` (default 100, max 1000), `cursor` (opaque string), `order` ('asc' | 'desc', default 'asc')
- [ ] Define `PaginatedResult<T>` — `items: T[]`, `nextCursor?: string`, `total: number`
- [ ] Define `Snapshot` interface — `id`, `spaceId`, `eventSequenceNumber`, `timestamp`, `state` (unknown), `hash` (integrity hash of snapshot content)
- [ ] Define `IntegrityReport` — `valid: boolean`, `totalEvents: number`, `checkedEvents: number`, `firstBrokenLink?: { eventId: string; expected: string; actual: string }`, `duration: number`
- [ ] Define `StorageReport` — `totalEvents: number`, `totalSnapshots: number`, `estimatedBytes: number`, `oldestEvent?: string`, `newestEvent?: string`, per-space breakdown
- [ ] Define `ImportReport` — `importedEvents: number`, `skippedDuplicates: number`, `errors: ImportError[]`
- [ ] Define `EventLogConfig` — `databaseName` (string, default "event-log"), `schemaVersion` (number), `maxEventsPerQuery` (number, default 1000), `snapshotInterval` (number, default 100 — create snapshot every N events per space), `hashAlgorithm` ('SHA-256')
- [ ] Define `EventLog` interface — all 10 methods with full signatures: `writeEvent`, `queryBySpace`, `queryByType`, `queryByTime`, `reconstructState`, `verifyIntegrity`, `createSnapshot`, `getStorageUsage`, `exportArchive`, `importArchive`
- [ ] Define `EventLogError` discriminated union — `INTEGRITY_VIOLATION`, `STORAGE_FULL`, `INVALID_QUERY`, `INVALID_EVENT`, `SNAPSHOT_FAILED`, `IMPORT_FAILED`, `DATABASE_ERROR`
- [ ] Define `Result<T, E>` type — `{ ok: true; value: T } | { ok: false; error: E }`
- [ ] Write type-level tests — verify types compile correctly, verify discriminated unions narrow properly
- [ ] Export all types from `src/index.ts`
- [ ] Update `README.md` with full type documentation

### Done When

- [ ] All public types are defined and exported
- [ ] `npx tsc --noEmit` passes — types are valid TypeScript
- [ ] Type tests verify discriminated union narrowing
- [ ] `npx tsup` produces `.d.ts` files with all types
- [ ] README documents every public type

---

## M3: Event Storage & Hash Chain (Status: NOT STARTED)

**Goal**: Core write path — append events with SHA-256 hash chain integrity.

**Depends on**: M2

### Tasks

- [ ] Install `dexie` (IndexedDB wrapper)
- [ ] Create `src/storage/database.ts` — Dexie database setup with schema:
    - `events` table: keyPath `id`, indexes on `spaceId`, `type`, `timestamp`, `sequenceNumber`
    - `snapshots` table: keyPath `id`, indexes on `spaceId`, `eventSequenceNumber`
    - `metadata` table: keyPath `key` (sequence counters, schema version, storage stats)
- [ ] Create `src/hash-chain/hash.ts` — SHA-256 hash computation using Web Crypto API (`crypto.subtle.digest`)
    - `computeEventHash(event: Omit<Event, 'hash'>): Promise<string>` — deterministic serialization → SHA-256 → hex string
    - Deterministic serialization: sort keys alphabetically, stable JSON stringify
- [ ] Create `src/hash-chain/chain.ts` — hash chain linking logic
    - Get `previousHash` from the last event for a space (or null for genesis)
    - Verify chain link before write — `previousHash` must match last event's `hash`
- [ ] Create `src/storage/event-writer.ts` — `writeEvent` implementation
    - Validate event fields (non-empty spaceId, valid type, non-empty payload)
    - Generate UUID v4 for `id`
    - Set `timestamp` to caller-injected time (NOT `Date.now()`)
    - Increment `sequenceNumber` atomically (per-space counter in metadata table)
    - Compute hash chain (`previousHash` from last event, then compute `hash`)
    - Write to IndexedDB in a single Dexie transaction (atomicity)
    - Return the complete `Event` on success, `EventLogError` on failure
- [ ] Create `src/storage/event-writer.test.ts` — unit tests:
    - Writes first event with `previousHash: null`
    - Writes second event with correct `previousHash` linking to first
    - Writes 100 events and verifies chain integrity
    - Rejects event with empty `spaceId`
    - Rejects event with invalid `type`
    - Handles concurrent writes to the same space (serialized via Dexie transaction)
    - Handles concurrent writes to different spaces (independent chains)
- [ ] Create `src/hash-chain/hash.test.ts` — unit tests:
    - Deterministic: same input → same hash
    - Different input → different hash
    - Serialization is key-order independent
    - Empty payload hashes correctly
    - Large payload (100KB) hashes within performance target
- [ ] Create `src/hash-chain/chain.test.ts` — unit tests:
    - Genesis event has null previousHash
    - Chain links are correct across 10 events
    - Detects tampered event (modified payload, hash mismatch)
    - Detects missing event in chain
- [ ] Wire `writeEvent` into the `EventLog` factory function in `src/event-log.ts`
- [ ] Export factory function `createEventLog(config: EventLogConfig): EventLog` from `src/index.ts`

### Done When

- [ ] `writeEvent` appends events with correct hash chain
- [ ] SHA-256 hash computed via Web Crypto API
- [ ] Hash chain is verified on every write
- [ ] Events are written atomically (Dexie transaction)
- [ ] All unit tests pass
- [ ] `npx tsc --noEmit` passes
- [ ] Coverage ≥ 90% for hash chain and event writer modules

---

## M4: Query Engine (Status: NOT STARTED)

**Goal**: All query methods — by space, by type, by time range — with cursor-based pagination.

**Depends on**: M3

### Tasks

- [ ] Create `src/queries/query-engine.ts` — query executor
    - `queryBySpace(spaceId, options?)` — returns all events for a space, paginated
    - `queryByType(type, options?)` — returns all events of a given type, paginated
    - `queryByTime(from, to, options?)` — returns events within ISO 8601 time range, paginated
    - All queries support `limit` (default 100, max 1000), `cursor`, `order` (asc/desc)
- [ ] Implement cursor-based pagination
    - Cursor encodes `(sequenceNumber, id)` — opaque base64 string to caller
    - Forward cursor: `WHERE sequenceNumber > cursor.seq`
    - Backward cursor: `WHERE sequenceNumber < cursor.seq` (for desc order)
    - `nextCursor` is undefined when no more results
- [ ] Implement `total` count — use Dexie `.count()` with the same filters
- [ ] Create `src/queries/query-engine.test.ts` — unit tests:
    - Empty database returns `{ items: [], nextCursor: undefined, total: 0 }`
    - queryBySpace returns only events for the requested space
    - queryByType returns only events of the requested type
    - queryByTime returns events within the range (inclusive-exclusive)
    - queryByTime with invalid ISO strings returns `INVALID_QUERY` error
    - Pagination: 250 events, limit 100 → 3 pages with correct cursors
    - Pagination: last page has `nextCursor: undefined`
    - Order: `asc` returns oldest first, `desc` returns newest first
    - Limit clamped to max 1000 — requesting 2000 returns 1000
    - Cross-space: events from different spaces don't leak into each other's queries
- [ ] Performance test: queryBySpace with 10,000 events completes in < 50ms
- [ ] Wire all query methods into `EventLog` factory

### Done When

- [ ] All three query methods work with pagination
- [ ] Cursor-based pagination is correct and opaque to callers
- [ ] 10,000-event query completes in < 50ms
- [ ] All unit tests pass
- [ ] Coverage ≥ 90% for query module

---

## M5: Integrity Verification (Status: NOT STARTED)

**Goal**: Full chain verification — detect any tampering or corruption in the event log.

**Depends on**: M3

### Tasks

- [ ] Create `src/integrity/verifier.ts` — `verifyIntegrity` implementation
    - Walk the hash chain from genesis to latest event
    - For each event: recompute hash from payload, verify it matches stored hash
    - For each event: verify `previousHash` matches the prior event's hash
    - Support per-space verification (`spaceId` parameter) or full-database verification (all spaces)
    - Return `IntegrityReport` with: `valid`, `totalEvents`, `checkedEvents`, `firstBrokenLink` (if any), `duration`
    - Batch processing: verify in chunks of 500 events to avoid blocking
- [ ] Create `src/integrity/verifier.test.ts` — unit tests:
    - Empty database: `{ valid: true, totalEvents: 0, checkedEvents: 0 }`
    - Single event: valid chain
    - 100 events: valid chain
    - Tampered event (payload modified): `valid: false`, correct `firstBrokenLink`
    - Tampered event (hash modified): `valid: false`, next event's `previousHash` mismatch
    - Deleted event (gap in chain): `valid: false`, detects missing link
    - Per-space verification: only checks events for the requested space
    - Full verification: checks all spaces
    - 10,000 events: completes within 5 seconds
- [ ] Wire `verifyIntegrity` into `EventLog` factory

### Done When

- [ ] `verifyIntegrity` detects all forms of tampering (payload, hash, deletion)
- [ ] Reports include exact location of first broken link
- [ ] Per-space and full-database verification both work
- [ ] All unit tests pass
- [ ] Coverage ≥ 90% for verifier module

---

## M6: Snapshots & State Reconstruction (Status: NOT STARTED)

**Goal**: Snapshot creation and temporal state reconstruction — reconstruct any space's state at any point in time.

**Depends on**: M4, M5

### Tasks

- [ ] Create `src/snapshots/snapshot-manager.ts` — snapshot operations
    - `createSnapshot(spaceId)` — capture current state:
        1. Query all events for space (ordered by sequence)
        2. Build state by applying events sequentially (caller provides `stateReducer` in config)
        3. Store snapshot: `{ id, spaceId, eventSequenceNumber, timestamp, state, hash }`
        4. Hash includes state content for integrity
    - Auto-snapshot: trigger after every `snapshotInterval` events per space (configurable, default 100)
- [ ] Create `src/snapshots/state-reconstructor.ts` — `reconstructState` implementation
    - `reconstructState(spaceId, atTimestamp?)`:
        1. Find nearest snapshot BEFORE `atTimestamp` (or latest if no timestamp)
        2. Load snapshot state
        3. Query events AFTER snapshot up to `atTimestamp`
        4. Apply events sequentially using `stateReducer`
        5. Return reconstructed state
    - If no snapshot exists: replay from genesis (`space_created` event)
    - If `atTimestamp` predates all events: return null/error
- [ ] Add `stateReducer` to `EventLogConfig` — `(state: unknown, event: Event) => unknown`
    - Default reducer: returns event payload (last-write-wins)
    - Caller can provide custom reducer for domain-specific state
- [ ] Create `src/snapshots/snapshot-manager.test.ts` — unit tests:
    - Creates snapshot with correct sequence number
    - Snapshot hash matches state content
    - Auto-snapshot triggers at configured interval
    - Snapshot of empty space returns initial state
    - Multiple snapshots for same space, different sequence points
- [ ] Create `src/snapshots/state-reconstructor.test.ts` — unit tests:
    - Reconstruct from genesis (no snapshots): applies all events
    - Reconstruct from snapshot: applies only events after snapshot
    - Reconstruct at specific timestamp: stops at correct point
    - Reconstruct with custom reducer: reducer applied correctly
    - 1000 events with snapshot every 100: reconstruction < 100ms
    - Timestamp before all events: returns error or initial state
    - Timestamp after all events: returns latest state
- [ ] Wire `createSnapshot` and `reconstructState` into `EventLog` factory

### Done When

- [ ] Snapshots are created and stored correctly
- [ ] Auto-snapshot triggers at the configured interval
- [ ] State reconstruction uses nearest snapshot + event replay
- [ ] Custom `stateReducer` works correctly
- [ ] Reconstruction of 1000 events with snapshots < 100ms
- [ ] All unit tests pass
- [ ] Coverage ≥ 90% for snapshot and reconstruction modules

---

## M7: Storage Budget & Monitoring (Status: NOT STARTED)

**Goal**: Track storage usage, enforce thresholds, and trigger appropriate actions at each level.

**Depends on**: M3

### Tasks

- [ ] Create `src/storage/budget.ts` — storage budget monitor
    - `getStorageUsage()` — return `StorageReport`:
        - `totalEvents`, `totalSnapshots`, `estimatedBytes`
        - `oldestEvent`, `newestEvent` timestamps
        - Per-space breakdown: `{ spaceId, eventCount, estimatedBytes }`
    - `estimatedBytes`: sum of serialized event sizes (JSON.stringify length as byte estimate)
- [ ] Create `src/storage/pressure.ts` — storage pressure levels
    - `getStoragePressure(report: StorageReport, availableBytes: number): StoragePressureLevel`
    - Levels:
        - `NORMAL` (< 50%): no action
        - `COMPACT` (50–70%): return recommendation to compact
        - `EXPORT_PROMPT` (70–80%): return recommendation to prompt user for export
        - `AGGRESSIVE` (80–90%): return recommendation for auto-compact + aggressive snapshots
        - `BLOCKED` (> 90%): return recommendation to block new space creation
    - Caller provides `availableBytes` — library doesn't access browser storage APIs directly
- [ ] Create `src/storage/compaction.ts` — background compaction
    - `compact(spaceId)`:
        1. Create a snapshot at the latest event
        2. Mark old events as "compacted" (don't delete — append-only)
        3. Return compaction report: events compacted, bytes saved (estimated)
    - Note: compaction doesn't delete events (append-only guarantee). It creates snapshots so reconstruction doesn't need to replay from genesis.
- [ ] Create `src/storage/budget.test.ts` — unit tests:
    - Empty database: zero events, zero bytes
    - 100 events: correct count and byte estimate
    - Per-space breakdown: events distributed across 5 spaces
    - Byte estimate grows linearly with event count
- [ ] Create `src/storage/pressure.test.ts` — unit tests:
    - Each threshold returns the correct level
    - Boundary values: exactly 50%, 70%, 80%, 90%
    - 0% usage: NORMAL
    - 100% usage: BLOCKED
- [ ] Create `src/storage/compaction.test.ts` — unit tests:
    - Compaction creates a snapshot
    - Compaction of space with no events: no-op
    - Compaction preserves all events (append-only)
    - Reconstruction works correctly after compaction (uses snapshot)
- [ ] Wire `getStorageUsage` into `EventLog` factory

### Done When

- [ ] Storage usage tracking returns accurate reports
- [ ] Pressure levels computed correctly for all thresholds
- [ ] Compaction creates snapshots without deleting events
- [ ] Post-compaction reconstruction works correctly
- [ ] All unit tests pass
- [ ] Coverage ≥ 90% for storage budget modules

---

## M8: Export & Import (Tiered Storage) (Status: NOT STARTED)

**Goal**: Export events to archive format, import archives back — enabling tiered storage.

**Depends on**: M5, M6

### Tasks

- [ ] Define archive format: `.rblogs` — a compressed binary format:
    - Header: magic bytes (`RBLOG`), format version (uint8), event count (uint32)
    - Body: JSON-serialized event array, compressed with CompressionStream (gzip)
    - Footer: SHA-256 hash of uncompressed body (integrity check)
- [ ] Create `src/archive/exporter.ts` — `exportArchive` implementation
    - `exportArchive(spaceId, beforeDate)`:
        1. Query events for space older than `beforeDate`
        2. Serialize events to JSON array
        3. Compress with `CompressionStream` (native browser API)
        4. Prepend header, append footer hash
        5. Return `Uint8Array`
    - Verify hash chain integrity of exported events before export
    - Return error if events fail integrity check
- [ ] Create `src/archive/importer.ts` — `importArchive` implementation
    - `importArchive(archive)`:
        1. Parse header, verify magic bytes and format version
        2. Decompress body with `DecompressionStream`
        3. Verify footer hash matches decompressed content
        4. Parse events from JSON
        5. Skip duplicate events (by `id` — already in database)
        6. Verify hash chain integrity of imported events
        7. Write non-duplicate events to database
        8. Return `ImportReport`
    - Handle version mismatches (future-proof: reject unknown versions)
- [ ] Create `src/archive/exporter.test.ts` — unit tests:
    - Export 100 events: produces valid archive
    - Export from empty space: produces archive with 0 events
    - Export with `beforeDate` filters correctly
    - Archive integrity hash is correct
    - Exported archive can be imported back (round-trip)
- [ ] Create `src/archive/importer.test.ts` — unit tests:
    - Import valid archive: all events written
    - Import with duplicates: duplicates skipped, report correct
    - Import corrupted archive (bad hash): returns error
    - Import unknown version: returns error
    - Import archive with broken hash chain: returns error
    - Round-trip: export → import → verify identical events
- [ ] Wire `exportArchive` and `importArchive` into `EventLog` factory

### Done When

- [ ] Export produces a valid compressed archive with integrity hash
- [ ] Import verifies integrity, deduplicates, and writes events
- [ ] Round-trip (export → import) produces identical event data
- [ ] Corrupted or invalid archives are rejected with clear errors
- [ ] All unit tests pass
- [ ] Coverage ≥ 90% for archive modules

---

## M9: AST Diff Storage (Status: NOT STARTED)

**Goal**: Optimize storage for frequently edited spaces — store AST diffs instead of full source snapshots.

**Depends on**: M3, M6

### Tasks

- [ ] Define diff payload schema for `space_evolved` events:
    - `astDiff`: array of `{ path: string; operation: 'add' | 'modify' | 'remove'; before?: unknown; after?: unknown }`
    - `scopeMetadata`: `{ changedNodes: number; totalNodes: number; affectedFunctions: string[] }`
    - `sourceHash`: SHA-256 of the full source AFTER applying the diff
- [ ] Define payload schemas for other event types:
    - `space_created`: `{ source: string; sourceHash: string; compiledWasmHash: string }`
    - `space_forked`: `{ sourceSpaceId: string; forkTimestamp: string }`
- [ ] Create `src/diff/diff-storage.ts` — diff-aware event writing
    - `writeDiffEvent(spaceId, astDiff, scopeMetadata, sourceHash)`: creates `space_evolved` event with diff payload
    - Validates diff structure (non-empty operations array, valid operation types)
    - Stores compact diff instead of full source
- [ ] Create `src/diff/diff-reconstructor.ts` — reconstruct source from diffs
    - `reconstructSource(spaceId, atTimestamp?)`:
        1. Find genesis (`space_created`) or nearest snapshot with full source
        2. Apply each subsequent `space_evolved` diff in sequence
        3. Verify `sourceHash` at each step matches expected
        4. Return reconstructed source
    - Error if diff application fails or hash mismatch detected
- [ ] Create `src/diff/diff-storage.test.ts` — unit tests:
    - Write diff event with valid structure
    - Reject diff with empty operations array
    - Reject diff with invalid operation type
    - Storage size: 100 diff events < 100 full source events (by 10x+)
- [ ] Create `src/diff/diff-reconstructor.test.ts` — unit tests:
    - Reconstruct from genesis + 1 diff
    - Reconstruct from genesis + 100 diffs
    - Reconstruct from snapshot + diffs (skips genesis chain)
    - Hash mismatch at step N: returns error with step number
    - Empty diff (no changes): state unchanged
- [ ] Wire diff-aware writes into `EventLog` as optional helpers (main `writeEvent` still works for all event types)

### Done When

- [ ] Diff events store compact AST changes instead of full source
- [ ] Source reconstruction from diffs is correct and verified via hashes
- [ ] Storage savings demonstrated: diffs use ~10x less space than full snapshots
- [ ] Hash chain integrity maintained for diff events
- [ ] All unit tests pass
- [ ] Coverage ≥ 90% for diff modules

---

## M10: Integration Tests & Performance Validation (Status: NOT STARTED)

**Goal**: End-to-end tests covering the full API surface, performance benchmarks, and production readiness.

**Depends on**: M3, M4, M5, M6, M7, M8, M9 (all previous milestones)

### Tasks

- [ ] Create `tests/integration/full-lifecycle.test.ts`:
    - Create event log → write 50 events across 5 spaces → query each space → verify counts
    - Write → query → verify hash chain integrity → pass
    - Tamper with one event → verify integrity → detect corruption
    - Create snapshots → reconstruct state → compare with full replay → identical
    - Export space → clear events → import archive → verify identical data
    - Write 500 events → auto-snapshot triggers at configured interval → reconstruction uses snapshots
- [ ] Create `tests/integration/concurrent-operations.test.ts`:
    - 10 concurrent writes to same space: all succeed, chain intact
    - 5 concurrent writes to 5 different spaces: all succeed independently
    - Write + query simultaneously: query returns consistent snapshot
    - Write + verify simultaneously: verification result is consistent
- [ ] Create `tests/integration/edge-cases.test.ts`:
    - Single event in database: all operations work
    - 10,000 events: performance within targets
    - Maximum payload size (100KB event): write and query succeed
    - Unicode payloads: hash chain works correctly
    - Empty string fields: rejected with clear error
    - Boundary values: limit=0, limit=1001, cursor for nonexistent position
- [ ] Create `tests/integration/storage-lifecycle.test.ts`:
    - Fresh database → write events → check storage report → compact → verify reconstruction
    - Export events older than X → verify remaining events unaffected
    - Import previously exported events → no duplicates
    - Storage pressure levels: simulate approaching each threshold
- [ ] Create `tests/performance/benchmarks.test.ts`:
    - Write 1 event: < 5ms
    - Write 100 events sequentially: < 500ms
    - Query 10,000 events by space: < 50ms
    - Reconstruct state from 1,000 events with snapshots: < 100ms
    - Verify integrity of 10,000 events: < 5 seconds
    - Export 1,000 events to archive: < 1 second
    - Import 1,000 events from archive: < 1 second
- [ ] Create `tests/determinism/determinism.test.ts`:
    - Same events written in same order → identical hashes
    - Same events written in same order → identical query results
    - Reconstruct state twice from same events → identical state
    - Export → import → export → compare: byte-identical archives
- [ ] Final `README.md` update:
    - Complete API documentation with examples for every public method
    - Performance characteristics table
    - Architecture overview (storage schema, hash chain, snapshots)
    - Getting started guide
    - Contributing guide
- [ ] Run full test suite with coverage — verify ≥ 90% across all modules
- [ ] Run `npx tsc --noEmit` — zero errors
- [ ] Run `npx tsup` — clean build
- [ ] Run linter — zero warnings

### Done When

- [ ] All integration tests pass
- [ ] All performance benchmarks meet targets
- [ ] Determinism tests verify byte-identical outputs
- [ ] Coverage ≥ 90% lines, ≥ 85% branches, ≥ 90% functions (overall)
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] `npx tsup` produces clean ESM + CJS + types output
- [ ] README is complete and documents the full public API
- [ ] Zero `TODO`/`FIXME` comments in source code
- [ ] Ready for `npm publish` and consumption by external callers
- [ ] Tag `v1.0.0`
