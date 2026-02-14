/**
 * ri-event-log — Dexie database setup
 *
 * Configures IndexedDB schema with tables for events, snapshots, and metadata.
 */

import Dexie from 'dexie';
import type { Event, Snapshot } from '../types.js';

/** Metadata record stored in the metadata table. */
export interface MetadataRecord {
  readonly key: string;
  readonly value: unknown;
}

/** Mutable event record for Dexie storage (Dexie needs mutable objects). */
export interface StoredEvent {
  id: string;
  type: string;
  spaceId: string;
  timestamp: string;
  sequenceNumber: number;
  hash: string;
  previousHash: string | null;
  version: number;
  payload: Record<string, unknown>;
}

/** Mutable snapshot record for Dexie storage. */
export interface StoredSnapshot {
  id: string;
  spaceId: string;
  eventSequenceNumber: number;
  timestamp: string;
  state: unknown;
  hash: string;
}

/** Mutable metadata record for Dexie storage. */
export interface StoredMetadata {
  key: string;
  value: unknown;
}

/** The Dexie database class for the event log. */
export class EventLogDatabase extends Dexie {
  events!: Dexie.Table<StoredEvent, string>;
  snapshots!: Dexie.Table<StoredSnapshot, string>;
  metadata!: Dexie.Table<StoredMetadata, string>;

  constructor(databaseName: string = 'event-log') {
    super(databaseName);

    this.version(1).stores({
      events: 'id, spaceId, type, timestamp, sequenceNumber, [spaceId+sequenceNumber]',
      snapshots: 'id, spaceId, eventSequenceNumber, [spaceId+eventSequenceNumber]',
      metadata: 'key',
    });
  }
}

/** Convert a stored event to an immutable Event. */
export function toEvent(stored: StoredEvent): Event {
  return Object.freeze({
    id: stored.id,
    type: stored.type,
    spaceId: stored.spaceId,
    timestamp: stored.timestamp,
    sequenceNumber: stored.sequenceNumber,
    hash: stored.hash,
    previousHash: stored.previousHash,
    version: stored.version,
    payload: Object.freeze({ ...stored.payload }),
  }) as Event;
}

/** Convert a stored snapshot to an immutable Snapshot. */
export function toSnapshot(stored: StoredSnapshot): Snapshot {
  return Object.freeze({
    id: stored.id,
    spaceId: stored.spaceId,
    eventSequenceNumber: stored.eventSequenceNumber,
    timestamp: stored.timestamp,
    state: stored.state,
    hash: stored.hash,
  });
}

/** Create an EventLogDatabase instance. */
export function createDatabase(databaseName: string = 'event-log'): EventLogDatabase {
  return new EventLogDatabase(databaseName);
}
