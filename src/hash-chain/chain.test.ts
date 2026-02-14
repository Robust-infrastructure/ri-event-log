/**
 * ri-event-log — Hash chain linking tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { verifyChainLinks, getLastEventHash, getNextSequenceNumber } from './chain.js';
import { computeEventHash } from './hash.js';
import { EventLogDatabase } from '../storage/database.js';
import type { Event } from '../types.js';

/** Helper to build a valid event chain for testing. */
async function buildEventChain(count: number, spaceId: string = 'space-1'): Promise<Event[]> {
  const events: Event[] = [];
  for (let i = 0; i < count; i++) {
    const prev = i === 0 ? null : (events[i - 1]?.hash ?? null);
    const eventWithoutHash = {
      id: `${spaceId}-evt-${String(i + 1).padStart(3, '0')}`,
      type: 'state_changed' as const,
      spaceId,
      timestamp: `2026-02-14T00:${String(i).padStart(2, '0')}:00.000Z`,
      sequenceNumber: i + 1,
      previousHash: prev,
      version: 1,
      payload: { step: i + 1 },
    };
    const hash = await computeEventHash(eventWithoutHash);
    events.push(Object.freeze({ ...eventWithoutHash, hash }) as Event);
  }
  return events;
}

describe('verifyChainLinks', () => {
  it('returns -1 for an empty chain (valid)', () => {
    expect(verifyChainLinks([])).toBe(-1);
  });

  it('returns -1 for a single genesis event with null previousHash', async () => {
    const events = await buildEventChain(1);
    expect(verifyChainLinks(events)).toBe(-1);
  });

  it('returns 0 for a genesis event with non-null previousHash', () => {
    const badGenesis: Event = {
      id: 'evt-1',
      type: 'space_created',
      spaceId: 'space-1',
      timestamp: '2026-02-14T00:00:00.000Z',
      sequenceNumber: 1,
      hash: 'some-hash',
      previousHash: 'should-be-null',
      version: 1,
      payload: {},
    };
    expect(verifyChainLinks([badGenesis])).toBe(0);
  });

  it('returns -1 for a valid chain of 10 events', async () => {
    const events = await buildEventChain(10);
    expect(verifyChainLinks(events)).toBe(-1);
  });

  it('detects tampered event in the middle of the chain', async () => {
    const events = await buildEventChain(5);
    // Tamper with event 3's hash (index 2)
    const tampered = events.map((e, i) =>
      i === 2 ? { ...e, hash: 'tampered-hash' } : e,
    );
    // Event at index 3 should fail because its previousHash won't match tampered hash at index 2
    expect(verifyChainLinks(tampered)).toBe(3);
  });

  it('detects missing event in chain (previousHash mismatch)', async () => {
    const events = await buildEventChain(5);
    // Remove event at index 2, creating a gap
    const e0 = events[0];
    const e1 = events[1];
    const e3 = events[3];
    const e4 = events[4];
    if (!e0 || !e1 || !e3 || !e4) throw new Error('Expected 5 events');
    const withGap = [e0, e1, e3, e4];
    // Event at index 2 (originally index 3) should fail
    expect(verifyChainLinks(withGap)).toBe(2);
  });
});

describe('getLastEventHash', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-chain-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('returns null for a space with no events', async () => {
    const hash = await getLastEventHash(db, 'nonexistent-space');
    expect(hash).toBeNull();
  });

  it('returns the hash of the last event for a space', async () => {
    const events = await buildEventChain(3);
    for (const event of events) {
      await db.events.add({ ...event, payload: { ...event.payload } });
    }
    const hash = await getLastEventHash(db, 'space-1');
    const lastEvent = events[2];
    expect(lastEvent).toBeDefined();
    expect(hash).toBe(lastEvent?.hash);
  });

  it('returns correct hash when multiple spaces exist', async () => {
    const spaceAEvents = await buildEventChain(2, 'space-a');
    const spaceBEvents = await buildEventChain(3, 'space-b');
    for (const event of [...spaceAEvents, ...spaceBEvents]) {
      await db.events.add({ ...event, payload: { ...event.payload } });
    }
    expect(await getLastEventHash(db, 'space-a')).toBe(spaceAEvents[1]?.hash);
    expect(await getLastEventHash(db, 'space-b')).toBe(spaceBEvents[2]?.hash);
  });
});

describe('getNextSequenceNumber', () => {
  let db: EventLogDatabase;

  beforeEach(() => {
    db = new EventLogDatabase(`test-seq-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('returns 1 for a space with no events', async () => {
    const seq = await getNextSequenceNumber(db, 'empty-space');
    expect(seq).toBe(1);
  });

  it('returns the next sequence number after existing events', async () => {
    const events = await buildEventChain(5);
    for (const event of events) {
      await db.events.add({ ...event, payload: { ...event.payload } });
    }
    const seq = await getNextSequenceNumber(db, 'space-1');
    expect(seq).toBe(6);
  });
});
