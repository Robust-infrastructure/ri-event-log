import { describe, it, expect } from 'vitest';
import {
  integrityViolation,
  storageFull,
  invalidQuery,
  invalidEvent,
  snapshotFailed,
  importFailed,
  databaseError,
} from '../errors.js';
import type {
  Event,
  EventType,
  QueryOptions,
  PaginatedResult,
  Snapshot,
  IntegrityReport,
  StorageReport,
  ImportReport,
  EventLogConfig,
  Result,
  EventLogError,
} from '../types.js';

describe('types', () => {
  it('exports all event types as a valid union', () => {
    const types: EventType[] = [
      'space_created',
      'space_evolved',
      'space_forked',
      'space_deleted',
      'state_changed',
      'action_invoked',
      'intent_submitted',
      'intent_queued',
      'intent_resolved',
      'user_feedback',
      'system_event',
    ];
    expect(types).toHaveLength(11);
  });

  it('Result type narrows correctly on ok: true', () => {
    const result: Result<number> = { ok: true, value: 42 };
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty('value', 42);
  });

  it('Result type narrows correctly on ok: false', () => {
    const error: EventLogError = invalidEvent('spaceId', 'must not be empty');
    const result: Result<number> = { ok: false, error };
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('error');
  });

  it('EventLogError discriminated union narrows by code', () => {
    const error: EventLogError = integrityViolation('evt-1', 'abc', 'def');
    switch (error.code) {
      case 'INTEGRITY_VIOLATION':
        expect(error.eventId).toBe('evt-1');
        expect(error.expected).toBe('abc');
        expect(error.actual).toBe('def');
        break;
      default:
        expect.unreachable('should have matched INTEGRITY_VIOLATION');
    }
  });
});

describe('error constructors', () => {
  it('creates INTEGRITY_VIOLATION error', () => {
    const err = integrityViolation('evt-1', 'expected-hash', 'actual-hash');
    expect(err.code).toBe('INTEGRITY_VIOLATION');
    if (err.code === 'INTEGRITY_VIOLATION') {
      expect(err.eventId).toBe('evt-1');
      expect(err.expected).toBe('expected-hash');
      expect(err.actual).toBe('actual-hash');
    }
  });

  it('creates STORAGE_FULL error', () => {
    const err = storageFull(500_000, 1_000_000);
    expect(err.code).toBe('STORAGE_FULL');
    if (err.code === 'STORAGE_FULL') {
      expect(err.usedBytes).toBe(500_000);
      expect(err.maxBytes).toBe(1_000_000);
    }
  });

  it('creates INVALID_QUERY error', () => {
    const err = invalidQuery('limit', 'must be positive');
    expect(err.code).toBe('INVALID_QUERY');
    if (err.code === 'INVALID_QUERY') {
      expect(err.field).toBe('limit');
      expect(err.reason).toBe('must be positive');
    }
  });

  it('creates INVALID_EVENT error', () => {
    const err = invalidEvent('spaceId', 'must not be empty');
    expect(err.code).toBe('INVALID_EVENT');
    if (err.code === 'INVALID_EVENT') {
      expect(err.field).toBe('spaceId');
    }
  });

  it('creates SNAPSHOT_FAILED error', () => {
    const err = snapshotFailed('space-1', 'no events found');
    expect(err.code).toBe('SNAPSHOT_FAILED');
    if (err.code === 'SNAPSHOT_FAILED') {
      expect(err.spaceId).toBe('space-1');
    }
  });

  it('creates IMPORT_FAILED error', () => {
    const err = importFailed('corrupted archive', 'evt-99');
    expect(err.code).toBe('IMPORT_FAILED');
    if (err.code === 'IMPORT_FAILED') {
      expect(err.reason).toBe('corrupted archive');
      expect(err.eventId).toBe('evt-99');
    }
  });

  it('creates IMPORT_FAILED error without eventId', () => {
    const err = importFailed('bad format');
    expect(err.code).toBe('IMPORT_FAILED');
    if (err.code === 'IMPORT_FAILED') {
      expect(err.eventId).toBeUndefined();
    }
  });

  it('creates DATABASE_ERROR error', () => {
    const err = databaseError('writeEvent', 'IndexedDB unavailable');
    expect(err.code).toBe('DATABASE_ERROR');
    if (err.code === 'DATABASE_ERROR') {
      expect(err.operation).toBe('writeEvent');
    }
  });
});

describe('type contracts', () => {
  it('Event interface has all required fields', () => {
    const event: Event = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      type: 'space_created',
      spaceId: 'space-1',
      timestamp: '2026-02-14T00:00:00.000Z',
      sequenceNumber: 1,
      hash: 'abc123',
      previousHash: null,
      version: 1,
      payload: { name: 'Test Space' },
    };
    expect(event.id).toBeDefined();
    expect(event.previousHash).toBeNull();
  });

  it('QueryOptions defaults are documented correctly', () => {
    const defaults: Required<QueryOptions> = {
      limit: 100,
      cursor: '',
      order: 'asc',
    };
    expect(defaults.limit).toBe(100);
    expect(defaults.order).toBe('asc');
  });

  it('PaginatedResult with no more pages has undefined nextCursor', () => {
    const result: PaginatedResult<string> = {
      items: ['a', 'b'],
      total: 2,
    };
    expect(result.nextCursor).toBeUndefined();
    expect(result.total).toBe(2);
  });

  it('Snapshot interface has integrity hash', () => {
    const snapshot: Snapshot = {
      id: 'snap-1',
      spaceId: 'space-1',
      eventSequenceNumber: 100,
      timestamp: '2026-02-14T00:00:00.000Z',
      state: { count: 42 },
      hash: 'snapshot-hash',
    };
    expect(snapshot.hash).toBe('snapshot-hash');
    expect(snapshot.eventSequenceNumber).toBe(100);
  });

  it('EventLogConfig has sensible defaults documented', () => {
    const config: EventLogConfig = {};
    expect(config.databaseName).toBeUndefined();
    expect(config.snapshotInterval).toBeUndefined();
  });

  it('IntegrityReport with broken link provides details', () => {
    const report: IntegrityReport = {
      valid: false,
      totalEvents: 50,
      checkedEvents: 25,
      firstBrokenLink: {
        eventId: 'evt-25',
        expected: 'hash-24',
        actual: 'tampered-hash',
      },
      duration: 150,
    };
    expect(report.valid).toBe(false);
    expect(report.firstBrokenLink?.eventId).toBe('evt-25');
  });

  it('StorageReport includes per-space breakdown', () => {
    const report: StorageReport = {
      totalEvents: 100,
      totalSnapshots: 5,
      estimatedBytes: 50_000,
      oldestEvent: '2026-01-01T00:00:00.000Z',
      newestEvent: '2026-02-14T00:00:00.000Z',
      spaces: [
        { spaceId: 'space-1', eventCount: 60, estimatedBytes: 30_000 },
        { spaceId: 'space-2', eventCount: 40, estimatedBytes: 20_000 },
      ],
    };
    expect(report.spaces).toHaveLength(2);
  });

  it('ImportReport tracks successes and failures', () => {
    const report: ImportReport = {
      importedEvents: 95,
      skippedDuplicates: 3,
      errors: [{ eventId: 'evt-99', reason: 'hash mismatch' }],
    };
    expect(report.importedEvents + report.skippedDuplicates + report.errors.length).toBe(99);
  });
});
