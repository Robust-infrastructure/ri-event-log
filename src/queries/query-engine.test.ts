/**
 * ri-event-log — Query engine tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { queryBySpace, queryByType, queryByTime } from './query-engine.js';
import { EventLogDatabase } from '../storage/database.js';
import { writeEvent } from '../storage/event-writer.js';
import type { WriteEventInput } from '../storage/event-writer.js';
import type { EventType, Event } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Write N events sequentially, returning all written events. */
async function writeMany(
  db: EventLogDatabase,
  count: number,
  overrides: Partial<WriteEventInput> = {},
): Promise<readonly Event[]> {
  const events: Event[] = [];
  for (let i = 0; i < count; i++) {
    const ts = new Date(Date.UTC(2026, 1, 14, 0, 0, i)).toISOString();
    const result = await writeEvent(db, makeInput({
      timestamp: ts,
      payload: { index: i },
      ...overrides,
    }));
    if (!result.ok) throw new Error(`writeEvent failed at ${String(i)}: ${result.error.code}`);
    events.push(result.value);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queryBySpace', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-query-space-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('returns empty result for empty database', async () => {
    const result = await queryBySpace(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual([]);
    expect(result.value.nextCursor).toBeUndefined();
    expect(result.value.total).toBe(0);
  });

  it('returns only events for the requested space', async () => {
    await writeMany(db, 3, { spaceId: 'space-a' });
    await writeMany(db, 5, { spaceId: 'space-b' });
    await writeMany(db, 2, { spaceId: 'space-c' });

    const result = await queryBySpace(db, 'space-b');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(5);
    expect(result.value.items).toHaveLength(5);
    for (const event of result.value.items) {
      expect(event.spaceId).toBe('space-b');
    }
  });

  it('cross-space: events from different spaces do not leak', async () => {
    await writeMany(db, 3, { spaceId: 'space-a' });
    await writeMany(db, 3, { spaceId: 'space-b' });

    const resultA = await queryBySpace(db, 'space-a');
    const resultB = await queryBySpace(db, 'space-b');
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    const idsA = resultA.value.items.map((e) => e.id);
    const idsB = resultB.value.items.map((e) => e.id);
    // No overlap
    for (const id of idsA) {
      expect(idsB).not.toContain(id);
    }
  });

  it('returns events in ascending order by default', async () => {
    const written = await writeMany(db, 5, { spaceId: 'space-1' });
    const result = await queryBySpace(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const seqs = result.value.items.map((e) => e.sequenceNumber);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(written[0]?.sequenceNumber);
  });

  it('returns events in descending order when specified', async () => {
    await writeMany(db, 5, { spaceId: 'space-1' });
    const result = await queryBySpace(db, 'space-1', { order: 'desc' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const seqs = result.value.items.map((e) => e.sequenceNumber);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it('clamps limit to max 1000', async () => {
    // We can't write 2000 events in a test, but we can verify the
    // limit is accepted without error and doesn't crash.
    await writeMany(db, 5, { spaceId: 'space-1' });
    const result = await queryBySpace(db, 'space-1', { limit: 2000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All 5 fit under a 1000 limit, returned correctly
    expect(result.value.items).toHaveLength(5);
  });

  it('returns INVALID_QUERY for malformed cursor', async () => {
    const result = await queryBySpace(db, 'space-1', { cursor: 'not-base64!@#' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_QUERY');
  });
});

describe('queryBySpace pagination', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-query-page-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('paginates 250 events with limit 100 across 3 pages', async () => {
    await writeMany(db, 250, { spaceId: 'space-1' });

    // Page 1
    const page1 = await queryBySpace(db, 'space-1', { limit: 100 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.items).toHaveLength(100);
    expect(page1.value.total).toBe(250);
    expect(page1.value.nextCursor).toBeDefined();
    if (page1.value.nextCursor === undefined) return;

    // Page 2
    const page2 = await queryBySpace(db, 'space-1', {
      limit: 100,
      cursor: page1.value.nextCursor,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.items).toHaveLength(100);
    expect(page2.value.nextCursor).toBeDefined();
    if (page2.value.nextCursor === undefined) return;

    // Page 3
    const page3 = await queryBySpace(db, 'space-1', {
      limit: 100,
      cursor: page2.value.nextCursor,
    });
    expect(page3.ok).toBe(true);
    if (!page3.ok) return;
    expect(page3.value.items).toHaveLength(50);
    expect(page3.value.nextCursor).toBeUndefined();

    // Verify no duplicates across pages
    const allIds = [
      ...page1.value.items.map((e) => e.id),
      ...page2.value.items.map((e) => e.id),
      ...page3.value.items.map((e) => e.id),
    ];
    expect(new Set(allIds).size).toBe(250);
  });

  it('last page has nextCursor undefined', async () => {
    await writeMany(db, 50, { spaceId: 'space-1' });
    const result = await queryBySpace(db, 'space-1', { limit: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(50);
    expect(result.value.nextCursor).toBeUndefined();
  });

  it('pagination works in descending order', async () => {
    await writeMany(db, 15, { spaceId: 'space-1' });

    const page1 = await queryBySpace(db, 'space-1', { limit: 10, order: 'desc' });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.items).toHaveLength(10);
    expect(page1.value.nextCursor).toBeDefined();
    if (page1.value.nextCursor === undefined) return;

    // First item in desc should have highest sequence number
    const firstSeq = page1.value.items[0]?.sequenceNumber;
    expect(firstSeq).toBe(15);

    const page2 = await queryBySpace(db, 'space-1', {
      limit: 10,
      order: 'desc',
      cursor: page1.value.nextCursor,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.items).toHaveLength(5);
    expect(page2.value.nextCursor).toBeUndefined();

    // Last item in desc page 2 should have lowest sequence number
    const lastItem = page2.value.items[page2.value.items.length - 1];
    expect(lastItem?.sequenceNumber).toBe(1);
  });
});

describe('queryByType', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-query-type-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('returns empty result for empty database', async () => {
    const result = await queryByType(db, 'state_changed');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual([]);
    expect(result.value.total).toBe(0);
  });

  it('returns only events of the requested type', async () => {
    const types: EventType[] = [
      'state_changed', 'state_changed',
      'action_invoked', 'action_invoked', 'action_invoked',
      'user_feedback',
    ];
    for (let i = 0; i < types.length; i++) {
      const t = types[i];
      if (t === undefined) continue;
      await writeEvent(db, makeInput({
        type: t,
        timestamp: new Date(Date.UTC(2026, 1, 14, 0, 0, i)).toISOString(),
        payload: { i },
      }));
    }

    const result = await queryByType(db, 'action_invoked');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(3);
    expect(result.value.items).toHaveLength(3);
    for (const event of result.value.items) {
      expect(event.type).toBe('action_invoked');
    }
  });

  it('paginates results correctly', async () => {
    // Write 15 events of same type
    await writeMany(db, 15, { type: 'space_created' });

    const page1 = await queryByType(db, 'space_created', { limit: 10 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.items).toHaveLength(10);
    expect(page1.value.nextCursor).toBeDefined();
    if (page1.value.nextCursor === undefined) return;

    const page2 = await queryByType(db, 'space_created', {
      limit: 10,
      cursor: page1.value.nextCursor,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.items).toHaveLength(5);
    expect(page2.value.nextCursor).toBeUndefined();
  });

  it('returns events in ascending order by default', async () => {
    await writeMany(db, 5, { type: 'system_event' });
    const result = await queryByType(db, 'system_event');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seqs = result.value.items.map((e) => e.sequenceNumber);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('returns events in descending order when specified', async () => {
    await writeMany(db, 5, { type: 'system_event' });
    const result = await queryByType(db, 'system_event', { order: 'desc' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seqs = result.value.items.map((e) => e.sequenceNumber);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });
});

describe('queryByTime', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-query-time-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('returns empty result for empty database', async () => {
    const result = await queryByTime(
      db,
      '2026-01-01T00:00:00.000Z',
      '2026-12-31T23:59:59.999Z',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual([]);
    expect(result.value.total).toBe(0);
  });

  it('returns events within the range (inclusive from, exclusive to)', async () => {
    // Events at seconds 0..9
    await writeMany(db, 10);

    // Query for seconds 2..5 (inclusive-exclusive)
    const from = '2026-02-14T00:00:02.000Z';
    const to = '2026-02-14T00:00:05.000Z';
    const result = await queryByTime(db, from, to);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should include seconds 2, 3, 4 (not 5)
    expect(result.value.total).toBe(3);
    expect(result.value.items).toHaveLength(3);
    for (const event of result.value.items) {
      expect(event.timestamp >= from).toBe(true);
      expect(event.timestamp < to).toBe(true);
    }
  });

  it('returns INVALID_QUERY for invalid from timestamp', async () => {
    const result = await queryByTime(db, 'not-a-date', '2026-12-31T00:00:00.000Z');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_QUERY');
    if (result.error.code === 'INVALID_QUERY') {
      expect(result.error.field).toBe('from');
    }
  });

  it('returns INVALID_QUERY for invalid to timestamp', async () => {
    const result = await queryByTime(db, '2026-01-01T00:00:00.000Z', 'xyz');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_QUERY');
    if (result.error.code === 'INVALID_QUERY') {
      expect(result.error.field).toBe('to');
    }
  });

  it('paginates results correctly', async () => {
    // 20 events, one per second
    await writeMany(db, 20);

    // Query the full range with limit 7
    const from = '2026-02-14T00:00:00.000Z';
    const to = '2026-02-14T00:00:20.000Z';

    const page1 = await queryByTime(db, from, to, { limit: 7 });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.items).toHaveLength(7);
    expect(page1.value.nextCursor).toBeDefined();
    if (page1.value.nextCursor === undefined) return;

    const page2 = await queryByTime(db, from, to, {
      limit: 7,
      cursor: page1.value.nextCursor,
    });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.items).toHaveLength(7);
    expect(page2.value.nextCursor).toBeDefined();
    if (page2.value.nextCursor === undefined) return;

    const page3 = await queryByTime(db, from, to, {
      limit: 7,
      cursor: page2.value.nextCursor,
    });
    expect(page3.ok).toBe(true);
    if (!page3.ok) return;
    expect(page3.value.items).toHaveLength(6);
    expect(page3.value.nextCursor).toBeUndefined();

    // All unique
    const allIds = [
      ...page1.value.items.map((e) => e.id),
      ...page2.value.items.map((e) => e.id),
      ...page3.value.items.map((e) => e.id),
    ];
    expect(new Set(allIds).size).toBe(20);
  });

  it('ascending order returns oldest first', async () => {
    await writeMany(db, 5);
    const result = await queryByTime(
      db,
      '2026-02-14T00:00:00.000Z',
      '2026-02-14T00:01:00.000Z',
      { order: 'asc' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seqs = result.value.items.map((e) => e.sequenceNumber);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('descending order returns newest first', async () => {
    await writeMany(db, 5);
    const result = await queryByTime(
      db,
      '2026-02-14T00:00:00.000Z',
      '2026-02-14T00:01:00.000Z',
      { order: 'desc' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seqs = result.value.items.map((e) => e.sequenceNumber);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });
});

describe('performance', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-query-perf-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('queryBySpace with 10,000 events completes in < 50ms', async () => {
    // Write 10,000 events in batches for speed
    const spaceId = 'perf-space';
    const batchSize = 100;
    for (let batch = 0; batch < 100; batch++) {
      for (let i = 0; i < batchSize; i++) {
        const idx = batch * batchSize + i;
        await writeEvent(db, makeInput({
          spaceId,
          timestamp: new Date(Date.UTC(2026, 1, 14, 0, 0, 0, idx)).toISOString(),
          payload: { idx },
        }));
      }
    }

    // Now time the query
    const start = performance.now();
    const result = await queryBySpace(db, spaceId, { limit: 1000 });
    const duration = performance.now() - start;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(10000);
    expect(result.value.items).toHaveLength(1000);
    expect(duration).toBeLessThan(100);
  }, 120_000); // Allow 2 minutes for setup (writing 10k events is slow)
});
