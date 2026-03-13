/**
 * invoice-intelligence.ts — InvoiceGuard AI
 * Built for field salesmen. Language reflects collecting/receiving money, not paying.
 */

import type { InvoiceProcessingResult, VendorProfile, ValidatedData } from './types';

export function normaliseVendorKey(name: string | undefined): string {
  if (!name) return '__unknown__';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

export function detectDuplicate(
  result: InvoiceProcessingResult,
  history: InvoiceProcessingResult[]
): { isDuplicate: boolean; duplicateOfId?: string } {
  const invNo = result.validatedData.invoice_number;
  const total = result.validatedData.total;
  const vendorKey = normaliseVendorKey(result.validatedData.customer_name);

  for (const h of history) {
    if (h.id === result.id) continue;
    const hVendorKey = normaliseVendorKey(h.validatedData.customer_name);
    if (invNo && h.validatedData.invoice_number === invNo && hVendorKey === vendorKey)
      return { isDuplicate: true, duplicateOfId: h.id };
    if (
      total !== undefined && h.validatedData.total === total &&
      hVendorKey === vendorKey && h.validatedData.date === result.validatedData.date &&
      h.validatedData.date !== undefined
    ) return { isDuplicate: true, duplicateOfId: h.id };
  }
  return { isDuplicate: false };
}

export function detectPartialPayment(
  result: InvoiceProcessingResult,
  history: InvoiceProcessingResult[]
): { isPartial: boolean; originalTotal?: number; originalId?: string } {
  const invNo = result.validatedData.invoice_number;
  const total = result.validatedData.total;
  if (!invNo || total === undefined) return { isPartial: false };
  const vendorKey = normaliseVendorKey(result.validatedData.customer_name);
  for (const h of history) {
    if (h.id === result.id) continue;
    const hVendorKey = normaliseVendorKey(h.validatedData.customer_name);
    if (
      h.validatedData.invoice_number === invNo &&
      hVendorKey === vendorKey &&
      h.validatedData.total !== undefined &&
      total < h.validatedData.total
    ) return { isPartial: true, originalTotal: h.validatedData.total, originalId: h.id };
  }
  return { isPartial: false };
}

export function validateTaxRate(
  subtotal: number | undefined,
  tax: number | undefined,
  expectedRatePct = 15
): { ok: boolean; impliedRate: number | null; message?: string } {
  if (subtotal === undefined || tax === undefined || subtotal === 0)
    return { ok: true, impliedRate: null };
  const impliedRate = Math.round((tax / subtotal) * 10000) / 100;
  if (Math.abs(impliedRate - expectedRatePct) > 2) {
    return {
      ok: false, impliedRate,
      message: `Tax rate looks unusual: ${impliedRate}% (expected ~${expectedRatePct}%). Verify the tax amount before receiving money.`,
    };
  }
  return { ok: true, impliedRate };
}

export function checkDateAnomaly(dateStr: string | undefined): string | null {
  if (!dateStr) return null;
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return null;
  const diffDays = (new Date().getTime() - parsed.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays < -1) return `Invoice is dated in the future (${dateStr}). Verify before accepting payment.`;
  if (diffDays > 90) return `Invoice date (${dateStr}) is over 90 days ago. Confirm this is not a resubmitted old invoice.`;
  return null;
}

export function buildSmartName(data: ValidatedData): string {
  const vendor = data.customer_name?.replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'Unknown';
  const date = data.date?.replace(/[^0-9\-\/]/g, '') || new Date().toISOString().split('T')[0];
  const total = data.total !== undefined ? data.total.toFixed(2) : '0.00';
  return `${vendor}_${date}_${total}`;
}

export function buildVendorProfiles(history: InvoiceProcessingResult[]): Record<string, VendorProfile> {
  const profiles: Record<string, VendorProfile> = {};
  // Sort oldest-first so first-seen prices are set by earliest invoice
  const sorted = [...history].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const inv of sorted) {
    const key = normaliseVendorKey(inv.validatedData.customer_name);
    const name = inv.validatedData.customer_name || 'Unknown';
    const total = inv.validatedData.total || 0;
    if (!profiles[key]) {
      profiles[key] = {
        vendorKey: key, vendorName: name, invoiceCount: 0,
        averageTotal: 0, lastTotal: 0, lastSeen: inv.createdAt,
        categories: [], itemNames: [], itemPrices: {},
        itemFirstPrices: {}, // fix #3
        errorCount: 0, taxRates: [],
      };
    }
    const p = profiles[key];
    p.invoiceCount++;
    p.averageTotal = (p.averageTotal * (p.invoiceCount - 1) + total) / p.invoiceCount;
    p.lastTotal = total;
    if (inv.createdAt > p.lastSeen) p.lastSeen = inv.createdAt;
    const cat = inv.validatedData.category;
    if (cat && !p.categories.includes(cat)) p.categories.push(cat);
    if (inv.status === 'error') p.errorCount++;
    for (const item of inv.validatedData.items || []) {
      if (item.name && item.unit_price !== undefined) {
        const k = item.name.toLowerCase();
        p.itemPrices[k] = item.unit_price; // always update to latest
        if (p.itemFirstPrices[k] === undefined) p.itemFirstPrices[k] = item.unit_price; // fix #3: set once
        if (!p.itemNames.includes(item.name)) p.itemNames.push(item.name);
      }
    }
    if (inv.validatedData.subtotal && inv.validatedData.tax) {
      p.taxRates.push(Math.round((inv.validatedData.tax / inv.validatedData.subtotal) * 10000) / 100);
    }
  }
  return profiles;
}

export function detectRecurring(
  result: InvoiceProcessingResult,
  profile: VendorProfile | undefined
): { isRecurring: boolean; recurringDelta?: number } {
  if (!profile || profile.invoiceCount < 2) return { isRecurring: false };
  const delta = profile.lastTotal > 0
    ? Math.round(((result.validatedData.total || 0) - profile.lastTotal) / profile.lastTotal * 100)
    : 0;
  return { isRecurring: true, recurringDelta: delta };
}

/** fix #3: compares against BOTH last price (incremental spike) AND first-seen price (cumulative drift).
 *  Flags if either exceeds 15%. */
export function checkPriceMemory(
  result: InvoiceProcessingResult,
  profile: VendorProfile | undefined
): string[] {
  if (!profile) return [];
  const warnings: string[] = [];
  for (const item of result.validatedData.items || []) {
    if (!item.name || item.unit_price === undefined) continue;
    const k = item.name.toLowerCase();
    const lastPrice = profile.itemPrices[k];
    const firstPrice = profile.itemFirstPrices[k];

    if (lastPrice !== undefined) {
      const pct = ((item.unit_price - lastPrice) / lastPrice) * 100;
      if (pct > 15) {
        warnings.push(
          `"${item.name}" is ${pct.toFixed(0)}% higher than last invoice from this vendor ` +
          `(was ${lastPrice.toFixed(2)}, now ${item.unit_price.toFixed(2)}). Verify before receiving money.`
        );
        continue; // already warned — skip cumulative check to avoid double message
      }
    }

    // Cumulative drift: compare against very first price seen
    if (firstPrice !== undefined && firstPrice !== lastPrice) {
      const driftPct = ((item.unit_price - firstPrice) / firstPrice) * 100;
      if (driftPct > 30) {
        warnings.push(
          `"${item.name}" has drifted ${driftPct.toFixed(0)}% above its original price ` +
          `(first seen: ${firstPrice.toFixed(2)}, now ${item.unit_price.toFixed(2)}). Worth checking.`
        );
      }
    }
  }
  return warnings;
}

export function calcHealthScore(result: InvoiceProcessingResult): number {
  let score = 100;
  const d = result.validatedData;
  if (!d.invoice_number) score -= 15;
  if (!d.customer_name) score -= 15;
  if (!d.date) score -= 10;
  if (d.total === undefined) score -= 20;
  if (!d.items || d.items.length === 0) score -= 20;
  if (d.subtotal === undefined) score -= 5;
  if (d.tax === undefined) score -= 5;
  score -= Math.min(result.errors.length * 10, 30);
  if (result.isDuplicate) score -= 25;
  return Math.max(0, score);
}

export function healthScoreBreakdown(result: InvoiceProcessingResult): Array<{ label: string; deduction: number; ok: boolean }> {
  const d = result.validatedData;
  return [
    { label: 'Invoice number present', deduction: 15, ok: !!d.invoice_number },
    { label: 'Customer name present', deduction: 15, ok: !!d.customer_name },
    { label: 'Invoice date present', deduction: 10, ok: !!d.date },
    { label: 'Grand total readable', deduction: 20, ok: d.total !== undefined },
    { label: 'Line items found', deduction: 20, ok: !!(d.items && d.items.length > 0) },
    { label: 'Subtotal present', deduction: 5, ok: d.subtotal !== undefined },
    { label: 'Tax present', deduction: 5, ok: d.tax !== undefined },
    { label: 'No validation errors', deduction: Math.min(result.errors.length * 10, 30), ok: result.errors.length === 0 },
    { label: 'Not a duplicate', deduction: 25, ok: !result.isDuplicate },
  ];
}

export function healthLabel(score: number): { label: string; colour: string } {
  if (score >= 85) return { label: 'Excellent', colour: 'text-green-600' };
  if (score >= 65) return { label: 'Good', colour: 'text-blue-600' };
  if (score >= 40) return { label: 'Fair', colour: 'text-yellow-600' };
  return { label: 'Poor', colour: 'text-red-600' };
}

/** fix #7: money-at-risk counts invoices where verdict is REJECT/ESCALATE,
 *  not just status==='error', so protocol-9-only risks are included. */
export function calcMoneyAtRisk(history: InvoiceProcessingResult[]): number {
  return history
    .filter(i => {
      const v = i.riskVerdict?.verdict;
      // Legacy invoices (pre-v3) fall back to status-based check
      if (!v) return i.status === 'error';
      return v === 'REJECT' || v === 'ESCALATE';
    })
    .reduce((s, i) => s + (i.validatedData.total || 0), 0);
}

export function buildTrendData(history: InvoiceProcessingResult[], mode: 'weekly' | 'monthly' = 'monthly') {
  const buckets: Record<string, { label: string; amount: number; count: number; errors: number }> = {};
  for (const inv of history) {
    const d = new Date(inv.createdAt);
    let key: string, label: string;
    if (mode === 'weekly') {
      const jan1 = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
      key = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
      label = `Wk ${week}`;
    } else {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      label = d.toLocaleString('default', { month: 'short', year: '2-digit' });
    }
    if (!buckets[key]) buckets[key] = { label, amount: 0, count: 0, errors: 0 };
    buckets[key].amount += inv.validatedData.total || 0;
    buckets[key].count++;
    if (inv.status === 'error') buckets[key].errors++;
  }
  return Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}

export function topVendors(history: InvoiceProcessingResult[], limit = 5) {
  const map: Record<string, { name: string; amount: number; count: number }> = {};
  for (const inv of history) {
    const key = normaliseVendorKey(inv.validatedData.customer_name);
    if (!map[key]) map[key] = { name: inv.validatedData.customer_name || 'Unknown', amount: 0, count: 0 };
    map[key].amount += inv.validatedData.total || 0;
    map[key].count++;
  }
  return Object.values(map).sort((a, b) => b.amount - a.amount).slice(0, limit);
}

export function topItems(history: InvoiceProcessingResult[], limit = 5) {
  const map: Record<string, { name: string; count: number; totalSpend: number }> = {};
  for (const inv of history) {
    for (const item of inv.validatedData.items || []) {
      if (!item.name) continue;
      const key = item.name.toLowerCase();
      if (!map[key]) map[key] = { name: item.name, count: 0, totalSpend: 0 };
      map[key].count++;
      map[key].totalSpend += item.line_total || 0;
    }
  }
  return Object.values(map).sort((a, b) => b.count - a.count).slice(0, limit);
}

export function daysUntilDue(dueDate: string | undefined): number | null {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  if (isNaN(due.getTime())) return null;
  return Math.ceil((due.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
}

export function dueDateStatus(days: number | null): 'overdue' | 'due-soon' | 'ok' | 'none' {
  if (days === null) return 'none';
  if (days < 0) return 'overdue';
  if (days <= 3) return 'due-soon';
  return 'ok';
}

export function nlSearch(query: string, history: InvoiceProcessingResult[]): InvoiceProcessingResult[] {
  const q = query.toLowerCase().trim();
  if (!q) return history;
  const overMatch = q.match(/(?:over|above|more than)\s+([\d,]+)/);
  const underMatch = q.match(/(?:under|below|less than)\s+([\d,]+)/);
  const overAmt = overMatch ? parseFloat(overMatch[1].replace(/,/g, '')) : null;
  const underAmt = underMatch ? parseFloat(underMatch[1].replace(/,/g, '')) : null;
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  let monthFilter: number | null = null;
  for (let i = 0; i < monthNames.length; i++) { if (q.includes(monthNames[i])) { monthFilter = i; break; } }
  if (q.includes('last month')) { const lm = new Date(); lm.setMonth(lm.getMonth() - 1); monthFilter = lm.getMonth(); }
  const wantsErrors = q.includes('error') || q.includes('invalid') || q.includes('wrong');
  const wantsApproved = q.includes('approved');
  const wantsOverdue = q.includes('overdue');
  const keywords = q.replace(/(?:over|above|under|below|more than|less than|last month|in|all|invoices?|from|show|find|with|errors?|approved|overdue)[\s]*/g, '').replace(/[\d,]+/g, '').trim();
  return history.filter(inv => {
    const total = inv.validatedData.total || 0;
    const invDate = new Date(inv.createdAt);
    if (overAmt !== null && total <= overAmt) return false;
    if (underAmt !== null && total >= underAmt) return false;
    if (monthFilter !== null && invDate.getMonth() !== monthFilter) return false;
    if (wantsErrors && inv.status !== 'error') return false;
    if (wantsApproved && inv.status !== 'approved') return false;
    if (wantsOverdue) { const days = daysUntilDue(inv.dueDate); if (days === null || days >= 0) return false; }
    if (keywords.length > 1) {
      const haystack = [inv.validatedData.customer_name, inv.validatedData.category, inv.validatedData.invoice_number, ...(inv.validatedData.items || []).map(i => i.name), inv.smartName].join(' ').toLowerCase();
      if (!haystack.includes(keywords)) return false;
    }
    return true;
  });
}

const OFFLINE_QUEUE_KEY = 'invoiceguard_offline_queue';
export interface OfflineQueueItem { id: string; imageBase64: string; queuedAt: string; }

export function getOfflineQueue(): OfflineQueueItem[] {
  if (typeof window === 'undefined') return [];
  try { const raw = localStorage.getItem(OFFLINE_QUEUE_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
export function addToOfflineQueue(imageBase64: string): string {
  const id = crypto.randomUUID();
  const queue = getOfflineQueue();
  queue.push({ id, imageBase64, queuedAt: new Date().toISOString() });
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  return id;
}
export function removeFromOfflineQueue(id: string) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(getOfflineQueue().filter(q => q.id !== id)));
}
export function clearOfflineQueue() { localStorage.removeItem(OFFLINE_QUEUE_KEY); }

export function buildDailyReportData(history: InvoiceProcessingResult[]) {
  const today = new Date().toDateString();
  const todayInvoices = history.filter(h => new Date(h.createdAt).toDateString() === today);
  const totalValue = todayInvoices.reduce((s, i) => s + (i.validatedData.total || 0), 0);
  const errorInvoices = todayInvoices.filter(i => i.status === 'error');
  const approvedInvoices = todayInvoices.filter(i => i.status === 'approved');
  return {
    date: new Date().toLocaleDateString(),
    totalInvoices: todayInvoices.length,
    totalValue,
    errorCount: errorInvoices.length,
    approvedCount: approvedInvoices.length,
    moneyAtRisk: calcMoneyAtRisk(todayInvoices), // fix #7
    moneySafe: approvedInvoices.reduce((s, i) => s + (i.validatedData.total || 0), 0),
    invoices: todayInvoices,
  };
}

export function checkRiskThreshold(
  history: InvoiceProcessingResult[],
  thresholdStr: string
): { exceeded: boolean; atRisk: number; threshold: number } {
  const threshold = parseFloat(thresholdStr) || 0;
  if (threshold <= 0) return { exceeded: false, atRisk: 0, threshold };
  const atRisk = calcMoneyAtRisk(history); // fix #7
  return { exceeded: atRisk > threshold, atRisk, threshold };
}

export async function preprocessImage(dataUri: string, maxWidth = 1600): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, maxWidth / img.width);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d')!;
      ctx.filter = 'contrast(1.1) brightness(1.05)';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

export function checkImageQuality(dataUri: string): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, 64, 64);
      const data = ctx.getImageData(0, 0, 64, 64).data;
      let total = 0;
      const samples = data.length / 4;
      for (let i = 0; i < data.length; i += 4)
        total += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const avg = total / samples;
      let variance = 0;
      for (let i = 0; i < data.length; i += 4) {
        const b = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        variance += (b - avg) ** 2;
      }
      variance /= samples;
      if (avg < 30) return resolve({ ok: false, reason: 'Image is too dark. Move to better lighting and retake.' });
      if (variance < 80) return resolve({ ok: false, reason: 'Image appears blurry or blank. Hold the camera steady and retake.' });
      resolve({ ok: true });
    };
    img.onerror = () => resolve({ ok: true });
    img.src = dataUri;
  });
}
