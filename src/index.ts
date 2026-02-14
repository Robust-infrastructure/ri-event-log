/**
 * ri-event-log
 *
 * Append-only immutable event log with hash chain integrity,
 * temporal queries, and tiered storage.
 *
 * @packageDocumentation
 */

// Types
export type {
  Event,
  EventType,
  QueryOptions,
  PaginatedResult,
  Snapshot,
  IntegrityReport,
  StorageReport,
  SpaceStorageInfo,
  ImportReport,
  ImportError,
  EventLogConfig,
  Result,
  EventLog,
} from './types.js';

// Errors
export type { EventLogError, EventLogErrorCode } from './errors.js';
export {
  integrityViolation,
  storageFull,
  invalidQuery,
  invalidEvent,
  snapshotFailed,
  importFailed,
  databaseError,
} from './errors.js';
