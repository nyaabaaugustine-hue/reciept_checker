/**
 * intelligence.ts
 * Core analysis engine powering features:
 * #1  Duplicate invoice detector
 * #4  Vendor consistency check
 * #5  Tax rate validator
 * #10 Date anomaly check
 * #39 Smart invoice naming
 * #40 Recurring invoice detection
 * #43 Invoice health score
 */

import type { InvoiceProcessingResult, RecurringPattern, ValidationError } from './types';

// ─── #1 Duplicate Invoice Detector ────────────────────────────────────────────
export function detectDuplicate(
  candidate: InvoiceProcessingResult,
  history: InvoiceProcessingResult[]
): { isDuplicate: boolean; duplicateOfId?: string; reason?: string } {
  for (const existing of history) {
    if (existing.id === candidate.id) continue;

    const sameInvoiceNumber =
      candidate.validatedData.invoice_number &&
      existing.validatedData.invoice_number &&
      candidate.validatedData.invoice_number.trim().toLowerCase() ===
        existing.validatedData.invoice_number.trim().toLowerCase();

    const sameVendor =
      candidate.validatedData.customer_name &&
      existing.validatedData.customer_name &&
      normaliseVendor(candidate.validatedData.customer_name) ===
        normaliseVendor(existing.validatedData.customer_name);

    const sameTotal =
      candidate.validatedData.total !== undefined &&
      existing.validatedData.total !== undefined &&
      Math.abs(candidate.validatedData.total - existing.validatedData.total) < 0.01;

    const sameDate =
      candidate.validatedData.date &&
      existing.validatedData.date &&
      candidate.validatedData.date === existing.validatedData.date;

    if (sameInvoiceNumber && sameVendor) {
      return { isDuplicate: true, duplicateOfId: existing.id, reason: `Same invoice number (${candidate.validatedData.invoice_number}) from same vendor` };
    }
    if (sameVendor && sameTotal && sameDate) {
      return { isDuplicate: true, duplicateOfId: existing.id, reason: `Same vendor, same total, same date — possible duplicate payment` };
    }
  }
  return { isDuplicate: false };
}

// ─── #4 Vendor Consistency Check ─────────────────────────────────────────────
export function checkVendorConsistency(
  candidate: InvoiceProcessingResult,
  history: InvoiceProcessingResult[]
): string[] {
  const warnings: string[] = [];
  const vendorName = candidate.validatedData.customer_name;
  if (!vendorName) return warnings;

  const key = normaliseVendor(vendorName);

  // Find invoices with similar but not identical vendor names
  const similar = history.filter(h => {
    if (h.id === candidate.id) return false;
    const hKey = normaliseVendor(h.validatedData.customer_name || '');
    return hKey !== key && levenshtein(hKey, key) <= 3 && hKey.length > 3;
  });

  if (similar.length > 0) {
    const names = [...new Set(similar.map(h => h.validatedData.customer_name))].slice(0, 3).join(', ');
    warnings.push(`Vendor name "${vendorName}" is similar to previously seen: ${names}. Possible duplicate billing under a different name.`);
  }

  return warnings;
}

// ─── #5 Tax Rate Validator ────────────────────────────────────────────────────
export function validateTaxRate(
  subtotal: number | undefined,
  tax: number | undefined,
  total: number | undefined
): { warning: string | null; impliedRate: number | null } {
  if (!subtotal || tax === undefined || !total) return { warning: null, impliedRate: null };
  if (subtotal === 0) return { warning: null, impliedRate: null };

  const impliedRate = Math.round((tax / subtotal) * 100 * 10) / 10;

  // Common rates: Ghana VAT 15%, UK 20%, EU 19-25%, US 0-15%
  const EXPECTED_MIN = 0;
  const EXPECTED_MAX = 30;

  if (impliedRate < EXPECTED_MIN || impliedRate > EXPECTED_MAX) {
    return {
      warning: `Unusual tax rate detected: ${impliedRate}% (expected 0–30%). This may indicate a calculation error or non-standard levy.`,
      impliedRate,
    };
  }

  return { warning: null, impliedRate };
}

// ─── #10 Date Anomaly Check ───────────────────────────────────────────────────
export function checkDateAnomaly(dateStr: string | undefined): string | null {
  if (!dateStr) return null;

  // Try to parse various date formats
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return null;

  const now = new Date();
  const diffDays = (parsed.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  if (diffDays > 1) {
    return `Invoice is dated in the future (${dateStr}). This is a red flag — verify with the supplier.`;
  }
  if (diffDays < -90) {
    return `Invoice is over 90 days old (${dateStr}). Be cautious — late invoices may indicate backdating.`;
  }
  return null;
}

// ─── #39 Smart Invoice Naming ─────────────────────────────────────────────────
export function buildSmartName(result: InvoiceProcessingResult): string {
  const vendor = result.validatedData.customer_name
    ? result.validatedData.customer_name.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20)
    : 'UnknownVendor';
  const date = result.validatedData.date
    ? result.validatedData.date.replace(/[^0-9]/g, '-').slice(0, 10)
    : result.createdAt.slice(0, 10);
  const total = result.validatedData.total !== undefined
    ? result.validatedData.total.toFixed(2)
    : '0.00';
  const inv = result.validatedData.invoice_number
    ? `_INV${result.validatedData.invoice_number.replace(/[^a-zA-Z0-9]/g, '')}`
    : '';
  return `${vendor}_${date}_${total}${inv}`;
}

// ─── #40 Recurring Invoice Detection ─────────────────────────────────────────
export function detectRecurringPatterns(history: InvoiceProcessingResult[]): RecurringPattern[] {
  const vendorMap: Record<string, InvoiceProcessingResult[]> = {};

  for (const item of history) {
    const key = normaliseVendor(item.validatedData.customer_name || 'unknown');
    if (!vendorMap[key]) vendorMap[key] = [];
    vendorMap[key].push(item);
  }

  const patterns: RecurringPattern[] = [];

  for (const [key, invoices] of Object.entries(vendorMap)) {
    if (invoices.length < 2) continue;

    const sorted = [...invoices].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const totals = sorted.map(i => i.validatedData.total || 0);
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length;

    // Detect frequency by gaps between invoices
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const diff = (new Date(sorted[i].createdAt).getTime() - new Date(sorted[i - 1].createdAt).getTime()) / (1000 * 60 * 60 * 24);
      gaps.push(diff);
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

    let frequency: RecurringPattern['frequency'] = 'irregular';
    if (avgGap >= 25 && avgGap <= 35) frequency = 'monthly';
    else if (avgGap >= 5 && avgGap <= 9) frequency = 'weekly';

    patterns.push({
      vendorKey: key,
      vendorName: sorted[sorted.length - 1].validatedData.customer_name || key,
      averageTotal: avg,
      frequency,
      lastSeen: sorted[sorted.length - 1].createdAt,
      count: invoices.length,
    });
  }

  return patterns.filter(p => p.frequency !== 'irregular' || p.count >= 3);
}

// ─── #43 Invoice Health Score ─────────────────────────────────────────────────
export function calcHealthScore(result: InvoiceProcessingResult): { score: number; grade: string; color: string } {
  let score = 100;

  // Deduct for missing fields
  if (!result.validatedData.invoice_number) score -= 15;
  if (!result.validatedData.customer_name) score -= 15;
  if (!result.validatedData.date) score -= 10;
  if (!result.validatedData.total) score -= 20;
  if (!result.validatedData.items || result.validatedData.items.length === 0) score -= 15;

  // Deduct for each validation error
  score -= result.errors.length * 10;

  // Deduct for duplicate
  if (result.isDuplicate) score -= 25;

  score = Math.max(0, Math.min(100, score));

  let grade = 'A';
  let color = 'text-green-600';
  if (score < 90) { grade = 'B'; color = 'text-blue-600'; }
  if (score < 75) { grade = 'C'; color = 'text-yellow-600'; }
  if (score < 60) { grade = 'D'; color = 'text-orange-600'; }
  if (score < 40) { grade = 'F'; color = 'text-red-600'; }

  return { score, grade, color };
}

// ─── #12/#13 Vendor & Item Analytics ─────────────────────────────────────────
export function getTopVendors(history: InvoiceProcessingResult[], limit = 5) {
  const map: Record<string, { name: string; total: number; count: number }> = {};
  for (const item of history) {
    const key = normaliseVendor(item.validatedData.customer_name || 'Unknown');
    if (!map[key]) map[key] = { name: item.validatedData.customer_name || 'Unknown', total: 0, count: 0 };
    map[key].total += item.validatedData.total || 0;
    map[key].count += 1;
  }
  return Object.values(map).sort((a, b) => b.total - a.total).slice(0, limit);
}

export function getTopItems(history: InvoiceProcessingResult[], limit = 5) {
  const map: Record<string, { name: string; totalSpent: number; frequency: number }> = {};
  for (const item of history) {
    for (const lineItem of item.validatedData.items || []) {
      const key = (lineItem.name || '').toLowerCase().trim();
      if (!key) continue;
      if (!map[key]) map[key] = { name: lineItem.name || key, totalSpent: 0, frequency: 0 };
      map[key].totalSpent += lineItem.line_total || 0;
      map[key].frequency += 1;
    }
  }
  return Object.values(map).sort((a, b) => b.frequency - a.frequency).slice(0, limit);
}

// ─── #11 Weekly/Monthly Trend ─────────────────────────────────────────────────
export function getMonthlyTrend(history: InvoiceProcessingResult[]) {
  const map: Record<string, number> = {};
  for (const item of history) {
    const month = item.createdAt.slice(0, 7); // YYYY-MM
    map[month] = (map[month] || 0) + (item.validatedData.total || 0);
  }
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, total]) => ({ month, total }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function normaliseVendor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}
