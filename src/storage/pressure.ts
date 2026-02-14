/**
 * ri-event-log — Storage Pressure Levels
 *
 * Pure function that maps storage usage to a pressure level.
 * The caller provides available bytes — this module never accesses
 * browser storage APIs directly.
 */

import type { StorageReport, StoragePressureReport, StoragePressureLevel } from '../types.js';

/**
 * Compute the storage pressure level based on current usage.
 *
 * This is a pure function — deterministic, no side effects, no I/O.
 * The caller is responsible for providing the `availableBytes` budget.
 *
 * Thresholds:
 * - NORMAL     (< 50%):  No action needed.
 * - COMPACT    (50–70%): Recommend compaction.
 * - EXPORT_PROMPT (70–80%): Recommend prompting user for export.
 * - AGGRESSIVE (80–90%): Recommend auto-compact + aggressive snapshots.
 * - BLOCKED    (> 90%):  Recommend blocking new space creation.
 *
 * @param report - Current storage usage report.
 * @param availableBytes - Total storage budget in bytes (provided by caller).
 * @returns A StoragePressureReport with level, ratio, and recommendation.
 */
export function getStoragePressure(
  report: StorageReport,
  availableBytes: number,
): StoragePressureReport {
  if (availableBytes <= 0) {
    return Object.freeze({
      level: 'BLOCKED' as StoragePressureLevel,
      usageRatio: 1,
      recommendation: 'Storage budget is zero or negative — all writes should be blocked.',
    });
  }

  const usageRatio = Math.min(report.estimatedBytes / availableBytes, 1);

  let level: StoragePressureLevel;
  let recommendation: string;

  if (usageRatio >= 0.9) {
    level = 'BLOCKED';
    recommendation = 'Storage usage exceeds 90%. Block new space creation and prompt for export or cleanup.';
  } else if (usageRatio >= 0.8) {
    level = 'AGGRESSIVE';
    recommendation = 'Storage usage exceeds 80%. Auto-compact old spaces and create aggressive snapshots.';
  } else if (usageRatio >= 0.7) {
    level = 'EXPORT_PROMPT';
    recommendation = 'Storage usage exceeds 70%. Prompt user to export old data to archives.';
  } else if (usageRatio >= 0.5) {
    level = 'COMPACT';
    recommendation = 'Storage usage exceeds 50%. Consider compacting infrequently accessed spaces.';
  } else {
    level = 'NORMAL';
    recommendation = 'Storage usage is within normal limits. No action needed.';
  }

  return Object.freeze({ level, usageRatio, recommendation });
}
