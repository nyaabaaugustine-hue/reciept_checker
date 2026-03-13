'use client';

import { useState, useMemo } from 'react';
import type { InvoiceProcessingResult, ValidatedData } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { calcHealthScore, healthLabel, daysUntilDue, dueDateStatus } from '@/lib/invoice-intelligence';
import { shareViaWhatsApp, shareNative } from '@/lib/utils';
import { HealthScoreBadge } from './health-score-badge';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle, XCircle, Copy, FileText,
  BookOpen, AlertTriangle, ShieldAlert, BadgeCheck,
  ThumbsUp, ThumbsDown, CalendarClock, StickyNote,
  RefreshCw, AlertOctagon, ChevronDown, ChevronUp,
  Share2, MessageCircle, Calculator,
} from 'lucide-react';
import { ExportMenu } from './export-menu';

interface ResultsViewProps {
  result: InvoiceProcessingResult;
  onReset: () => void;
  onUpdate: (id: string, data: ValidatedData) => void;
  onNotesUpdate: (id: string, notes: string) => void;
  onDueDateUpdate: (id: string, dueDate: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => void;
  currency?: string;
}

function buildStory(data: ValidatedData, errors: InvoiceProcessingResult['errors'], isValid: boolean) {
  const customer = data.customer_name || 'unknown customer';
  const invoiceNo = data.invoice_number ? `#${data.invoice_number}` : '(no invoice number)';
  const date = data.date || 'unspecified date';
  const total = data.total !== undefined
    ? data.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '?.??';
  const itemCount = data.items?.length || 0;
  const category = data.category || 'General';
  const topItems = (data.items || []).filter(i => i.name).slice(0, 3)
    .map(i => `${i.quantity !== undefined ? `${i.quantity}× ` : ''}${i.name}${i.line_total !== undefined ? ` (${i.line_total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : ''}`);
  const biggest = (data.items || []).filter(i => i.line_total !== undefined).sort((a, b) => (b.line_total || 0) - (a.line_total || 0))[0];

  const paragraphs: string[] = [
    `Invoice ${invoiceNo} from ${customer}, dated ${date}. Category: "${category}". ${itemCount} line item${itemCount !== 1 ? 's' : ''}.`,
  ];
  if (topItems.length) paragraphs.push(`Key items: ${topItems.join(', ')}${itemCount > 3 ? ` + ${itemCount - 3} more` : ''}.`);
  if (data.subtotal !== undefined && data.tax !== undefined) {
    paragraphs.push(`Subtotal ${data.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })} + tax ${data.tax.toLocaleString(undefined, { minimumFractionDigits: 2 })} = ${total}.`);
  } else {
    paragraphs.push(`Grand total: ${total}.`);
  }
  if (biggest) {
    const pct = data.total ? Math.round(((biggest.line_total || 0) / data.total) * 100) : null;
    paragraphs.push(`Biggest item: "${biggest.name}"${pct !== null ? ` (${pct}% of total)` : ''}.`);
  }

  const warnings: string[] = [];
  const actions: string[] = [];

  if (!isValid) {
    errors.forEach(err => {
      if (err.field === 'invoice_number') { warnings.push('No invoice number — cannot be tracked or disputed.'); actions.push('Request a proper invoice number before accepting payment.'); }
      else if (err.field === 'customer_name') { warnings.push('Customer name missing — identity unverifiable.'); actions.push('Confirm customer identity before proceeding.'); }
      else if (err.field === 'total') { warnings.push('Grand total unreadable — wrong amount risk.'); actions.push('Confirm the total before receiving money.'); }
      else if (err.field === 'items') { warnings.push('No line items — cannot verify what you are being paid for.'); actions.push('Request a fully itemised invoice.'); }
      else if (err.field.includes('line_total')) { warnings.push('Line item calculation error — possible overcharge.'); actions.push('Check every line: qty × unit price must match line total.'); }
      else if (err.field === 'subtotal') { warnings.push('Items do not add up to the stated subtotal.'); actions.push('Return the invoice for correction before receiving money.'); }
      else if (err.field === 'tax') { warnings.push('Tax rate is unusual for this region.'); actions.push('Verify the tax amount before receiving money.'); }
      else if (err.field === 'date') { warnings.push(err.message); actions.push('Confirm the invoice date with the customer.'); }
      else if (err.field === 'price_memory') { warnings.push(err.message); actions.push('Query the price change with the customer before approving.'); }
    });
  } else {
    actions.push('All figures verified. Safe to collect payment.');
    actions.push(`File under "${category}" in your records.`);
  }

  const headline = isValid
    ? `✅ ${customer} — ${total} is verified. Safe to collect.`
    : `⚠️ ${customer} — ${errors.length} issue${errors.length !== 1 ? 's' : ''} found. Do NOT accept payment yet.`;

  return { headline, paragraphs, warnings, actions };
}

export const ResultsView = ({
  result, onReset, onUpdate, onNotesUpdate, onDueDateUpdate, onApprove, onReject, currency = 'GHS',
}: ResultsViewProps) => {
  const { toast } = useToast();
  const [editedData, setEditedData] = useState<ValidatedData>(JSON.parse(JSON.stringify(result.validatedData)));
  const [isEditing, setIsEditing] = useState(false);
  const [notes, setNotes] = useState(result.notes || '');
  const [dueDate, setDueDate] = useState(result.dueDate || '');
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showAILog, setShowAILog] = useState(false);

  const errorFields = useMemo(() => {
    const fields = new Set<string>();
    result.errors?.forEach(err => {
      fields.add(err.field);
      if (err.field === 'total') { fields.add('subtotal'); fields.add('tax'); }
      if (err.field === 'subtotal') editedData.items?.forEach((_, i) => fields.add(`items[${i}].line_total`));
    });
    return fields;
  }, [result.errors, editedData.items]);

  const { isSubtotalMatching, isTotalMatching } = useMemo(() => {
    const sumItems = (editedData.items || []).reduce((a, i) => a + (Number((i as any).line_total) || 0), 0);
    const sumTotal = (Number((editedData as any).subtotal) || 0) + (Number((editedData as any).tax) || 0);
    return {
      isSubtotalMatching: (editedData as any).subtotal !== undefined && Math.abs(sumItems - Number((editedData as any).subtotal)) < 0.01,
      isTotalMatching: (editedData as any).total !== undefined && Math.abs(sumTotal - Number((editedData as any).total)) < 0.01,
    };
  }, [editedData]);

  const story = useMemo(() => buildStory(editedData, result.errors, result.isValid), [editedData, result.errors, result.isValid]);
  const health = healthLabel(result.healthScore ?? calcHealthScore(result));
  const dueDays = daysUntilDue(dueDate || result.dueDate);

  // #22 — suggested correct total when mismatch detected
  const suggestedTotal = useMemo(() => {
    const sub = editedData.subtotal;
    const tax = editedData.tax;
    if (sub !== undefined && tax !== undefined) return sub + tax;
    const itemSum = (editedData.items || []).reduce((s, i) => s + (i.line_total || 0), 0);
    return itemSum || undefined;
  }, [editedData]);
  const dueStatus = dueDateStatus(dueDays);
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleFieldChange = (field: keyof Omit<ValidatedData, 'items'>, value: string) => {
    setEditedData(prev => ({ ...prev, [field]: value as any }));
    setIsEditing(true);
  };
  const handleItemChange = (index: number, field: string, value: string) => {
    setEditedData(prev => {
      const items = [...(prev.items || [])];
      if (!items[index]) return prev;
      items[index] = { ...items[index], [field]: value } as any;
      return { ...prev, items };
    });
    setIsEditing(true);
  };
  const handleSave = () => {
    const numericData = {
      ...editedData,
      items: editedData.items?.map(item => ({
        ...item,
        quantity: Number((item as any).quantity) || undefined,
        unit_price: Number((item as any).unit_price) || undefined,
        line_total: Number((item as any).line_total) || undefined,
      })),
      subtotal: Number((editedData as any).subtotal) || undefined,
      tax: Number((editedData as any).tax) || undefined,
      total: Number((editedData as any).total) || undefined,
    };
    onUpdate(result.id, numericData);
    setIsEditing(false);
    toast({ title: 'Saved ✓' });
  };
  const handleNotesSave = () => { onNotesUpdate(result.id, notes); toast({ title: 'Note saved ✓' }); };
  const handleDueDateSave = () => { onDueDateUpdate(result.id, dueDate); toast({ title: 'Due date set ✓' }); };
  const handleRejectConfirm = () => {
    if (!rejectReason.trim()) { toast({ variant: 'destructive', title: 'Enter a reason first' }); return; }
    onReject(result.id, rejectReason);
    setShowRejectInput(false);
  };

  const isApproved = result.status === 'approved';
  const isRejected = result.status === 'rejected';
  const canAct = !isApproved && !isRejected;

  // ── VERDICT COLOURS ──
  const verdictBg = isApproved ? 'bg-blue-600' : isRejected ? 'bg-gray-500' : result.isValid ? 'bg-green-600' : 'bg-red-600';
  const verdictText = isApproved ? 'Approved — Safe to Collect' : isRejected ? 'Invoice Rejected' : result.isValid ? '✅ Verified — Collect Payment' : '⛔ Errors — Do NOT Accept';

  return (
    // Extra bottom padding so sticky bar doesn't cover content
    <div className="w-full space-y-4 animate-fade-in-up pb-36">

      {/* ── VERDICT BANNER — full width, huge, unmissable ── */}
      <div className={`rounded-2xl ${verdictBg} text-white p-5 space-y-2`}>
        <p className="text-xl font-black leading-tight">{verdictText}</p>
        <p className="text-sm opacity-90 leading-snug">{story.headline}</p>

        {/* Health + badges row */}
        <div className="flex flex-wrap gap-2 pt-1">
          <span className={`text-xs font-bold px-3 py-1 rounded-full bg-white/20`}>
            Health {result.healthScore ?? calcHealthScore(result)}/100 — {health.label}
          </span>
          {result.isDuplicate && (
            <span className="text-xs font-bold px-3 py-1 rounded-full bg-red-900/60 flex items-center gap-1">
              <AlertOctagon className="h-3 w-3" /> DUPLICATE
            </span>
          )}
          {result.isRecurring && (
            <span className="text-xs font-bold px-3 py-1 rounded-full bg-purple-700/60 flex items-center gap-1">
              <RefreshCw className="h-3 w-3" /> Recurring {result.recurringDelta !== undefined && result.recurringDelta !== 0 ? `(${result.recurringDelta > 0 ? '+' : ''}${result.recurringDelta}%)` : ''}
            </span>
          )}
          {dueStatus !== 'none' && (
            <span className={`text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1 ${dueStatus === 'overdue' ? 'bg-red-900/60' : dueStatus === 'due-soon' ? 'bg-orange-500/60' : 'bg-white/20'}`}>
              <CalendarClock className="h-3 w-3" />
              {dueStatus === 'overdue' ? `${Math.abs(dueDays!)}d OVERDUE` : `Due in ${dueDays}d`}
            </span>
          )}
          {isApproved && result.approvedAt && (
            <span className="text-xs opacity-75">{new Date(result.approvedAt).toLocaleString()}</span>
          )}
          {isRejected && result.rejectionReason && (
            <span className="text-xs opacity-75">Reason: {result.rejectionReason}</span>
          )}
        </div>
      </div>

      {/* ── HEALTH SCORE BREAKDOWN BADGE (#27) ── */}
      <div className="flex flex-wrap gap-2">
        <HealthScoreBadge result={result} />
      </div>

      {/* ── PARTIAL PAYMENT ALERT (#30) ── */}
      {result.isPartialPayment && result.partialPaymentOriginalTotal !== undefined && (
        <div className="rounded-2xl border-2 border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30 p-4 flex items-start gap-3">
          <Calculator className="h-6 w-6 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-black text-yellow-700 dark:text-yellow-400 text-base">Possible Partial Payment</p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
              Same invoice number exists with a higher total of {fmt(result.partialPaymentOriginalTotal)}.
              Verify with customer whether this is a partial payment.
            </p>
          </div>
        </div>
      )}

      {/* ── DUPLICATE ALERT ── */}
      {result.isDuplicate && (
        <div className="rounded-2xl border-2 border-red-500 bg-red-50 dark:bg-red-950/40 p-4 flex items-start gap-3">
          <AlertOctagon className="h-7 w-7 text-red-600 flex-shrink-0" />
          <div>
            <p className="font-black text-red-700 dark:text-red-400 text-base">Duplicate Invoice!</p>
            <p className="text-sm text-red-600 dark:text-red-300 mt-1">This invoice matches one already in your history. Do NOT collect payment twice — contact the customer immediately.</p>
          </div>
        </div>
      )}

      {/* ── SUGGESTED CORRECT TOTAL (#22) ── */}
      {!result.isValid && suggestedTotal !== undefined && editedData.total !== undefined && Math.abs(suggestedTotal - editedData.total) > 0.01 && (
        <div className="rounded-2xl border-2 border-blue-300 bg-blue-50 dark:bg-blue-950/30 p-4 flex items-center justify-between gap-3">
          <div>
            <p className="font-bold text-blue-700 dark:text-blue-400 text-sm">Suggested Correct Total</p>
            <p className="text-xs text-blue-600 dark:text-blue-300 mt-0.5">Based on subtotal + tax from this invoice</p>
          </div>
          <span className="text-2xl font-black text-blue-700 dark:text-blue-300">{fmt(suggestedTotal)}</span>
        </div>
      )}

      {/* ── ERROR LIST ── */}
      {!result.isValid && result.errors.length > 0 && (
        <div className="rounded-2xl border-2 border-red-400 bg-red-50 dark:bg-red-950/30 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-red-200 dark:border-red-800">
            <div className="flex items-center gap-2">
              <XCircle className="h-6 w-6 text-red-600" />
              <span className="font-bold text-red-700 dark:text-red-400 text-base">{result.errors.length} Error{result.errors.length !== 1 ? 's' : ''} Found</span>
            </div>
            <button
              className="text-xs text-muted-foreground flex items-center gap-1 px-3 py-2 rounded-xl border active:scale-95"
              onClick={() => { navigator.clipboard.writeText(result.errors.map(e => e.message).join('\n')); toast({ title: 'Copied' }); }}
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
          </div>
          <div className="p-3 space-y-2">
            {result.errors.map((err, i) => (
              <div key={i} className="flex items-start gap-3 bg-white dark:bg-red-950/40 rounded-xl p-3 border border-red-200 dark:border-red-800">
                <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800 dark:text-red-200 leading-snug">{err.message}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── INVOICE STORY ── */}
      <div className={`rounded-2xl border-2 overflow-hidden ${result.isValid ? 'border-blue-200 bg-blue-50/50 dark:bg-blue-950/20 dark:border-blue-800' : 'border-orange-200 bg-orange-50/50 dark:bg-orange-950/20 dark:border-orange-800'}`}>
        <div className="flex items-center gap-2 p-4 border-b border-inherit">
          <BookOpen className="h-5 w-5 text-primary" />
          <span className="font-bold text-base">Invoice Story</span>
        </div>
        <div className="p-4 space-y-3">
          {story.paragraphs.map((p, i) => <p key={i} className="text-sm leading-relaxed">{p}</p>)}

          {story.warnings.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-orange-200 dark:border-orange-800">
              <p className="text-sm font-bold text-orange-700 dark:text-orange-400 flex items-center gap-1"><ShieldAlert className="h-4 w-4" /> Risk Warnings</p>
              {story.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-sm bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200 p-3 rounded-xl">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span className="leading-snug">{w}</span>
                </div>
              ))}
            </div>
          )}

          {story.actions.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-blue-200 dark:border-blue-800">
              <p className="text-sm font-bold text-blue-700 dark:text-blue-400 flex items-center gap-1"><BadgeCheck className="h-4 w-4" /> What To Do</p>
              {story.actions.map((a, i) => (
                <div key={i} className="flex items-start gap-2 text-sm bg-blue-100 dark:bg-blue-900/30 text-blue-900 dark:text-blue-200 p-3 rounded-xl">
                  <span className="font-black text-blue-600 flex-shrink-0">{i + 1}.</span><span className="leading-snug">{a}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── DUE DATE ── */}
      <div className="rounded-2xl border bg-card p-4 space-y-2">
        <p className="font-semibold flex items-center gap-2 text-sm"><CalendarClock className="h-5 w-5 text-primary" /> Payment Due Date</p>
        <div className="flex gap-2">
          <Input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            className="flex-1 h-12 rounded-xl text-base"
          />
          <button className="action-btn-primary !w-auto !min-w-[72px] !flex-none" onClick={handleDueDateSave}>Set</button>
        </div>
      </div>

      {/* ── NOTES ── */}
      <div className="rounded-2xl border bg-card p-4 space-y-2">
        <p className="font-semibold flex items-center gap-2 text-sm"><StickyNote className="h-5 w-5 text-primary" /> Quick Notes</p>
        <Textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="e.g. Confirm with manager, check price list..."
          className="rounded-xl text-base resize-none"
          rows={2}
        />
        <button className="action-btn-secondary !min-h-[48px]" onClick={handleNotesSave}>Save Note</button>
      </div>

      {/* ── EXTRACTED DATA (collapsible) ── */}
      <div className="rounded-2xl border bg-card overflow-hidden">
        <button
          className="w-full flex items-center justify-between p-4 text-left active:bg-muted"
          style={{ minHeight: 56 }}
          onClick={() => setShowDetails(v => !v)}
        >
          <span className="font-semibold flex items-center gap-2"><FileText className="h-5 w-5 text-primary" /> Extracted Invoice Data {isEditing && <Badge variant="outline" className="text-orange-600 border-orange-400 text-xs">Unsaved</Badge>}</span>
          {showDetails ? <ChevronUp className="h-5 w-5 text-muted-foreground" /> : <ChevronDown className="h-5 w-5 text-muted-foreground" />}
        </button>

        {showDetails && (
          <div className="px-4 pb-4 space-y-4 border-t">
            {/* Fields */}
            <div className="grid grid-cols-2 gap-3 pt-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Invoice #</label>
                <Input value={editedData.invoice_number || ''} onChange={e => handleFieldChange('invoice_number', e.target.value)} className={cn('h-12 text-base rounded-xl', errorFields.has('invoice_number') && 'border-2 border-red-500')} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Date</label>
                <Input value={editedData.date || ''} onChange={e => handleFieldChange('date', e.target.value)} className={cn('h-12 text-base rounded-xl', errorFields.has('date') && 'border-2 border-red-500')} />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Customer Name</label>
              <Input value={editedData.customer_name || ''} onChange={e => handleFieldChange('customer_name', e.target.value)} className={cn('h-12 text-base rounded-xl', errorFields.has('customer_name') && 'border-2 border-red-500')} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Category</label>
              <Input value={editedData.category || ''} onChange={e => handleFieldChange('category', e.target.value)} className="h-12 text-base rounded-xl" />
            </div>

            {/* Line items — scrollable table on mobile */}
            <div>
              <p className="text-sm font-semibold mb-2">Line Items</p>
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full min-w-[480px] text-sm">
                  <thead>
                    <tr className="bg-muted text-muted-foreground text-xs">
                      <th className="text-left p-2 font-medium">Item</th>
                      <th className="text-right p-2 font-medium w-16">Qty</th>
                      <th className="text-right p-2 font-medium w-24">Unit</th>
                      <th className="text-right p-2 font-medium w-24">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(editedData.items || []).map((item, idx) => (
                      <tr key={idx} className={cn('border-t', errorFields.has(`items[${idx}].line_total`) && 'bg-red-50 dark:bg-red-950/30')}>
                        <td className="p-1"><Input value={(item as any).name || ''} onChange={e => handleItemChange(idx, 'name', e.target.value)} className="h-9 text-xs rounded-lg" /></td>
                        <td className="p-1"><Input value={(item as any).quantity ?? ''} onChange={e => handleItemChange(idx, 'quantity', e.target.value)} className={cn('h-9 text-xs text-right rounded-lg', errorFields.has(`items[${idx}].line_total`) && 'border-red-400')} type="number" /></td>
                        <td className="p-1"><Input value={(item as any).unit_price ?? ''} onChange={e => handleItemChange(idx, 'unit_price', e.target.value)} className={cn('h-9 text-xs text-right rounded-lg', errorFields.has(`items[${idx}].line_total`) && 'border-red-400')} type="number" step="0.01" /></td>
                        <td className="p-1"><Input value={(item as any).line_total ?? ''} onChange={e => handleItemChange(idx, 'line_total', e.target.value)} className={cn('h-9 text-xs text-right rounded-lg', errorFields.has(`items[${idx}].line_total`) && 'border-red-400')} type="number" step="0.01" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Maths check */}
            <div className="rounded-xl bg-muted p-3 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Items sum vs Subtotal</span>
                {(editedData as any).subtotal !== undefined
                  ? isSubtotalMatching
                    ? <span className="text-green-600 font-bold flex items-center gap-1"><CheckCircle className="h-3 w-3" /> OK</span>
                    : <span className="text-red-600 font-bold flex items-center gap-1"><XCircle className="h-3 w-3" /> Mismatch</span>
                  : <span className="text-muted-foreground">N/A</span>}
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal + Tax vs Total</span>
                {(editedData as any).total !== undefined
                  ? isTotalMatching
                    ? <span className="text-green-600 font-bold flex items-center gap-1"><CheckCircle className="h-3 w-3" /> OK</span>
                    : <span className="text-red-600 font-bold flex items-center gap-1"><XCircle className="h-3 w-3" /> Mismatch</span>
                  : <span className="text-muted-foreground">N/A</span>}
              </div>
            </div>

            {/* Totals */}
            <div className="grid grid-cols-3 gap-2">
              {(['subtotal', 'tax', 'total'] as const).map(field => (
                <div key={field} className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground capitalize">{field}</label>
                  <Input
                    value={(editedData as any)[field] ?? ''}
                    onChange={e => handleFieldChange(field, e.target.value)}
                    className={cn('h-12 text-base text-right font-bold rounded-xl', errorFields.has(field) && 'border-2 border-red-500')}
                    type="number" step="0.01"
                  />
                </div>
              ))}
            </div>

            {/* Save edits */}
            {isEditing && (
              <button className="action-btn-primary" onClick={handleSave}>
                <CheckCircle className="h-5 w-5" /> Save Changes
              </button>
            )}

            {/* Export */}
            <div className="pt-1">
              <ExportMenu data={editedData} />
            </div>
          </div>
        )}
      </div>

      {/* ── SHARE BUTTONS (#39–#41) ── */}
      <div className="rounded-2xl border bg-card p-4 space-y-2">
        <p className="font-semibold text-sm flex items-center gap-2"><Share2 className="h-4 w-4 text-primary" /> Share This Invoice</p>
        <div className="flex gap-2">
          <button
            onClick={() => shareViaWhatsApp(result, currency)}
            className="flex-1 h-11 rounded-xl border-2 border-green-500 text-green-700 dark:text-green-400 font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
          >
            <MessageCircle className="h-4 w-4" /> WhatsApp
          </button>
          <button
            onClick={async () => {
              const usedNative = await shareNative(result, currency);
              toast({ title: usedNative ? 'Shared!' : 'Copied to clipboard ✓' });
            }}
            className="flex-1 h-11 rounded-xl border-2 border-border font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
          >
            <Share2 className="h-4 w-4" /> Share / Copy
          </button>
        </div>
      </div>

      {/* ── AI LOG (collapsible) ── */}
      <div className="rounded-2xl border bg-card overflow-hidden">
        <button
          className="w-full flex items-center justify-between p-4 text-left active:bg-muted"
          style={{ minHeight: 56 }}
          onClick={() => setShowAILog(v => !v)}
        >
          <span className="font-semibold text-sm">AI Extraction Log</span>
          {showAILog ? <ChevronUp className="h-5 w-5 text-muted-foreground" /> : <ChevronDown className="h-5 w-5 text-muted-foreground" />}
        </button>
        {showAILog && (
          <div className="px-4 pb-4 border-t">
            <pre className="text-xs whitespace-pre-wrap font-mono bg-muted p-3 rounded-xl max-h-64 overflow-auto mt-3">
              {result.ocrText}
            </pre>
          </div>
        )}
      </div>

      {/* ── REJECT REASON INPUT (appears when tapping Reject) ── */}
      {showRejectInput && (
        <div className="rounded-2xl border-2 border-red-400 bg-red-50 dark:bg-red-950/30 p-4 space-y-3">
          <p className="font-bold text-red-700 dark:text-red-400">Why are you rejecting this invoice?</p>
          <Input
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            placeholder="e.g. Wrong totals, not our customer, duplicate..."
            className="h-12 text-base rounded-xl border-red-300"
            autoFocus
          />
          <div className="flex gap-2">
            <button className="action-btn-danger flex-1" onClick={handleRejectConfirm}>
              <ThumbsDown className="h-5 w-5" /> Confirm Reject
            </button>
            <button className="action-btn-secondary flex-1" onClick={() => setShowRejectInput(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── STICKY APPROVE / REJECT BAR — sits above the main bottom bar ── */}
      {canAct && !showRejectInput && (
        <div
          className="fixed left-0 right-0 z-40 no-print"
          style={{ bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))' }}
        >
          <div className="container mx-auto max-w-2xl px-3">
            <div className="flex gap-3 bg-card/95 backdrop-blur border-t border-x rounded-t-2xl p-3 shadow-2xl">
              <button
                className="action-btn-primary flex-1"
                style={{ background: '#16a34a' }}
                onClick={() => onApprove(result.id)}
              >
                <ThumbsUp className="h-6 w-6" /> Approve — Collect
              </button>
              <button
                className="action-btn-secondary flex-1 border-red-400 text-red-600"
                onClick={() => setShowRejectInput(true)}
              >
                <ThumbsDown className="h-5 w-5" /> Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Approved / rejected confirmation badge */}
      {!canAct && (
        <div className={`rounded-2xl p-4 text-center font-bold text-lg ${isApproved ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
          {isApproved ? '✅ Approved' : '❌ Rejected'}
          {isApproved && result.approvedAt && <p className="text-sm font-normal mt-1">{new Date(result.approvedAt).toLocaleString()}</p>}
          {isRejected && result.rejectionReason && <p className="text-sm font-normal mt-1">{result.rejectionReason}</p>}
        </div>
      )}
    </div>
  );
};
