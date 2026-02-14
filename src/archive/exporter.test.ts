/**
 * ri-event-log — Archive exporter tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { exportArchive } from './exporter.js';
import { importArchive } from './importer.js';
import { EventLogDatabase } from '../storage/database.js';
import { writeEvent } from '../storage/event-writer.js';
import type { WriteEventInput } from '../storage/event-writer.js';
import type { Event } from '../types.js';
import { HEADER_SIZE, FOOTER_SIZE, parseHeader } from './format.js';

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
    if (!result.ok) throw new Error(`writeEvent failed: ${result.error.code}`);
    events.push(result.value);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exportArchive', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-export-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('exports events as a valid archive', async () => {
    await writeMany(db, 10);

    const result = await exportArchive(db, 'space-1', '2026-12-31T00:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const archive = result.value;
    expect(archive).toBeInstanceOf(Uint8Array);
    expect(archive.length).toBeGreaterThan(HEADER_SIZE + FOOTER_SIZE);
  });

  it('archive header contains correct event count', async () => {
    await writeMany(db, 10);

    const result = await exportArchive(db, 'space-1', '2026-12-31T00:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const header = parseHeader(result.value);
    expect(typeof header).toBe('object');
    if (typeof header === 'string') return;

    expect(header.eventCount).toBe(10);
    expect(header.version).toBe(1);
  });

  it('exports empty archive for space with no events', async () => {
    const result = await exportArchive(db, 'nonexistent', '2026-12-31T00:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const header = parseHeader(result.value);
    expect(typeof header).toBe('object');
    if (typeof header === 'string') return;

    expect(header.eventCount).toBe(0);
  });

  it('beforeDate filters events correctly', async () => {
    // Events at t=0, t=1, t=2, t=3, t=4
    await writeMany(db, 5);

    // Only events before t=3 should be included
    const cutoff = new Date(Date.UTC(2026, 1, 14, 0, 0, 3)).toISOString();
    const result = await exportArchive(db, 'space-1', cutoff);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const header = parseHeader(result.value);
    expect(typeof header).toBe('object');
    if (typeof header === 'string') return;

    // Events at t=0, t=1, t=2 — three events before t=3
    expect(header.eventCount).toBe(3);
  });

  it('archive integrity hash is valid (import succeeds)', async () => {
    await writeMany(db, 5);

    const exportResult = await exportArchive(db, 'space-1', '2026-12-31T00:00:00.000Z');
    expect(exportResult.ok).toBe(true);
    if (!exportResult.ok) return;

    // Import into a fresh database — should succeed if hash is valid
    const db2 = new EventLogDatabase(`test-export-verify-${Math.random().toString(36).slice(2)}`);
    try {
      const importResult = await importArchive(db2, exportResult.value);
      expect(importResult.ok).toBe(true);
    } finally {
      db2.close();
      await db2.delete();
    }
  });

  it('round-trip: export → import → events match', async () => {
    const originalEvents = await writeMany(db, 5);

    const exportResult = await exportArchive(db, 'space-1', '2026-12-31T00:00:00.000Z');
    expect(exportResult.ok).toBe(true);
    if (!exportResult.ok) return;

    // Import into a fresh database
    const db2 = new EventLogDatabase(`test-roundtrip-${Math.random().toString(36).slice(2)}`);
    try {
      const importResult = await importArchive(db2, exportResult.value);
      expect(importResult.ok).toBe(true);
      if (!importResult.ok) return;

      expect(importResult.value.importedEvents).toBe(5);
      expect(importResult.value.skippedDuplicates).toBe(0);

      // Verify imported events match originals
      const imported = await db2.events
        .where('[spaceId+sequenceNumber]')
        .between(['space-1', -Infinity], ['space-1', Infinity], true, true)
        .toArray();

      expect(imported).toHaveLength(5);
      for (let i = 0; i < originalEvents.length; i++) {
        const original = originalEvents[i];
        const imp = imported[i];
        if (original === undefined || imp === undefined) continue;
        expect(imp.id).toBe(original.id);
        expect(imp.hash).toBe(original.hash);
        expect(imp.sequenceNumber).toBe(original.sequenceNumber);
        expect(imp.previousHash).toBe(original.previousHash);
      }
    } finally {
      db2.close();
      await db2.delete();
    }
  });

  it('returns error for invalid beforeDate', async () => {
    const result = await exportArchive(db, 'space-1', 'not-a-date');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_QUERY');
  });

  it('exports only events for the specified space', async () => {
    await writeMany(db, 3, { spaceId: 'alpha' });
    await writeMany(db, 5, { spaceId: 'beta' });

    const result = await exportArchive(db, 'alpha', '2026-12-31T00:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const header = parseHeader(result.value);
    expect(typeof header).toBe('object');
    if (typeof header === 'string') return;

    expect(header.eventCount).toBe(3);
  });

  it('exports 100 events successfully', async () => {
    await writeMany(db, 100);

    const result = await exportArchive(db, 'space-1', '2026-12-31T00:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const header = parseHeader(result.value);
    expect(typeof header).toBe('object');
    if (typeof header === 'string') return;

    expect(header.eventCount).toBe(100);
  }, 30_000);
});
