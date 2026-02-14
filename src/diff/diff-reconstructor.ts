/**
 * ri-event-log — Source reconstruction from AST diffs
 *
 * Reconstructs a space's source by replaying `space_created` genesis
 * and subsequent `space_evolved` diff events. Verifies `sourceHash`
 * at each step to ensure integrity.
 */

import type { Event, Result } from '../types.js';
import { databaseError, invalidEvent } from '../errors.js';
import type { EventLogDatabase } from '../storage/database.js';
import { toEvent } from '../storage/database.js';
import type {
  AstDiffOperation,
  DiffPayload,
  SpaceCreatedPayload,
  ReconstructedSource,
} from './types.js';
import { sha256, deterministicSerialize } from '../hash-chain/hash.js';

// ---------------------------------------------------------------------------
// Internal: apply diffs to a state object
// ---------------------------------------------------------------------------

/**
 * Set a value at a dot-separated path in a nested object.
 * Creates intermediate objects as needed.
 * Returns a shallow-cloned object with the modification applied.
 */
function setAtPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = path.split('.');
  const root = { ...obj };
  let current: Record<string, unknown> = root;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const next = current[seg];
    if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
      current[seg] = { ...(next as Record<string, unknown>) };
    } else {
      current[seg] = {};
    }
    current = current[seg] as Record<string, unknown>;
  }

  const lastSeg = segments[segments.length - 1];
  if (lastSeg !== undefined) {
    current[lastSeg] = value;
  }
  return root;
}

/**
 * Delete a value at a dot-separated path in a nested object.
 * Returns a shallow-cloned object with the key removed.
 */
function deleteAtPath(
  obj: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const segments = path.split('.');
  const root = { ...obj };
  let current: Record<string, unknown> = root;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const next = current[seg];
    if (next !== null && typeof next === 'object' && !Array.isArray(next)) {
      current[seg] = { ...(next as Record<string, unknown>) };
    } else {
      return root; // path doesn't exist — nothing to delete
    }
    current = current[seg] as Record<string, unknown>;
  }

  const lastSeg = segments[segments.length - 1];
  if (lastSeg !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete current[lastSeg];
  }
  return root;
}

/**
 * Apply a single diff operation to a state object.
 */
function applyOperation(
  state: Record<string, unknown>,
  op: AstDiffOperation,
): Record<string, unknown> {
  switch (op.operation) {
    case 'add':
      return setAtPath(state, op.path, op.after);
    case 'modify':
      return setAtPath(state, op.path, op.after);
    case 'remove':
      return deleteAtPath(state, op.path);
  }
}

/**
 * Apply all diff operations in a single event to a state object.
 */
function applyDiff(
  state: Record<string, unknown>,
  astDiff: readonly AstDiffOperation[],
): Record<string, unknown> {
  let current = state;
  for (const op of astDiff) {
    current = applyOperation(current, op);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Check if a payload looks like a SpaceCreatedPayload. */
function isSpaceCreatedPayload(
  payload: Readonly<Record<string, unknown>>,
): payload is SpaceCreatedPayload & Readonly<Record<string, unknown>> {
  return typeof payload['source'] === 'string' && typeof payload['sourceHash'] === 'string';
}

/** Check if a payload looks like a DiffPayload. */
function isDiffPayload(
  payload: Readonly<Record<string, unknown>>,
): payload is DiffPayload & Readonly<Record<string, unknown>> {
  return Array.isArray(payload['astDiff']) && typeof payload['sourceHash'] === 'string';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconstruct a space's source by replaying genesis and diff events.
 *
 * 1. Finds the genesis `space_created` event (or nearest snapshot with source).
 * 2. Applies each subsequent `space_evolved` diff in sequence.
 * 3. Verifies `sourceHash` at each step.
 * 4. Returns the reconstructed source.
 *
 * @param db - The database instance.
 * @param spaceId - The space to reconstruct.
 * @param atTimestamp - Optional: reconstruct state at this timestamp (inclusive).
 * @returns The reconstructed source or an error.
 */
export async function reconstructSource(
  db: EventLogDatabase,
  spaceId: string,
  atTimestamp?: string,
): Promise<Result<ReconstructedSource>> {
  try {
    // 1. Query all events for this space, ordered by sequence number
    const query = db.events
      .where('[spaceId+sequenceNumber]')
      .between([spaceId, -Infinity], [spaceId, Infinity], true, true);

    const allEvents: Event[] = (await query.toArray()).map(toEvent);

    // Filter by timestamp if provided
    let events: readonly Event[];
    if (atTimestamp !== undefined) {
      events = allEvents.filter((e) => e.timestamp <= atTimestamp);
    } else {
      events = allEvents;
    }

    if (events.length === 0) {
      return {
        ok: false,
        error: invalidEvent('spaceId', `No events found for space "${spaceId}"`),
      };
    }

    // 2. Find genesis (space_created) event
    const genesis = events.find((e) => e.type === 'space_created');
    if (genesis === undefined) {
      return {
        ok: false,
        error: invalidEvent(
          'spaceId',
          `No space_created genesis event found for space "${spaceId}"`,
        ),
      };
    }

    if (!isSpaceCreatedPayload(genesis.payload)) {
      return {
        ok: false,
        error: invalidEvent(
          'payload',
          'Genesis event does not have a valid SpaceCreatedPayload',
        ),
      };
    }

    // 3. Build initial state from genesis source
    const initialSource = genesis.payload.source;

    // Verify genesis sourceHash
    const genesisHash = await sha256(initialSource);
    if (genesisHash !== genesis.payload.sourceHash) {
      return {
        ok: false,
        error: invalidEvent(
          'sourceHash',
          `Genesis sourceHash mismatch: expected ${genesis.payload.sourceHash}, got ${genesisHash}`,
        ),
      };
    }

    // Parse initial source into state object for diff application
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(initialSource) as Record<string, unknown>;
    } catch {
      // If source is not JSON, store it as a { source: string } wrapper
      state = { source: initialSource };
    }

    // 4. Collect space_evolved events after genesis
    const diffEvents = events.filter(
      (e) => e.type === 'space_evolved' && e.sequenceNumber > genesis.sequenceNumber,
    );

    // Sort by sequence number (should already be sorted, but be safe)
    const sortedDiffs = [...diffEvents].sort(
      (a, b) => a.sequenceNumber - b.sequenceNumber,
    );

    // 5. Apply each diff, verifying sourceHash at each step
    let diffsApplied = 0;
    let lastSeqNum = genesis.sequenceNumber;

    for (const diffEvent of sortedDiffs) {
      if (!isDiffPayload(diffEvent.payload)) {
        return {
          ok: false,
          error: invalidEvent(
            'payload',
            `Event ${diffEvent.id} (seq ${String(diffEvent.sequenceNumber)}) does not have a valid DiffPayload`,
          ),
        };
      }

      const astDiff = diffEvent.payload.astDiff;
      state = applyDiff(state, astDiff);
      diffsApplied++;
      lastSeqNum = diffEvent.sequenceNumber;

      // Verify sourceHash
      const serialized = deterministicSerialize(state);
      const computedHash = await sha256(serialized);
      if (computedHash !== diffEvent.payload.sourceHash) {
        return {
          ok: false,
          error: invalidEvent(
            'sourceHash',
            `Hash mismatch at step ${String(diffsApplied)} (event ${diffEvent.id}): expected ${diffEvent.payload.sourceHash}, got ${computedHash}`,
          ),
        };
      }
    }

    // 6. Serialize final state
    const finalSource = deterministicSerialize(state);
    const finalHash = await sha256(finalSource);

    return {
      ok: true,
      value: {
        source: finalSource,
        sourceHash: finalHash,
        diffsApplied,
        lastSequenceNumber: lastSeqNum,
      },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: databaseError(
        'reconstructSource',
        err instanceof Error ? err.message : 'Unknown error',
      ),
    };
  }
}
