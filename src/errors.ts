/**
 * ri-event-log — Error types
 *
 * Discriminated union of all error types the library can produce.
 */

/** All possible error codes produced by the event log. */
export type EventLogErrorCode =
  | 'INTEGRITY_VIOLATION'
  | 'STORAGE_FULL'
  | 'INVALID_QUERY'
  | 'INVALID_EVENT'
  | 'SNAPSHOT_FAILED'
  | 'IMPORT_FAILED'
  | 'DATABASE_ERROR';

/** Discriminated union of all event log errors. */
export type EventLogError =
  | {
      readonly code: 'INTEGRITY_VIOLATION';
      readonly eventId: string;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly code: 'STORAGE_FULL';
      readonly usedBytes: number;
      readonly maxBytes: number;
    }
  | {
      readonly code: 'INVALID_QUERY';
      readonly field: string;
      readonly reason: string;
    }
  | {
      readonly code: 'INVALID_EVENT';
      readonly field: string;
      readonly reason: string;
    }
  | {
      readonly code: 'SNAPSHOT_FAILED';
      readonly spaceId: string;
      readonly reason: string;
    }
  | {
      readonly code: 'IMPORT_FAILED';
      readonly reason: string;
      readonly eventId?: string | undefined;
    }
  | {
      readonly code: 'DATABASE_ERROR';
      readonly operation: string;
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Error Constructors
// ---------------------------------------------------------------------------

/** Create an INTEGRITY_VIOLATION error. */
export function integrityViolation(
  eventId: string,
  expected: string,
  actual: string,
): EventLogError {
  return { code: 'INTEGRITY_VIOLATION', eventId, expected, actual } as const;
}

/** Create a STORAGE_FULL error. */
export function storageFull(usedBytes: number, maxBytes: number): EventLogError {
  return { code: 'STORAGE_FULL', usedBytes, maxBytes } as const;
}

/** Create an INVALID_QUERY error. */
export function invalidQuery(field: string, reason: string): EventLogError {
  return { code: 'INVALID_QUERY', field, reason } as const;
}

/** Create an INVALID_EVENT error. */
export function invalidEvent(field: string, reason: string): EventLogError {
  return { code: 'INVALID_EVENT', field, reason } as const;
}

/** Create a SNAPSHOT_FAILED error. */
export function snapshotFailed(spaceId: string, reason: string): EventLogError {
  return { code: 'SNAPSHOT_FAILED', spaceId, reason } as const;
}

/** Create an IMPORT_FAILED error. */
export function importFailed(reason: string, eventId?: string): EventLogError {
  return { code: 'IMPORT_FAILED', reason, eventId } as const;
}

/** Create a DATABASE_ERROR error. */
export function databaseError(operation: string, reason: string): EventLogError {
  return { code: 'DATABASE_ERROR', operation, reason } as const;
}
