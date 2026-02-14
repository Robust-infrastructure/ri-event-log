/**
 * ri-event-log — Event writer tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { writeEvent } from './event-writer.js';
import type { WriteEventInput } from './event-writer.js';
import { EventLogDatabase, toEvent } from './database.js';
import { computeEventHash } from '../hash-chain/hash.js';
import { verifyChainLinks } from '../hash-chain/chain.js';
import type { Event } from '../types.js';

function makeInput(overrides: Partial<WriteEventInput> = {}): WriteEventInput {
  return {
    type: 'state_changed',
    spaceId: 'space-1',
    timestamp: '2026-02-14T00:00:00.000Z',
    version: 1,
    payload: { key: 'value' },
    ...overrides,
  };
}

describe('writeEvent', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-writer-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  // --- Basic writes ---

  it('writes the first event with previousHash: null', async () => {
    const result = await writeEvent(db, makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previousHash).toBeNull();
    expect(result.value.sequenceNumber).toBe(1);
    expect(result.value.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the second event with correct previousHash linking to first', async () => {
    const first = await writeEvent(db, makeInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await writeEvent(db, makeInput({
      timestamp: '2026-02-14T00:01:00.000Z',
      payload: { step: 2 },
    }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.previousHash).toBe(first.value.hash);
    expect(second.value.sequenceNumber).toBe(2);
  });

  it('writes 100 events and verifies chain integrity', async () => {
    const events: Event[] = [];
    for (let i = 0; i < 100; i++) {
      const result = await writeEvent(db, makeInput({
        timestamp: `2026-02-14T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        payload: { step: i + 1 },
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      events.push(result.value);
    }

    // Verify chain links
    expect(verifyChainLinks(events)).toBe(-1);

    // Verify each hash is computed correctly
    for (const event of events) {
      const { hash, ...eventWithoutHash } = event;
      const expectedHash = await computeEventHash(eventWithoutHash);
      expect(hash).toBe(expectedHash);
    }
  });

  it('generates a valid UUID v4 for the event id', async () => {
    const result = await writeEvent(db, makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('preserves the caller-injected timestamp (no Date.now())', async () => {
    const timestamp = '2020-01-01T00:00:00.000Z';
    const result = await writeEvent(db, makeInput({ timestamp }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timestamp).toBe(timestamp);
  });

  it('stores the event in IndexedDB', async () => {
    const result = await writeEvent(db, makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await db.events.get(result.value.id);
    expect(stored).toBeDefined();
    expect(stored?.hash).toBe(result.value.hash);
  });

  // --- Validation ---

  it('rejects event with empty spaceId', async () => {
    const result = await writeEvent(db, makeInput({ spaceId: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
    if (result.error.code === 'INVALID_EVENT') {
      expect(result.error.field).toBe('spaceId');
    }
  });

  it('rejects event with whitespace-only spaceId', async () => {
    const result = await writeEvent(db, makeInput({ spaceId: '   ' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('rejects event with invalid type', async () => {
    const result = await writeEvent(db, makeInput({
      type: 'not_a_valid_type' as never,
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
    if (result.error.code === 'INVALID_EVENT') {
      expect(result.error.field).toBe('type');
    }
  });

  it('rejects event with empty timestamp', async () => {
    const result = await writeEvent(db, makeInput({ timestamp: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('rejects event with invalid ISO timestamp', async () => {
    const result = await writeEvent(db, makeInput({ timestamp: 'not-a-date' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('rejects event with version < 1', async () => {
    const result = await writeEvent(db, makeInput({ version: 0 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
  });

  // --- Concurrent writes ---

  it('handles concurrent writes to the same space correctly', async () => {
    // Write 10 events concurrently to the same space
    const promises = Array.from({ length: 10 }, (_, i) =>
      writeEvent(db, makeInput({
        timestamp: `2026-02-14T00:00:${String(i).padStart(2, '0')}.000Z`,
        payload: { step: i + 1 },
      })),
    );
    const results = await Promise.all(promises);

    // All should succeed
    for (const result of results) {
      expect(result.ok).toBe(true);
    }

    // Verify the chain is intact
    const allEvents = await db.events
      .where('spaceId')
      .equals('space-1')
      .sortBy('sequenceNumber');
    const events = allEvents.map((e) => toEvent(e));

    expect(events).toHaveLength(10);
    expect(verifyChainLinks(events)).toBe(-1);

    // Sequence numbers should be 1-10 (no gaps, no duplicates)
    const seqNums = events.map((e) => e.sequenceNumber).sort((a, b) => a - b);
    expect(seqNums).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it('handles concurrent writes to different spaces independently', async () => {
    const spaces = ['space-a', 'space-b', 'space-c'];
    const promises = spaces.flatMap((spaceId) =>
      Array.from({ length: 3 }, (_, i) =>
        writeEvent(db, makeInput({
          spaceId,
          timestamp: `2026-02-14T00:00:${String(i).padStart(2, '0')}.000Z`,
          payload: { space: spaceId, step: i + 1 },
        })),
      ),
    );

    const results = await Promise.all(promises);
    for (const result of results) {
      expect(result.ok).toBe(true);
    }

    // Each space should have its own independent chain
    for (const spaceId of spaces) {
      const spaceEvents = await db.events
        .where('spaceId')
        .equals(spaceId)
        .sortBy('sequenceNumber');
      const events = spaceEvents.map((e) => toEvent(e));

      expect(events).toHaveLength(3);
      const firstEvent = events[0];
      expect(firstEvent).toBeDefined();
      expect(firstEvent?.previousHash).toBeNull(); // Genesis for each space
      expect(verifyChainLinks(events)).toBe(-1);
    }
  });

  // --- All event types ---

  it('accepts all valid event types', async () => {
    const types = [
      'space_created', 'space_evolved', 'space_forked', 'space_deleted',
      'state_changed', 'action_invoked', 'intent_submitted', 'intent_queued',
      'intent_resolved', 'user_feedback', 'system_event',
    ] as const;

    for (const type of types) {
      const result = await writeEvent(db, makeInput({
        type,
        spaceId: `space-${type}`,
      }));
      expect(result.ok).toBe(true);
    }
  });
});
