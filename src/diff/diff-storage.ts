/**
 * ri-event-log — Diff-aware event storage
 *
 * Convenience functions for writing structured diff events.
 * These are optional helpers — the main `writeEvent` still works
 * for all event types with arbitrary payloads.
 */

import type { Event, Result } from '../types.js';
import { invalidEvent } from '../errors.js';
import type { EventLogDatabase } from '../storage/database.js';
import { writeEvent } from '../storage/event-writer.js';
import type {
  AstDiffOperation,
  ScopeMetadata,
  DiffPayload,
  SpaceCreatedPayload,
} from './types.js';
import { VALID_DIFF_OPERATIONS } from './types.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate an array of AST diff operations. */
function validateDiffOperations(
  astDiff: readonly AstDiffOperation[],
): Result<true> {
  if (astDiff.length === 0) {
    return {
      ok: false,
      error: invalidEvent('astDiff', 'Operations array must not be empty'),
    };
  }

  for (let i = 0; i < astDiff.length; i++) {
    const op = astDiff[i];
    if (op === undefined) continue;

    if (typeof op.path !== 'string' || op.path.length === 0) {
      return {
        ok: false,
        error: invalidEvent('astDiff', `Operation at index ${String(i)} has an invalid path`),
      };
    }

    if (!VALID_DIFF_OPERATIONS.has(op.operation)) {
      return {
        ok: false,
        error: invalidEvent(
          'astDiff',
          `Operation at index ${String(i)} has invalid type "${op.operation}". Must be add, modify, or remove`,
        ),
      };
    }

    // 'add' requires 'after'
    if (op.operation === 'add' && op.after === undefined) {
      return {
        ok: false,
        error: invalidEvent(
          'astDiff',
          `'add' operation at index ${String(i)} must include 'after' value`,
        ),
      };
    }

    // 'modify' requires both 'before' and 'after'
    if (op.operation === 'modify' && (op.before === undefined || op.after === undefined)) {
      return {
        ok: false,
        error: invalidEvent(
          'astDiff',
          `'modify' operation at index ${String(i)} must include both 'before' and 'after' values`,
        ),
      };
    }

    // 'remove' requires 'before'
    if (op.operation === 'remove' && op.before === undefined) {
      return {
        ok: false,
        error: invalidEvent(
          'astDiff',
          `'remove' operation at index ${String(i)} must include 'before' value`,
        ),
      };
    }
  }

  return { ok: true, value: true };
}

/** Validate scope metadata. */
function validateScopeMetadata(
  meta: ScopeMetadata,
): Result<true> {
  if (typeof meta.changedNodes !== 'number' || meta.changedNodes < 0) {
    return {
      ok: false,
      error: invalidEvent('scopeMetadata', 'changedNodes must be a non-negative number'),
    };
  }
  if (typeof meta.totalNodes !== 'number' || meta.totalNodes < 0) {
    return {
      ok: false,
      error: invalidEvent('scopeMetadata', 'totalNodes must be a non-negative number'),
    };
  }
  if (!Array.isArray(meta.affectedFunctions)) {
    return {
      ok: false,
      error: invalidEvent('scopeMetadata', 'affectedFunctions must be an array'),
    };
  }
  return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a `space_evolved` event with structured AST diff payload.
 *
 * Validates the diff structure before writing. This is a convenience
 * helper — the main `writeEvent` still accepts arbitrary payloads.
 *
 * @param db - The database instance.
 * @param spaceId - The space to write the diff event to.
 * @param timestamp - ISO 8601 timestamp (caller-provided).
 * @param astDiff - Array of AST diff operations.
 * @param scopeMetadata - Metadata about the scope of changes.
 * @param sourceHash - SHA-256 hash of the full source AFTER applying diffs.
 * @returns The written event or an error.
 */
export async function writeDiffEvent(
  db: EventLogDatabase,
  spaceId: string,
  timestamp: string,
  astDiff: readonly AstDiffOperation[],
  scopeMetadata: ScopeMetadata,
  sourceHash: string,
): Promise<Result<Event>> {
  // Validate diff operations
  const opsResult = validateDiffOperations(astDiff);
  if (!opsResult.ok) return opsResult;

  // Validate scope metadata
  const metaResult = validateScopeMetadata(scopeMetadata);
  if (!metaResult.ok) return metaResult;

  // Validate sourceHash
  if (typeof sourceHash !== 'string' || sourceHash.length === 0) {
    return {
      ok: false,
      error: invalidEvent('sourceHash', 'sourceHash must be a non-empty string'),
    };
  }

  const payload: DiffPayload = {
    astDiff,
    scopeMetadata,
    sourceHash,
  };

  return writeEvent(db, {
    type: 'space_evolved',
    spaceId,
    timestamp,
    version: 1,
    payload: payload as unknown as Readonly<Record<string, unknown>>,
  });
}

/**
 * Write a `space_created` event with structured genesis payload.
 *
 * @param db - The database instance.
 * @param spaceId - The space to create.
 * @param timestamp - ISO 8601 timestamp (caller-provided).
 * @param source - The full initial source code.
 * @param sourceHash - SHA-256 hash of the source.
 * @param compiledWasmHash - SHA-256 hash of the compiled Wasm.
 * @returns The written event or an error.
 */
export async function writeGenesisEvent(
  db: EventLogDatabase,
  spaceId: string,
  timestamp: string,
  source: string,
  sourceHash: string,
  compiledWasmHash: string,
): Promise<Result<Event>> {
  if (typeof source !== 'string' || source.length === 0) {
    return {
      ok: false,
      error: invalidEvent('source', 'source must be a non-empty string'),
    };
  }
  if (typeof sourceHash !== 'string' || sourceHash.length === 0) {
    return {
      ok: false,
      error: invalidEvent('sourceHash', 'sourceHash must be a non-empty string'),
    };
  }
  if (typeof compiledWasmHash !== 'string' || compiledWasmHash.length === 0) {
    return {
      ok: false,
      error: invalidEvent('compiledWasmHash', 'compiledWasmHash must be a non-empty string'),
    };
  }

  const payload: SpaceCreatedPayload = {
    source,
    sourceHash,
    compiledWasmHash,
  };

  return writeEvent(db, {
    type: 'space_created',
    spaceId,
    timestamp,
    version: 1,
    payload: payload as unknown as Readonly<Record<string, unknown>>,
  });
}
