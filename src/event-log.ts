/**
 * ri-event-log — EventLog factory
 *
 * Creates an EventLog instance backed by IndexedDB (via Dexie).
 * Currently implements writeEvent (M3). Additional methods will be
 * added in subsequent milestones.
 */

import type {
  Event,
  EventType,
  EventLog,
  EventLogConfig,
  QueryOptions,
  PaginatedResult,
  Snapshot,
  IntegrityReport,
  StorageReport,
  ImportReport,
  Result,
} from './types.js';
import { createDatabase } from './storage/database.js';
import { writeEvent } from './storage/event-writer.js';
import type { WriteEventInput } from './storage/event-writer.js';
import { queryBySpace, queryByType, queryByTime } from './queries/query-engine.js';

/** Resolved configuration with defaults applied. */
interface ResolvedConfig {
  readonly databaseName: string;
  readonly schemaVersion: number;
  readonly maxEventsPerQuery: number;
  readonly snapshotInterval: number;
  readonly hashAlgorithm: 'SHA-256';
  readonly stateReducer: (state: unknown, event: Event) => unknown;
}

/** Default state reducer: last-write-wins (returns event payload). */
function defaultStateReducer(_state: unknown, event: Event): unknown {
  return event.payload;
}

/** Apply defaults to user-provided config. */
function resolveConfig(config?: EventLogConfig): ResolvedConfig {
  return {
    databaseName: config?.databaseName ?? 'event-log',
    schemaVersion: config?.schemaVersion ?? 1,
    maxEventsPerQuery: config?.maxEventsPerQuery ?? 1000,
    snapshotInterval: config?.snapshotInterval ?? 100,
    hashAlgorithm: config?.hashAlgorithm ?? 'SHA-256',
    stateReducer: config?.stateReducer ?? defaultStateReducer,
  };
}

/** Stub error for methods not yet implemented. */
function notImplemented(method: string): Promise<Result<never>> {
  return Promise.resolve({
    ok: false,
    error: {
      code: 'DATABASE_ERROR' as const,
      operation: method,
      reason: 'Not yet implemented',
    },
  });
}

/**
 * Create an EventLog instance.
 *
 * @param config - Optional configuration. All fields have sensible defaults.
 * @returns An EventLog backed by IndexedDB.
 */
export function createEventLog(config?: EventLogConfig): EventLog {
  const resolved = resolveConfig(config);
  const db = createDatabase(resolved.databaseName);

  return {
    async writeEvent(
      event: Omit<Event, 'id' | 'hash' | 'previousHash' | 'sequenceNumber'>,
    ): Promise<Result<Event>> {
      const input: WriteEventInput = {
        type: event.type,
        spaceId: event.spaceId,
        timestamp: event.timestamp,
        version: event.version,
        payload: event.payload,
      };
      return writeEvent(db, input);
    },

    // --- Query methods (M4) ---

    queryBySpace(
      spaceId: string,
      options?: QueryOptions,
    ): Promise<Result<PaginatedResult<Event>>> {
      return queryBySpace(db, spaceId, options);
    },

    queryByType(
      type: EventType,
      options?: QueryOptions,
    ): Promise<Result<PaginatedResult<Event>>> {
      return queryByType(db, type, options);
    },

    queryByTime(
      from: string,
      to: string,
      options?: QueryOptions,
    ): Promise<Result<PaginatedResult<Event>>> {
      return queryByTime(db, from, to, options);
    },

    // --- State reconstruction (M6) ---

    reconstructState(
      _spaceId: string,
      _atTimestamp?: string,
    ): Promise<Result<unknown>> {
      return notImplemented('reconstructState');
    },

    // --- Integrity (M5) ---

    verifyIntegrity(_spaceId?: string): Promise<Result<IntegrityReport>> {
      return notImplemented('verifyIntegrity');
    },

    // --- Snapshots (M6) ---

    createSnapshot(_spaceId: string): Promise<Result<Snapshot>> {
      return notImplemented('createSnapshot');
    },

    // --- Storage (M7) ---

    getStorageUsage(): Promise<Result<StorageReport>> {
      return notImplemented('getStorageUsage');
    },

    // --- Archive (M8) ---

    exportArchive(
      _spaceId: string,
      _beforeDate: string,
    ): Promise<Result<Uint8Array>> {
      return notImplemented('exportArchive');
    },

    importArchive(_archive: Uint8Array): Promise<Result<ImportReport>> {
      return notImplemented('importArchive');
    },
  };
}
