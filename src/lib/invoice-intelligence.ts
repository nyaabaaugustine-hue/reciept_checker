/**
 * invoice-intelligence.ts — InvoiceGuard AI
 * Built for field salesmen. All language reflects collecting/receiving money, not paying.
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

// #5 — salesman language: "receiving money" not "paying"
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
      ok: false,
      impliedRate,
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
  for (const inv of history) {
    const key = normaliseVendorKey(inv.validatedData.customer_name);
    const name = inv.validatedData.customer_name || 'Unknown';
    const total = inv.validatedData.total || 0;
    if (!profiles[key]) {
      profiles[key] = { vendorKey: key, vendorName: name, invoiceCount: 0, averageTotal: 0, lastTotal: 0, lastSeen: inv.createdAt, categories: [], itemNames: [], itemPrices: {}, errorCount: 0, taxRates: [] };
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
        p.itemPrices[item.name.toLowerCase()] = item.unit_price;
        if (!p.itemNames.includes(item.name)) p.itemNames.push(item.name);
      }
    }
    if (inv.validatedData.subtotal && inv.validatedData.tax) {
      p.taxRates.push(Math.round((inv.validatedData.tax / inv.validatedData.subtotal) * 10000) / 100);
    }
  }
  return profiles;
}

export function detectRecurring(result: InvoiceProcessingResult, profile: VendorProfile | undefined): { isRecurring: boolean; recurringDelta?: number } {
  if (!profile || profile.invoiceCount < 2) return { isRecurring: false };
  const delta = profile.lastTotal > 0 ? Math.round(((result.validatedData.total || 0) - profile.lastTotal) / profile.lastTotal * 100) : 0;
  return { isRecurring: true, recurringDelta: delta };
}

export function checkPriceMemory(result: InvoiceProcessingResult, profile: VendorProfile | undefined): string[] {
  if (!profile) return [];
  const warnings: string[] = [];
  for (const item of result.validatedData.items || []) {
    if (!item.name || item.unit_price === undefined) continue;
    const lastPrice = profile.itemPrices[item.name.toLowerCase()];
    if (lastPrice === undefined) continue;
    const changePct = ((item.unit_price - lastPrice) / lastPrice) * 100;
    if (changePct > 20) {
      warnings.push(`"${item.name}" price rose ${changePct.toFixed(0)}% vs last invoice from this customer (was ${lastPrice.toFixed(2)}, now ${item.unit_price.toFixed(2)}). Verify before receiving money.`);
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

export function healthLabel(score: number): { label: string; colour: string } {
  if (score >= 85) return { label: 'Excellent', colour: 'text-green-600' };
  if (score >= 65) return { label: 'Good', colour: 'text-blue-600' };
  if (score >= 40) return { label: 'Fair', colour: 'text-yellow-600' };
  return { label: 'Poor', colour: 'text-red-600' };
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
    moneyAtRisk: errorInvoices.reduce((s, i) => s + (i.validatedData.total || 0), 0),
    moneySafe: approvedInvoices.reduce((s, i) => s + (i.validatedData.total || 0), 0),
    invoices: todayInvoices,
  };
}
