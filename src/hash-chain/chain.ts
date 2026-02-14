/**
 * ri-event-log — Hash chain linking logic
 *
 * Manages the chain of previousHash references that link events together
 * within a single space.
 */

import type { Event } from '../types.js';
import type { EventLogDatabase } from '../storage/database.js';

/**
 * Get the hash of the last event for a given space.
 * Returns null if no events exist (genesis case).
 */
export async function getLastEventHash(
  db: EventLogDatabase,
  spaceId: string,
): Promise<string | null> {
  const lastEvent = await db.events
    .where('[spaceId+sequenceNumber]')
    .between([spaceId, Dexie.minKey], [spaceId, Dexie.maxKey])
    .last();

  if (lastEvent === undefined) {
    return null;
  }
  return lastEvent.hash;
}

/**
 * Get the next sequence number for a given space.
 * Returns 1 for the first event.
 */
export async function getNextSequenceNumber(
  db: EventLogDatabase,
  spaceId: string,
): Promise<number> {
  const lastEvent = await db.events
    .where('[spaceId+sequenceNumber]')
    .between([spaceId, Dexie.minKey], [spaceId, Dexie.maxKey])
    .last();

  if (lastEvent === undefined) {
    return 1;
  }
  return lastEvent.sequenceNumber + 1;
}

/**
 * Verify that a chain of events has valid hash links.
 * Returns the index of the first broken link, or -1 if the chain is valid.
 */
export function verifyChainLinks(
  events: readonly Event[],
): number {
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event === undefined) continue;
    if (i === 0) {
      // Genesis event must have null previousHash
      if (event.previousHash !== null) {
        return i;
      }
    } else {
      const previousEvent = events[i - 1];
      if (previousEvent === undefined) return i;
      if (event.previousHash !== previousEvent.hash) {
        return i;
      }
    }
  }
  return -1;
}

// Re-export Dexie for use in chain queries
import Dexie from 'dexie';
export { Dexie };
