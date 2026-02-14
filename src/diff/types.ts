/**
 * ri-event-log — AST diff types
 *
 * Type definitions for structured AST diff payloads used by
 * `space_created`, `space_evolved`, and `space_forked` events.
 */

// ---------------------------------------------------------------------------
// Diff Operations
// ---------------------------------------------------------------------------

/** Valid operations that can appear in an AST diff. */
export type DiffOperationType = 'add' | 'modify' | 'remove';

/** All valid diff operation types as a set for runtime validation. */
export const VALID_DIFF_OPERATIONS: ReadonlySet<DiffOperationType> = new Set([
  'add',
  'modify',
  'remove',
]);

/** A single AST diff operation targeting a node path. */
export interface AstDiffOperation {
  /** Dot-separated path to the target AST node (e.g. "functions.main.body"). */
  readonly path: string;
  /** The kind of change. */
  readonly operation: DiffOperationType;
  /** The value before the change. Required for 'modify' and 'remove'. */
  readonly before?: unknown;
  /** The value after the change. Required for 'add' and 'modify'. */
  readonly after?: unknown;
}

// ---------------------------------------------------------------------------
// Structured Payloads
// ---------------------------------------------------------------------------

/** Metadata about the scope of a diff operation. */
export interface ScopeMetadata {
  /** Number of AST nodes changed by this diff. */
  readonly changedNodes: number;
  /** Total number of AST nodes in the source. */
  readonly totalNodes: number;
  /** Names of functions affected by this change. */
  readonly affectedFunctions: readonly string[];
}

/** Payload for `space_evolved` events containing AST diffs. */
export interface DiffPayload {
  /** The array of AST diff operations. */
  readonly astDiff: readonly AstDiffOperation[];
  /** Metadata about the scope of changes. */
  readonly scopeMetadata: ScopeMetadata;
  /** SHA-256 hash of the full source AFTER applying the diff. */
  readonly sourceHash: string;
}

/** Payload for `space_created` events with initial source. */
export interface SpaceCreatedPayload {
  /** The full initial source code or state. */
  readonly source: string;
  /** SHA-256 hash of the source. */
  readonly sourceHash: string;
  /** SHA-256 hash of the compiled Wasm binary. */
  readonly compiledWasmHash: string;
}

/** Payload for `space_forked` events. */
export interface SpaceForkedPayload {
  /** The space ID that was forked from. */
  readonly sourceSpaceId: string;
  /** ISO 8601 timestamp when the fork was made. */
  readonly forkTimestamp: string;
}

// ---------------------------------------------------------------------------
// Reconstruction Result
// ---------------------------------------------------------------------------

/** The result of reconstructing source from diffs. */
export interface ReconstructedSource {
  /** The reconstructed source string. */
  readonly source: string;
  /** SHA-256 hash of the reconstructed source. */
  readonly sourceHash: string;
  /** Number of diff events applied. */
  readonly diffsApplied: number;
  /** The sequence number of the last event applied. */
  readonly lastSequenceNumber: number;
}
