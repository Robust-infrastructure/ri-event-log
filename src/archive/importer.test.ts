/**
 * ri-event-log — Archive importer tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { importArchive } from './importer.js';
import { exportArchive } from './exporter.js';
import { EventLogDatabase } from '../storage/database.js';
import { writeEvent } from '../storage/event-writer.js';
import type { WriteEventInput } from '../storage/event-writer.js';
import type { Event } from '../types.js';
import { HEADER_SIZE, FOOTER_SIZE, encodeHeader, compressData } from './format.js';
import { sha256 } from '../hash-chain/hash.js';

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

/**
 * Build a minimal valid archive from an array of event-like objects.
 */
async function buildArchive(events: readonly Record<string, unknown>[]): Promise<Uint8Array> {
  const jsonBody = JSON.stringify(events);
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(jsonBody);
  const bodyHash = await sha256(jsonBody);
  const compressed = await compressData(jsonBytes);

  const header = encodeHeader(events.length);
  const footerBytes = encoder.encode(bodyHash);

  const archive = new Uint8Array(HEADER_SIZE + compressed.length + FOOTER_SIZE);
  archive.set(header, 0);
  archive.set(compressed, HEADER_SIZE);
  archive.set(footerBytes, HEADER_SIZE + compressed.length);
  return archive;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('importArchive', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-import-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('imports valid archive with all events', async () => {
    // Build the archive from a source database
    const srcDb = new EventLogDatabase(`test-import-src-${Math.random().toString(36).slice(2)}`);
    try {
      await writeMany(srcDb, 5);
      const exportResult = await exportArchive(srcDb, 'space-1', '2026-12-31T00:00:00.000Z');
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      const result = await importArchive(db, exportResult.value);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.importedEvents).toBe(5);
      expect(result.value.skippedDuplicates).toBe(0);
      expect(result.value.errors).toHaveLength(0);

      // Verify events are in the database
      const count = await db.events.count();
      expect(count).toBe(5);
    } finally {
      srcDb.close();
      await srcDb.delete();
    }
  });

  it('skips duplicate events on re-import', async () => {
    const srcDb = new EventLogDatabase(`test-import-dup-${Math.random().toString(36).slice(2)}`);
    try {
      await writeMany(srcDb, 5);
      const exportResult = await exportArchive(srcDb, 'space-1', '2026-12-31T00:00:00.000Z');
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      // Import once
      const first = await importArchive(db, exportResult.value);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.importedEvents).toBe(5);

      // Import again — all should be duplicates
      const second = await importArchive(db, exportResult.value);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.importedEvents).toBe(0);
      expect(second.value.skippedDuplicates).toBe(5);

      // Database should still have only 5 events
      const count = await db.events.count();
      expect(count).toBe(5);
    } finally {
      srcDb.close();
      await srcDb.delete();
    }
  });

  it('returns error for corrupted archive (bad hash)', async () => {
    const srcDb = new EventLogDatabase(`test-import-corrupt-${Math.random().toString(36).slice(2)}`);
    try {
      await writeMany(srcDb, 3);
      const exportResult = await exportArchive(srcDb, 'space-1', '2026-12-31T00:00:00.000Z');
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      // Corrupt the footer hash
      const corrupted = new Uint8Array(exportResult.value);
      const footerStart = corrupted.length - FOOTER_SIZE;
      corrupted[footerStart] = 0x00; // Corrupt first byte of hash
      corrupted[footerStart + 1] = 0x00;

      const result = await importArchive(db, corrupted);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('IMPORT_FAILED');
    } finally {
      srcDb.close();
      await srcDb.delete();
    }
  });

  it('returns error for unknown version', async () => {
    const srcDb = new EventLogDatabase(`test-import-ver-${Math.random().toString(36).slice(2)}`);
    try {
      await writeMany(srcDb, 1);
      const exportResult = await exportArchive(srcDb, 'space-1', '2026-12-31T00:00:00.000Z');
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      // Change version byte to 99
      const modified = new Uint8Array(exportResult.value);
      modified[5] = 99;

      const result = await importArchive(db, modified);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('IMPORT_FAILED');
    } finally {
      srcDb.close();
      await srcDb.delete();
    }
  });

  it('returns error for broken hash chain in archive', async () => {
    // Create an archive with events that have a broken chain
    // We'll manually craft events with mismatched previousHash
    const brokenEvents = [
      {
        id: 'evt-1',
        type: 'state_changed',
        spaceId: 'space-1',
        timestamp: '2026-02-14T00:00:00.000Z',
        sequenceNumber: 1,
        hash: 'abc123',
        previousHash: null,
        version: 1,
        payload: { key: 'value' },
      },
      {
        id: 'evt-2',
        type: 'state_changed',
        spaceId: 'space-1',
        timestamp: '2026-02-14T00:00:01.000Z',
        sequenceNumber: 2,
        hash: 'def456',
        previousHash: 'WRONG_HASH', // Should be abc123
        version: 1,
        payload: { key: 'value2' },
      },
    ];

    const archive = await buildArchive(brokenEvents);
    const result = await importArchive(db, archive);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('IMPORT_FAILED');
  });

  it('returns error for archive too small', async () => {
    const tiny = new Uint8Array(5);
    const result = await importArchive(db, tiny);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('IMPORT_FAILED');
  });

  it('returns error for invalid magic bytes', async () => {
    const bad = new Uint8Array(HEADER_SIZE + FOOTER_SIZE + 10);
    bad[0] = 0xFF; // Not "R"
    const result = await importArchive(db, bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('IMPORT_FAILED');
  });

  it('round-trip preserves all event data', async () => {
    const srcDb = new EventLogDatabase(`test-roundtrip-${Math.random().toString(36).slice(2)}`);
    try {
      const originals = await writeMany(srcDb, 10);

      const exportResult = await exportArchive(srcDb, 'space-1', '2026-12-31T00:00:00.000Z');
      expect(exportResult.ok).toBe(true);
      if (!exportResult.ok) return;

      const importResult = await importArchive(db, exportResult.value);
      expect(importResult.ok).toBe(true);
      if (!importResult.ok) return;

      // Verify each event field matches
      const imported = await db.events
        .where('[spaceId+sequenceNumber]')
        .between(['space-1', -Infinity], ['space-1', Infinity], true, true)
        .toArray();

      expect(imported).toHaveLength(originals.length);

      for (let i = 0; i < originals.length; i++) {
        const orig = originals[i];
        const imp = imported[i];
        if (orig === undefined || imp === undefined) continue;

        expect(imp.id).toBe(orig.id);
        expect(imp.type).toBe(orig.type);
        expect(imp.spaceId).toBe(orig.spaceId);
        expect(imp.timestamp).toBe(orig.timestamp);
        expect(imp.sequenceNumber).toBe(orig.sequenceNumber);
        expect(imp.hash).toBe(orig.hash);
        expect(imp.previousHash).toBe(orig.previousHash);
        expect(imp.version).toBe(orig.version);
        expect(imp.payload).toEqual(orig.payload);
      }
    } finally {
      srcDb.close();
      await srcDb.delete();
    }
  });

  it('imports archive with 0 events', async () => {
    const emptyArchive = await buildArchive([]);
    const result = await importArchive(db, emptyArchive);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.importedEvents).toBe(0);
    expect(result.value.skippedDuplicates).toBe(0);
  });
});
