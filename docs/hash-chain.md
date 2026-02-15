# Hash Chain Integrity

> ri-event-log v1.0.0 — How the hash chain works and why it matters

## Purpose

Every event in the log is cryptographically linked to its predecessor via a SHA-256 hash chain. This creates a tamper-evident audit trail: modifying, inserting, or deleting any event breaks the chain and is detectable via `verifyIntegrity()`.

## Deterministic Serialization

Before hashing, event data is serialized deterministically:

1. Collect all event fields **except** `hash` itself
2. Sort object keys alphabetically at every nesting level (recursively)
3. Apply `JSON.stringify()` to produce canonical JSON

This ensures identical event content always produces the same hash, regardless of JavaScript object key insertion order.

### Example

Given an event:

```typescript
{
  type: "state_changed",
  id: "abc-123",
  spaceId: "my-space",
  timestamp: "2025-01-01T00:00:00.000Z",
  sequenceNumber: 5,
  previousHash: "f2ca1bb6c7e907d06dafe4687e579fce76b37e4e93b7605022da52e6ccc26fd2",
  version: 1,
  payload: { count: 42, label: "test" }
}
```

Deterministic serialization produces:

```json
{"id":"abc-123","payload":{"count":42,"label":"test"},"previousHash":"f2ca1bb6...","sequenceNumber":5,"spaceId":"my-space","timestamp":"2025-01-01T00:00:00.000Z","type":"state_changed","version":1}
```

Keys are sorted: `id` < `payload` < `previousHash` < `sequenceNumber` < `spaceId` < `timestamp` < `type` < `version`. Within `payload`, keys are also sorted: `count` < `label`.

## Hash Computation

```
hash = SHA-256(deterministicSerialize(event_without_hash)) → 64-char hex string
```

The Web Crypto API (`crypto.subtle.digest('SHA-256', ...)`) computes the hash. The result is a 64-character lowercase hexadecimal string.

## Chain Rules

### Rule 1: Genesis Event

The first event in each space has `previousHash: null`.

```
Event 1:  previousHash = null
          hash = SHA-256(serialize(event1))
```

### Rule 2: Subsequent Events

Every event after genesis links to its predecessor:

```
Event N:  previousHash = Event(N-1).hash
          hash = SHA-256(serialize(eventN))
```

### Rule 3: Per-Space Chains

Each space maintains its own independent chain. Events in different spaces do not link to each other. The chain ordering follows `sequenceNumber` within a space.

```
Space A:  [E1] → [E2] → [E3] → [E4]
Space B:  [E1] → [E2]
```

### Rule 4: Write-Time Validation

On every `writeEvent` call, the library reads the latest event for the space and sets `previousHash` accordingly. This happens within an IndexedDB transaction, ensuring atomicity.

## Verification

`verifyIntegrity(spaceId?)` walks the hash chain and checks every link:

1. If `spaceId` is provided, verify that single space. Otherwise, collect all distinct spaceIds and verify each independently.
2. For each space, load events in chunks of 500 (ordered by `sequenceNumber`):
   - First event: verify `previousHash === null`
   - Subsequent events: verify `previousHash === predecessor.hash`
   - Every event: recompute hash from fields and verify it matches `event.hash`
3. Report the first broken link (if any)

### IntegrityReport

```typescript
{
  valid: boolean;         // true if entire chain is intact
  totalEvents: number;    // events in scope
  checkedEvents: number;  // events actually verified
  firstBrokenLink?: {     // only present if valid === false
    eventId: string;
    expected: string;     // what previousHash should be
    actual: string;       // what previousHash actually is
  };
  duration: number;       // verification time in milliseconds
}
```

## Tamper Detection Examples

### Modified Event

If an event's `payload` is modified after write:

```
Original: E3.hash = SHA-256({...payload: {x: 1}...})
Tampered: E3.hash = SHA-256({...payload: {x: 1}...})  ← stored hash unchanged
          But recomputed hash = SHA-256({...payload: {x: 99}...}) ← different!
```

`verifyIntegrity` detects this because the recomputed hash doesn't match the stored hash.

### Deleted Event

If event E2 is deleted:

```
Before: E1 → E2 → E3  (E3.previousHash = E2.hash)
After:  E1 → E3        (E3.previousHash = E2.hash, but E2 doesn't exist)
```

`verifyIntegrity` detects this because E3's `previousHash` doesn't match E1's hash.

### Inserted Event

If a fake event is inserted between E2 and E3:

```
Before: E1 → E2 → E3  (E3.previousHash = E2.hash)
After:  E1 → E2 → FAKE → E3  (E3.previousHash still = E2.hash, not FAKE.hash)
```

The chain from FAKE to E3 is broken.

## Performance

Hash chain verification is O(n) in the number of events. For large databases, scope verification to a single space:

```typescript
// Verify one space (fast)
const report = await log.verifyIntegrity('my-space');

// Verify entire database (slower)
const fullReport = await log.verifyIntegrity();
```

---

*See also: [reference.md](reference.md) · [architecture.md](architecture.md)*
