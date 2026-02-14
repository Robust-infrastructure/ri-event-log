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
  StoragePressureLevel,
  StoragePressureReport,
  CompactionReport,
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

// Factory
export { createEventLog } from './event-log.js';

// Storage pressure (pure function — no DB needed)
export { getStoragePressure } from './storage/pressure.js';

// Writer input type
export type { WriteEventInput } from './storage/event-writer.js';

// Diff types (M9)
export type {
  AstDiffOperation,
  DiffOperationType,
  ScopeMetadata,
  DiffPayload,
  SpaceCreatedPayload,
  SpaceForkedPayload,
  ReconstructedSource,
} from './diff/types.js';

// Diff helpers (optional — main writeEvent still works for all event types)
export { writeDiffEvent, writeGenesisEvent } from './diff/diff-storage.js';
export { reconstructSource } from './diff/diff-reconstructor.js';
