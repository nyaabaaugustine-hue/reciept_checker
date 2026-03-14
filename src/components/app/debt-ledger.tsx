'use client';

import { useMemo } from 'react';
import { X, AlertOctagon, CalendarClock, PhoneCall, TrendingUp } from 'lucide-react';
import type { InvoiceProcessingResult } from '@/lib/types';
import { normaliseVendorKey, daysUntilDue, dueDateStatus } from '@/lib/invoice-intelligence';

interface DebtLedgerProps {
  history: InvoiceProcessingResult[];
  currency: string;
  onClose: () => void;
  onSelectInvoice: (result: InvoiceProcessingResult) => void;
}

interface DebtEntry {
  customerName: string;
  vendorKey: string;
  totalOwed: number;
  invoiceCount: number;
  invoices: InvoiceProcessingResult[];
  oldestDate: string;
  mostOverdueDays: number | null;
}

export function DebtLedger({ history, currency, onClose, onSelectInvoice }: DebtLedgerProps) {
  const debtors = useMemo(() => {
    const map: Record<string, DebtEntry> = {};

    history.forEach(inv => {
      if (!inv.isCreditSale) return;
      if (inv.status === 'approved' || inv.status === 'rejected') return;

      const key = normaliseVendorKey(inv.validatedData.customer_name);
      const name = inv.validatedData.customer_name?.trim() || 'Unknown Customer';

      if (!map[key]) {
        map[key] = {
          customerName: name,
          vendorKey: key,
          totalOwed: 0,
          invoiceCount: 0,
          invoices: [],
          oldestDate: inv.createdAt,
          mostOverdueDays: null,
        };
      }

      const entry = map[key];
      entry.totalOwed += inv.validatedData.total ?? 0;
      entry.invoiceCount++;
      entry.invoices.push(inv);
      if (inv.createdAt < entry.oldestDate) entry.oldestDate = inv.createdAt;

      const days = daysUntilDue(inv.dueDate);
      if (days !== null && days < 0) {
        const overdueDays = Math.abs(days);
        if (entry.mostOverdueDays === null || overdueDays > entry.mostOverdueDays) {
          entry.mostOverdueDays = overdueDays;
        }
      }
    });

    return Object.values(map).sort((a, b) => b.totalOwed - a.totalOwed);
  }, [history]);

  const totalOwed = debtors.reduce((s, d) => s + d.totalOwed, 0);
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative bg-card w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden animate-fade-in-up"
        style={{ maxHeight: '90dvh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b">
          <div>
            <h2 className="text-base font-bold">Customer Debt Ledger</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Unpaid credit sales only</p>
          </div>
          <button className="rounded-full p-2 hover:bg-muted" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto" style={{ maxHeight: 'calc(90dvh - 72px)' }}>
          <div className="px-5 py-4 space-y-4">

            {debtors.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <TrendingUp className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p className="font-medium">No outstanding credit debts</p>
                <p className="text-sm mt-1">All credit sales have been settled.</p>
              </div>
            ) : (
              <>
                {/* Summary */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-red-50 dark:bg-red-950/30 border-2 border-red-300 rounded-2xl p-4">
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Total Outstanding</p>
                    <p className="text-xl font-black text-red-600 mt-1">{currency} {fmt(totalOwed)}</p>
                  </div>
                  <div className="bg-muted rounded-2xl p-4">
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Customers Owing</p>
                    <p className="text-xl font-black mt-1">{debtors.length}</p>
                  </div>
                </div>

                {/* Debtor list */}
                <div className="space-y-3">
                  {debtors.map((debtor, idx) => (
                    <div key={debtor.vendorKey} className="rounded-2xl border-2 border-border overflow-hidden">
                      {/* Customer header */}
                      <div className={`px-4 py-3 flex items-center justify-between gap-3 ${debtor.mostOverdueDays ? 'bg-red-50 dark:bg-red-950/20 border-b border-red-200 dark:border-red-800' : 'bg-muted/50 border-b'}`}>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0">{idx + 1}</span>
                            <p className="font-bold text-sm truncate">{debtor.customerName}</p>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 ml-8">
                            {debtor.invoiceCount} invoice{debtor.invoiceCount !== 1 ? 's' : ''} · Since {new Date(debtor.oldestDate).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-base font-black text-red-600">{currency} {fmt(debtor.totalOwed)}</p>
                          {debtor.mostOverdueDays && (
                            <p className="text-xs font-bold text-red-500 flex items-center gap-1 justify-end">
                              <AlertOctagon className="h-3 w-3" /> {debtor.mostOverdueDays}d overdue
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Individual invoices */}
                      <div className="divide-y divide-border">
                        {debtor.invoices.map(inv => {
                          const days = daysUntilDue(inv.dueDate);
                          const dStatus = dueDateStatus(days);
                          return (
                            <button
                              key={inv.id}
                              className="w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-muted/50 active:scale-[0.99] transition-transform"
                              onClick={() => { onSelectInvoice(inv); onClose(); }}
                            >
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-muted-foreground">
                                  #{inv.validatedData.invoice_number || '—'} · {new Date(inv.createdAt).toLocaleDateString()}
                                </p>
                                {inv.dueDate && (
                                  <p className={`text-xs font-semibold flex items-center gap-1 mt-0.5 ${dStatus === 'overdue' ? 'text-red-500' : dStatus === 'due-soon' ? 'text-amber-500' : 'text-muted-foreground'}`}>
                                    <CalendarClock className="h-3 w-3" />
                                    {dStatus === 'overdue' ? `${Math.abs(days!)}d overdue` : dStatus === 'due-soon' ? `Due in ${days}d` : `Due ${new Date(inv.dueDate).toLocaleDateString()}`}
                                  </p>
                                )}
                              </div>
                              <p className="text-sm font-bold flex-shrink-0">{currency} {fmt(inv.validatedData.total ?? 0)}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
