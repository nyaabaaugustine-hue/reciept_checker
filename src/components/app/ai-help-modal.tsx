'use client';

import { useState } from 'react';
import { HelpCircle, Eye, EyeOff, ChevronRight, AlertTriangle, Sparkles, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { ValidatedData, ValidationError } from '@/lib/types';

export interface AIHelpField {
  key: string;
  label: string;
  hint: string;
  type: 'text' | 'number' | 'date';
  currentValue?: string;
}

interface AIHelpModalProps {
  fields: AIHelpField[];
  previewImageUri?: string;
  onSubmit: (filled: Record<string, string>) => void;
  onSkip: () => void;
}

export function AIHelpModal({ fields, previewImageUri, onSubmit, onSkip }: AIHelpModalProps) {
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(fields.map(f => [f.key, f.currentValue ?? '']))
  );
  const [showImage, setShowImage] = useState(true);

  const filled = fields.filter(f => values[f.key]?.trim()).length;
  const total = fields.length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background animate-fade-in-up">
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0 bg-amber-50 dark:bg-amber-950/40">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center">
            <HelpCircle className="h-5 w-5 text-amber-600" />
          </div>
          <div>
            <h2 className="font-bold text-base leading-tight">AI Needs Your Help</h2>
            <p className="text-xs text-muted-foreground">{filled}/{total} fields filled</p>
          </div>
        </div>
        <button onClick={onSkip} className="p-2 rounded-full hover:bg-muted">
          <X className="h-5 w-5 text-muted-foreground" />
        </button>
      </div>

      <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 px-4 py-3 flex-shrink-0">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              The AI could not read {total} field{total !== 1 ? 's' : ''} clearly from the scan.
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              Look at the invoice image and type in the missing values. Skip any you cannot see either.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 pb-32">
        {previewImageUri && (
          <div className="rounded-2xl border-2 border-amber-300 overflow-hidden">
            <button
              onClick={() => setShowImage(v => !v)}
              className="w-full flex items-center justify-between px-4 py-3 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 active:opacity-70"
            >
              <span className="text-sm font-bold text-amber-800 dark:text-amber-300 flex items-center gap-2">
                {showImage ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                {showImage ? 'Hide' : 'Show'} Invoice Image
              </span>
              <span className="text-xs text-amber-600">Reference the original</span>
            </button>
            {showImage && (
              <div className="bg-black/5 p-2">
                <img
                  src={previewImageUri}
                  alt="Invoice scan"
                  className="w-full rounded-xl object-contain max-h-64"
                />
              </div>
            )}
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wider">
              Fill in what you can see on the invoice
            </h3>
          </div>

          {fields.map(field => (
            <div key={field.key} className="space-y-1.5">
              <label className="text-sm font-bold flex items-center gap-2">
                {field.label}
                {values[field.key]?.trim()
                  ? <span className="text-xs font-semibold text-green-600 bg-green-100 dark:bg-green-900/30 px-2 py-0.5 rounded-full">filled</span>
                  : <span className="text-xs text-amber-600 bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 rounded-full">needed</span>
                }
              </label>
              <p className="text-xs text-muted-foreground leading-snug">{field.hint}</p>
              <Input
                type={field.type}
                value={values[field.key] ?? ''}
                onChange={e => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                placeholder={field.type === 'number' ? '0.00' : field.type === 'date' ? 'DD/MM/YYYY' : '—'}
                className={`h-12 text-base rounded-xl border-2 ${
                  values[field.key]?.trim()
                    ? 'border-green-400 bg-green-50 dark:bg-green-950/20'
                    : 'border-amber-300 bg-amber-50/50 dark:bg-amber-950/20'
                }`}
                step={field.type === 'number' ? '0.01' : undefined}
                min={field.type === 'number' ? '0' : undefined}
              />
            </div>
          ))}
        </div>

        <div className="rounded-2xl bg-muted/40 p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-bold">{filled} / {total} filled</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: total > 0 ? `${(filled / total) * 100}%` : '0%' }}
            />
          </div>
          {filled === total && total > 0 && (
            <p className="text-xs font-semibold text-green-600 dark:text-green-400">
              All fields filled — tap Apply to continue.
            </p>
          )}
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 border-t bg-background px-4 py-3 flex gap-3">
        <button onClick={onSkip} className="action-btn-secondary flex-1 text-sm">
          Skip
        </button>
        <button
          onClick={() => onSubmit(values)}
          className="action-btn-primary flex-1 text-sm"
        >
          <ChevronRight className="h-4 w-4" />
          Apply &amp; Continue
        </button>
      </div>
    </div>
  );
}

export function buildHelpFields(validatedData: ValidatedData, errors: ValidationError[]): AIHelpField[] {
  const fields: AIHelpField[] = [];
  const errorFields = new Set(errors.map(e => e.field));

  const totalMissing = validatedData.total === undefined && errorFields.has('total');
  const totalLowConf = errors.some(e =>
    e.field === 'total' &&
    (e.message.includes('confidence') || e.message.includes('difficult to read') ||
     e.message.includes('unreadable') || e.message.includes('missing'))
  );

  if (totalMissing) {
    fields.push({
      key: 'total',
      label: 'Grand Total',
      hint: 'The final payable amount at the bottom of the invoice. Include cents (e.g. 1250.00).',
      type: 'number',
      currentValue: '',
    });
  } else if (totalLowConf && validatedData.total !== undefined) {
    fields.push({
      key: 'total',
      label: 'Grand Total — please confirm',
      hint: `AI read ${validatedData.total.toFixed(2)} but was not confident. Check the physical invoice and correct if wrong.`,
      type: 'number',
      currentValue: String(validatedData.total),
    });
  }

  if (!validatedData.invoice_number && errorFields.has('invoice_number')) {
    fields.push({
      key: 'invoice_number',
      label: 'Invoice Number',
      hint: 'Usually near the top — may say "Invoice No.", "Inv #", "Receipt No." or similar.',
      type: 'text',
      currentValue: '',
    });
  }

  if (!validatedData.customer_name && errorFields.has('customer_name')) {
    fields.push({
      key: 'customer_name',
      label: 'Vendor / Supplier Name',
      hint: 'The business name printed at the top of the invoice — who issued this document?',
      type: 'text',
      currentValue: '',
    });
  }

  if (!validatedData.date) {
    fields.push({
      key: 'date',
      label: 'Invoice Date',
      hint: 'The date printed on the invoice. Type it exactly as you see it.',
      type: 'text',
      currentValue: '',
    });
  }

  return fields;
}

export function shouldShowHelpModal(validatedData: ValidatedData, errors: ValidationError[]): boolean {
  return buildHelpFields(validatedData, errors).length > 0;
}
