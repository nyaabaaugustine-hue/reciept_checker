'use client';

import { useMemo } from 'react';
import { X, TrendingUp, TrendingDown, CheckCircle, XCircle, AlertTriangle, Clock, BarChart2 } from 'lucide-react';
import type { InvoiceProcessingResult } from '@/lib/types';

interface WeeklySummaryProps {
  history: InvoiceProcessingResult[];
  currency: string;
  onClose: () => void;
  onSelectInvoice: (result: InvoiceProcessingResult) => void;
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date: Date): Date {
  const d = startOfWeek(date);
  d.setDate(d.getDate() + 6);
  d.setHours(23, 59, 59, 999);
  return d;
}

function formatCurrency(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function WeeklySummary({ history, currency, onClose, onSelectInvoice }: WeeklySummaryProps) {
  const now = new Date();
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(now);

  const weekInvoices = useMemo(() =>
    history.filter(inv => {
      const d = new Date(inv.createdAt);
      return d >= weekStart && d <= weekEnd;
    }),
    [history] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const stats = useMemo(() => {
    const total = weekInvoices.reduce((s, inv) => s + (inv.validatedData.total ?? 0), 0);
    const approved = weekInvoices.filter(i => i.status === 'approved').length;
    const rejected = weekInvoices.filter(i => i.status === 'rejected').length;
    const pending = weekInvoices.filter(i => i.status !== 'approved' && i.status !== 'rejected').length;
    const creditSales = weekInvoices.filter(i => i.isCreditSale);
    const creditTotal = creditSales.reduce((s, i) => s + (i.validatedData.total ?? 0), 0);
    const duplicates = weekInvoices.filter(i => i.isDuplicate).length;
    const highRisk = weekInvoices.filter(i => i.riskVerdict?.verdict === 'REJECT' || i.riskVerdict?.verdict === 'ESCALATE').length;

    // By-day breakdown
    const byDay: Record<number, { count: number; total: number }> = {};
    for (let d = 0; d < 7; d++) byDay[d] = { count: 0, total: 0 };
    weekInvoices.forEach(inv => {
      const day = new Date(inv.createdAt).getDay();
      byDay[day].count += 1;
      byDay[day].total += inv.validatedData.total ?? 0;
    });

    // Top customers
    const customerMap: Record<string, { count: number; total: number }> = {};
    weekInvoices.forEach(inv => {
      const name = inv.validatedData.customer_name?.trim() || 'Unknown';
      if (!customerMap[name]) customerMap[name] = { count: 0, total: 0 };
      customerMap[name].count += 1;
      customerMap[name].total += inv.validatedData.total ?? 0;
    });
    const topCustomers = Object.entries(customerMap)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5);

    return { total, approved, rejected, pending, creditTotal, creditSales: creditSales.length, duplicates, highRisk, byDay, topCustomers };
  }, [weekInvoices]);

  const maxDayTotal = Math.max(...Object.values(stats.byDay).map(d => d.total), 1);

  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

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
          <div className="flex items-center gap-2">
            <BarChart2 className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-base font-bold leading-tight">Weekly Summary</h2>
              <p className="text-xs text-muted-foreground">{weekLabel}</p>
            </div>
          </div>
          <button className="rounded-full p-2 hover:bg-muted transition-colors" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto" style={{ maxHeight: 'calc(90dvh - 72px)' }}>
          <div className="px-5 py-4 space-y-5">

            {weekInvoices.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                <BarChart2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p className="font-medium">No invoices this week</p>
                <p className="text-sm mt-1">Start scanning to see your summary here.</p>
              </div>
            ) : (
              <>
                {/* KPI row */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-primary/10 rounded-2xl p-4">
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Total Value</p>
                    <p className="text-xl font-bold text-primary mt-1 leading-tight">{formatCurrency(stats.total, currency)}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{weekInvoices.length} invoice{weekInvoices.length !== 1 ? 's' : ''}</p>
                  </div>
                  <div className="bg-muted rounded-2xl p-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
                      <span className="text-sm font-semibold">{stats.approved} Approved</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
                      <span className="text-sm font-semibold">{stats.rejected} Rejected</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-amber-500 flex-shrink-0" />
                      <span className="text-sm font-semibold">{stats.pending} Pending</span>
                    </div>
                  </div>
                </div>

                {/* Alerts row */}
                {(stats.highRisk > 0 || stats.duplicates > 0 || stats.creditSales > 0) && (
                  <div className="space-y-2">
                    {stats.highRisk > 0 && (
                      <div className="flex items-center gap-3 bg-red-500/10 rounded-xl px-4 py-2.5">
                        <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0" />
                        <span className="text-sm font-medium text-red-600 dark:text-red-400">{stats.highRisk} high-risk invoice{stats.highRisk !== 1 ? 's' : ''} this week</span>
                      </div>
                    )}
                    {stats.duplicates > 0 && (
                      <div className="flex items-center gap-3 bg-amber-500/10 rounded-xl px-4 py-2.5">
                        <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                        <span className="text-sm font-medium text-amber-700 dark:text-amber-400">{stats.duplicates} duplicate{stats.duplicates !== 1 ? 's' : ''} detected</span>
                      </div>
                    )}
                    {stats.creditSales > 0 && (
                      <div className="flex items-center gap-3 bg-blue-500/10 rounded-xl px-4 py-2.5">
                        <TrendingUp className="h-4 w-4 text-blue-500 flex-shrink-0" />
                        <span className="text-sm font-medium text-blue-700 dark:text-blue-400">
                          {stats.creditSales} credit sale{stats.creditSales !== 1 ? 's' : ''} · {formatCurrency(stats.creditTotal, currency)} outstanding
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Daily bar chart */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Daily Activity</p>
                  <div className="flex items-end gap-1.5 h-24">
                    {DAY_LABELS.map((label, idx) => {
                      const dayData = stats.byDay[idx];
                      const heightPct = dayData.total > 0 ? Math.max((dayData.total / maxDayTotal) * 100, 8) : 0;
                      const isToday = new Date().getDay() === idx;
                      return (
                        <div key={label} className="flex-1 flex flex-col items-center gap-1">
                          <div className="w-full flex items-end" style={{ height: '72px' }}>
                            <div
                              className={`w-full rounded-t-md transition-all ${isToday ? 'bg-primary' : 'bg-primary/30'}`}
                              style={{ height: `${heightPct}%` }}
                            />
                          </div>
                          <span className={`text-[10px] font-medium ${isToday ? 'text-primary' : 'text-muted-foreground'}`}>{label}</span>
                          {dayData.count > 0 && (
                            <span className="text-[9px] text-muted-foreground leading-none">{dayData.count}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Top customers */}
                {stats.topCustomers.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Top Customers</p>
                    <div className="space-y-2">
                      {stats.topCustomers.map(([name, data]) => (
                        <div key={name} className="flex items-center justify-between gap-3 bg-muted rounded-xl px-4 py-2.5">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{name}</p>
                            <p className="text-xs text-muted-foreground">{data.count} invoice{data.count !== 1 ? 's' : ''}</p>
                          </div>
                          <span className="text-sm font-bold text-primary flex-shrink-0">{formatCurrency(data.total, currency)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recent invoices */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">This Week's Invoices</p>
                  <div className="space-y-2">
                    {weekInvoices.slice(0, 10).map(inv => {
                      const verdict = inv.riskVerdict?.verdict;
                      const verdictColor =
                        verdict === 'REJECT' ? 'text-red-500' :
                        verdict === 'ESCALATE' ? 'text-orange-500' :
                        verdict === 'CAUTION' ? 'text-amber-500' :
                        'text-green-500';
                      return (
                        <button
                          key={inv.id}
                          className="w-full text-left flex items-center gap-3 bg-muted rounded-xl px-4 py-2.5 active:scale-[0.98] transition-transform"
                          onClick={() => { onSelectInvoice(inv); onClose(); }}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{inv.validatedData.customer_name || 'Unknown customer'}</p>
                            <p className="text-xs text-muted-foreground truncate">
                              #{inv.validatedData.invoice_number || '—'} · {new Date(inv.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                            </p>
                          </div>
                          <div className="flex-shrink-0 text-right">
                            <p className="text-sm font-bold">{formatCurrency(inv.validatedData.total ?? 0, currency)}</p>
                            {verdict && <p className={`text-xs font-semibold ${verdictColor}`}>{verdict}</p>}
                          </div>
                        </button>
                      );
                    })}
                    {weekInvoices.length > 10 && (
                      <p className="text-xs text-center text-muted-foreground pt-1">+ {weekInvoices.length - 10} more — open History to see all</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
