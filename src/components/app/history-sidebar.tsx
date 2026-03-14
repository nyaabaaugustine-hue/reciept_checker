'use client';

import { useState, useMemo, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { InvoiceProcessingResult } from '@/lib/types';
import { daysUntilDue, dueDateStatus } from '@/lib/invoice-intelligence';
import { FileText, ImageIcon, AlertOctagon, CalendarClock, StickyNote, Trash2 } from 'lucide-react';

interface HistorySidebarProps {
  history: InvoiceProcessingResult[];
  onSelect: (result: InvoiceProcessingResult) => void;
  onClear: () => void;
  isOpen: boolean;
  inline?: boolean; // when true: no fixed positioning, used inside mobile drawer
}

const statusColour: Record<string, string> = {
  verified: 'text-green-600',
  error: 'text-red-600',
  corrected: 'text-yellow-600',
  approved: 'text-blue-600',
  rejected: 'text-gray-500',
};

const statusBg: Record<string, string> = {
  verified: 'bg-green-100 dark:bg-green-900/30',
  error: 'bg-red-100 dark:bg-red-900/30',
  corrected: 'bg-yellow-100 dark:bg-yellow-900/30',
  approved: 'bg-blue-100 dark:bg-blue-900/30',
  rejected: 'bg-gray-100 dark:bg-gray-800',
};

export const HistorySidebar = ({ history, onSelect, onClear, isOpen, inline = false }: HistorySidebarProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isClient, setIsClient] = useState(false);

  useEffect(() => { setIsClient(true); }, []);

  const filteredHistory = useMemo(() => {
    if (!searchTerm) return history;
    const q = searchTerm.toLowerCase();
    return history.filter(item =>
      item.validatedData.invoice_number?.toLowerCase().includes(q) ||
      item.validatedData.customer_name?.toLowerCase().includes(q) ||
      item.validatedData.category?.toLowerCase().includes(q) ||
      item.status.toLowerCase().includes(q) ||
      item.smartName?.toLowerCase().includes(q) ||
      item.notes?.toLowerCase().includes(q)
    );
  }, [history, searchTerm]);

  if (!isOpen) return null;

  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const content = (
    <div className={inline ? 'p-3 space-y-3' : 'w-72 xl:w-80 border-l p-3 flex flex-col gap-3 no-print overflow-y-auto'}>
      {/* Search */}
      {isClient && history.length > 0 && (
        <Input
          placeholder="Search name, invoice #, category..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full"
          style={{ fontSize: 16 }}
        />
      )}

      {/* Clear all */}
      {isClient && history.length > 0 && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" className="w-full text-destructive border-destructive/30 hover:bg-destructive/10">
              <Trash2 className="h-4 w-4 mr-2" /> Clear All History
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Clear all history?</AlertDialogTitle>
              <AlertDialogDescription>This permanently deletes all scanned invoices.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onClear}>Clear</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Empty state */}
      {(!isClient || history.length === 0) && (
        <div className="text-center text-muted-foreground py-12 space-y-3">
          <ImageIcon className="mx-auto h-12 w-12 opacity-20" />
          <p className="text-sm font-medium">No invoices scanned yet</p>
          <p className="text-xs">Use the Scan button to get started</p>
        </div>
      )}

      {/* Invoice list */}
      {isClient && history.length > 0 && (
        <div className="space-y-2">
          {filteredHistory.map(item => {
            const dueDays = daysUntilDue(item.dueDate);
            const dueStatus = dueDateStatus(dueDays);
            const isOverdue = dueStatus === 'overdue';
            const isDueSoon = dueStatus === 'due-soon';

            return (
              <button
                key={item.id}
                onClick={() => onSelect(item)}
                className="w-full text-left"
                style={{ minHeight: 72 }}
              >
                <Card className={`transition-colors active:scale-[0.98] ${item.isDuplicate ? 'border-red-400 bg-red-50/30 dark:bg-red-950/20' : 'hover:bg-muted'} ${isOverdue ? 'border-orange-400' : ''}`}>
                  <CardContent className="p-3 space-y-1">
                    {/* Row 1: name + total */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {item.isDuplicate && <AlertOctagon className="h-4 w-4 text-red-500 flex-shrink-0" />}
                        <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <p className="font-semibold text-sm truncate">
                          {item.validatedData.customer_name || 'Unknown Customer'}
                        </p>
                      </div>
                      <p className="text-sm font-bold flex-shrink-0">
                        {item.validatedData.total !== undefined ? fmt(item.validatedData.total) : '—'}
                      </p>
                    </div>

                    {/* Row 2: invoice # + status + health */}
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground truncate">
                        {item.validatedData.invoice_number ? `#${item.validatedData.invoice_number}` : 'No invoice #'}
                        {item.validatedData.category ? ` · ${item.validatedData.category}` : ''}
                      </p>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {item.healthScore !== undefined && (
                          <span className={`text-xs font-mono ${item.healthScore >= 85 ? 'text-green-600' : item.healthScore >= 50 ? 'text-yellow-600' : 'text-red-600'}`}>
                            {item.healthScore}
                          </span>
                        )}
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${statusBg[item.status]} ${statusColour[item.status]}`}>
                          {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                        </span>
                      </div>
                    </div>

                    {/* Row 3: due date / notes / recurring */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {isOverdue && (
                        <Badge variant="destructive" className="text-xs flex items-center gap-1 h-5 px-1.5">
                        <CalendarClock className="h-3 w-3" /> {dueDays !== null ? Math.abs(dueDays) : 0}d overdue
                        </Badge>
                      )}
                      {isDueSoon && (
                        <Badge variant="outline" className="text-xs text-orange-600 border-orange-300 flex items-center gap-1 h-5 px-1.5">
                          <CalendarClock className="h-3 w-3" /> Due {dueDays}d
                        </Badge>
                      )}
                      {item.notes && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1 truncate max-w-[140px]">
                          <StickyNote className="h-3 w-3 flex-shrink-0" />{item.notes}
                        </span>
                      )}
                      {item.isRecurring && item.recurringDelta !== undefined && Math.abs(item.recurringDelta) > 10 && (
                        <span className="text-xs text-purple-600 font-medium">
                          {item.recurringDelta > 0 ? `+${item.recurringDelta}%` : `${item.recurringDelta}%`}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </button>
            );
          })}

          {filteredHistory.length === 0 && searchTerm && (
            <p className="text-center text-sm text-muted-foreground py-8">No results for "{searchTerm}"</p>
          )}
        </div>
      )}
    </div>
  );

  // On desktop: render as a sidebar
  if (!inline) {
    return (
      <aside className="hidden lg:block w-72 xl:w-80 border-l overflow-y-auto no-print" role="complementary">
        <div className="p-3 border-b">
          <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">History ({history.length})</h2>
        </div>
        {content}
      </aside>
    );
  }

  return content;
};
