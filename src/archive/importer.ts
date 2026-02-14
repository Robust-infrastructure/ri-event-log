/**
 * ri-event-log — Archive importer
 *
 * Imports events from a `.rblogs` archive into the database.
 * Verifies archive integrity, deduplicates, and validates hash chains.
 */

import type { Event, EventType, ImportReport, ImportError, Result } from '../types.js';
import type { EventLogDatabase, StoredEvent } from '../storage/database.js';
import { sha256 } from '../hash-chain/hash.js';
import { verifyChainLinks } from '../hash-chain/chain.js';
import {
  parseHeader,
  decompressData,
  HEADER_SIZE,
  FOOTER_SIZE,
} from './format.js';

/** Valid event types for runtime validation. */
const VALID_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
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
]);

/**
 * Minimal shape check for a parsed event from JSON.
 */
function isValidEventShape(obj: unknown): obj is {
  id: string;
  type: string;
  spaceId: string;
  timestamp: string;
  sequenceNumber: number;
  hash: string;
  previousHash: string | null;
  version: number;
  payload: Record<string, unknown>;
} {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['type'] === 'string' &&
    VALID_EVENT_TYPES.has(o['type']) &&
    typeof o['spaceId'] === 'string' &&
    typeof o['timestamp'] === 'string' &&
    typeof o['sequenceNumber'] === 'number' &&
    typeof o['hash'] === 'string' &&
    (o['previousHash'] === null || typeof o['previousHash'] === 'string') &&
    typeof o['version'] === 'number' &&
    typeof o['payload'] === 'object' &&
    o['payload'] !== null
  );
}

/**
 * Convert a validated parsed object to a frozen Event.
 */
function toEvent(obj: {
  id: string;
  type: string;
  spaceId: string;
  timestamp: string;
  sequenceNumber: number;
  hash: string;
  previousHash: string | null;
  version: number;
  payload: Record<string, unknown>;
}): Event {
  return Object.freeze({
    id: obj.id,
    type: obj.type as EventType,
    spaceId: obj.spaceId,
    timestamp: obj.timestamp,
    sequenceNumber: obj.sequenceNumber,
    hash: obj.hash,
    previousHash: obj.previousHash,
    version: obj.version,
    payload: Object.freeze({ ...obj.payload }),
  });
}

/**
 * Convert an Event to a StoredEvent for database insertion.
 */
function toStoredEvent(event: Event): StoredEvent {
  return {
    id: event.id,
    type: event.type,
    spaceId: event.spaceId,
    timestamp: event.timestamp,
    sequenceNumber: event.sequenceNumber,
    hash: event.hash,
    previousHash: event.previousHash,
    version: event.version,
    payload: { ...event.payload },
  };
}

/**
 * Import events from a `.rblogs` archive.
 *
 * @param db - The event log database.
 * @param archive - The archive bytes.
 * @returns An ImportReport with counts and any errors.
 */
export async function importArchive(
  db: EventLogDatabase,
  archive: Uint8Array,
): Promise<Result<ImportReport>> {
  try {
    // Minimum size check: header + footer
    if (archive.length < HEADER_SIZE + FOOTER_SIZE) {
      return {
        ok: false,
        error: {
          code: 'IMPORT_FAILED' as const,
          reason: 'Archive is too small to be valid',
        },
      };
    }

    // Parse and validate header
    const headerResult = parseHeader(archive);
    if (typeof headerResult === 'string') {
      return {
        ok: false,
        error: {
          code: 'IMPORT_FAILED' as const,
          reason: headerResult,
        },
      };
    }

    const { eventCount } = headerResult;

    // Extract compressed body and footer
    const compressedBody = archive.slice(HEADER_SIZE, archive.length - FOOTER_SIZE);
    const footerBytes = archive.slice(archive.length - FOOTER_SIZE);
    const decoder = new TextDecoder();
    const expectedHash = decoder.decode(footerBytes);

    // Decompress body
    let jsonBytes: Uint8Array;
    try {
      jsonBytes = await decompressData(compressedBody);
    } catch {
      return {
        ok: false,
        error: {
          code: 'IMPORT_FAILED' as const,
          reason: 'Failed to decompress archive body',
        },
      };
    }

    // Verify integrity hash
    const jsonBody = decoder.decode(jsonBytes);
    const actualHash = await sha256(jsonBody);
    if (actualHash !== expectedHash) {
      return {
        ok: false,
        error: {
          code: 'IMPORT_FAILED' as const,
          reason: `Archive integrity check failed: expected hash ${expectedHash}, got ${actualHash}`,
        },
      };
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonBody);
    } catch {
      return {
        ok: false,
        error: {
          code: 'IMPORT_FAILED' as const,
          reason: 'Failed to parse archive JSON body',
        },
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        error: {
          code: 'IMPORT_FAILED' as const,
          reason: 'Archive body is not a JSON array',
        },
      };
    }

    // Validate event count matches header
    if (parsed.length !== eventCount) {
      return {
        ok: false,
        error: {
          code: 'IMPORT_FAILED' as const,
          reason: `Header declares ${String(eventCount)} events but body contains ${String(parsed.length)}`,
        },
      };
    }

    // Validate each event shape
    const events: Event[] = [];
    const errors: ImportError[] = [];

    for (const raw of parsed) {
      if (!isValidEventShape(raw)) {
        const id = typeof raw === 'object' && raw !== null && 'id' in raw
          ? String((raw as Record<string, unknown>)['id'])
          : 'unknown';
        errors.push({ eventId: id, reason: 'Invalid event shape' });
        continue;
      }
      events.push(toEvent(raw));
    }

    // Group events by space and verify hash chain integrity
    const bySpace = new Map<string, Event[]>();
    for (const event of events) {
      const spaceEvents = bySpace.get(event.spaceId);
      if (spaceEvents !== undefined) {
        spaceEvents.push(event);
      } else {
        bySpace.set(event.spaceId, [event]);
      }
    }

    for (const [spaceId, spaceEvents] of bySpace) {
      // Sort by sequence number
      spaceEvents.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

      const brokenIndex = verifyChainLinks(spaceEvents);
      if (brokenIndex >= 0) {
        const brokenEvent = spaceEvents[brokenIndex];
        return {
          ok: false,
          error: {
            code: 'IMPORT_FAILED' as const,
            reason: `Hash chain integrity failed for space "${spaceId}": event ${brokenEvent?.id ?? 'unknown'}`,
            eventId: brokenEvent?.id,
          },
        };
      }
    }

    // Deduplicate: skip events that already exist in the database
    let importedEvents = 0;
    let skippedDuplicates = 0;

    for (const event of events) {
      const existing = await db.events.get(event.id);
      if (existing !== undefined) {
        skippedDuplicates++;
        continue;
      }

      // Write the event to the database
      const storedEvent = toStoredEvent(event);
      await db.events.add(storedEvent);
      importedEvents++;
    }

    const report: ImportReport = Object.freeze({
      importedEvents,
      skippedDuplicates,
      errors,
    });

    return { ok: true, value: report };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'IMPORT_FAILED' as const,
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
