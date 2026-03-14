'use client';

import { useState, useMemo } from 'react';
import type { InvoiceProcessingResult, ValidatedData } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { calcHealthScore, healthLabel, healthScoreBreakdown, daysUntilDue, dueDateStatus } from '@/lib/invoice-intelligence';
import { shareViaWhatsApp, shareNative } from '@/lib/utils';
import { HealthScoreBadge } from './health-score-badge';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle, XCircle, Copy, FileText,
  BookOpen, AlertTriangle, ShieldAlert, BadgeCheck,
  ThumbsUp, ThumbsDown, CalendarClock, StickyNote,
  RefreshCw, AlertOctagon, ChevronDown, ChevronUp,
  Share2, MessageCircle, Calculator, ShieldCheck,
  Ban, AlertCircle, TrendingUp, Lightbulb,
  PackageCheck, Diff, Send,
  MessageCircle as WA,
} from 'lucide-react';
import { ExportMenu } from './export-menu';
import { useContactBook } from '@/hooks/use-contact-book';
import { useBlacklist } from '@/hooks/use-blacklist';
import { normaliseVendorKey, detectHandwritten } from '@/lib/invoice-intelligence';
import { Phone, PhoneCall, BookUser } from 'lucide-react';

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

interface CheckItem {
  label: string;
  passed: boolean;
  detail?: string;
}

/** Split an error message on " → " to extract problem and suggestion */
function splitErrorMessage(message: string): { problem: string; suggestion?: string } {
  const parts = message.split(' → ');
  return {
    problem: parts[0].trim(),
    suggestion: parts.length > 1 ? parts.slice(1).join(' → ').trim() : undefined,
  };
}

function buildChecklist(result: InvoiceProcessingResult): CheckItem[] {
  const d = result.validatedData;
  const errorFields = new Set(result.errors.map(e => e.field));
  const items: CheckItem[] = [];
  items.push({ label: 'Invoice number', passed: !!d.invoice_number, detail: d.invoice_number ?? undefined });
  items.push({ label: 'Customer name', passed: !!d.customer_name, detail: d.customer_name ?? undefined });
  // Date: show overdue months if date is present but flagged
  const dateOverdueDetail = (() => {
  if (!d.date) return undefined;
  return d.date;
  })();
  items.push({ label: d.date && errorFields.has('date') ? 'Wrong date — please correct' : 'Invoice date', passed: !!d.date && !errorFields.has('date'), detail: dateOverdueDetail });
  items.push({ label: 'Line items found', passed: !!(d.items && d.items.length > 0), detail: d.items?.length ? `${d.items.length} item${d.items.length !== 1 ? 's' : ''}` : undefined });
  items.push({ label: 'Grand total readable', passed: d.total !== undefined && !errorFields.has('total'), detail: d.total !== undefined ? d.total.toLocaleString(undefined, { minimumFractionDigits: 2 }) : undefined });
  items.push({ label: 'Subtotal present', passed: true, detail: d.subtotal !== undefined ? d.subtotal.toFixed(2) : 'Not required on simple invoices' });
  items.push({ label: 'Tax / VAT', passed: true, detail: d.tax !== undefined ? `VAT: ${d.tax.toFixed(2)}` : 'No VAT on this invoice' });
  items.push({ label: 'Line items maths correct', passed: !result.errors.some(e => e.field.includes('line_total')) });
  items.push({ label: 'Numbers add up', passed: !errorFields.has('math') && !errorFields.has('hallucination') && !errorFields.has('subtotal') });
  items.push({ label: 'Not a duplicate', passed: !result.isDuplicate });
  items.push({ label: 'Not a partial payment', passed: !result.isPartialPayment });
  items.push({ label: 'No price spikes', passed: !(result.priceWarnings && result.priceWarnings.length > 0) });
  items.push({ label: 'AI reading confidence', passed: !result.errors.some(e => e.message.includes('confidence')) });
  return items;
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
    .map(i => `${i.quantity !== undefined ? `${i.quantity}× ` : ''}${i.name}${i.line_total !== undefined ? ` (${i.line_total.toLocaleString(undefined, { minimumFractionDigits: 2 })})` : ''}`);
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
      const { problem } = splitErrorMessage(err.message);
      if (err.field === 'invoice_number') { warnings.push('No invoice number — cannot be tracked or disputed.'); actions.push('Request a proper invoice number before accepting payment.'); }
      else if (err.field === 'customer_name') { warnings.push('Customer name missing — identity unverifiable.'); actions.push('Confirm customer identity before proceeding.'); }
      else if (err.field === 'total') { warnings.push('Grand total unreadable — wrong amount risk.'); actions.push('Confirm the total before receiving money.'); }
      else if (err.field === 'items') { warnings.push('No line items — cannot verify what you are being paid for.'); actions.push('Request a fully itemised invoice.'); }
      else if (err.field.includes('line_total')) { warnings.push('Line item calculation error — possible overcharge.'); actions.push('Check every line: qty × unit price must match line total.'); }
      else if (err.field === 'subtotal') { warnings.push('Items do not add up to the stated subtotal.'); actions.push('Return the invoice for correction before receiving money.'); }
      else if (err.field === 'tax') { warnings.push('Tax rate is unusual for this region.'); actions.push('Verify the tax amount before receiving money.'); }
      else if (err.field === 'date') { warnings.push(problem); actions.push('Confirm the invoice date with the customer.'); }
      else if (err.field === 'price_memory') { warnings.push(problem); actions.push('Query the price change with the customer before approving.'); }
    });
  } else {
    actions.push('All figures verified. Safe to submit this invoice.');
    actions.push(`File under "${category}" in your records.`);
  }

  const headline = isValid
    ? `✅ ${customer} — GH¢${total} — Invoice is correct. Safe to submit.`
    : `⚠️ ${customer} — ${errors.length} issue${errors.length !== 1 ? 's' : ''} found. Fix before submitting.`;

  return { headline, paragraphs, warnings, actions };
}

function ManagerEmailPanel({ editedData, result, currency, toast }: {
  editedData: ValidatedData;
  result: InvoiceProcessingResult;
  currency: string;
  toast: (opts: any) => void;
}) {
  const vendor = editedData.customer_name || 'Unknown Vendor';
  const invNo = editedData.invoice_number ? `#${editedData.invoice_number}` : '(no number)';
  const total = editedData.total !== undefined ? editedData.total.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '?';
  const verdictLabel = result.riskVerdict?.verdict ?? 'CAUTION';
  const reason = result.riskVerdict?.reason ?? 'Issues found.';
  const problems = result.errors.slice(0, 3).map(e => e.message.split(' → ')[0]).join('\n- ');
  const subject = `[InvoiceGuard] ${verdictLabel} — ${vendor} Invoice ${invNo}`;
  const body = `Invoice Alert\n\nVerdict: ${verdictLabel}\nVendor: ${vendor}\nInvoice: ${invNo}\nTotal: ${currency} ${total}\n\nIssue: ${reason}\n\nProblems:\n- ${problems}\n\nPlease advise before payment is collected.`;
  return (
    <div className="px-4 pb-4 border-t border-amber-200 dark:border-amber-800 space-y-3 pt-3">
      <div className="bg-white dark:bg-amber-950/20 border border-amber-200 rounded-xl p-3 space-y-1">
        <p className="text-xs font-bold text-amber-700 dark:text-amber-400">Subject</p>
        <p className="text-xs font-mono text-amber-900 dark:text-amber-200 leading-snug">{subject}</p>
        <p className="text-xs font-bold text-amber-700 dark:text-amber-400 mt-2">Body</p>
        <pre className="text-xs font-mono text-amber-900 dark:text-amber-200 whitespace-pre-wrap leading-snug">{body}</pre>
      </div>
      <div className="flex gap-2">
        <button
          className="flex-1 h-11 rounded-xl bg-blue-600 text-white font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
          onClick={() => window.open(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener,noreferrer')}
        >
          <Send className="h-4 w-4" /> Open in Email App
        </button>
        <button
          className="flex-1 h-11 rounded-xl border-2 border-amber-400 text-amber-700 dark:text-amber-300 font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
          onClick={() => navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`).then(() => toast({ title: 'Email copied ✓' })).catch(() => toast({ variant: 'destructive', title: 'Copy failed' }))}
        >
          <Copy className="h-4 w-4" /> Copy
        </button>
      </div>
    </div>
  );
}

const VERDICT_CONFIG = {
  ACCEPT:  { bg: 'bg-green-600',  border: 'border-green-500',  text: 'text-green-700 dark:text-green-300',  icon: ShieldCheck,  label: '🟢 GOOD — Invoice is correct. Safe to submit.'    },
  CAUTION: { bg: 'bg-amber-500',  border: 'border-amber-400',  text: 'text-amber-700 dark:text-amber-300',  icon: AlertCircle,  label: '🟡 CHECK — Fix the flagged issues before submitting.' },
  REJECT:  { bg: 'bg-red-600',    border: 'border-red-500',    text: 'text-red-700 dark:text-red-300',      icon: Ban,          label: '🔴 DO NOT SUBMIT — Serious problem found.'  },
  ESCALATE:{ bg: 'bg-orange-600', border: 'border-orange-500', text: 'text-orange-700 dark:text-orange-300',icon: TrendingUp,   label: '🟠 REWRITE — Numbers do not add up. Correct and rescan.' },
} as const;

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
  // Auto-open edit panel when there are errors — salesman needs to fix before submitting
  const [showDetails, setShowDetails] = useState(
    result.errors.some(e => ['items', 'math', 'hallucination', 'subtotal'].includes(e.field) || e.field.includes('line_total'))
  );
  const [showAILog, setShowAILog] = useState(false);
  // #13 delivery confirmation
  const [deliveryChecked, setDeliveryChecked] = useState<boolean[]>([]);
  const [showDeliveryCheck, setShowDeliveryCheck] = useState(false);
  // #16 diff view
  const [showDiffView, setShowDiffView] = useState(false);
  // #20 send to manager
  const [showManagerMsg, setShowManagerMsg] = useState(false);

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
  const checklist = useMemo(() => buildChecklist(result), [result]);
  const health = healthLabel(result.healthScore ?? calcHealthScore(result));
  const dueDays = daysUntilDue(dueDate || result.dueDate);

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

  // Contact book & blacklist
  const { get: getContact, upsert: upsertContact } = useContactBook();
  const { isBlocked, get: getBlacklistEntry, add: addToBlacklist, remove: removeFromBlacklist } = useBlacklist();
  const vendorKey = normaliseVendorKey(result.validatedData.customer_name);
  const contact = getContact(vendorKey);
  const blacklistEntry = getBlacklistEntry(vendorKey);
  const blocked = isBlocked(vendorKey);
  const [phoneInput, setPhoneInput] = useState(contact?.phone || '');
  const [showContactEdit, setShowContactEdit] = useState(false);
  const [blacklistReason, setBlacklistReason] = useState('');
  const [showBlacklistInput, setShowBlacklistInput] = useState(false);

  // Handwritten detection
  const isHandwritten = detectHandwritten(result.ocrText);

  const verdict = result.riskVerdict?.verdict ?? (result.isValid ? 'ACCEPT' : 'REJECT');
  const verdictCfg = VERDICT_CONFIG[verdict];
  const VerdictIcon = verdictCfg.icon;
  const verdictBg = isApproved ? 'bg-blue-600' : isRejected ? 'bg-gray-500' : verdictCfg.bg;
  const verdictText = isApproved ? '✅ Submitted — Invoice Accepted' : isRejected ? '✏️ Marked for Rewrite' : verdictCfg.label;

  const passedCount = checklist.filter(c => c.passed).length;
  const failedCount = checklist.filter(c => !c.passed).length;

  return (
    <div className="w-full space-y-4 animate-fade-in-up pb-36">

      {/* ── VERDICT BANNER ── */}
      <div className={`rounded-2xl ${verdictBg} text-white p-5 space-y-2`}>
        <div className="flex items-center gap-2">
          <VerdictIcon className="h-7 w-7 flex-shrink-0" />
          <p className="text-xl font-black leading-tight">{verdictText}</p>
        </div>
        {result.riskVerdict && (
          <p className="text-sm font-semibold opacity-95 leading-snug bg-black/20 rounded-xl px-3 py-2">
            {result.riskVerdict.reason}
          </p>
        )}
        <p className="text-sm opacity-85 leading-snug">{story.headline}</p>

        <div className="flex flex-wrap gap-2 pt-1">
          <span className="text-xs font-bold px-3 py-1 rounded-full bg-white/20">
            Health {result.healthScore ?? calcHealthScore(result)}/100 — {health.label}
          </span>
          {result.isDuplicate && (
            <span className="text-xs font-bold px-3 py-1 rounded-full bg-red-900/60 flex items-center gap-1">
              <AlertOctagon className="h-3 w-3" /> DUPLICATE
            </span>
          )}
          {result.reconciliationApplied && (
            <span className="text-xs font-bold px-3 py-1 rounded-full bg-white/20 flex items-center gap-1">
              ✅ Re-verified
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

      {/* ── BLACKLIST WARNING ── */}
      {blocked && blacklistEntry && (
        <div className="rounded-2xl border-2 border-red-600 bg-red-50 dark:bg-red-950/40 p-4 flex items-start gap-3">
          <Ban className="h-7 w-7 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-black text-red-700 dark:text-red-400 text-base">⛔ BLACKLISTED VENDOR</p>
            <p className="text-sm text-red-600 dark:text-red-300 mt-1">
              <strong>{result.validatedData.customer_name}</strong> is on your blacklist.
            </p>
            {blacklistEntry.reason && (
              <p className="text-xs font-mono bg-red-100 dark:bg-red-900/40 rounded-lg px-3 py-2 mt-2 text-red-800 dark:text-red-200">
                Reason: {blacklistEntry.reason}
              </p>
            )}
            <p className="text-xs text-red-700 dark:text-red-400 mt-2 font-semibold">
              → Do NOT collect money from this vendor without manager approval.
            </p>
            <button
              className="mt-3 text-xs text-red-600 underline active:opacity-70"
              onClick={() => removeFromBlacklist(vendorKey)}
            >
              Remove from blacklist
            </button>
          </div>
        </div>
      )}

      {/* ── HANDWRITTEN WARNING ── */}
      {isHandwritten && (
        <div className="rounded-2xl border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-4 flex items-start gap-3">
          <AlertTriangle className="h-6 w-6 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-black text-amber-700 dark:text-amber-400 text-base">Handwritten Invoice Detected</p>
            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
              This invoice appears to be handwritten. AI reading accuracy is lower on handwritten documents — totals and item names may have errors.
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-2 font-semibold">
              → Manually verify every total and item against the physical invoice before submitting.
            </p>
          </div>
        </div>
      )}

      {/* ── CONTACT BOOK PANEL ── */}
      <div className="rounded-2xl border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/40">
          <div className="flex items-center gap-2">
            <BookUser className="h-4 w-4 text-primary" />
            <span className="font-semibold text-sm">
              {result.validatedData.customer_name || 'Customer'} Contact
            </span>
          </div>
          <button
            className="text-xs text-primary font-semibold px-3 py-1.5 rounded-xl bg-primary/10 active:scale-95"
            onClick={() => setShowContactEdit(v => !v)}
          >
            {contact?.phone ? 'Edit' : '+ Add Phone'}
          </button>
        </div>

        {contact?.phone && !showContactEdit && (
          <div className="px-4 py-3 flex items-center gap-3">
            <span className="text-sm font-mono font-bold flex-1">{contact.phone}</span>
            <a
              href={`tel:${contact.phone}`}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-green-500 text-white text-xs font-bold active:scale-95"
            >
              <Phone className="h-3.5 w-3.5" /> Call
            </a>
            <a
              href={`https://wa.me/${contact.phone.replace(/[^0-9]/g, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-green-600 text-white text-xs font-bold active:scale-95"
            >
              <WA className="h-3.5 w-3.5" /> WhatsApp
            </a>
          </div>
        )}

        {showContactEdit && (
          <div className="px-4 py-3 space-y-3">
            <input
              type="tel"
              value={phoneInput}
              onChange={e => setPhoneInput(e.target.value)}
              placeholder="e.g. +233201234567"
              className="w-full h-12 rounded-xl border-2 px-4 text-base font-mono bg-background"
              inputMode="tel"
            />
            <div className="flex gap-2">
              <button
                className="flex-1 h-10 rounded-xl bg-primary text-primary-foreground font-bold text-sm active:scale-95"
                onClick={() => {
                  if (phoneInput.trim()) {
                    upsertContact(vendorKey, result.validatedData.customer_name || 'Unknown', phoneInput);
                    toast({ title: 'Contact saved ✓' });
                  }
                  setShowContactEdit(false);
                }}
              >
                Save
              </button>
              <button
                className="flex-1 h-10 rounded-xl border-2 border-border font-semibold text-sm active:scale-95"
                onClick={() => setShowContactEdit(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Blacklist toggle */}
        <div className="px-4 py-3 border-t flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {blocked ? '⛔ This vendor is blacklisted' : 'Mark vendor as blocked?'}
          </span>
          {blocked ? (
            <button
              className="text-xs text-green-600 font-bold px-3 py-1.5 rounded-xl border border-green-400 active:scale-95"
              onClick={() => removeFromBlacklist(vendorKey)}
            >
              Unblock
            </button>
          ) : (
            <button
              className="text-xs text-red-600 font-bold px-3 py-1.5 rounded-xl border border-red-400 active:scale-95"
              onClick={() => setShowBlacklistInput(v => !v)}
            >
              Blacklist
            </button>
          )}
        </div>
        {showBlacklistInput && !blocked && (
          <div className="px-4 pb-4 space-y-2 border-t">
            <p className="text-xs text-muted-foreground pt-3">Reason for blacklisting (optional):</p>
            <input
              value={blacklistReason}
              onChange={e => setBlacklistReason(e.target.value)}
              placeholder="e.g. Repeated fraud, bad invoices..."
              className="w-full h-10 rounded-xl border-2 px-3 text-sm bg-background"
            />
            <button
              className="w-full h-10 rounded-xl bg-red-600 text-white font-bold text-sm active:scale-95"
              onClick={() => {
                addToBlacklist(vendorKey, result.validatedData.customer_name || 'Unknown', blacklistReason);
                setShowBlacklistInput(false);
                setBlacklistReason('');
                toast({ title: '⛔ Vendor blacklisted', description: 'You will be warned on their next invoice.' });
              }}
            >
              Confirm Blacklist
            </button>
          </div>
        )}
      </div>

      {/* ── HEALTH SCORE ── */}
      <div className="flex flex-wrap gap-2">
        <HealthScoreBadge result={result} />
      </div>

      {/* ── CHECKLIST: GREEN CHECKS + RED X's ── */}
      <div className="rounded-2xl border-2 border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
          <span className="font-bold text-base flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Invoice Check
          </span>
          <div className="flex items-center gap-3 text-sm">
            <span className="flex items-center gap-1 font-bold text-green-600">
              <CheckCircle className="h-4 w-4" /> {passedCount} passed
            </span>
            {failedCount > 0 && (
              <span className="flex items-center gap-1 font-bold text-red-600">
                <XCircle className="h-4 w-4" /> {failedCount} failed
              </span>
            )}
          </div>
        </div>

        <div className="divide-y divide-border">
          {checklist.map((item, i) => (
            <div
              key={i}
              className={cn(
                'flex items-center gap-3 px-4 py-3',
                item.passed
                  ? 'bg-green-50/60 dark:bg-green-950/20'
                  : 'bg-red-50/70 dark:bg-red-950/25'
              )}
            >
              {item.passed
                ? <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0" />
                : <XCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
              }
              <div className="flex-1 min-w-0">
                <span className={cn(
                  'text-sm font-semibold',
                  item.passed ? 'text-green-800 dark:text-green-300' : 'text-red-800 dark:text-red-300'
                )}>
                  {item.label}
                </span>
                {item.passed && item.detail && (
                  <span className="ml-2 text-xs text-green-700 dark:text-green-400 font-mono truncate">
                    {item.detail}
                  </span>
                )}
              </div>
              {item.passed
                ? <span className="text-xs font-bold text-green-600 bg-green-100 dark:bg-green-900/40 px-2 py-0.5 rounded-full flex-shrink-0">✓ OK</span>
                : <span className="text-xs font-bold text-red-600 bg-red-100 dark:bg-red-900/40 px-2 py-0.5 rounded-full flex-shrink-0">✗ FAIL</span>
              }
            </div>
          ))}
        </div>

        {failedCount === 0 && (
          <div className="px-4 py-3 bg-green-100 dark:bg-green-900/30 border-t border-green-200 dark:border-green-800">
            <p className="text-sm font-bold text-green-700 dark:text-green-300 flex items-center gap-2">
              <CheckCircle className="h-5 w-5" /> All checks passed — invoice is clean
            </p>
          </div>
        )}
      </div>

      {/* ── ERRORS WITH PROBLEM + SUGGESTION ── */}
      {!result.isValid && result.errors.length > 0 && (
        <div className="rounded-2xl border-2 border-red-400 bg-red-50 dark:bg-red-950/30 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-red-200 dark:border-red-800">
            <div className="flex items-center gap-2">
              <XCircle className="h-6 w-6 text-red-600" />
              <span className="font-bold text-red-700 dark:text-red-400 text-base">
                {result.errors.length} Issue{result.errors.length !== 1 ? 's' : ''} Found
              </span>
            </div>
            <button
              className="text-xs text-muted-foreground flex items-center gap-1 px-3 py-2 rounded-xl border active:scale-95"
              onClick={() => { navigator.clipboard.writeText(result.errors.map(e => e.message).join('\n')).catch(() => toast({ variant: 'destructive', title: 'Copy failed' })); toast({ title: 'Copied' }); }}
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
          </div>
          <div className="p-3 space-y-3">
            {result.errors.map((err, i) => {
              const { problem, suggestion } = splitErrorMessage(err.message);
              return (
                <div key={i} className="bg-white dark:bg-red-950/40 rounded-xl border border-red-200 dark:border-red-800 overflow-hidden">
                  {/* Problem */}
                  <div className="flex items-start gap-3 p-3">
                    <XCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-800 dark:text-red-200 leading-snug font-medium">{problem}</p>
                  </div>
                  {/* Suggestion */}
                  {suggestion && (
                    <div className="flex items-start gap-3 px-3 pb-3 pt-0">
                      <Lightbulb className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5 ml-0.5" />
                      <p className="text-xs text-amber-700 dark:text-amber-300 leading-snug">{suggestion}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── PARTIAL PAYMENT ALERT ── */}
      {result.isPartialPayment && result.partialPaymentOriginalTotal !== undefined && (
        <div className="rounded-2xl border-2 border-yellow-400 bg-yellow-50 dark:bg-yellow-950/30 p-4 flex items-start gap-3">
          <Calculator className="h-6 w-6 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-black text-yellow-700 dark:text-yellow-400 text-base">Possible Partial Payment</p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
              Same invoice number exists with a higher total of {fmt(result.partialPaymentOriginalTotal)}.
              Verify with customer whether this is a partial payment.
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-2 font-semibold">
              → Call your manager to confirm before collecting any money.
            </p>
          </div>
        </div>
      )}



      {/* ── CREDIT SALE ALERT ── */}
      {result.isCreditSale && (
        <div className="rounded-2xl border-2 border-purple-500 bg-purple-50 dark:bg-purple-950/40 p-4 flex items-start gap-3">
          <span className="text-3xl flex-shrink-0">📋</span>
          <div>
            <p className="font-black text-purple-700 dark:text-purple-300 text-base">CREDIT SALE — Goods Given, Money NOT Collected</p>
            <p className="text-sm text-purple-700 dark:text-purple-300 mt-1">
              This invoice was marked as <strong>NOT PAID / On Credit</strong>. The customer received the goods but has not paid yet.
            </p>
            {result.creditSaleNote && (
              <p className="text-xs font-mono bg-purple-100 dark:bg-purple-900/40 rounded-lg px-3 py-2 mt-2 text-purple-800 dark:text-purple-200">
                "{result.creditSaleNote}"
              </p>
            )}
            <div className="mt-3 space-y-1">
              <p className="text-xs font-bold text-purple-700 dark:text-purple-400">→ What to do:</p>
              <p className="text-xs text-purple-700 dark:text-purple-300">1. Record this in your credit book immediately.</p>
              <p className="text-xs text-purple-700 dark:text-purple-300">2. Note the customer name, amount ({result.validatedData.total?.toLocaleString(undefined, {minimumFractionDigits: 2})} GHS) and today's date.</p>
              <p className="text-xs text-purple-700 dark:text-purple-300">3. Follow up with the customer on the agreed payment date.</p>
              <p className="text-xs text-purple-700 dark:text-purple-300">4. Do NOT submit this as collected — use the Notes field to record the credit date.</p>
            </div>
          </div>
        </div>
      )}

      {/* ── DUPLICATE ALERT ── */}
      {result.isDuplicate && (
        <div className="rounded-2xl border-2 border-red-500 bg-red-50 dark:bg-red-950/40 p-4 flex items-start gap-3">
          <AlertOctagon className="h-7 w-7 text-red-600 flex-shrink-0" />
          <div>
            {(result as any).crossCustomerDuplicate ? (
              <>
                <p className="font-black text-red-700 dark:text-red-400 text-base">Same Invoice Number — Different Customer!</p>
                <p className="text-sm text-red-600 dark:text-red-300 mt-1">
                  Invoice number <strong>{result.validatedData.invoice_number}</strong> was already used for a different customer.
                  You may be reusing an old invoice book.
                </p>
                <p className="text-xs text-red-700 dark:text-red-400 mt-2 font-semibold">
                  → Use a new invoice number for this transaction. Do not reuse numbers from old books.
                </p>
              </>
            ) : (
              <>
                <p className="font-black text-red-700 dark:text-red-400 text-base">Duplicate Invoice!</p>
                <p className="text-sm text-red-600 dark:text-red-300 mt-1">This invoice matches one already in your history. Do NOT submit again.</p>
                <p className="text-xs text-red-700 dark:text-red-400 mt-2 font-semibold">
                  → This invoice was already submitted. If this is a new transaction, write a new invoice with a different number.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── #13 DELIVERY CONFIRMATION ── */}
      {(editedData.items?.length ?? 0) > 0 && (
        <div className="rounded-2xl border-2 border-indigo-300 bg-indigo-50 dark:bg-indigo-950/30 overflow-hidden">
          <button
            className="w-full flex items-center justify-between p-4 text-left active:bg-indigo-100"
            onClick={() => {
              if (!showDeliveryCheck) {
                setDeliveryChecked(new Array(editedData.items!.length).fill(false));
              }
              setShowDeliveryCheck(v => !v);
            }}
          >
            <span className="font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-2">
              <PackageCheck className="h-5 w-5" />
              Did you deliver everything on this invoice?
            </span>
            {showDeliveryCheck ? <ChevronUp className="h-4 w-4 text-indigo-500" /> : <ChevronDown className="h-4 w-4 text-indigo-500" />}
          </button>
          {showDeliveryCheck && (
            <div className="px-4 pb-4 space-y-2 border-t border-indigo-200 dark:border-indigo-800">
              <p className="text-xs text-indigo-600 dark:text-indigo-400 pt-3">Tick each item you physically delivered to the customer:</p>
              {editedData.items!.map((item, idx) => (
                <label key={idx} className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer border transition-colors ${
                  deliveryChecked[idx]
                    ? 'bg-green-100 border-green-300 dark:bg-green-900/30 dark:border-green-700'
                    : 'bg-white border-indigo-200 dark:bg-indigo-950/20 dark:border-indigo-700'
                }`}>
                  <input
                    type="checkbox"
                    checked={!!deliveryChecked[idx]}
                    onChange={e => {
                      const next = [...deliveryChecked];
                      next[idx] = e.target.checked;
                      setDeliveryChecked(next);
                    }}
                    className="h-5 w-5 rounded accent-green-600"
                  />
                  <span className="flex-1 text-sm font-medium">
                    {(item as any).quantity !== undefined ? `${(item as any).quantity}× ` : ''}
                    {(item as any).name || `Item ${idx + 1}`}
                    {(item as any).line_total !== undefined ? ` — ${Number((item as any).line_total).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : ''}
                  </span>
                </label>
              ))}
              {deliveryChecked.length > 0 && deliveryChecked.some(c => !c) && (
                <div className="mt-2 p-3 rounded-xl bg-orange-100 dark:bg-orange-900/30 border border-orange-300">
                  <p className="text-sm font-bold text-orange-700 dark:text-orange-400 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    {deliveryChecked.filter(c => !c).length} item(s) not ticked — do not approve until all goods are delivered.
                  </p>
                </div>
              )}
              {deliveryChecked.length > 0 && deliveryChecked.every(c => c) && (
                <div className="mt-2 p-3 rounded-xl bg-green-100 dark:bg-green-900/30 border border-green-300">
                  <p className="text-sm font-bold text-green-700 dark:text-green-400 flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" /> All items delivered — delivery confirmed.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── #16 DIFF VIEW: Invoice vs What Should Be ── */}
      {!result.isValid && result.errors.some(e => e.field === 'math' || e.field.includes('line_total')) && (
        <div className="rounded-2xl border-2 border-purple-300 bg-purple-50 dark:bg-purple-950/30 overflow-hidden">
          <button
            className="w-full flex items-center justify-between p-4 text-left active:bg-purple-100"
            onClick={() => setShowDiffView(v => !v)}
          >
            <span className="font-bold text-purple-700 dark:text-purple-300 flex items-center gap-2">
              <Diff className="h-5 w-5" />
              Invoice vs Correct — Side-by-Side
            </span>
            {showDiffView ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showDiffView && (
            <div className="px-4 pb-4 border-t border-purple-200 dark:border-purple-800">
              <div className="grid grid-cols-2 gap-3 pt-3">
                <div>
                  <p className="text-xs font-bold text-red-600 mb-2 uppercase tracking-wide">📄 On Invoice (wrong)</p>
                  <div className="space-y-1">
                    {(editedData.items || []).map((item, idx) => {
                      const qty = parseFloat(String((item as any).quantity)) || 0;
                      const unit = parseFloat(String((item as any).unit_price)) || 0;
                      const lt   = parseFloat(String((item as any).line_total)) || 0;
                      const hasError = qty > 0 && unit > 0 && Math.abs(qty * unit - lt) > 0.10;
                      return (
                        <div key={idx} className={`text-xs p-2 rounded-lg ${ hasError ? 'bg-red-100 dark:bg-red-950/40 font-bold text-red-800 dark:text-red-300' : 'bg-muted text-muted-foreground' }`}>
                          {(item as any).name || `Item ${idx+1}`}: {lt.toFixed(2)}
                        </div>
                      );
                    })}
                    {editedData.subtotal !== undefined && <div className="text-xs p-2 bg-muted rounded-lg">Subtotal: {Number(editedData.subtotal).toFixed(2)}</div>}
                    {editedData.total !== undefined && <div className="text-xs p-2 bg-red-100 dark:bg-red-950/40 rounded-lg font-bold text-red-800 dark:text-red-300">Total: {Number(editedData.total).toFixed(2)}</div>}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-bold text-green-600 mb-2 uppercase tracking-wide">✅ Should Be (correct)</p>
                  <div className="space-y-1">
                    {(editedData.items || []).map((item, idx) => {
                      const qty = parseFloat(String((item as any).quantity)) || 0;
                      const unit = parseFloat(String((item as any).unit_price)) || 0;
                      const correct = qty > 0 && unit > 0 ? qty * unit : parseFloat(String((item as any).line_total)) || 0;
                      const lt = parseFloat(String((item as any).line_total)) || 0;
                      const hasError = qty > 0 && unit > 0 && Math.abs(correct - lt) > 0.10;
                      return (
                        <div key={idx} className={`text-xs p-2 rounded-lg ${ hasError ? 'bg-green-100 dark:bg-green-950/40 font-bold text-green-800 dark:text-green-300' : 'bg-muted text-muted-foreground' }`}>
                          {(item as any).name || `Item ${idx+1}`}: {correct.toFixed(2)}
                        </div>
                      );
                    })}
                    {editedData.subtotal !== undefined && (
                      <div className="text-xs p-2 bg-muted rounded-lg">
                        Subtotal: {(editedData.items || []).reduce((s, i) => s + (parseFloat(String((i as any).line_total)) || 0), 0).toFixed(2)}
                      </div>
                    )}
                    {suggestedTotal !== undefined && <div className="text-xs p-2 bg-green-100 dark:bg-green-950/40 rounded-lg font-bold text-green-800 dark:text-green-300">Total: {fmt(suggestedTotal)}</div>}
                  </div>
                </div>
              </div>
              <p className="text-xs text-purple-600 dark:text-purple-400 mt-3">→ Show this screen to the vendor and ask them to correct the highlighted amounts.</p>
            </div>
          )}
        </div>
      )}

      {/* ── #20 SEND TO EMAIL ── */}
      {(result.riskVerdict?.verdict === 'ESCALATE' || result.riskVerdict?.verdict === 'CAUTION') && (
        <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 dark:bg-amber-950/30 overflow-hidden">
          <button
            className="w-full flex items-center justify-between p-4 text-left"
            onClick={() => setShowManagerMsg(v => !v)}
          >
            <span className="font-bold text-amber-700 dark:text-amber-300 flex items-center gap-2">
              <Send className="h-5 w-5" />
              Send to Email
            </span>
            {showManagerMsg ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showManagerMsg && <ManagerEmailPanel
            editedData={editedData}
            result={result}
            currency={currency}
            toast={toast}
          />}
        </div>
      )}

      {/* ── SUGGESTED CORRECT TOTAL ── */}
      {!result.isValid && suggestedTotal !== undefined && editedData.total !== undefined && Math.abs(suggestedTotal - editedData.total) > 0.01 && (
        <div className="rounded-2xl border-2 border-blue-300 bg-blue-50 dark:bg-blue-950/30 p-4 flex items-center justify-between gap-3">
          <div>
            <p className="font-bold text-blue-700 dark:text-blue-400 text-sm">Suggested Correct Total</p>
            <p className="text-xs text-blue-600 dark:text-blue-300 mt-0.5">Based on subtotal + tax from this invoice</p>
          </div>
          <span className="text-2xl font-black text-blue-700 dark:text-blue-300">{fmt(suggestedTotal)}</span>
        </div>
      )}

      {/* ── VERDICT DETAILS (expandable) ── */}
      {result.riskVerdict && result.riskVerdict.details.length > 0 && (
        <div className={cn('rounded-2xl border-2 overflow-hidden', verdictCfg.border)}>
          <div className={cn('px-4 py-3 border-b', verdictCfg.border)}>
            <p className={cn('font-bold text-sm flex items-center gap-2', verdictCfg.text)}>
              <VerdictIcon className="h-4 w-4" />
              Why this verdict — details &amp; how to fix
            </p>
          </div>
          <div className="p-3 space-y-2 bg-card">
            {result.riskVerdict.details.map((d, i) => {
              const isSuggestion = d.startsWith('→');
              return (
                <div key={i} className={cn('flex items-start gap-2 text-sm', isSuggestion ? 'pl-6' : '')}>
                  {isSuggestion
                    ? <Lightbulb className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    : <XCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                  }
                  <span className={cn('leading-snug', isSuggestion ? 'text-amber-700 dark:text-amber-300 text-xs' : 'text-foreground/80')}>
                    {isSuggestion ? d.replace(/^→\s*/, '') : d}
                  </span>
                </div>
              );
            })}
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
      <div className={`rounded-2xl border-2 p-4 space-y-2 ${
        result.isCreditSale && !dueDate
          ? 'border-red-400 bg-red-50 dark:bg-red-950/30 animate-pulse'
          : result.isCreditSale
          ? 'border-purple-400 bg-purple-50 dark:bg-purple-950/20'
          : 'border-border bg-card'
      }`}>
        <p className={`font-semibold flex items-center gap-2 text-sm ${
          result.isCreditSale && !dueDate ? 'text-red-600' : result.isCreditSale ? 'text-purple-700 dark:text-purple-300' : ''
        }`}>
          <CalendarClock className="h-5 w-5" />
          {result.isCreditSale ? (
            !dueDate ? '⚠️ Credit Sale — Set Payment Due Date (REQUIRED)' : '📌 Credit Payment Due Date'
          ) : 'Payment Due Date'}
        </p>
        <div className="flex gap-2">
          <Input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            className={`flex-1 h-12 rounded-xl text-base ${
              result.isCreditSale && !dueDate ? 'border-red-400 border-2' : ''
            }`}
          />
          <button className="action-btn-primary !w-auto !min-w-[72px] !flex-none" onClick={handleDueDateSave}>Set</button>
        </div>
        {result.isCreditSale && !dueDate && (
          <p className="text-xs text-red-600 font-semibold">→ You cannot submit this invoice without a payment due date.</p>
        )}
      </div>

      {/* ── NOTES ── */}
      <div className="rounded-2xl border bg-card p-4 space-y-2">
        <p className="font-semibold flex items-center gap-2 text-sm"><StickyNote className="h-5 w-5 text-primary" /> Quick Notes</p>
        <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Confirm with manager, check price list..." className="rounded-xl text-base resize-none" rows={2} />
        <button className="action-btn-secondary !min-h-[48px]" onClick={handleNotesSave}>Save Note</button>
      </div>

      {/* ── EXTRACTED DATA (collapsible) ── */}
      <div className="rounded-2xl border bg-card overflow-hidden">
        <button
          className="w-full flex items-center justify-between p-4 text-left active:bg-muted"
          style={{ minHeight: 56 }}
          onClick={() => setShowDetails(v => !v)}
        >
          <span className="font-semibold flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Extracted Invoice Data
            {isEditing && <Badge variant="outline" className="text-orange-600 border-orange-400 text-xs">Unsaved</Badge>}
          </span>
          {showDetails ? <ChevronUp className="h-5 w-5 text-muted-foreground" /> : <ChevronDown className="h-5 w-5 text-muted-foreground" />}
        </button>

        {showDetails && (
          <div className="px-4 pb-4 space-y-4 border-t">
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

            {/* Line items */}
            <div>
              <p className="text-sm font-semibold mb-2">Line Items</p>
              <div className="overflow-x-auto -mx-4 px-4 rounded-xl">
              <div className="border rounded-xl min-w-[420px]">
                <table className="w-full text-sm">
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

            {isEditing && (
              <button className="action-btn-primary" onClick={handleSave}>
                <CheckCircle className="h-5 w-5" /> Save Changes
              </button>
            )}

            <div className="pt-1">
              <ExportMenu data={editedData} />
            </div>
          </div>
        )}
      </div>

      {/* ── SHARE BUTTONS ── */}
      <div className="rounded-2xl border bg-card p-4 space-y-2">
        <p className="font-semibold text-sm flex items-center gap-2"><Share2 className="h-4 w-4 text-primary" /> Share This Invoice</p>
        <div className="flex gap-2 flex-wrap sm:flex-nowrap">
          <button
            onClick={() => {
              const d = editedData;
              const total = d.total?.toLocaleString(undefined, { minimumFractionDigits: 2 }) ?? '?';
              const items = (d.items || []).map(i =>
                `  - ${i.quantity !== undefined ? `${i.quantity}x ` : ''}${i.name || 'Item'}${i.line_total !== undefined ? ` = GH¢${i.line_total.toFixed(2)}` : ''}`
              ).join('\n');
              const creditLine = result.isCreditSale
                ? `\n\n⚠️ CREDIT SALE — Amount owed: GH¢${total}\nPayment due: ${result.dueDate || 'not set'}\nPlease pay on the agreed date.`
                : '';
              const msg =
                `*InvoiceGuard Receipt*\n` +
                `Invoice: #${d.invoice_number || 'N/A'}\n` +
                `Date: ${d.date || new Date().toLocaleDateString()}\n` +
                `Customer: ${d.customer_name || 'N/A'}\n\n` +
                `*Items:*\n${items}\n\n` +
                `*Total: GH¢${total}*` +
                creditLine;
              const url = `https://wa.me/?text=${encodeURIComponent(msg)}`;
              window.open(url, '_blank', 'noopener,noreferrer');
            }}
            className="flex-1 h-11 rounded-xl border-2 border-green-500 text-green-700 dark:text-green-400 font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
          >
            <MessageCircle className="h-4 w-4" /> {result.isCreditSale ? 'Send Credit Receipt' : 'WhatsApp'}
          </button>
          <button
            onClick={async () => {
              try {
                const usedNative = await shareNative(result, currency);
                toast({ title: usedNative ? 'Shared!' : 'Copied to clipboard ✓' });
              } catch {
                toast({ variant: 'destructive', title: 'Could not share', description: 'Copy the invoice details manually.' });
              }
            }}
            className="flex-1 h-11 rounded-xl border-2 border-border font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
          >
            <Share2 className="h-4 w-4" /> Share / Copy
          </button>
        </div>
        {result.isCreditSale && (
          <p className="text-xs text-green-700 dark:text-green-400">
            → Tap “Send Credit Receipt” to WhatsApp the customer their balance and due date.
          </p>
        )}
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

      {/* ── REJECT REASON INPUT ── */}
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
            <button className="action-btn-secondary flex-1" onClick={() => setShowRejectInput(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── STICKY APPROVE / REJECT BAR ── */}
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
                <ThumbsUp className="h-5 w-5" /> Submit Invoice
              </button>
              <button
                className="action-btn-secondary flex-1 border-red-400 text-red-600"
                onClick={() => setShowRejectInput(true)}
              >
                <ThumbsDown className="h-5 w-5" /> Rewrite
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Approved/rejected confirmation */}
      {!canAct && (
        <div className={`rounded-2xl p-4 text-center font-bold text-lg ${isApproved ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'}`}>
          {isApproved ? '✅ Submitted' : '✏️ Rewrite Required'}
          {isApproved && result.approvedAt && <p className="text-sm font-normal mt-1">{new Date(result.approvedAt).toLocaleString()}</p>}
          {isRejected && result.rejectionReason && <p className="text-sm font-normal mt-1">{result.rejectionReason}</p>}
        </div>
      )}
    </div>
  );
};
