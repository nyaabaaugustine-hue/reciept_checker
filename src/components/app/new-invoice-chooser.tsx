'use client';

import { FileText, Mic, X, Sparkles } from 'lucide-react';

interface NewInvoiceChooserProps {
  onClose: () => void;
  onSelectManual: () => void;
  onSelectVoice: () => void;
}

export function NewInvoiceChooser({ onClose, onSelectManual, onSelectVoice }: NewInvoiceChooserProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Sheet */}
      <div
        className="relative bg-card rounded-t-3xl shadow-2xl px-4 pt-5 pb-8 animate-fade-in-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Drag pill */}
        <div className="w-10 h-1 bg-muted-foreground/20 rounded-full mx-auto mb-5" />

        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-black">New Invoice</h2>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-sm text-muted-foreground mb-4">Choose how you'd like to create your invoice:</p>

        <div className="grid grid-cols-1 gap-3">
          {/* Manual */}
          <button
            onClick={onSelectManual}
            className="group flex items-center gap-4 rounded-2xl border-2 border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/60 p-4 text-left transition-all active:scale-95"
          >
            <div className="w-14 h-14 rounded-2xl bg-primary/10 group-hover:bg-primary/20 flex items-center justify-center flex-shrink-0 transition-colors">
              <FileText className="h-7 w-7 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-base">Manual Form</p>
              <p className="text-sm text-muted-foreground mt-0.5">Fill in customer, items & amounts using dropdowns and fields</p>
            </div>
          </button>

          {/* Voice */}
          <button
            onClick={onSelectVoice}
            className="group flex items-center gap-4 rounded-2xl border-2 border-violet-400/40 bg-violet-500/5 hover:bg-violet-500/10 hover:border-violet-500/60 p-4 text-left transition-all active:scale-95"
          >
            <div className="w-14 h-14 rounded-2xl bg-violet-500/10 group-hover:bg-violet-500/20 flex items-center justify-center flex-shrink-0 transition-colors relative">
              <Mic className="h-7 w-7 text-violet-500" />
              <Sparkles className="h-3.5 w-3.5 text-violet-400 absolute -top-1 -right-1" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-bold text-base">Voice Invoice</p>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-600 dark:text-violet-400 border border-violet-400/30">AI</span>
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">Speak your items — AI transcribes and builds the invoice instantly</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
