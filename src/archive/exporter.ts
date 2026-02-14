/**
 * ri-event-log — Archive exporter
 *
 * Exports events from a space as a compressed `.rblogs` archive.
 * Verifies hash chain integrity before export.
 */

import type { Event, Result } from '../types.js';
import type { EventLogDatabase } from '../storage/database.js';
import { toEvent } from '../storage/database.js';
import { sha256 } from '../hash-chain/hash.js';
import { verifyChainLinks } from '../hash-chain/chain.js';
import {
  encodeHeader,
  compressData,
  HEADER_SIZE,
  FOOTER_SIZE,
} from './format.js';

/**
 * Serializable event record for the archive format.
 * Matches the public Event interface for round-trip fidelity.
 */
interface ArchiveEvent {
  readonly id: string;
  readonly type: string;
  readonly spaceId: string;
  readonly timestamp: string;
  readonly sequenceNumber: number;
  readonly hash: string;
  readonly previousHash: string | null;
  readonly version: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Convert an Event to its archive-serializable form.
 */
function toArchiveEvent(event: Event): ArchiveEvent {
  return {
    id: event.id,
    type: event.type,
    spaceId: event.spaceId,
    timestamp: event.timestamp,
    sequenceNumber: event.sequenceNumber,
    hash: event.hash,
    previousHash: event.previousHash,
    version: event.version,
    payload: event.payload,
  };
}

/**
 * Export events from a space as a compressed archive.
 *
 * @param db - The event log database.
 * @param spaceId - The space to export events from.
 * @param beforeDate - ISO 8601 timestamp. Only events with timestamp < beforeDate are exported.
 * @returns A Uint8Array containing the `.rblogs` archive.
 */
export async function exportArchive(
  db: EventLogDatabase,
  spaceId: string,
  beforeDate: string,
): Promise<Result<Uint8Array>> {
  try {
    // Validate beforeDate
    const d = new Date(beforeDate);
    if (isNaN(d.getTime())) {
      return {
        ok: false,
        error: {
          code: 'INVALID_QUERY' as const,
          field: 'beforeDate',
          reason: 'Invalid ISO 8601 timestamp',
        },
      };
    }

    // Query events for this space, ordered by sequence number
    const storedEvents = await db.events
      .where('[spaceId+sequenceNumber]')
      .between([spaceId, -Infinity], [spaceId, Infinity], true, true)
      .toArray();

    // Filter to events before the cutoff date
    const filteredStored = storedEvents.filter((e) => e.timestamp < beforeDate);

    // Convert to Event objects
    const events: readonly Event[] = filteredStored.map(toEvent);

    // Verify hash chain integrity of the events being exported
    if (events.length > 0) {
      const brokenIndex = verifyChainLinks(events);
      if (brokenIndex >= 0) {
        const brokenEvent = events[brokenIndex];
        const prevEvent = brokenIndex > 0 ? events[brokenIndex - 1] : undefined;
        return {
          ok: false,
          error: {
            code: 'INTEGRITY_VIOLATION' as const,
            eventId: brokenEvent?.id ?? 'unknown',
            expected: prevEvent?.hash ?? 'null',
            actual: brokenEvent?.previousHash ?? 'unknown',
          },
        };
      }
    }

    // Serialize events to JSON
    const archiveEvents = events.map(toArchiveEvent);
    const jsonBody = JSON.stringify(archiveEvents);
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(jsonBody);

    // Compute integrity hash of uncompressed body
    const bodyHash = await sha256(jsonBody);

    // Compress the JSON body
    const compressedBody = await compressData(jsonBytes);

    // Build archive: [header] [compressed body] [footer hash]
    const header = encodeHeader(events.length);
    const footerBytes = encoder.encode(bodyHash);

    const totalSize = HEADER_SIZE + compressedBody.length + FOOTER_SIZE;
    const archive = new Uint8Array(totalSize);
    archive.set(header, 0);
    archive.set(compressedBody, HEADER_SIZE);
    archive.set(footerBytes, HEADER_SIZE + compressedBody.length);

    return { ok: true, value: archive };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'DATABASE_ERROR' as const,
        operation: 'exportArchive',
        reason: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
