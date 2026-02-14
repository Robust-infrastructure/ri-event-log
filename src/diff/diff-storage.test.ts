/**
 * ri-event-log — Diff storage tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { EventLogDatabase } from '../storage/database.js';
import { writeDiffEvent, writeGenesisEvent } from './diff-storage.js';
import type { AstDiffOperation, ScopeMetadata } from './types.js';
import { sha256 } from '../hash-chain/hash.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScopeMetadata(overrides: Partial<ScopeMetadata> = {}): ScopeMetadata {
  return {
    changedNodes: 1,
    totalNodes: 10,
    affectedFunctions: ['main'],
    ...overrides,
  };
}

function makeValidDiff(): readonly AstDiffOperation[] {
  return [
    { path: 'functions.main.body', operation: 'modify', before: 'old code', after: 'new code' },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('writeDiffEvent', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-diff-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('writes a valid diff event', async () => {
    const result = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      makeValidDiff(),
      makeScopeMetadata(),
      'abc123hash',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.type).toBe('space_evolved');
    expect(result.value.spaceId).toBe('space-1');

    const payload = result.value.payload as Record<string, unknown>;
    expect(payload['sourceHash']).toBe('abc123hash');
    expect(Array.isArray(payload['astDiff'])).toBe(true);
    expect(payload['scopeMetadata']).toBeDefined();
  });

  it('rejects diff with empty operations array', async () => {
    const result = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      [],
      makeScopeMetadata(),
      'abc123hash',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
    if (result.error.code !== 'INVALID_EVENT') return;
    expect(result.error.field).toBe('astDiff');
    expect(result.error.reason).toContain('empty');
  });

  it('rejects diff with invalid operation type', async () => {
    const badDiff = [
      { path: 'a.b', operation: 'explode' as 'add', after: 'boom' },
    ];

    const result = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      badDiff,
      makeScopeMetadata(),
      'abc123hash',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
    if (result.error.code !== 'INVALID_EVENT') return;
    expect(result.error.reason).toContain('invalid type');
  });

  it('rejects add operation without after value', async () => {
    const badDiff: AstDiffOperation[] = [
      { path: 'a.b', operation: 'add' },
    ];

    const result = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      badDiff,
      makeScopeMetadata(),
      'hash',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('rejects modify operation without before/after', async () => {
    const badDiff: AstDiffOperation[] = [
      { path: 'a.b', operation: 'modify', after: 'new' },
    ];

    const result = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      badDiff,
      makeScopeMetadata(),
      'hash',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
    if (result.error.code !== 'INVALID_EVENT') return;
    expect(result.error.reason).toContain("'before' and 'after'");
  });

  it('rejects remove operation without before value', async () => {
    const badDiff: AstDiffOperation[] = [
      { path: 'a.b', operation: 'remove' },
    ];

    const result = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      badDiff,
      makeScopeMetadata(),
      'hash',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('rejects empty sourceHash', async () => {
    const result = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      makeValidDiff(),
      makeScopeMetadata(),
      '',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
    if (result.error.code !== 'INVALID_EVENT') return;
    expect(result.error.field).toBe('sourceHash');
  });

  it('rejects invalid scopeMetadata (negative changedNodes)', async () => {
    const result = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      makeValidDiff(),
      makeScopeMetadata({ changedNodes: -1 }),
      'hash',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('rejects diff with empty path', async () => {
    const badDiff: AstDiffOperation[] = [
      { path: '', operation: 'add', after: 'value' },
    ];

    const result = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      badDiff,
      makeScopeMetadata(),
      'hash',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
    if (result.error.code !== 'INVALID_EVENT') return;
    expect(result.error.reason).toContain('invalid path');
  });

  it('writes multiple diff operations in one event', async () => {
    const multiDiff: AstDiffOperation[] = [
      { path: 'functions.main.body', operation: 'modify', before: 'old', after: 'new' },
      { path: 'functions.helper', operation: 'add', after: { body: 'return 42' } },
      { path: 'imports.lodash', operation: 'remove', before: 'import lodash' },
    ];

    const result = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      multiDiff,
      makeScopeMetadata({ changedNodes: 3, affectedFunctions: ['main', 'helper'] }),
      'multihash',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = result.value.payload as Record<string, unknown>;
    const astDiff = payload['astDiff'] as unknown[];
    expect(astDiff).toHaveLength(3);
  });

  it('storage size: 100 diff events < 100 full source events', async () => {
    const diffDb = new EventLogDatabase(`test-diff-size-${Math.random().toString(36).slice(2)}`);
    const fullDb = new EventLogDatabase(`test-full-size-${Math.random().toString(36).slice(2)}`);
    try {
      // Write 100 diff events (small payloads)
      for (let i = 0; i < 100; i++) {
        const ts = new Date(Date.UTC(2026, 1, 14, 0, 0, i)).toISOString();
        await writeDiffEvent(
          diffDb,
          'space-1',
          ts,
          [{ path: `functions.fn${String(i)}.body`, operation: 'modify', before: 'x', after: 'y' }],
          makeScopeMetadata(),
          `hash-${String(i)}`,
        );
      }

      // Write 100 full source events (large payloads with full source)
      const largeSource = 'x'.repeat(10_000); // simulate a 10KB source file
      for (let i = 0; i < 100; i++) {
        const ts = new Date(Date.UTC(2026, 1, 14, 0, 0, i)).toISOString();
        const { writeEvent } = await import('../storage/event-writer.js');
        await writeEvent(fullDb, {
          type: 'space_evolved',
          spaceId: 'space-1',
          timestamp: ts,
          version: 1,
          payload: { source: largeSource + String(i), sourceHash: `hash-${String(i)}` },
        });
      }

      // Compare sizes: count bytes for all events
      const diffEvents = await diffDb.events.toArray();
      const fullEvents = await fullDb.events.toArray();

      const diffSize = JSON.stringify(diffEvents).length;
      const fullSize = JSON.stringify(fullEvents).length;

      // Diff should be significantly smaller
      expect(diffSize).toBeLessThan(fullSize);
      // Should be at least 5x less (conservative; 10x is ideal)
      expect(diffSize * 5).toBeLessThan(fullSize);
    } finally {
      diffDb.close();
      await diffDb.delete();
      fullDb.close();
      await fullDb.delete();
    }
  });
});

describe('writeGenesisEvent', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-genesis-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('writes a valid genesis event', async () => {
    const source = '{ "functions": { "main": { "body": "return 0" } } }';
    const hash = await sha256(source);

    const result = await writeGenesisEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      source,
      hash,
      'wasm-hash-123',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.type).toBe('space_created');
    expect(result.value.spaceId).toBe('space-1');

    const payload = result.value.payload as Record<string, unknown>;
    expect(payload['source']).toBe(source);
    expect(payload['sourceHash']).toBe(hash);
    expect(payload['compiledWasmHash']).toBe('wasm-hash-123');
  });

  it('rejects empty source', async () => {
    const result = await writeGenesisEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      '',
      'hash',
      'wasm-hash',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('rejects empty sourceHash', async () => {
    const result = await writeGenesisEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      'source code',
      '',
      'wasm-hash',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('rejects empty compiledWasmHash', async () => {
    const result = await writeGenesisEvent(
      db,
      'space-1',
      '2026-02-14T00:00:00.000Z',
      'source code',
      'hash',
      '',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_EVENT');
  });
});
