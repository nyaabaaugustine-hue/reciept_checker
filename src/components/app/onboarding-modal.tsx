'use client';

import { useState } from 'react';
import { ChevronRight, ChevronLeft, X, ShieldCheck, Camera, AlertTriangle, FileText, BarChart2 } from 'lucide-react';

const STEPS = [
  {
    icon: ShieldCheck,
    iconColor: 'text-primary',
    iconBg: 'bg-primary/10',
    title: 'Welcome to InvoiceGuard AI',
    body: 'This app protects you and your company from invoice fraud, overcharges, and duplicate payments. Every invoice you scan is verified by AI in seconds.',
    tip: null,
  },
  {
    icon: Camera,
    iconColor: 'text-blue-600',
    iconBg: 'bg-blue-50 dark:bg-blue-950/30',
    title: 'Scan Every Invoice',
    body: 'Before you accept an invoice and collect money, scan it with the camera. Point your camera at the invoice, keep it flat and in good light, and tap Scan.',
    tip: '📸 Good lighting = better accuracy. Avoid shadows.',
  },
  {
    icon: ShieldCheck,
    iconColor: 'text-green-600',
    iconBg: 'bg-green-50 dark:bg-green-950/30',
    title: 'Read the Verdict',
    body: 'Every scan produces a colour-coded verdict:\n🟢 ACCEPT — Safe to collect.\n🟡 CAUTION — Check the flagged issues.\n🟠 ESCALATE — Numbers don\'t add up.\n🔴 REJECT — Do NOT collect money.',
    tip: '⚠️ Never collect money on a RED invoice without manager approval.',
  },
  {
    icon: AlertTriangle,
    iconColor: 'text-amber-600',
    iconBg: 'bg-amber-50 dark:bg-amber-950/30',
    title: 'Watch for Warnings',
    body: 'The app will alert you to duplicates, partial payments, credit sales, overdue balances, and suspicious price changes. Always read the warnings before submitting.',
    tip: '🔁 Duplicate invoices are the #1 fraud method. The app catches them automatically.',
  },
  {
    icon: FileText,
    iconColor: 'text-purple-600',
    iconBg: 'bg-purple-50 dark:bg-purple-950/30',
    title: 'Submit or Reject',
    body: 'After reviewing, tap Submit Invoice to record a successful collection, or Rewrite to flag it for correction. For credit sales, always set a payment due date.',
    tip: '📋 Credit sale? Set the due date so the app reminds you to collect.',
  },
  {
    icon: BarChart2,
    iconColor: 'text-primary',
    iconBg: 'bg-primary/10',
    title: 'Track Your Performance',
    body: 'Use the Dashboard to see your totals, the Week button for your weekly summary, and the Debt Ledger for outstanding credit. Download daily and monthly reports for your manager.',
    tip: '📊 Your data stays on your phone — nothing is stored on external servers.',
  },
];

interface OnboardingModalProps {
  onDone: () => void;
}

export function OnboardingModal({ onDone }: OnboardingModalProps) {
  const [step, setStep] = useState(0);

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const Icon = current.icon;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center bg-black/60">
      <div
        className="relative bg-card w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden animate-fade-in-up"
        style={{ maxHeight: '92dvh' }}
      >
        {/* Skip */}
        <button
          className="absolute top-4 right-4 text-xs text-muted-foreground px-3 py-1.5 rounded-full hover:bg-muted transition-colors"
          onClick={onDone}
        >
          Skip
        </button>

        <div className="px-6 pt-8 pb-6 flex flex-col items-center text-center space-y-4">
          {/* Icon */}
          <div className={`w-20 h-20 rounded-full flex items-center justify-center ${current.iconBg}`}>
            <Icon className={`h-10 w-10 ${current.iconColor}`} />
          </div>

          {/* Step indicator */}
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-primary' : 'w-1.5 bg-muted-foreground/30'}`}
              />
            ))}
          </div>

          {/* Title */}
          <h2 className="text-xl font-black">{current.title}</h2>

          {/* Body */}
          <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
            {current.body}
          </p>

          {/* Tip */}
          {current.tip && (
            <div className="w-full bg-muted rounded-2xl px-4 py-3 text-left">
              <p className="text-xs font-semibold leading-snug">{current.tip}</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="px-6 pb-8 flex gap-3">
          {step > 0 && (
            <button
              className="flex items-center justify-center gap-1 px-4 h-12 rounded-xl border-2 border-border font-semibold text-sm active:scale-95 transition-transform"
              onClick={() => setStep(s => s - 1)}
            >
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
          )}
          <button
            className="flex-1 h-12 rounded-xl bg-primary text-primary-foreground font-bold text-sm flex items-center justify-center gap-1.5 active:scale-95 transition-transform"
            onClick={() => isLast ? onDone() : setStep(s => s + 1)}
          >
            {isLast ? (
              <>
                <ShieldCheck className="h-4 w-4" /> Start Scanning
              </>
            ) : (
              <>
                Next <ChevronRight className="h-4 w-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
