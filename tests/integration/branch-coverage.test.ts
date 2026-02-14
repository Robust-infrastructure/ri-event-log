/**
 * ri-event-log — Branch coverage integration tests
 *
 * Targets uncovered branches across query-engine, archive exporter/importer,
 * integrity verifier, and diff-reconstructor modules.
 */

import { describe, it, expect, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { createEventLog } from '../../src/event-log.js';
import { createDatabase } from '../../src/storage/database.js';
import type { Event, EventLog } from '../../src/types.js';
import { encodeHeader, HEADER_SIZE, FOOTER_SIZE, compressData } from '../../src/archive/format.js';
import { writeGenesisEvent, writeDiffEvent } from '../../src/diff/diff-storage.js';
import { reconstructSource } from '../../src/diff/diff-reconstructor.js';
import { sha256, deterministicSerialize } from '../../src/hash-chain/hash.js';
import type { AstDiffOperation } from '../../src/diff/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueDbName(): string {
  return `test-branch-${Math.random().toString(36).slice(2)}`;
}

function makeEvent(
  spaceId: string,
  index: number,
  overrides: Partial<Pick<Event, 'type' | 'payload'>> = {},
): Omit<Event, 'id' | 'hash' | 'previousHash' | 'sequenceNumber'> {
  return {
    type: overrides.type ?? 'state_changed',
    spaceId,
    timestamp: new Date(Date.UTC(2026, 1, 14, 0, 0, index)).toISOString(),
    version: 1,
    payload: overrides.payload ?? { index },
  };
}

async function writeN(
  log: EventLog,
  spaceId: string,
  count: number,
  startIndex = 0,
): Promise<Event[]> {
  const events: Event[] = [];
  for (let i = 0; i < count; i++) {
    const result = await log.writeEvent(makeEvent(spaceId, startIndex + i));
    expect(result.ok).toBe(true);
    if (result.ok) events.push(result.value);
  }
  return events;
}

async function genesisSource(): Promise<{ source: string; hash: string }> {
  const obj = { functions: { main: { body: 'return 0' } } };
  const source = JSON.stringify(obj);
  const hash = await sha256(source);
  return { source, hash };
}

async function computeStateHash(state: Record<string, unknown>): Promise<string> {
  return sha256(deterministicSerialize(state));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Branch Coverage', () => {
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

  // =========================================================================
  // 1. Query Engine — descending order branches
  // =========================================================================

  describe('Query Engine — descending order', () => {
    it('queryByType with desc order returns events newest-first', async () => {
      const log = trackedLog();
      await writeN(log, 'space-1', 5);

      const result = await log.queryByType('state_changed', { order: 'desc' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.items).toHaveLength(5);
      // Descending: sequence numbers should decrease
      expect(result.value.items[0]?.sequenceNumber).toBe(5);
      expect(result.value.items[4]?.sequenceNumber).toBe(1);

      for (let i = 1; i < result.value.items.length; i++) {
        const prev = result.value.items[i - 1];
        const curr = result.value.items[i];
        if (prev && curr) {
          expect(prev.sequenceNumber).toBeGreaterThan(curr.sequenceNumber);
        }
      }
    });

    it('queryByType with desc order and cursor paginates backwards', async () => {
      const log = trackedLog();
      await writeN(log, 'space-1', 5);

      // First page: desc order, limit 2
      const page1 = await log.queryByType('state_changed', {
        order: 'desc',
        limit: 2,
      });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;

      expect(page1.value.items).toHaveLength(2);
      expect(page1.value.nextCursor).toBeDefined();
      expect(page1.value.items[0]?.sequenceNumber).toBe(5);
      expect(page1.value.items[1]?.sequenceNumber).toBe(4);

      // Second page using cursor from first page
      const cursor1 = page1.value.nextCursor;
      if (cursor1 === undefined) return;
      const page2 = await log.queryByType('state_changed', {
        order: 'desc',
        limit: 2,
        cursor: cursor1,
      });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;

      expect(page2.value.items).toHaveLength(2);
      expect(page2.value.items[0]?.sequenceNumber).toBe(3);
      expect(page2.value.items[1]?.sequenceNumber).toBe(2);

      // Third page — last event
      const cursor2 = page2.value.nextCursor;
      if (cursor2 === undefined) return;
      const page3 = await log.queryByType('state_changed', {
        order: 'desc',
        limit: 2,
        cursor: cursor2,
      });
      expect(page3.ok).toBe(true);
      if (!page3.ok) return;

      expect(page3.value.items).toHaveLength(1);
      expect(page3.value.items[0]?.sequenceNumber).toBe(1);
      expect(page3.value.nextCursor).toBeUndefined();
    });

    it('queryByTime with desc order returns events newest-first', async () => {
      const log = trackedLog();
      await writeN(log, 'space-1', 10);

      const from = new Date(Date.UTC(2026, 1, 14, 0, 0, 2)).toISOString();
      const to = new Date(Date.UTC(2026, 1, 14, 0, 0, 7)).toISOString();

      const result = await log.queryByTime(from, to, { order: 'desc' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // inclusive from, exclusive to: seconds 2,3,4,5,6 → 5 events
      expect(result.value.total).toBe(5);
      expect(result.value.items).toHaveLength(5);

      // Verify descending order by sequence number
      for (let i = 1; i < result.value.items.length; i++) {
        const prev = result.value.items[i - 1];
        const curr = result.value.items[i];
        if (prev && curr) {
          expect(prev.sequenceNumber).toBeGreaterThan(curr.sequenceNumber);
        }
      }
    });

    it('queryByTime with invalid to parameter returns INVALID_QUERY error', async () => {
      const log = trackedLog();

      const result = await log.queryByTime(
        '2026-02-14T00:00:00.000Z',
        'not-a-valid-date',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('INVALID_QUERY');
      if (result.error.code === 'INVALID_QUERY') {
        expect(result.error.field).toBe('to');
        expect(result.error.reason).toContain('ISO 8601');
      }
    });

    it('queryByTime with desc order and cursor paginates correctly', async () => {
      const log = trackedLog();
      await writeN(log, 'space-1', 10);

      const from = new Date(Date.UTC(2026, 1, 14, 0, 0, 1)).toISOString();
      const to = new Date(Date.UTC(2026, 1, 14, 0, 0, 8)).toISOString();

      // First page: desc, limit 3
      const page1 = await log.queryByTime(from, to, {
        order: 'desc',
        limit: 3,
      });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;

      expect(page1.value.items).toHaveLength(3);
      expect(page1.value.nextCursor).toBeDefined();

      // Second page with cursor
      const timeCursor = page1.value.nextCursor;
      if (timeCursor === undefined) return;
      const page2 = await log.queryByTime(from, to, {
        order: 'desc',
        limit: 3,
        cursor: timeCursor,
      });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;

      expect(page2.value.items).toHaveLength(3);

      // Verify ordering across pages: page1 events > page2 events
      const lastP1 = page1.value.items[page1.value.items.length - 1];
      const firstP2 = page2.value.items[0];
      if (lastP1 && firstP2) {
        expect(lastP1.sequenceNumber).toBeGreaterThan(firstP2.sequenceNumber);
      }
    });

    it('queryByType with invalid cursor returns INVALID_QUERY error', async () => {
      const log = trackedLog();
      await writeN(log, 'space-1', 3);

      const result = await log.queryByType('state_changed', {
        cursor: 'not-valid-base64!!!',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('INVALID_QUERY');
      if (result.error.code === 'INVALID_QUERY') {
        expect(result.error.field).toBe('cursor');
      }
    });

    it('queryByTime with invalid cursor returns INVALID_QUERY error', async () => {
      const log = trackedLog();
      await writeN(log, 'space-1', 3);

      const result = await log.queryByTime(
        '2026-02-14T00:00:00.000Z',
        '2026-02-14T00:01:00.000Z',
        { cursor: '%%%invalid%%' },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('INVALID_QUERY');
      if (result.error.code === 'INVALID_QUERY') {
        expect(result.error.field).toBe('cursor');
      }
    });

    it('queryBySpace with desc order and cursor paginates correctly', async () => {
      const log = trackedLog();
      await writeN(log, 'space-1', 5);

      // First page: desc order, limit 2
      const page1 = await log.queryBySpace('space-1', {
        order: 'desc',
        limit: 2,
      });
      expect(page1.ok).toBe(true);
      if (!page1.ok) return;

      expect(page1.value.items).toHaveLength(2);
      expect(page1.value.nextCursor).toBeDefined();
      expect(page1.value.items[0]?.sequenceNumber).toBe(5);
      expect(page1.value.items[1]?.sequenceNumber).toBe(4);

      // Second page using cursor
      const spaceCursor1 = page1.value.nextCursor;
      if (spaceCursor1 === undefined) return;
      const page2 = await log.queryBySpace('space-1', {
        order: 'desc',
        limit: 2,
        cursor: spaceCursor1,
      });
      expect(page2.ok).toBe(true);
      if (!page2.ok) return;

      expect(page2.value.items).toHaveLength(2);
      expect(page2.value.items[0]?.sequenceNumber).toBe(3);
      expect(page2.value.items[1]?.sequenceNumber).toBe(2);

      // Third page — last event
      const spaceCursor2 = page2.value.nextCursor;
      if (spaceCursor2 === undefined) return;
      const page3 = await log.queryBySpace('space-1', {
        order: 'desc',
        limit: 2,
        cursor: spaceCursor2,
      });
      expect(page3.ok).toBe(true);
      if (!page3.ok) return;

      expect(page3.value.items).toHaveLength(1);
      expect(page3.value.items[0]?.sequenceNumber).toBe(1);
      expect(page3.value.nextCursor).toBeUndefined();
    });
  });

  // =========================================================================
  // 2. Archive Exporter — broken chain during export
  // =========================================================================

  describe('Archive Exporter — broken chain', () => {
    it('exportArchive fails when hash chain has broken previousHash link', async () => {
      const dbName = uniqueDbName();
      dbs.push(dbName);
      const log = createEventLog({ databaseName: dbName });
      await writeN(log, 'space-1', 5);

      // Tamper: break hash chain at the 3rd event (non-genesis)
      const db = createDatabase(dbName);
      const events = await db.events
        .where('[spaceId+sequenceNumber]')
        .between(['space-1', -Infinity], ['space-1', Infinity], true, true)
        .toArray();

      const target = events[2];
      if (target) {
        await db.events.update(target.id, { previousHash: 'BROKEN_LINK' });
      }
      db.close();

      const result = await log.exportArchive('space-1', '2027-01-01T00:00:00.000Z');
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('INTEGRITY_VIOLATION');
      if (result.error.code === 'INTEGRITY_VIOLATION') {
        expect(result.error.actual).toBe('BROKEN_LINK');
      }
    });

    it('exportArchive fails when genesis previousHash is non-null', async () => {
      const dbName = uniqueDbName();
      dbs.push(dbName);
      const log = createEventLog({ databaseName: dbName });
      await writeN(log, 'space-1', 3);

      // Tamper: set genesis event's previousHash to a non-null value
      const db = createDatabase(dbName);
      const events = await db.events
        .where('[spaceId+sequenceNumber]')
        .between(['space-1', -Infinity], ['space-1', Infinity], true, true)
        .toArray();

      const genesis = events[0];
      if (genesis) {
        await db.events.update(genesis.id, { previousHash: 'SHOULD_BE_NULL' });
      }
      db.close();

      const result = await log.exportArchive('space-1', '2027-01-01T00:00:00.000Z');
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('INTEGRITY_VIOLATION');
      if (result.error.code === 'INTEGRITY_VIOLATION') {
        // When brokenIndex === 0, prevEvent is undefined → expected is 'null'
        expect(result.error.expected).toBe('null');
        expect(result.error.actual).toBe('SHOULD_BE_NULL');
      }
    });
  });

  // =========================================================================
  // 3. Archive Importer — error paths
  // =========================================================================

  describe('Archive Importer — error paths', () => {
    it('importArchive fails on archive that is too small', async () => {
      const log = trackedLog();

      // An archive shorter than HEADER_SIZE + FOOTER_SIZE bytes
      const tinyArchive = new Uint8Array(5);
      tinyArchive[0] = 0x52; // 'R'
      tinyArchive[1] = 0x42; // 'B'

      const result = await log.importArchive(tinyArchive);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('IMPORT_FAILED');
    });

    it('importArchive fails when header event count does not match body', async () => {
      const srcName = uniqueDbName();
      dbs.push(srcName);
      const srcLog = createEventLog({ databaseName: srcName });
      await writeN(srcLog, 'space-1', 3);

      // Export a valid archive with 3 events
      const exported = await srcLog.exportArchive('space-1', '2027-01-01T00:00:00.000Z');
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;

      // Create a copy and tamper the event count in the header (bytes 6-9)
      const modified = new Uint8Array(exported.value);
      const view = new DataView(modified.buffer, modified.byteOffset, modified.byteLength);
      // Change event count from 3 to 99
      view.setUint32(6, 99, false);

      // Try to import the tampered archive into a fresh database
      const dstLog = trackedLog();
      const result = await dstLog.importArchive(modified);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('IMPORT_FAILED');
      if (result.error.code === 'IMPORT_FAILED') {
        expect(result.error.reason).toContain('Header declares');
        expect(result.error.reason).toContain('99');
        expect(result.error.reason).toContain('3');
      }
    });

    it('importArchive reports errors for events with id but invalid shape', async () => {
      const log = trackedLog();

      // Create a crafted archive with 2 "events": one with id but missing fields,
      // one without id at all (primitive)
      const fakeEvents = [
        { id: 'evt-123', type: 'bad_type', spaceId: 'space-1' }, // has 'id' but invalid shape
        42, // primitive: typeof !== 'object'
      ];
      const jsonBody = JSON.stringify(fakeEvents);
      const encoder = new TextEncoder();
      const jsonBytes = encoder.encode(jsonBody);

      const compressed = await compressData(jsonBytes);
      const bodyHash = await sha256(jsonBody);

      const header = encodeHeader(2);
      const footerBytes = encoder.encode(bodyHash);
      const totalSize = HEADER_SIZE + compressed.length + FOOTER_SIZE;
      const archive = new Uint8Array(totalSize);
      archive.set(header, 0);
      archive.set(compressed, HEADER_SIZE);
      archive.set(footerBytes, HEADER_SIZE + compressed.length);

      const result = await log.importArchive(archive);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Both events are invalid shape so both should be in errors
      expect(result.value.importedEvents).toBe(0);
      expect(result.value.errors.length).toBe(2);
      // First error: has an id → should extract it
      expect(result.value.errors[0]?.eventId).toBe('evt-123');
      // Second error: primitive → 'unknown' id
      expect(result.value.errors[1]?.eventId).toBe('unknown');
    });

    it('importArchive reports error for non-array JSON body', async () => {
      const log = trackedLog();

      // Create archive with a JSON object (not array)
      const jsonBody = JSON.stringify({ not: 'an array' });
      const encoder = new TextEncoder();
      const jsonBytes = encoder.encode(jsonBody);

      const compressed = await compressData(jsonBytes);
      const bodyHash = await sha256(jsonBody);

      const header = encodeHeader(0);
      const footerBytes = encoder.encode(bodyHash);
      const totalSize = HEADER_SIZE + compressed.length + FOOTER_SIZE;
      const archive = new Uint8Array(totalSize);
      archive.set(header, 0);
      archive.set(compressed, HEADER_SIZE);
      archive.set(footerBytes, HEADER_SIZE + compressed.length);

      const result = await log.importArchive(archive);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('IMPORT_FAILED');
      if (result.error.code === 'IMPORT_FAILED') {
        expect(result.error.reason).toContain('not a JSON array');
      }
    });
  });

  // =========================================================================
  // 4. Integrity Verifier — tampered events
  // =========================================================================

  describe('Integrity Verifier — tampered events', () => {
    it('detects non-genesis event with previousHash set to null (chain break)', async () => {
      const dbName = uniqueDbName();
      dbs.push(dbName);
      const log = createEventLog({ databaseName: dbName });
      await writeN(log, 'space-1', 5);

      // Tamper: set the 3rd event's previousHash to null
      const db = createDatabase(dbName);
      const events = await db.events
        .where('[spaceId+sequenceNumber]')
        .between(['space-1', -Infinity], ['space-1', Infinity], true, true)
        .toArray();

      const target = events[2];
      if (target) {
        await db.events.update(target.id, { previousHash: null });
      }
      db.close();

      const result = await log.verifyIntegrity('space-1');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.valid).toBe(false);
      expect(result.value.firstBrokenLink).toBeDefined();
      // The actual value is null, which the verifier renders as 'null'
      expect(result.value.firstBrokenLink?.actual).toBe('null');
    });

    it('detects genesis event with non-null previousHash', async () => {
      const dbName = uniqueDbName();
      dbs.push(dbName);
      const log = createEventLog({ databaseName: dbName });
      await writeN(log, 'space-1', 3);

      // Tamper: set genesis event's previousHash to a non-null value
      const db = createDatabase(dbName);
      const events = await db.events
        .where('[spaceId+sequenceNumber]')
        .between(['space-1', -Infinity], ['space-1', Infinity], true, true)
        .toArray();

      const genesis = events[0];
      if (genesis) {
        await db.events.update(genesis.id, { previousHash: 'NOT_NULL_HASH' });
      }
      db.close();

      const result = await log.verifyIntegrity('space-1');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.valid).toBe(false);
      expect(result.value.firstBrokenLink).toBeDefined();
      expect(result.value.firstBrokenLink?.expected).toBe('null (genesis)');
      expect(result.value.firstBrokenLink?.actual).toBe('NOT_NULL_HASH');
    });
  });

  // =========================================================================
  // 5. Diff Reconstructor — atTimestamp filtering + missing genesis
  // =========================================================================

  describe('Diff Reconstructor — filtering and missing genesis', () => {
    it('reconstructSource with atTimestamp applies only diffs up to that time', async () => {
      const dbName = uniqueDbName();
      dbs.push(dbName);
      const db = createDatabase(dbName);

      // Write genesis event
      const { source, hash: genesisHash } = await genesisSource();
      const genesisResult = await writeGenesisEvent(
        db,
        'space-1',
        '2026-02-14T00:00:00.000Z',
        source,
        genesisHash,
        'wasm-hash',
      );
      expect(genesisResult.ok).toBe(true);

      // Initial state
      let state = JSON.parse(source) as Record<string, unknown>;

      // Diff 1 at T+1s: modify main body → 'return 1'
      state = { ...state, functions: { main: { body: 'return 1' } } };
      const hash1 = await computeStateHash(state);
      const diffOps1: readonly AstDiffOperation[] = [
        { path: 'functions.main.body', operation: 'modify', before: 'return 0', after: 'return 1' },
      ];
      const diff1 = await writeDiffEvent(
        db,
        'space-1',
        '2026-02-14T00:00:01.000Z',
        diffOps1,
        { changedNodes: 1, totalNodes: 3, affectedFunctions: ['main'] },
        hash1,
      );
      expect(diff1.ok).toBe(true);

      // Diff 2 at T+2s: modify main body → 'return 2'
      state = { ...state, functions: { main: { body: 'return 2' } } };
      const hash2 = await computeStateHash(state);
      const diffOps2: readonly AstDiffOperation[] = [
        { path: 'functions.main.body', operation: 'modify', before: 'return 1', after: 'return 2' },
      ];
      const diff2 = await writeDiffEvent(
        db,
        'space-1',
        '2026-02-14T00:00:02.000Z',
        diffOps2,
        { changedNodes: 1, totalNodes: 3, affectedFunctions: ['main'] },
        hash2,
      );
      expect(diff2.ok).toBe(true);

      // Reconstruct at T+1.5s — should include genesis + diff 1, but NOT diff 2
      const result = await reconstructSource(
        db,
        'space-1',
        '2026-02-14T00:00:01.500Z',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        db.close();
        return;
      }

      expect(result.value.diffsApplied).toBe(1);
      const parsed = JSON.parse(result.value.source) as Record<string, unknown>;
      const fns = parsed['functions'] as Record<string, unknown>;
      const main = fns['main'] as Record<string, unknown>;
      expect(main['body']).toBe('return 1');

      db.close();
    });

    it('reconstructSource without genesis event returns error', async () => {
      const dbName = uniqueDbName();
      dbs.push(dbName);

      // Write state_changed events (not space_created) via the facade
      const log = createEventLog({ databaseName: dbName });
      await writeN(log, 'space-1', 3);

      // Attempt to reconstruct source — no space_created genesis exists
      const db = createDatabase(dbName);
      const result = await reconstructSource(db, 'space-1');
      db.close();

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('INVALID_EVENT');
      if (result.error.code === 'INVALID_EVENT') {
        expect(result.error.reason).toContain('genesis');
      }
    });

    it('reconstructSource with non-JSON genesis source wraps as state object', async () => {
      const dbName = uniqueDbName();
      dbs.push(dbName);
      const db = createDatabase(dbName);

      // Write genesis with plain text source (not JSON)
      const plainSource = 'function main() { return 0; }';
      const plainHash = await sha256(plainSource);
      const genesisResult = await writeGenesisEvent(
        db,
        'space-1',
        '2026-02-14T00:00:00.000Z',
        plainSource,
        plainHash,
        'wasm-hash',
      );
      expect(genesisResult.ok).toBe(true);

      // Reconstruct — the non-JSON source should be wrapped as { source: string }
      const result = await reconstructSource(db, 'space-1');
      expect(result.ok).toBe(true);
      if (!result.ok) {
        db.close();
        return;
      }

      expect(result.value.diffsApplied).toBe(0);
      // The source is serialized via deterministicSerialize, verify it contains the text
      const parsed = JSON.parse(result.value.source) as Record<string, unknown>;
      expect(parsed['source']).toBe(plainSource);

      db.close();
    });

    it('reconstructSource with diff that creates deep paths via setAtPath', async () => {
      const dbName = uniqueDbName();
      dbs.push(dbName);
      const db = createDatabase(dbName);

      // Write genesis
      const { source, hash: genesisHash } = await genesisSource();
      const genesisResult = await writeGenesisEvent(
        db,
        'space-1',
        '2026-02-14T00:00:00.000Z',
        source,
        genesisHash,
        'wasm-hash',
      );
      expect(genesisResult.ok).toBe(true);

      // Initial state: { functions: { main: { body: 'return 0' } } }
      const state = JSON.parse(source) as Record<string, unknown>;

      // Add a deeply nested path where intermediate 'utils' doesn't exist
      // This forces the setAtPath else branch (creating intermediate objects)
      const newState = { ...state } as Record<string, unknown>;
      const fns = { ...(newState['functions'] as Record<string, unknown>) };
      fns['main'] = { body: 'return 0' };
      // Add utils.helpers.format — utils and helpers don't exist yet
      fns['utils'] = { helpers: { format: 'fmt' } };
      newState['functions'] = fns;
      const hash = await computeStateHash(newState);

      const diffOps: readonly AstDiffOperation[] = [
        {
          path: 'functions.utils.helpers.format',
          operation: 'add',
          after: 'fmt',
        },
      ];
      const diffResult = await writeDiffEvent(
        db,
        'space-1',
        '2026-02-14T00:00:01.000Z',
        diffOps,
        { changedNodes: 1, totalNodes: 5, affectedFunctions: ['utils'] },
        hash,
      );
      expect(diffResult.ok).toBe(true);

      const result = await reconstructSource(db, 'space-1');
      expect(result.ok).toBe(true);
      if (!result.ok) {
        db.close();
        return;
      }

      expect(result.value.diffsApplied).toBe(1);
      const parsed = JSON.parse(result.value.source) as Record<string, unknown>;
      const funcs = parsed['functions'] as Record<string, unknown>;
      const utils = funcs['utils'] as Record<string, unknown>;
      const helpers = utils['helpers'] as Record<string, unknown>;
      expect(helpers['format']).toBe('fmt');

      db.close();
    });

    it('reconstructSource with genesis missing SpaceCreatedPayload shape returns error', async () => {
      const dbName = uniqueDbName();
      dbs.push(dbName);
      const db = createDatabase(dbName);

      // Write a space_created event WITHOUT the required payload fields
      const { writeEvent } = await import('../../src/storage/event-writer.js');
      await writeEvent(db, {
        type: 'space_created',
        spaceId: 'space-bad-payload',
        timestamp: '2026-02-14T00:00:00.000Z',
        version: 1,
        payload: { notSource: true }, // Missing 'source' and 'sourceHash'
      });

      const result = await reconstructSource(db, 'space-bad-payload');
      expect(result.ok).toBe(false);
      if (result.ok) {
        db.close();
        return;
      }

      expect(result.error.code).toBe('INVALID_EVENT');
      if (result.error.code === 'INVALID_EVENT') {
        expect(result.error.reason).toContain('SpaceCreatedPayload');
      }

      db.close();
    });
  });

  // =========================================================================
  // 6. State Reconstructor — atTimestamp with snapshots
  // =========================================================================

  describe('State Reconstructor — atTimestamp branches', () => {
    it('reconstructState with atTimestamp uses snapshot and filters events', async () => {
      const dbName = uniqueDbName();
      dbs.push(dbName);

      // Accumulator reducer: collects payload indices
      const reducer = (state: unknown, event: Event): unknown => {
        const arr = (Array.isArray(state) ? state : []) as unknown[];
        return [...arr, event.payload];
      };

      const log = createEventLog({
        databaseName: dbName,
        stateReducer: reducer,
        snapshotInterval: 1000, // no auto-snapshot
      });

      // Write 10 events
      await writeN(log, 'space-1', 10);

      // Create a snapshot covering events 1-10
      const snap = await log.createSnapshot('space-1');
      expect(snap.ok).toBe(true);

      // Write 10 more events (indices 10-19)
      await writeN(log, 'space-1', 10, 10);

      // Reconstruct at timestamp of event 15 (index 15, seq 16)
      // Should use snapshot + events 11-16
      const atTimestamp = new Date(Date.UTC(2026, 1, 14, 0, 0, 15)).toISOString();
      const result = await log.reconstructState('space-1', atTimestamp);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const state = result.value as Record<string, unknown>[];
      // Should have events 0-15 (16 events total: 10 from snapshot + 6 from replay)
      expect(state).toHaveLength(16);
    });

    it('reconstructState with atTimestamp predating all events returns error', async () => {
      const log = trackedLog();
      // Write events starting at 2026-02-14T00:00:00.000Z
      await writeN(log, 'space-1', 5);

      // Reconstruct at a time before any events exist
      const result = await log.reconstructState(
        'space-1',
        '2020-01-01T00:00:00.000Z',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe('INVALID_QUERY');
      if (result.error.code === 'INVALID_QUERY') {
        expect(result.error.field).toBe('atTimestamp');
        expect(result.error.reason).toContain('predates');
      }
    });
  });
});
