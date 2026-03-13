import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import Papa from "papaparse";
import type { ValidatedData, InvoiceProcessingResult } from "@/lib/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function download(filename: string, text: string, mimeType: string) {
  const element = document.createElement("a");
  element.setAttribute("href", `data:${mimeType};charset=utf-8,` + encodeURIComponent(text));
  element.setAttribute("download", filename);
  element.style.display = "none";
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}

// #45 — currency-aware number formatting
export function fmtCurrency(n: number, currency = 'GHS'): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    // Fallback for unknown currency codes
    return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

export function exportToJson(data: ValidatedData) {
  const jsonData = JSON.stringify(data, null, 2);
  download(`invoice-data-${data.invoice_number || 'N_A'}.json`, jsonData, 'application/json');
}

export function exportToCsv(data: ValidatedData) {
  const { items, ...mainData } = data;
  const mainDataSanitized = Object.fromEntries(
    Object.entries(mainData).map(([k, v]) => [k, String(v ?? '')])
  );

  if (!items || items.length === 0) {
    const csv = Papa.unparse([mainDataSanitized]);
    download(`invoice-summary-${data.invoice_number || 'N_A'}.csv`, csv, 'text/csv');
    return;
  }

  const itemsWithMainData = items.map(item => ({
    ...mainDataSanitized,
    item_name: item.name,
    item_quantity: item.quantity,
    item_unit_price: item.unit_price,
    item_line_total: item.line_total,
  }));

  const csv = Papa.unparse(itemsWithMainData);
  download(`invoice-details-${data.invoice_number || 'N_A'}.csv`, csv, 'text/csv');
}

// #7 — Export ALL history as JSON backup
export function exportAllHistory(history: InvoiceProcessingResult[], salesmanName = '') {
  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: salesmanName || 'InvoiceGuard User',
    version: '2.0',
    count: history.length,
    invoices: history,
  };
  const date = new Date().toISOString().split('T')[0];
  download(`InvoiceGuard_Backup_${date}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

// #7 — Import history from JSON backup — returns parsed array or throws
export async function importHistory(file: File): Promise<InvoiceProcessingResult[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const parsed = JSON.parse(text);
        // Support both wrapped export format and raw array
        const invoices: InvoiceProcessingResult[] = Array.isArray(parsed)
          ? parsed
          : parsed?.invoices;
        if (!Array.isArray(invoices)) throw new Error('Invalid backup file format.');
        resolve(invoices);
      } catch (err: any) {
        reject(new Error(`Could not import: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// #39 — Share invoice summary as text (WhatsApp / SMS / Email)
export function buildShareText(result: InvoiceProcessingResult, currency = 'GHS'): string {
  const d = result.validatedData;
  const total = d.total !== undefined ? fmtCurrency(d.total, currency) : '?';
  const status = result.status.toUpperCase();
  const errors = result.errors.length > 0
    ? `\n⚠️ Issues:\n${result.errors.map(e => `  • ${e.message}`).join('\n')}`
    : '\n✅ No issues found.';
  return [
    `🛡️ InvoiceGuard AI Report`,
    `Customer: ${d.customer_name || 'Unknown'}`,
    `Invoice #: ${d.invoice_number || 'N/A'}`,
    `Date: ${d.date || 'N/A'}`,
    `Total: ${total}`,
    `Status: ${status}`,
    `Health: ${result.healthScore ?? 0}/100`,
    errors,
  ].join('\n');
}

// #40 — Share via WhatsApp
export function shareViaWhatsApp(result: InvoiceProcessingResult, currency = 'GHS') {
  const text = encodeURIComponent(buildShareText(result, currency));
  window.open(`https://wa.me/?text=${text}`, '_blank');
}

// #41 — Share via native share sheet (falls back to clipboard)
export async function shareNative(result: InvoiceProcessingResult, currency = 'GHS'): Promise<boolean> {
  const text = buildShareText(result, currency);
  if (navigator.share) {
    try {
      await navigator.share({ title: 'InvoiceGuard Report', text });
      return true;
    } catch { /* user cancelled */ }
  }
  // Fallback: copy to clipboard
  try {
    await navigator.clipboard.writeText(text);
    return false; // false = used clipboard fallback
  } catch {
    return false;
  }
}

// #43 — Email daily report
export function emailDailyReport(summaryText: string, salesmanName = '') {
  const subject = encodeURIComponent(`InvoiceGuard Daily Report — ${new Date().toLocaleDateString()}`);
  const body = encodeURIComponent(
    `${salesmanName ? `Report by: ${salesmanName}\n` : ''}${summaryText}`
  );
  window.open(`mailto:?subject=${subject}&body=${body}`);
}

// #42 — Print clean receipt
export function printInvoice() {
  window.print();
}
