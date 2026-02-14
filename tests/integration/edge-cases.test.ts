/**
 * ri-event-log — Edge case integration tests
 *
 * Tests boundary conditions and unusual inputs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { createEventLog } from '../../src/event-log.js';
import { createDatabase } from '../../src/storage/database.js';
import type { Event, EventLog } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueDbName(): string {
  return `test-edge-${Math.random().toString(36).slice(2)}`;
}

function makeEvent(
  spaceId: string,
  index: number,
  payload?: Readonly<Record<string, unknown>>,
): Omit<Event, 'id' | 'hash' | 'previousHash' | 'sequenceNumber'> {
  return {
    type: 'state_changed',
    spaceId,
    timestamp: new Date(Date.UTC(2026, 1, 14, 0, 0, index)).toISOString(),
    version: 1,
    payload: payload ?? { index },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Edge Cases', () => {
  const dbs: string[] = [];

  function trackedLog(config?: Parameters<typeof createEventLog>[0]): EventLog {
    const name = config?.databaseName ?? uniqueDbName();
    dbs.push(name);
    return createEventLog({ ...config, databaseName: name });
  }

  afterEach(async () => {
    for (const name of dbs) {
      const db = createDatabase(name);
      db.close();
      await db.delete();
    }
    dbs.length = 0;
  });

  it('single event in database: all operations work', async () => {
    const log = trackedLog();
    const result = await log.writeEvent(makeEvent('space-1', 0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Query
    const query = await log.queryBySpace('space-1');
    expect(query.ok).toBe(true);
    if (query.ok) expect(query.value.total).toBe(1);

    // Verify integrity
    const integrity = await log.verifyIntegrity('space-1');
    expect(integrity.ok).toBe(true);
    if (integrity.ok) expect(integrity.value.valid).toBe(true);

    // Reconstruct state
    const state = await log.reconstructState('space-1');
    expect(state.ok).toBe(true);

    // Storage
    const storage = await log.getStorageUsage();
    expect(storage.ok).toBe(true);
    if (storage.ok) expect(storage.value.totalEvents).toBe(1);

    // Export
    const archive = await log.exportArchive('space-1', '2027-01-01T00:00:00.000Z');
    expect(archive.ok).toBe(true);

    // Snapshot
    const snap = await log.createSnapshot('space-1');
    expect(snap.ok).toBe(true);
  });

  it('maximum payload size (100KB event): write and query succeed', async () => {
    const log = trackedLog();

    // ~100KB payload
    const largePayload = { data: 'x'.repeat(100_000) };

    const result = await log.writeEvent({
      type: 'state_changed',
      spaceId: 'space-1',
      timestamp: '2026-02-14T00:00:00.000Z',
      version: 1,
      payload: largePayload,
    });
    expect(result.ok).toBe(true);

    const query = await log.queryBySpace('space-1');
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    expect(query.value.items[0]?.payload).toEqual(largePayload);
  });

  it('unicode payloads: hash chain works correctly', async () => {
    const log = trackedLog();

    const unicodePayloads = [
      { text: '日本語テスト' },
      { text: 'Ñoño español 🎉' },
      { text: '中文测试 🐉' },
      { text: 'العربية' },
      { text: '🏆🎯🚀💡🔥' },
    ];

    for (let i = 0; i < unicodePayloads.length; i++) {
      const result = await log.writeEvent(makeEvent('space-1', i, unicodePayloads[i]));
      expect(result.ok).toBe(true);
    }

    const integrity = await log.verifyIntegrity('space-1');
    expect(integrity.ok).toBe(true);
    if (!integrity.ok) return;
    expect(integrity.value.valid).toBe(true);

    const query = await log.queryBySpace('space-1');
    expect(query.ok).toBe(true);
    if (!query.ok) return;

    for (let i = 0; i < unicodePayloads.length; i++) {
      expect(query.value.items[i]?.payload).toEqual(unicodePayloads[i]);
    }
  });

  it('empty string spaceId: rejected with clear error', async () => {
    const log = trackedLog();
    const result = await log.writeEvent({
      type: 'state_changed',
      spaceId: '',
      timestamp: '2026-02-14T00:00:00.000Z',
      version: 1,
      payload: { x: 1 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('empty string timestamp: rejected with clear error', async () => {
    const log = trackedLog();
    const result = await log.writeEvent({
      type: 'state_changed',
      spaceId: 'space-1',
      timestamp: '',
      version: 1,
      payload: { x: 1 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('boundary values: limit=0 is clamped to 1', async () => {
    const log = trackedLog();
    await log.writeEvent(makeEvent('space-1', 0));
    await log.writeEvent(makeEvent('space-1', 1));

    const result = await log.queryBySpace('space-1', { limit: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Limit is clamped to minimum of 1
    expect(result.value.items.length).toBeLessThanOrEqual(1);
  });

  it('boundary values: limit=1001 is clamped to 1000', async () => {
    const log = trackedLog();
    await log.writeEvent(makeEvent('space-1', 0));

    const result = await log.queryBySpace('space-1', { limit: 1001 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Limit is clamped to max 1000 — still succeeds
    expect(result.value.items).toHaveLength(1);
  });

  it('cursor for nonexistent position: returns empty result', async () => {
    const log = trackedLog();
    await log.writeEvent(makeEvent('space-1', 0));

    // Use a valid base64 cursor that points past all events
    const fakeCursor = btoa(JSON.stringify({ seq: 999999, id: 'zzz' }));
    const result = await log.queryBySpace('space-1', { cursor: fakeCursor });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(0);
  });

  it('query empty space: returns zero results', async () => {
    const log = trackedLog();
    const result = await log.queryBySpace('nonexistent');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(0);
    expect(result.value.items).toHaveLength(0);
  });

  it('verify integrity on empty space: returns valid with 0 events', async () => {
    const log = trackedLog();
    const result = await log.verifyIntegrity('nonexistent');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.totalEvents).toBe(0);
  });

  it('queryByType returns only matching events', async () => {
    const log = trackedLog();

    await log.writeEvent({
      type: 'state_changed', spaceId: 'space-1',
      timestamp: '2026-02-14T00:00:00.000Z', version: 1, payload: { x: 1 },
    });
    await log.writeEvent({
      type: 'action_invoked', spaceId: 'space-1',
      timestamp: '2026-02-14T00:00:01.000Z', version: 1, payload: { y: 2 },
    });
    await log.writeEvent({
      type: 'state_changed', spaceId: 'space-1',
      timestamp: '2026-02-14T00:00:02.000Z', version: 1, payload: { z: 3 },
    });

    const result = await log.queryByType('state_changed');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(2);
    expect(result.value.items.every((e) => e.type === 'state_changed')).toBe(true);
  });

  it('queryByTime returns events within range', async () => {
    const log = trackedLog();

    for (let i = 0; i < 10; i++) {
      await log.writeEvent(makeEvent('space-1', i));
    }

    const from = new Date(Date.UTC(2026, 1, 14, 0, 0, 3)).toISOString();
    const to = new Date(Date.UTC(2026, 1, 14, 0, 0, 7)).toISOString();

    const result = await log.queryByTime(from, to);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // queryByTime is inclusive-from, exclusive-to → events at seconds 3,4,5,6 = 4 events
    expect(result.value.total).toBe(4);
    for (const event of result.value.items) {
      expect(event.timestamp >= from).toBe(true);
      expect(event.timestamp <= to).toBe(true);
    }
  });
});
