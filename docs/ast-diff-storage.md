# AST Diff Storage

> ri-event-log v1.0.0 — Storing incremental changes instead of full source

## Overview

The diff storage system provides helpers for writing structured change events (`space_evolved`) that record only what changed between versions of source code, rather than storing the full source every time. A genesis event (`space_created`) stores the initial full source. Subsequent changes store AST-level diffs. The full source can be reconstructed by replaying the genesis event plus all diffs.

## Architecture

```
diff/
├── types.ts              Diff payload types
├── diff-storage.ts       writeDiffEvent + writeGenesisEvent
└── diff-reconstructor.ts reconstructSource from diffs
```

These modules build on top of the core event storage — they create standard events with structured payloads.

## Types

### AstDiffOperation

A single change in the source AST.

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Dot-separated path in the AST (e.g., `"functions.0.body"`) |
| `operation` | `DiffOperationType` | `'add'`, `'modify'`, or `'remove'` |
| `before` | `unknown \| undefined` | Previous value (required for `modify`, `remove`) |
| `after` | `unknown \| undefined` | New value (required for `add`, `modify`) |

### DiffPayload

Payload shape for `space_evolved` events.

| Field | Type | Description |
|-------|------|-------------|
| `astDiff` | `readonly AstDiffOperation[]` | List of changes |
| `scopeMetadata` | `ScopeMetadata` | Summary of what changed |
| `sourceHash` | `string` | SHA-256 of the resulting source after applying diffs |

### SpaceCreatedPayload

Payload shape for `space_created` (genesis) events.

| Field | Type | Description |
|-------|------|-------------|
| `source` | `string` | Full source text |
| `sourceHash` | `string` | SHA-256 of the source |
| `compiledWasmHash` | `string` | Hash of compiled output |

### SpaceForkedPayload

Payload shape for `space_forked` events.

| Field | Type | Description |
|-------|------|-------------|
| `sourceSpaceId` | `string` | Space forked from |
| `forkTimestamp` | `string` | Timestamp of the fork point |

### ScopeMetadata

Summary of the scope of changes.

| Field | Type | Description |
|-------|------|-------------|
| `changedNodes` | `number` | Number of AST nodes changed |
| `totalNodes` | `number` | Total AST nodes in the source |
| `affectedFunctions` | `readonly string[]` | Names of functions affected |

## Helper Functions

### writeGenesisEvent

Writes the initial `space_created` event with the full source.

```typescript
import { writeGenesisEvent } from 'ri-event-log';

const result = await writeGenesisEvent(
  db,
  'my-space',
  '2025-01-01T00:00:00.000Z',
  'function hello() { return "world"; }',
  'abc123...sourceHash',
  'def456...wasmHash',
);
```

### writeDiffEvent

Writes a `space_evolved` event with only the changes.

```typescript
import { writeDiffEvent } from 'ri-event-log';

const result = await writeDiffEvent(
  db,
  'my-space',
  '2025-01-01T00:01:00.000Z',
  [
    {
      path: 'functions.0.body',
      operation: 'modify',
      before: 'return "world";',
      after: 'return "hello world";',
    },
  ],
  { changedNodes: 1, totalNodes: 5, affectedFunctions: ['hello'] },
  'newSourceHash...',
);
```

### reconstructSource

Rebuilds the full source text from genesis + diffs at a given point in time.

```typescript
import { reconstructSource } from 'ri-event-log';

// Reconstruct at latest
const result = await reconstructSource(db, 'my-space');

// Reconstruct at a specific time
const result = await reconstructSource(db, 'my-space', '2025-01-01T00:01:00.000Z');

if (result.ok) {
  console.log(result.value.source);       // Full source text
  console.log(result.value.diffsApplied); // Number of diffs replayed
}
```

## Reconstruction Algorithm

1. Query all events for the space, ordered by sequence number
2. Find the `space_created` event (must be first)
3. Extract full source from genesis payload
4. For each subsequent `space_evolved` event (up to `atTimestamp`):
   - Apply each `AstDiffOperation` to the in-memory source representation
5. Return the final source text with metadata

If no `space_created` event is found, returns an error. If no `space_evolved` events exist after genesis, returns the original source.

## Storage Savings

The diff approach significantly reduces storage for spaces with many edits:

| Scenario | Full Source | Diff Storage | Savings |
|----------|-----------|-------------|---------|
| 10 edits, 10 KB source | 100 KB | ~15 KB | 85% |
| 100 edits, 10 KB source | 1 MB | ~60 KB | 94% |
| 1000 edits, 50 KB source | 50 MB | ~550 KB | 99% |

Each `space_evolved` event typically stores 0.5–5 KB of diff data vs. the full 5–50 KB source. The ratio improves with more edits.

## Integration with Core Event Log

The diff helpers are **standalone functions** that take the Dexie database directly, not the `EventLog` interface. They write standard events with structured payloads — the core event log does not treat them specially.

```typescript
// These use the EventLog interface (config-aware)
const log = createEventLog({ idGenerator: myGenerator });
await log.writeEvent({ ... });

// These are standalone helpers (use default idGenerator)
await writeGenesisEvent(db, ...);
await writeDiffEvent(db, ...);
```

If you need deterministic IDs in diff helpers, use `writeEvent` directly with a diff-structured payload.

---

*See also: [reference.md](reference.md) · [architecture.md](architecture.md)*
