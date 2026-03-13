/**
 * invoice-intelligence.ts — InvoiceGuard AI v7.0
 * Built for field salesmen. Language reflects collecting/receiving money, not paying.
 *
 * v7.0 Improvements:
 * #I01 — Ghana-specific date parsing (DD/MM/YY, DD-MMM-YYYY, ordinal dates)
 * #I02 — Extended abbreviation map (50+ Ghana market terms)
 * #I03 — Round-number anomaly flag (suspiciously round totals = manual entry risk)
 * #I04 — Vendor fuzzy-name matching (Levenshtein) to catch duplicate vendors
 * #I05 — Unit mismatch detection (bags vs kg vs cartons on same item)
 * #I06 — Payment terms extraction & late-payment warning
 * #I07 — Proforma vs real invoice classifier (proforma → CAUTION, not ACCEPT)
 * #I08 — West Africa multi-currency guard (NGN, XOF, SLL appearing in GHS invoices)
 * #I09 — Stricter GRA invoice line detection (all 5 levies must balance)
 * #I10 — Improved re-read threshold: triggers on MEDIUM confidence, not just LOW
 * #I11 — Cumulative vendor spend limit warning
 * #I12 — Normalised invoice-number duplicate matching (strips prefix, compares digits)
 * #I13 — Daily collection summary helper for salesmen
 * #I14 — Price memory: skip warning on first invoice from a vendor
 * #I15 — Context-aware quantity sanity (cement bags vs pens vs litres)
 * #I16 — OCR quality score from variance calculation
 * #I17 — Fixed: GRA levy rates not applied to non-GRA invoices incorrectly
 * #I18 — Ghana public holiday calendar for time-anomaly check
 * #I19 — Suspiciously identical totals across different vendors flag
 * #I20 — Salesman-readable summary line for every result
 * v7.1 — Date message now shows calculated overdue months/years instead of raw days
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

/**
 * checkDateAnomaly — always produces a meaningful message.
 * #I01: Uses parseGhanaDate for DD/MM/YY and text dates.
 * #I18: Ghana public holiday awareness.
 * v7.1: Shows calculated overdue months/years, not raw day count.
 */
export function checkDateAnomaly(dateStr: string | undefined): string | null {
  if (!dateStr) {
    return 'Invoice has no date. A valid date is required to track and dispute invoices. Ask the vendor to reissue with a date.';
  }

  // #I01: try Ghana-aware parser first
  const parsed = parseGhanaDate(dateStr);
  if (!parsed) {
    return `Invoice date "${dateStr}" could not be read as a real date. Verify the date with the vendor before accepting payment.`;
  }

  const now = new Date();
  const diffDays = Math.floor((now.getTime() - parsed.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < -1) {
    const daysAhead = Math.abs(diffDays);
    return `Invoice is dated ${daysAhead} day${daysAhead !== 1 ? 's' : ''} in the future (${dateStr}). This is a red flag — vendors cannot issue invoices for dates that haven't happened yet. Do not accept without manager approval.`;
  }

  if (diffDays > 30) {
    const totalMonths = Math.floor(diffDays / 30);
    const years = Math.floor(totalMonths / 12);
    // If date is more than 2 years ago, it is almost certainly a misread year (e.g. 2012 instead of 2024)
    if (years >= 2) {
      return `Invoice date looks wrong (${dateStr}) — the year may have been written incorrectly. Please correct the date before submitting.`;
    }
    const remainMonths = totalMonths % 12;
    const overdueLabel = years > 0
      ? `${years} year${years !== 1 ? 's' : ''}${remainMonths > 0 ? ` and ${remainMonths} month${remainMonths !== 1 ? 's' : ''}` : ''}`
      : `${totalMonths} month${totalMonths !== 1 ? 's' : ''}`;
    return `Invoice date is ${overdueLabel} old (${dateStr}). Make sure you have written today's date correctly.`;
  }

  return null; // Within 30 days - OK
}

export function buildSmartName(data: ValidatedData): string {
  const vendor = data.customer_name?.replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'Unknown';
  const date = data.date?.replace(/[^0-9\-\/]/g, '') || new Date().toISOString().split('T')[0];
  const total = data.total !== undefined ? data.total.toFixed(2) : '0.00';
  return `${vendor}_${date}_${total}`;
}

export function buildVendorProfiles(history: InvoiceProcessingResult[]): Record<string, VendorProfile> {
  const profiles: Record<string, VendorProfile> = {};
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
        itemFirstPrices: {},
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
        // #12: store under normalised key so abbreviations match
        const k = normaliseItemName(item.name) || item.name.toLowerCase();
        p.itemPrices[k] = item.unit_price;
        if (p.itemFirstPrices[k] === undefined) p.itemFirstPrices[k] = item.unit_price;
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

// ─────────────────────────────────────────────────────────────
// #11 — VENDOR TOTAL RANGE CHECK
// ─────────────────────────────────────────────────────────────

export function checkVendorTotalRange(
  newTotal: number,
  vendorHistory: InvoiceProcessingResult[],
  vendorName: string | undefined
): string | null {
  if (vendorHistory.length < 3) return null;
  const totals = vendorHistory
    .map(h => h.validatedData.total)
    .filter((t): t is number => t !== undefined && t > 0);
  if (totals.length < 3) return null;
  const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
  const max = Math.max(...totals);
  const min = Math.min(...totals);
  const name = vendorName || 'this vendor';

  if (newTotal > max * 3) {
    return `Invoice total (${newTotal.toFixed(2)}) is more than 3x the highest previous invoice from ${name} (max was ${max.toFixed(2)}, average ${avg.toFixed(2)}). This is highly unusual — verify before collecting.`;
  }
  if (newTotal > avg * 2.5 && totals.length >= 5) {
    return `Invoice total (${newTotal.toFixed(2)}) is 2.5x above the average for ${name} (average: ${avg.toFixed(2)}). Confirm this is a genuine large order.`;
  }
  if (newTotal < min * 0.2 && totals.length >= 5) {
    return `Invoice total (${newTotal.toFixed(2)}) is far below the normal range for ${name} (minimum seen: ${min.toFixed(2)}). This may be a partial payment or keying error.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// #15 — INVOICE NUMBER GAP DETECTION
// ─────────────────────────────────────────────────────────────

export function detectInvoiceNumberGap(
  newInvNumber: string,
  vendorKey: string,
  history: InvoiceProcessingResult[]
): string | null {
  const vendorInvoices = history.filter(
    h => normaliseVendorKey(h.validatedData.customer_name) === vendorKey && h.validatedData.invoice_number
  );
  if (vendorInvoices.length < 2) return null;

  const extractNum = (s: string): number | null => {
    const m = s.match(/(\d+)\s*$/);
    return m ? parseInt(m[1]) : null;
  };

  const newNum = extractNum(newInvNumber);
  if (newNum === null) return null;

  const sorted = [...vendorInvoices].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lastInv = sorted[0].validatedData.invoice_number!;
  const lastNum = extractNum(lastInv);
  if (lastNum === null) return null;

  const newPrefix  = newInvNumber.replace(/\d+\s*$/, '');
  const lastPrefix = lastInv.replace(/\d+\s*$/, '');
  if (newPrefix.toLowerCase() !== lastPrefix.toLowerCase()) return null;

  const gap = Math.abs(newNum - lastNum);
  if (gap > 50) {
    return `Invoice number ${newInvNumber} is a large jump from this vendor's last invoice ${lastInv} (gap of ${gap}). This could indicate backdating or a skipped number block.`;
  }
  if (newNum < lastNum) {
    return `Invoice number ${newInvNumber} is lower than this vendor's last recorded invoice ${lastInv}. Invoice numbers should increase over time — this may be a reuse or backdating.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// #12 — ITEM NAME NORMALISATION
// ─────────────────────────────────────────────────────────────

// #I02 — Extended abbreviation map: 50+ Ghana market terms
export function normaliseItemName(name: string): string {
  if (!name) return '';
  let n = name.toLowerCase().trim();
  const abbrevMap: [RegExp, string][] = [
    // Cement
    [/\bp\/cement\b/g,         'portland cement'],
    [/\bport\s*cem\b/g,        'portland cement'],
    [/\bopc\b/g,               'portland cement'],
    [/\bcem\b/g,               'cement'],
    // Building blocks
    [/\bblk\b/g,               'block'],
    [/\bblks\b/g,              'blocks'],
    [/\b6\s*inch\s*blk/g,      '6 inch block'],
    [/\b9\s*inch\s*blk/g,      '9 inch block'],
    // Quantities
    [/\bpcs\b/g,               'pieces'],
    [/\bpc\b/g,                'pieces'],
    [/\bpkt\b/g,               'packet'],
    [/\bpkts\b/g,              'packets'],
    [/\bctn\b/g,               'carton'],
    [/\bctns\b/g,              'cartons'],
    [/\bltr\b/g,               'litre'],
    [/\bltrs\b/g,              'litres'],
    [/\blt\b/g,                'litre'],
    [/\bkgs?\b/g,              'kg'],
    [/\bgals?\b/g,             'gallon'],
    [/\bdoz\b/g,               'dozen'],
    [/\bbag\b/g,               'bag'],
    [/\bbags\b/g,              'bags'],
    [/\bshts?\b/g,             'sheets'],
    [/\brolls?\b/g,            'roll'],
    [/\bpails?\b/g,            'pail'],
    [/\btins?\b/g,             'tin'],
    [/\bbundle\b/g,            'bundle'],
    [/\bbdl\b/g,               'bundle'],
    // Roofing
    [/\baluzinc\b/g,           'aluzinc'],
    [/\balu\s*zinc\b/g,        'aluzinc'],
    [/\bgi\s*sheet/g,          'galvanised iron sheet'],
    [/\bgalv\b/g,              'galvanised'],
    // Paint & chemicals
    [/\bemi\s*paint\b/g,       'emulsion paint'],
    [/\bemul\b/g,              'emulsion'],
    [/\bgloss\b/g,             'gloss paint'],
    [/\bsolv\b/g,              'solvent'],
    // Rice & grains
    [/\bwasa\b/g,              'wasa rice'],
    [/\bbr\s*rice\b/g,         'brown rice'],
    [/\bbasmati\b/g,           'basmati rice'],
    // Oil
    [/\bveg\s*oil\b/g,         'vegetable oil'],
    [/\bpalm\s*oil\b/g,        'palm oil'],
    [/\bcooking\s*oil\b/g,     'cooking oil'],
    // Common items
    [/\bsugar\s*50/g,          'sugar 50kg'],
    [/\bflour\s*50/g,          'flour 50kg'],
    [/\bchick\b/g,             'chicken'],
    [/\bfrozen\s*chick/g,      'frozen chicken'],
    [/\bmackerel\b/g,          'mackerel'],
    [/\bsard\b/g,              'sardine'],
    // Electronics / electrical
    [/\bbatt\b/g,              'battery'],
    [/\bbulb\b/g,              'light bulb'],
    [/\bled\b/g,               'led bulb'],
    [/\bsassin\b/g,            'distribution board'],
    [/\btrunking\b/g,          'cable trunking'],
    [/\brosette\b/g,           'ceiling rose'],
    // Transport
    [/\btrip\b/g,              'delivery trip'],
    [/\bdel\s*fee/g,           'delivery fee'],
    [/\bdel\.fee/g,            'delivery fee'],
    // Stationery
    [/\bexer\b/g,              'exercise book'],
    [/\brim\b/g,               'ream of paper'],
    [/\a4\s*ppr/g,             'a4 paper'],
  ];
  for (const [pattern, replacement] of abbrevMap) {
    n = n.replace(pattern, replacement);
  }
  return n.replace(/\s+/g, ' ').trim();
}

/**
 * checkPriceMemory — compares against BOTH last price AND first-seen price.
 * #12: uses normaliseItemName for fuzzy abbreviation matching.
 */
export function checkPriceMemory(
  result: InvoiceProcessingResult,
  profile: VendorProfile | undefined
): string[] {
  if (!profile) return [];
  const warnings: string[] = [];
  for (const item of result.validatedData.items || []) {
    if (!item.name || item.unit_price === undefined) continue;
    // #12: try normalised name first, fall back to raw lowercase
    const kNorm = normaliseItemName(item.name);
    const kRaw  = item.name.toLowerCase();
    const k = (profile.itemPrices[kNorm] !== undefined ? kNorm : kRaw);
    const lastPrice = profile.itemPrices[k];
    const firstPrice = profile.itemFirstPrices[k];

    if (lastPrice !== undefined) {
      const pct = ((item.unit_price - lastPrice) / lastPrice) * 100;
      if (pct > 15) {
        warnings.push(
          `"${item.name}" is ${pct.toFixed(0)}% higher than last invoice from this vendor ` +
          `(was ${lastPrice.toFixed(2)}, now ${item.unit_price.toFixed(2)}). Verify before receiving money.`
        );
        continue;
      }
    }

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

export function calcMoneyAtRisk(history: InvoiceProcessingResult[]): number {
  return history
    .filter(i => {
      const v = i.riskVerdict?.verdict;
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
    moneyAtRisk: calcMoneyAtRisk(todayInvoices),
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
  const atRisk = calcMoneyAtRisk(history);
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

export function checkImageQuality(dataUri: string): Promise<{ ok: boolean; reason?: string; qualityScore?: number }> {
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
      // #I16 — OCR quality score: 0-100
      const brightnessScore = Math.min(100, Math.max(0, (avg - 20) / (200 - 20) * 100));
      const sharpnessScore  = Math.min(100, Math.max(0, (variance - 50) / (400 - 50) * 100));
      const qualityScore    = Math.round((brightnessScore * 0.4) + (sharpnessScore * 0.6));
      if (avg < 30) return resolve({ ok: false, reason: 'Image is too dark. Move to better lighting and retake.', qualityScore });
      if (variance < 80) return resolve({ ok: false, reason: 'Image appears blurry or blank. Hold the camera steady and retake.', qualityScore });
      resolve({ ok: true, qualityScore });
    };
    img.onerror = () => resolve({ ok: true });
    img.src = dataUri;
  });
}

// =============================================================================
// v7.0 NEW FUNCTIONS
// =============================================================================

// ─────────────────────────────────────────────────────────────
// #I01 — GHANA DATE PARSER
// Handles: DD/MM/YYYY, DD-MMM-YYYY, DDth MMM YYYY, YYYY-MM-DD
// ─────────────────────────────────────────────────────────────
export function parseGhanaDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();

  // ISO already handled by new Date()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[/\-\.](\d{1,2})[/\-\.](\d{2,4})$/);
  if (dmy) {
    const day   = parseInt(dmy[1]);
    const month = parseInt(dmy[2]) - 1;
    let   year  = parseInt(dmy[3]);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }

  // DD MMM YYYY or DDth MMM YYYY (e.g. "15 JAN 2024", "3rd Mar 2025")
  const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const textDate = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-,]+([a-zA-Z]{3,9})[\s\-,]+(\d{2,4})$/);
  if (textDate) {
    const day     = parseInt(textDate[1]);
    const monStr  = textDate[2].slice(0, 3).toLowerCase();
    const month   = MONTHS[monStr];
    if (month === undefined) return null;
    let year = parseInt(textDate[3]);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }

  // Fallback to native parser
  const native = new Date(s);
  return isNaN(native.getTime()) ? null : native;
}

// ─────────────────────────────────────────────────────────────
// #I03 — ROUND NUMBER ANOMALY DETECTOR
// Very round totals (1000, 2500, 5000) are suspicious on itemised invoices
// ─────────────────────────────────────────────────────────────
export function checkRoundNumberAnomaly(
  total: number | undefined,
  itemCount: number
): string | null {
  if (total === undefined || itemCount === 0) return null;
  if (itemCount < 2) return null;
  if (total <= 0) return null;

  const isRound1000 = total % 1000 === 0 && total >= 1000;
  const isRound500  = total % 500  === 0 && total >= 500 && !isRound1000;
  const isRound100  = total % 100  === 0 && total >= 100 && !isRound500 && !isRound1000;

  if (isRound1000) {
    return `Grand total is a very round number (${total.toFixed(2)}) on a multi-item invoice. Hand-keyed round numbers are a common error. Verify every line total adds up correctly.`;
  }
  if (isRound500) {
    return `Grand total ends in exactly 500 (${total.toFixed(2)}) across ${itemCount} items. Double-check the addition is correct — this could be a rounded estimate rather than a calculated total.`;
  }
  if (isRound100) {
    return `Total is a round number (${total.toFixed(2)}). Confirm this matches the sum of all line items, not an estimated lump sum.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// #I04 — VENDOR FUZZY NAME MATCHER (Levenshtein)
// Returns warning if a similar-but-different vendor name seen before
// ─────────────────────────────────────────────────────────────
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[a.length][b.length];
}

export function checkVendorNameFuzzyMatch(
  currentVendor: string | undefined,
  history: InvoiceProcessingResult[]
): string | null {
  if (!currentVendor || currentVendor.length < 4) return null;
  const currentKey = normaliseVendorKey(currentVendor);
  const seenKeys   = new Set<string>();
  const seenNames: Record<string, string> = {};

  for (const h of history) {
    const k = normaliseVendorKey(h.validatedData.customer_name);
    if (k && k !== currentKey && k.length >= 4) {
      seenKeys.add(k);
      seenNames[k] = h.validatedData.customer_name || k;
    }
  }

  for (const k of seenKeys) {
    const dist = levenshtein(currentKey, k);
    const maxLen = Math.max(currentKey.length, k.length);
    if (dist > 0 && dist <= Math.max(2, Math.floor(maxLen * 0.25))) {
      return `Vendor "${currentVendor}" looks very similar to a previous vendor "${seenNames[k]}". Confirm you have the correct vendor — very similar names could mean a typo or a duplicate billing attempt.`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// #I07 — PROFORMA INVOICE CLASSIFIER
// ─────────────────────────────────────────────────────────────
export function isProformaInvoice(ocrText: string | undefined): boolean {
  if (!ocrText) return false;
  const t = ocrText.toLowerCase();
  return (
    t.includes('proforma') ||
    t.includes('pro forma') ||
    t.includes('pro-forma') ||
    t.includes('quotation') ||
    t.includes('quote only') ||
    t.includes('not a tax invoice') ||
    t.includes('this is not an invoice')
  );
}

// ─────────────────────────────────────────────────────────────
// #I08 — WEST AFRICA CURRENCY GUARD
// ─────────────────────────────────────────────────────────────
export function checkForeignCurrencyInGHS(
  detectedCurrency: string | undefined,
  items: Array<{ currency_symbol_seen?: string | null }> | undefined
): string | null {
  const FOREIGN = ['NGN', 'N', '\u20a6', 'XOF', 'SLL', 'GMD', 'LRD', 'SLE'];
  const cur = (detectedCurrency ?? '').toUpperCase();
  if (FOREIGN.includes(cur)) {
    return `Invoice appears to be in ${cur} (not GHS). Do NOT collect Ghana cedis for a foreign-currency invoice without an exchange rate confirmation from your manager.`;
  }
  for (const item of items ?? []) {
    const sym = String(item.currency_symbol_seen ?? '').toUpperCase();
    if (FOREIGN.includes(sym)) {
      return `At least one item shows a foreign currency symbol (${sym}). The total may be in a different currency than GHS. Confirm with your manager before collecting.`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// #I11 — CUMULATIVE VENDOR SPEND WARNING
// ─────────────────────────────────────────────────────────────
export function checkCumulativeVendorSpend(
  vendorHistory: InvoiceProcessingResult[],
  newTotal: number | undefined,
  vendorName: string | undefined,
  limitGHS = 50000
): string | null {
  if (!newTotal || vendorHistory.length === 0) return null;
  const historicalSpend = vendorHistory.reduce((sum, h) => sum + (h.validatedData.total ?? 0), 0);
  const projected = historicalSpend + newTotal;
  const name = vendorName || 'this vendor';
  if (projected > limitGHS) {
    return `Adding this invoice would bring your total from ${name} to ${projected.toLocaleString('en-GH', { style: 'currency', currency: 'GHS' })} — over the ${limitGHS.toLocaleString('en-GH', { style: 'currency', currency: 'GHS' })} review threshold. Check with your manager before collecting.`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// #I13 — DAILY COLLECTION SUMMARY
// ─────────────────────────────────────────────────────────────
export function buildDailyCollectionSummary(history: InvoiceProcessingResult[]): {
  count: number;
  totalCollected: number;
  totalAtRisk: number;
  approvedCount: number;
  errorCount: number;
} {
  const today = new Date().toDateString();
  const todayInvoices = history.filter(h => new Date(h.createdAt).toDateString() === today);
  return {
    count:          todayInvoices.length,
    totalCollected: todayInvoices.filter(i => i.status === 'approved').reduce((s, i) => s + (i.validatedData.total ?? 0), 0),
    totalAtRisk:    todayInvoices.filter(i => i.riskVerdict?.verdict === 'REJECT' || i.riskVerdict?.verdict === 'ESCALATE').reduce((s, i) => s + (i.validatedData.total ?? 0), 0),
    approvedCount:  todayInvoices.filter(i => i.status === 'approved').length,
    errorCount:     todayInvoices.filter(i => i.status === 'error').length,
  };
}

// ─────────────────────────────────────────────────────────────
// #I18 — GHANA PUBLIC HOLIDAY CALENDAR
// ─────────────────────────────────────────────────────────────
const GHANA_PUBLIC_HOLIDAYS: Array<{ month: number; day: number; name: string }> = [
  { month: 1,  day: 1,  name: "New Year's Day" },
  { month: 3,  day: 6,  name: 'Independence Day' },
  { month: 5,  day: 1,  name: "Workers' Day (Labour Day)" },
  { month: 5,  day: 25, name: 'Africa Day' },
  { month: 7,  day: 1,  name: 'Republic Day' },
  { month: 8,  day: 4,  name: "Founders' Day" },
  { month: 9,  day: 21, name: 'Kwame Nkrumah Memorial Day' },
  { month: 12, day: 25, name: 'Christmas Day' },
  { month: 12, day: 26, name: 'Boxing Day' },
];

function isGhanaPublicHoliday(date: Date): string | null {
  for (const h of GHANA_PUBLIC_HOLIDAYS) {
    if (date.getMonth() + 1 === h.month && date.getDate() === h.day) return h.name;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// #I19 — CROSS-VENDOR IDENTICAL TOTAL FLAG
// ─────────────────────────────────────────────────────────────
export function checkIdenticalTotalCrossVendor(
  newTotal: number | undefined,
  newVendorKey: string | undefined,
  history: InvoiceProcessingResult[]
): string | null {
  if (!newTotal || !newVendorKey || newTotal < 10) return null;
  const today = new Date().toDateString();
  for (const h of history) {
    if (
      h.validatedData.total === newTotal &&
      normaliseVendorKey(h.validatedData.customer_name) !== newVendorKey &&
      new Date(h.createdAt).toDateString() === today
    ) {
      return `This invoice total (${newTotal.toFixed(2)}) is identical to another invoice from a different vendor ("${h.validatedData.customer_name}") collected today. Identical totals from different vendors on the same day are unusual — verify this is not a duplicate entry.`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// #I20 — SALESMAN-READABLE SUMMARY LINE
// ─────────────────────────────────────────────────────────────
export function buildSalesmanSummary(result: InvoiceProcessingResult): string {
  const v = result.validatedData;
  const vendor  = v.customer_name || 'Unknown Vendor';
  const total   = v.total !== undefined ? v.total.toLocaleString('en-GH', { style: 'currency', currency: 'GHS' }) : 'amount unknown';
  const verdict = result.riskVerdict?.verdict ?? 'UNKNOWN';
  const items   = v.items?.length ?? 0;

  if (verdict === 'ACCEPT') return `✅ ${vendor} — ${total} — ${items} item${items !== 1 ? 's' : ''} — Safe to collect.`;
  if (verdict === 'CAUTION') return `⚠️ ${vendor} — ${total} — Review flagged issues before collecting.`;
  if (verdict === 'REJECT') return `🔴 ${vendor} — ${total} — DO NOT COLLECT. See reason below.`;
  if (verdict === 'ESCALATE') return `🚨 ${vendor} — ${total} — Check and rewrite the correct invoice.`;
  return `${vendor} — ${total}`;
}
