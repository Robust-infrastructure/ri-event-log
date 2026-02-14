/**
 * ri-event-log — Core type definitions
 *
 * All public types for the append-only immutable event log with
 * hash chain integrity, temporal queries, and tiered storage.
 */

// ---------------------------------------------------------------------------
// Event Types
// ---------------------------------------------------------------------------

/** Discriminated union of all supported event types. */
export type EventType =
  | 'space_created'
  | 'space_evolved'
  | 'space_forked'
  | 'space_deleted'
  | 'state_changed'
  | 'action_invoked'
  | 'intent_submitted'
  | 'intent_queued'
  | 'intent_resolved'
  | 'user_feedback'
  | 'system_event';

/** An immutable record in the event log. */
export interface Event {
  /** Unique identifier (UUID v4). */
  readonly id: string;
  /** The category of this event. */
  readonly type: EventType;
  /** The space this event belongs to. */
  readonly spaceId: string;
  /** ISO 8601 timestamp — injected by the caller, never generated internally. */
  readonly timestamp: string;
  /** Monotonically increasing per-space sequence number. */
  readonly sequenceNumber: number;
  /** SHA-256 hex hash of this event's content. */
  readonly hash: string;
  /** SHA-256 hex hash of the previous event in this space's chain, or null for genesis. */
  readonly previousHash: string | null;
  /** Schema version for forward compatibility. */
  readonly version: number;
  /** Arbitrary caller-defined data. */
  readonly payload: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Query Types
// ---------------------------------------------------------------------------

/** Options for paginated queries. */
export interface QueryOptions {
  /** Maximum number of items to return. Default 100. Max 1000. */
  readonly limit?: number;
  /** Opaque cursor for the next page. */
  readonly cursor?: string;
  /** Sort order. Default 'asc' (oldest first). */
  readonly order?: 'asc' | 'desc';
}

/** A paginated result set. */
export interface PaginatedResult<T> {
  /** The items in this page. */
  readonly items: readonly T[];
  /** Cursor for the next page. Undefined when no more pages exist. */
  readonly nextCursor?: string | undefined;
  /** Total number of matching items across all pages. */
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Snapshot Types
// ---------------------------------------------------------------------------

/** A compacted state snapshot at a specific point in the event chain. */
export interface Snapshot {
  /** Unique identifier. */
  readonly id: string;
  /** The space this snapshot belongs to. */
  readonly spaceId: string;
  /** The sequence number of the last event included in this snapshot. */
  readonly eventSequenceNumber: number;
  /** ISO 8601 timestamp when this snapshot was created. */
  readonly timestamp: string;
  /** The reconstructed state at this point. */
  readonly state: unknown;
  /** SHA-256 integrity hash of the snapshot content. */
  readonly hash: string;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Result of a hash chain integrity verification. */
export interface IntegrityReport {
  /** Whether the entire chain is valid. */
  readonly valid: boolean;
  /** Total number of events in scope. */
  readonly totalEvents: number;
  /** Number of events actually checked. */
  readonly checkedEvents: number;
  /** Details of the first broken link, if any. */
  readonly firstBrokenLink?: {
    readonly eventId: string;
    readonly expected: string;
    readonly actual: string;
  } | undefined;
  /** Duration of the verification in milliseconds. */
  readonly duration: number;
}

/** Storage utilization report. */
export interface StorageReport {
  /** Total number of events in the database. */
  readonly totalEvents: number;
  /** Total number of snapshots in the database. */
  readonly totalSnapshots: number;
  /** Estimated storage consumption in bytes. */
  readonly estimatedBytes: number;
  /** ISO 8601 timestamp of the oldest event. */
  readonly oldestEvent?: string | undefined;
  /** ISO 8601 timestamp of the newest event. */
  readonly newestEvent?: string | undefined;
  /** Per-space breakdown. */
  readonly spaces: readonly SpaceStorageInfo[];
}

/** Storage info for a single space. */
export interface SpaceStorageInfo {
  readonly spaceId: string;
  readonly eventCount: number;
  readonly estimatedBytes: number;
}

// ---------------------------------------------------------------------------
// Storage Pressure
// ---------------------------------------------------------------------------

/** Storage pressure level based on usage percentage. */
export type StoragePressureLevel =
  | 'NORMAL'
  | 'COMPACT'
  | 'EXPORT_PROMPT'
  | 'AGGRESSIVE'
  | 'BLOCKED';

/** Storage pressure assessment returned by getStoragePressure. */
export interface StoragePressureReport {
  /** The computed pressure level. */
  readonly level: StoragePressureLevel;
  /** Usage as a fraction (0–1). */
  readonly usageRatio: number;
  /** Human-readable recommendation for the caller. */
  readonly recommendation: string;
}

/** Result of a compaction operation. */
export interface CompactionReport {
  /** The space that was compacted. */
  readonly spaceId: string;
  /** Number of events covered by the snapshot. */
  readonly eventsCompacted: number;
  /** Estimated bytes saved by future snapshot-based reconstruction. */
  readonly estimatedBytesSaved: number;
  /** ID of the snapshot created during compaction. */
  readonly snapshotId: string;
}

/** Result of an archive import operation. */
export interface ImportReport {
  /** Number of events successfully imported. */
  readonly importedEvents: number;
  /** Number of duplicate events skipped. */
  readonly skippedDuplicates: number;
  /** Errors encountered during import. */
  readonly errors: readonly ImportError[];
}

/** A single error encountered during import. */
export interface ImportError {
  readonly eventId: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for an EventLog instance. */
export interface EventLogConfig {
  /** IndexedDB database name. Default: "event-log". */
  readonly databaseName?: string | undefined;
  /** Schema version for database migrations. */
  readonly schemaVersion?: number | undefined;
  /** Maximum events per query. Default: 1000. */
  readonly maxEventsPerQuery?: number | undefined;
  /** Create a snapshot every N events per space. Default: 100. */
  readonly snapshotInterval?: number | undefined;
  /** Hash algorithm. Currently only 'SHA-256'. */
  readonly hashAlgorithm?: 'SHA-256' | undefined;
  /**
   * Caller-provided state reducer for reconstructing state from events.
   * Default: last-write-wins (returns event payload).
   */
  readonly stateReducer?: ((state: unknown, event: Event) => unknown) | undefined;
}

// ---------------------------------------------------------------------------
// Result Type
// ---------------------------------------------------------------------------

/** A discriminated union for fallible operations. */
export type Result<T, E = import('./errors.js').EventLogError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// ---------------------------------------------------------------------------
// EventLog Interface
// ---------------------------------------------------------------------------

/** The public API of the event log. */
export interface EventLog {
  /** Append a new event to the log. */
  writeEvent(
    event: Omit<Event, 'id' | 'hash' | 'previousHash' | 'sequenceNumber'>,
  ): Promise<Result<Event>>;

  /** Query events by space ID with pagination. */
  queryBySpace(
    spaceId: string,
    options?: QueryOptions,
  ): Promise<Result<PaginatedResult<Event>>>;

  /** Query events by type with pagination. */
  queryByType(
    type: EventType,
    options?: QueryOptions,
  ): Promise<Result<PaginatedResult<Event>>>;

  /** Query events within a time range with pagination. */
  queryByTime(
    from: string,
    to: string,
    options?: QueryOptions,
  ): Promise<Result<PaginatedResult<Event>>>;

  /** Reconstruct the state of a space at a given timestamp. */
  reconstructState(
    spaceId: string,
    atTimestamp?: string,
  ): Promise<Result<unknown>>;

  /** Verify hash chain integrity for a space or the entire database. */
  verifyIntegrity(spaceId?: string): Promise<Result<IntegrityReport>>;

  /** Create a snapshot of the current state for a space. */
  createSnapshot(spaceId: string): Promise<Result<Snapshot>>;

  /** Get storage usage statistics. */
  getStorageUsage(): Promise<Result<StorageReport>>;

  /** Export events to a compressed archive. */
  exportArchive(
    spaceId: string,
    beforeDate: string,
  ): Promise<Result<Uint8Array>>;

  /** Import events from a compressed archive. */
  importArchive(archive: Uint8Array): Promise<Result<ImportReport>>;
}

// ---------------------------------------------------------------------------
// Error Types (re-exported from errors.ts for convenience)
// ---------------------------------------------------------------------------

export type { EventLogError, EventLogErrorCode } from './errors.js';
