import { useEffect, useRef } from 'react';
import type { InvoiceProcessingResult } from '@/lib/types';

/**
 * Checks credit sale invoices that are past their due date and fires a
 * toast notification once per session per invoice.
 */
export function useCreditDueNotifications(
  history: InvoiceProcessingResult[],
  notify: (title: string, description: string) => void,
) {
  const notifiedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!history.length) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    history.forEach(inv => {
      if (!inv.isCreditSale) return;
      if (!inv.dueDate) return;
      if (inv.status === 'approved' || inv.status === 'rejected') return;
      if (notifiedIds.current.has(inv.id)) return;

      const due = new Date(inv.dueDate);
      due.setHours(0, 0, 0, 0);

      const diffDays = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

      if (diffDays < 0) {
        // Overdue
        notifiedIds.current.add(inv.id);
        notify(
          `⚠️ Overdue Credit — ${inv.validatedData.customer_name || 'Customer'}`,
          `Invoice #${inv.validatedData.invoice_number || '—'} was due on ${due.toLocaleDateString()}. Payment not yet collected.`,
        );
      } else if (diffDays === 0) {
        // Due today
        notifiedIds.current.add(inv.id);
        notify(
          `📅 Credit Due Today — ${inv.validatedData.customer_name || 'Customer'}`,
          `Invoice #${inv.validatedData.invoice_number || '—'} is due for payment today.`,
        );
      } else if (diffDays <= 2) {
        // Due soon
        notifiedIds.current.add(inv.id);
        notify(
          `🔔 Credit Due Soon — ${inv.validatedData.customer_name || 'Customer'}`,
          `Invoice #${inv.validatedData.invoice_number || '—'} is due in ${diffDays} day${diffDays !== 1 ? 's' : ''}.`,
        );
      }
    });
  }, [history]); // eslint-disable-line react-hooks/exhaustive-deps
}
