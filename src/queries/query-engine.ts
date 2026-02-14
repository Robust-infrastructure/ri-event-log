/**
 * ri-event-log — Query Engine
 *
 * Provides queryBySpace, queryByType, and queryByTime with
 * cursor-based pagination over the event store.
 */

import type { Event, EventType, QueryOptions, PaginatedResult, Result } from '../types.js';
import type { EventLogDatabase } from '../storage/database.js';
import { toEvent } from '../storage/database.js';
import { invalidQuery } from '../errors.js';

// ---------------------------------------------------------------------------
// Cursor encoding / decoding
// ---------------------------------------------------------------------------

/** Internal cursor structure — opaque to callers. */
interface CursorPayload {
  readonly seq: number;
  readonly id: string;
}

/** Encode a cursor from a sequence number and ID. */
function encodeCursor(seq: number, id: string): string {
  const json = JSON.stringify({ seq, id });
  return btoa(json);
}

/** Decode an opaque cursor string. Returns null if invalid. */
function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = atob(cursor);
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'seq' in parsed &&
      'id' in parsed &&
      typeof (parsed as CursorPayload).seq === 'number' &&
      typeof (parsed as CursorPayload).id === 'string'
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Options normalization
// ---------------------------------------------------------------------------

/** Max items per query page. */
const MAX_LIMIT = 1000;
/** Default items per query page. */
const DEFAULT_LIMIT = 100;

/** Resolve query options to concrete values. */
function resolveOptions(options?: QueryOptions): {
  readonly limit: number;
  readonly cursor: CursorPayload | null;
  readonly order: 'asc' | 'desc';
  readonly rawCursor: string | undefined;
} {
  const limit = Math.min(Math.max(1, options?.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const order = options?.order ?? 'asc';
  const rawCursor = options?.cursor;
  const cursor = rawCursor !== undefined ? decodeCursor(rawCursor) : null;
  return { limit, cursor, order, rawCursor };
}

// ---------------------------------------------------------------------------
// ISO 8601 validation
// ---------------------------------------------------------------------------

/** Check if a string is a valid ISO 8601 date. */
function isValidIsoDate(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime());
}

// ---------------------------------------------------------------------------
// Query implementations
// ---------------------------------------------------------------------------

/**
 * Query events by space ID with cursor-based pagination.
 */
export async function queryBySpace(
  db: EventLogDatabase,
  spaceId: string,
  options?: QueryOptions,
): Promise<Result<PaginatedResult<Event>>> {
  try {
    const { limit, cursor, order, rawCursor } = resolveOptions(options);

    // Validate cursor if provided
    if (rawCursor !== undefined && cursor === null) {
      return { ok: false, error: invalidQuery('cursor', 'Invalid cursor format') };
    }

    // Get total count for this space
    const total = await db.events.where('spaceId').equals(spaceId).count();

    // Build query using compound index [spaceId+sequenceNumber]
    let collection = db.events
      .where('[spaceId+sequenceNumber]')
      .between(
        [spaceId, cursor !== null ? (order === 'asc' ? cursor.seq + 1 : -Infinity) : -Infinity],
        [spaceId, cursor !== null ? (order === 'desc' ? cursor.seq - 1 : Infinity) : Infinity],
        true,
        true,
      );

    if (order === 'desc') {
      collection = collection.reverse();
    }

    // Fetch one extra to determine if there's a next page
    const rows = await collection.limit(limit + 1).toArray();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(toEvent);

    const lastItem = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && lastItem !== undefined
      ? encodeCursor(lastItem.sequenceNumber, lastItem.id)
      : undefined;

    return { ok: true, value: { items, nextCursor, total } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'DATABASE_ERROR' as const,
        operation: 'queryBySpace',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Query events by event type with cursor-based pagination.
 */
export async function queryByType(
  db: EventLogDatabase,
  type: EventType,
  options?: QueryOptions,
): Promise<Result<PaginatedResult<Event>>> {
  try {
    const { limit, cursor, order, rawCursor } = resolveOptions(options);

    if (rawCursor !== undefined && cursor === null) {
      return { ok: false, error: invalidQuery('cursor', 'Invalid cursor format') };
    }

    // Get total count for this type
    const total = await db.events.where('type').equals(type).count();

    // Filter by type, then apply cursor on sequenceNumber
    const collection = db.events.where('type').equals(type);

    // We need to sort and filter by sequenceNumber manually since
    // we don't have a compound index [type+sequenceNumber]
    let allMatching = await collection.toArray();

    // Apply cursor filter
    if (cursor !== null) {
      if (order === 'asc') {
        allMatching = allMatching.filter(
          (e) => e.sequenceNumber > cursor.seq ||
                 (e.sequenceNumber === cursor.seq && e.id > cursor.id),
        );
      } else {
        allMatching = allMatching.filter(
          (e) => e.sequenceNumber < cursor.seq ||
                 (e.sequenceNumber === cursor.seq && e.id < cursor.id),
        );
      }
    }

    // Sort
    allMatching.sort((a, b) => {
      const diff = a.sequenceNumber - b.sequenceNumber;
      if (diff !== 0) return order === 'asc' ? diff : -diff;
      return order === 'asc' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
    });

    // Paginate
    const hasMore = allMatching.length > limit;
    const pageRows = hasMore ? allMatching.slice(0, limit) : allMatching;
    const items = pageRows.map(toEvent);

    const lastItem = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && lastItem !== undefined
      ? encodeCursor(lastItem.sequenceNumber, lastItem.id)
      : undefined;

    return { ok: true, value: { items, nextCursor, total } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'DATABASE_ERROR' as const,
        operation: 'queryByType',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Query events within a time range with cursor-based pagination.
 *
 * Time range is inclusive on `from` and exclusive on `to`.
 */
export async function queryByTime(
  db: EventLogDatabase,
  from: string,
  to: string,
  options?: QueryOptions,
): Promise<Result<PaginatedResult<Event>>> {
  try {
    // Validate ISO 8601 timestamps
    if (!isValidIsoDate(from)) {
      return { ok: false, error: invalidQuery('from', 'Invalid ISO 8601 timestamp') };
    }
    if (!isValidIsoDate(to)) {
      return { ok: false, error: invalidQuery('to', 'Invalid ISO 8601 timestamp') };
    }

    const { limit, cursor, order, rawCursor } = resolveOptions(options);

    if (rawCursor !== undefined && cursor === null) {
      return { ok: false, error: invalidQuery('cursor', 'Invalid cursor format') };
    }

    // Total count for the time range (inclusive from, exclusive to)
    const total = await db.events
      .where('timestamp')
      .between(from, to, true, false)
      .count();

    // Fetch all matching events in the time range
    let allMatching = await db.events
      .where('timestamp')
      .between(from, to, true, false)
      .toArray();

    // Apply cursor filter
    if (cursor !== null) {
      if (order === 'asc') {
        allMatching = allMatching.filter(
          (e) => e.sequenceNumber > cursor.seq ||
                 (e.sequenceNumber === cursor.seq && e.id > cursor.id),
        );
      } else {
        allMatching = allMatching.filter(
          (e) => e.sequenceNumber < cursor.seq ||
                 (e.sequenceNumber === cursor.seq && e.id < cursor.id),
        );
      }
    }

    // Sort by sequenceNumber (tiebreak by id)
    allMatching.sort((a, b) => {
      const diff = a.sequenceNumber - b.sequenceNumber;
      if (diff !== 0) return order === 'asc' ? diff : -diff;
      return order === 'asc' ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
    });

    // Paginate
    const hasMore = allMatching.length > limit;
    const pageRows = hasMore ? allMatching.slice(0, limit) : allMatching;
    const items = pageRows.map(toEvent);

    const lastItem = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && lastItem !== undefined
      ? encodeCursor(lastItem.sequenceNumber, lastItem.id)
      : undefined;

    return { ok: true, value: { items, nextCursor, total } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'DATABASE_ERROR' as const,
        operation: 'queryByTime',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
