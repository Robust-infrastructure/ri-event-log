/**
 * ri-event-log — Diff reconstructor tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { EventLogDatabase } from '../storage/database.js';
import { writeGenesisEvent, writeDiffEvent } from './diff-storage.js';
import { reconstructSource } from './diff-reconstructor.js';
import { sha256, deterministicSerialize } from '../hash-chain/hash.js';
import type { AstDiffOperation } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a genesis source object and its hash. */
async function genesisSource(): Promise<{ source: string; hash: string }> {
  const obj = { functions: { main: { body: 'return 0' } } };
  const source = JSON.stringify(obj);
  const hash = await sha256(source);
  return { source, hash };
}

/** Compute the hash of a state object (deterministic serialization). */
async function stateHash(state: Record<string, unknown>): Promise<string> {
  return sha256(deterministicSerialize(state));
}

/**
 * Write a genesis event and return the initial state object.
 */
async function seedGenesis(
  db: EventLogDatabase,
  spaceId: string,
): Promise<Record<string, unknown>> {
  const { source, hash } = await genesisSource();
  const result = await writeGenesisEvent(
    db,
    spaceId,
    '2026-02-14T00:00:00.000Z',
    source,
    hash,
    'wasm-hash',
  );
  if (!result.ok) throw new Error('Failed to write genesis');
  return JSON.parse(source) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconstructSource', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-reconstruct-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('reconstructs from genesis + 1 diff', async () => {
    let state = await seedGenesis(db, 'space-1');

    // Apply a diff: modify main body
    state = { ...state, functions: { main: { body: 'return 42' } } };
    const hash = await stateHash(state);

    const diffOps: AstDiffOperation[] = [
      { path: 'functions.main.body', operation: 'modify', before: 'return 0', after: 'return 42' },
    ];

    const diffResult = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:01.000Z',
      diffOps,
      { changedNodes: 1, totalNodes: 3, affectedFunctions: ['main'] },
      hash,
    );
    expect(diffResult.ok).toBe(true);

    const result = await reconstructSource(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.diffsApplied).toBe(1);
    expect(result.value.sourceHash).toBe(hash);

    const parsed = JSON.parse(result.value.source) as Record<string, unknown>;
    const fns = parsed['functions'] as Record<string, unknown>;
    const main = fns['main'] as Record<string, unknown>;
    expect(main['body']).toBe('return 42');
  });

  it('reconstructs from genesis + 100 diffs', async () => {
    let state = await seedGenesis(db, 'space-1');

    for (let i = 0; i < 100; i++) {
      const fnName = `fn_${String(i)}`;
      const fns = (state['functions'] ?? {}) as Record<string, unknown>;
      state = { ...state, functions: { ...fns, [fnName]: { body: `return ${String(i)}` } } };
      const hash = await stateHash(state);

      const ts = new Date(Date.UTC(2026, 1, 14, 0, 0, i + 1)).toISOString();
      const diffResult = await writeDiffEvent(
        db,
        'space-1',
        ts,
        [{ path: `functions.${fnName}`, operation: 'add', after: { body: `return ${String(i)}` } }],
        { changedNodes: 1, totalNodes: i + 4, affectedFunctions: [fnName] },
        hash,
      );
      expect(diffResult.ok).toBe(true);
    }

    const result = await reconstructSource(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.diffsApplied).toBe(100);

    // Verify the last function exists
    const parsed = JSON.parse(result.value.source) as Record<string, unknown>;
    const fns = parsed['functions'] as Record<string, unknown>;
    expect(fns['fn_99']).toEqual({ body: 'return 99' });
    // And the first added function
    expect(fns['fn_0']).toEqual({ body: 'return 0' });
    // And the original main
    expect(fns['main']).toEqual({ body: 'return 0' });
  });

  it('hash mismatch at step N returns error with step number', async () => {
    await seedGenesis(db, 'space-1');

    // Write a diff with a wrong sourceHash
    const diffResult = await writeDiffEvent(
      db,
      'space-1',
      '2026-02-14T00:00:01.000Z',
      [{ path: 'functions.main.body', operation: 'modify', before: 'return 0', after: 'return 42' }],
      { changedNodes: 1, totalNodes: 3, affectedFunctions: ['main'] },
      'WRONG_HASH_ON_PURPOSE',
    );
    expect(diffResult.ok).toBe(true);

    const result = await reconstructSource(db, 'space-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
    if (result.error.code !== 'INVALID_EVENT') return;
    expect(result.error.field).toBe('sourceHash');
    expect(result.error.reason).toContain('step 1');
  });

  it('empty space returns error', async () => {
    const result = await reconstructSource(db, 'nonexistent-space');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
  });

  it('space without genesis returns error', async () => {
    // Write a space_evolved event without a space_created genesis
    const { writeEvent } = await import('../storage/event-writer.js');
    await writeEvent(db, {
      type: 'space_evolved',
      spaceId: 'space-no-genesis',
      timestamp: '2026-02-14T00:00:00.000Z',
      version: 1,
      payload: { astDiff: [], sourceHash: 'hash' },
    });

    const result = await reconstructSource(db, 'space-no-genesis');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('INVALID_EVENT');
    if (result.error.code !== 'INVALID_EVENT') return;
    expect(result.error.reason).toContain('genesis');
  });

  it('respects atTimestamp filter', async () => {
    let state = await seedGenesis(db, 'space-1');

    // Diff 1 at T+1s
    state = { ...state, functions: { main: { body: 'return 1' } } };
    let hash = await stateHash(state);
    await writeDiffEvent(
      db, 'space-1', '2026-02-14T00:00:01.000Z',
      [{ path: 'functions.main.body', operation: 'modify', before: 'return 0', after: 'return 1' }],
      { changedNodes: 1, totalNodes: 3, affectedFunctions: ['main'] },
      hash,
    );

    // Diff 2 at T+2s
    state = { ...state, functions: { main: { body: 'return 2' } } };
    hash = await stateHash(state);
    await writeDiffEvent(
      db, 'space-1', '2026-02-14T00:00:02.000Z',
      [{ path: 'functions.main.body', operation: 'modify', before: 'return 1', after: 'return 2' }],
      { changedNodes: 1, totalNodes: 3, affectedFunctions: ['main'] },
      hash,
    );

    // Reconstruct at T+1 — should only have diff 1
    const result = await reconstructSource(db, 'space-1', '2026-02-14T00:00:01.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.diffsApplied).toBe(1);
    const parsed = JSON.parse(result.value.source) as Record<string, unknown>;
    const fns = parsed['functions'] as Record<string, unknown>;
    const main = fns['main'] as Record<string, unknown>;
    expect(main['body']).toBe('return 1');
  });

  it('genesis-only reconstruction returns initial source', async () => {
    await seedGenesis(db, 'space-1');

    const result = await reconstructSource(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.diffsApplied).toBe(0);

    const parsed = JSON.parse(result.value.source) as Record<string, unknown>;
    const fns = parsed['functions'] as Record<string, unknown>;
    const main = fns['main'] as Record<string, unknown>;
    expect(main['body']).toBe('return 0');
  });

  it('handles remove operations correctly', async () => {
    let state = await seedGenesis(db, 'space-1');

    // Add a function, then remove it
    const fns = state['functions'] as Record<string, unknown>;
    state = { ...state, functions: { ...fns, helper: { body: 'return true' } } };
    let hash = await stateHash(state);
    await writeDiffEvent(
      db, 'space-1', '2026-02-14T00:00:01.000Z',
      [{ path: 'functions.helper', operation: 'add', after: { body: 'return true' } }],
      { changedNodes: 1, totalNodes: 4, affectedFunctions: ['helper'] },
      hash,
    );

    // Remove helper
    const fnsObj = state['functions'] as Record<string, unknown>;
    const remainingFns = Object.fromEntries(
      Object.entries(fnsObj).filter(([k]) => k !== 'helper'),
    );
    state = { ...state, functions: remainingFns };
    hash = await stateHash(state);
    await writeDiffEvent(
      db, 'space-1', '2026-02-14T00:00:02.000Z',
      [{ path: 'functions.helper', operation: 'remove', before: { body: 'return true' } }],
      { changedNodes: 1, totalNodes: 3, affectedFunctions: ['helper'] },
      hash,
    );

    const result = await reconstructSource(db, 'space-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.diffsApplied).toBe(2);
    const parsed = JSON.parse(result.value.source) as Record<string, unknown>;
    const reconstructedFns = parsed['functions'] as Record<string, unknown>;
    expect(reconstructedFns['helper']).toBeUndefined();
    expect(reconstructedFns['main']).toEqual({ body: 'return 0' });
  });

  it('maintains hash chain integrity for diff events', async () => {
    await seedGenesis(db, 'space-1');
    let state = JSON.parse((await genesisSource()).source) as Record<string, unknown>;

    // Write 5 diffs — each linked to previous via hash chain
    for (let i = 0; i < 5; i++) {
      const fns = state['functions'] as Record<string, unknown>;
      state = { ...state, functions: { ...fns, [`fn${String(i)}`]: { body: String(i) } } };
      const hash = await stateHash(state);
      const ts = new Date(Date.UTC(2026, 1, 14, 0, 0, i + 1)).toISOString();
      await writeDiffEvent(
        db, 'space-1', ts,
        [{ path: `functions.fn${String(i)}`, operation: 'add', after: { body: String(i) } }],
        { changedNodes: 1, totalNodes: i + 4, affectedFunctions: [`fn${String(i)}`] },
        hash,
      );
    }

    // Verify all events have linked previousHash
    const events = await db.events
      .where('[spaceId+sequenceNumber]')
      .between(['space-1', -Infinity], ['space-1', Infinity], true, true)
      .toArray();

    expect(events).toHaveLength(6); // 1 genesis + 5 diffs

    // First event has previousHash null
    expect(events[0]?.previousHash).toBeNull();
    // Each subsequent event links to predecessor
    for (let i = 1; i < events.length; i++) {
      expect(events[i]?.previousHash).toBe(events[i - 1]?.hash);
    }
  });
});
