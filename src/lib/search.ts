/**
 * Natural language invoice search (#42)
 * Parses queries like:
 *  "invoices over 5000 last month"
 *  "all Groceries invoices"
 *  "errors this week"
 *  "rejected invoices"
 *  "vendor Acme"
 */

import type { InvoiceProcessingResult, SearchResult } from './types';

export function naturalLanguageSearch(query: string, history: InvoiceProcessingResult[]): SearchResult {
  const q = query.toLowerCase().trim();
  let results = [...history];
  const appliedFilters: string[] = [];

  // ── Status filters ──
  if (q.includes('error') || q.includes('bad') || q.includes('invalid')) {
    results = results.filter(r => r.status === 'error');
    appliedFilters.push('status: errors only');
  } else if (q.includes('verified') || q.includes('clean') || q.includes('valid')) {
    results = results.filter(r => r.status === 'verified');
    appliedFilters.push('status: verified only');
  } else if (q.includes('approved')) {
    results = results.filter(r => r.status === 'approved');
    appliedFilters.push('status: approved only');
  } else if (q.includes('rejected')) {
    results = results.filter(r => r.status === 'rejected');
    appliedFilters.push('status: rejected only');
  } else if (q.includes('corrected')) {
    results = results.filter(r => r.status === 'corrected');
    appliedFilters.push('status: corrected only');
  } else if (q.includes('duplicate')) {
    results = results.filter(r => r.isDuplicate);
    appliedFilters.push('duplicates only');
  }

  // ── Amount filters ──
  const overMatch = q.match(/over\s+([\d,]+)/);
  const underMatch = q.match(/under\s+([\d,]+)/);
  const exactMatch = q.match(/exactly\s+([\d,]+)/);

  if (overMatch) {
    const threshold = parseFloat(overMatch[1].replace(/,/g, ''));
    results = results.filter(r => (r.validatedData.total || 0) > threshold);
    appliedFilters.push(`total > ${threshold}`);
  }
  if (underMatch) {
    const threshold = parseFloat(underMatch[1].replace(/,/g, ''));
    results = results.filter(r => (r.validatedData.total || 0) < threshold);
    appliedFilters.push(`total < ${threshold}`);
  }
  if (exactMatch) {
    const threshold = parseFloat(exactMatch[1].replace(/,/g, ''));
    results = results.filter(r => Math.abs((r.validatedData.total || 0) - threshold) < 0.5);
    appliedFilters.push(`total ≈ ${threshold}`);
  }

  // ── Date filters ──
  const now = new Date();
  if (q.includes('today')) {
    const today = now.toISOString().slice(0, 10);
    results = results.filter(r => r.createdAt.slice(0, 10) === today);
    appliedFilters.push('date: today');
  } else if (q.includes('this week') || q.includes('week')) {
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    results = results.filter(r => new Date(r.createdAt) >= weekAgo);
    appliedFilters.push('date: this week');
  } else if (q.includes('last month') || q.includes('this month') || q.includes('month')) {
    const monthAgo = new Date(now.getFullYear(), now.getMonth() - (q.includes('last month') ? 1 : 0), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + (q.includes('last month') ? 0 : 1), 0);
    results = results.filter(r => {
      const d = new Date(r.createdAt);
      return d >= monthAgo && d <= monthEnd;
    });
    appliedFilters.push(q.includes('last month') ? 'date: last month' : 'date: this month');
  }

  // ── Category filters ──
  const categories = ['groceries', 'office', 'transport', 'dining', 'utilities', 'electronics', 'healthcare'];
  for (const cat of categories) {
    if (q.includes(cat)) {
      results = results.filter(r => r.validatedData.category?.toLowerCase().includes(cat));
      appliedFilters.push(`category: ${cat}`);
    }
  }

  // ── Vendor/customer search ──
  const vendorMatch = q.match(/(?:vendor|from|supplier|customer)\s+([a-zA-Z0-9 ]+?)(?:\s+(?:invoice|over|under|this|last|today)|$)/);
  if (vendorMatch) {
    const vendorQuery = vendorMatch[1].trim().toLowerCase();
    results = results.filter(r => r.validatedData.customer_name?.toLowerCase().includes(vendorQuery));
    appliedFilters.push(`vendor: ${vendorMatch[1].trim()}`);
  }

  // ── Invoice number ──
  const invMatch = q.match(/inv(?:oice)?\s*#?\s*([a-zA-Z0-9-]+)/);
  if (invMatch) {
    results = results.filter(r => r.validatedData.invoice_number?.toLowerCase().includes(invMatch[1].toLowerCase()));
    appliedFilters.push(`invoice #: ${invMatch[1]}`);
  }

  // ── Overdue ──
  if (q.includes('overdue') || q.includes('due') || q.includes('late')) {
    const today = now.toISOString().slice(0, 10);
    results = results.filter(r => r.dueDate && r.dueDate < today && r.status !== 'approved');
    appliedFilters.push('overdue invoices');
  }

  const summary = results.length === 0
    ? `No invoices found matching "${query}"`
    : `Found ${results.length} invoice${results.length > 1 ? 's' : ''} — filters applied: ${appliedFilters.join(', ') || 'none'}`;

  return { invoices: results, summary };
}
