/**
 * ri-event-log — Storage pressure level tests
 */

import { describe, it, expect } from 'vitest';
import { getStoragePressure } from './pressure.js';
import type { StorageReport } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(estimatedBytes: number): StorageReport {
  return {
    totalEvents: 100,
    totalSnapshots: 5,
    estimatedBytes,
    oldestEvent: '2026-01-01T00:00:00.000Z',
    newestEvent: '2026-02-14T00:00:00.000Z',
    spaces: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getStoragePressure', () => {
  const budget = 1000; // 1000 bytes for easy percentage math

  it('returns NORMAL for 0% usage', () => {
    const result = getStoragePressure(makeReport(0), budget);
    expect(result.level).toBe('NORMAL');
    expect(result.usageRatio).toBe(0);
  });

  it('returns NORMAL for usage below 50%', () => {
    const result = getStoragePressure(makeReport(499), budget);
    expect(result.level).toBe('NORMAL');
    expect(result.usageRatio).toBeCloseTo(0.499);
  });

  it('returns COMPACT at exactly 50%', () => {
    const result = getStoragePressure(makeReport(500), budget);
    expect(result.level).toBe('COMPACT');
    expect(result.usageRatio).toBeCloseTo(0.5);
  });

  it('returns COMPACT for usage between 50% and 70%', () => {
    const result = getStoragePressure(makeReport(600), budget);
    expect(result.level).toBe('COMPACT');
  });

  it('returns EXPORT_PROMPT at exactly 70%', () => {
    const result = getStoragePressure(makeReport(700), budget);
    expect(result.level).toBe('EXPORT_PROMPT');
    expect(result.usageRatio).toBeCloseTo(0.7);
  });

  it('returns EXPORT_PROMPT for usage between 70% and 80%', () => {
    const result = getStoragePressure(makeReport(750), budget);
    expect(result.level).toBe('EXPORT_PROMPT');
  });

  it('returns AGGRESSIVE at exactly 80%', () => {
    const result = getStoragePressure(makeReport(800), budget);
    expect(result.level).toBe('AGGRESSIVE');
    expect(result.usageRatio).toBeCloseTo(0.8);
  });

  it('returns AGGRESSIVE for usage between 80% and 90%', () => {
    const result = getStoragePressure(makeReport(850), budget);
    expect(result.level).toBe('AGGRESSIVE');
  });

  it('returns BLOCKED at exactly 90%', () => {
    const result = getStoragePressure(makeReport(900), budget);
    expect(result.level).toBe('BLOCKED');
    expect(result.usageRatio).toBeCloseTo(0.9);
  });

  it('returns BLOCKED for 100% usage', () => {
    const result = getStoragePressure(makeReport(1000), budget);
    expect(result.level).toBe('BLOCKED');
    expect(result.usageRatio).toBeCloseTo(1.0);
  });

  it('caps usageRatio at 1 when usage exceeds budget', () => {
    const result = getStoragePressure(makeReport(2000), budget);
    expect(result.level).toBe('BLOCKED');
    expect(result.usageRatio).toBe(1);
  });

  it('returns BLOCKED when availableBytes is zero', () => {
    const result = getStoragePressure(makeReport(100), 0);
    expect(result.level).toBe('BLOCKED');
    expect(result.usageRatio).toBe(1);
  });

  it('returns BLOCKED when availableBytes is negative', () => {
    const result = getStoragePressure(makeReport(100), -500);
    expect(result.level).toBe('BLOCKED');
    expect(result.usageRatio).toBe(1);
  });

  it('includes a recommendation string', () => {
    const result = getStoragePressure(makeReport(0), budget);
    expect(result.recommendation).toBeTruthy();
    expect(typeof result.recommendation).toBe('string');
  });

  it('different levels have different recommendations', () => {
    const normal = getStoragePressure(makeReport(100), budget);
    const compact = getStoragePressure(makeReport(500), budget);
    const exportPrompt = getStoragePressure(makeReport(700), budget);
    const aggressive = getStoragePressure(makeReport(800), budget);
    const blocked = getStoragePressure(makeReport(900), budget);

    const recs = new Set([
      normal.recommendation,
      compact.recommendation,
      exportPrompt.recommendation,
      aggressive.recommendation,
      blocked.recommendation,
    ]);
    // All five levels should have distinct recommendations
    expect(recs.size).toBe(5);
  });

  it('result is frozen (immutable)', () => {
    const result = getStoragePressure(makeReport(100), budget);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('is deterministic — same inputs produce same output', () => {
    const report = makeReport(600);
    const r1 = getStoragePressure(report, budget);
    const r2 = getStoragePressure(report, budget);
    expect(r1.level).toBe(r2.level);
    expect(r1.usageRatio).toBe(r2.usageRatio);
    expect(r1.recommendation).toBe(r2.recommendation);
  });
});
