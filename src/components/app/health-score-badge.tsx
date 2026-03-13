'use client';

import { useState } from 'react';
import { healthScoreBreakdown, healthLabel } from '@/lib/invoice-intelligence';
import type { InvoiceProcessingResult } from '@/lib/types';
import { CheckCircle, XCircle, ChevronDown, ChevronUp } from 'lucide-react';

interface HealthScoreBadgeProps {
  result: InvoiceProcessingResult;
  size?: 'sm' | 'lg';
}

export const HealthScoreBadge = ({ result, size = 'sm' }: HealthScoreBadgeProps) => {
  const [open, setOpen] = useState(false);
  const score = result.healthScore ?? 0;
  const { label, colour } = healthLabel(score);
  const breakdown = healthScoreBreakdown(result);

  const ringColour = score >= 85 ? '#16a34a' : score >= 65 ? '#2563eb' : score >= 40 ? '#d97706' : '#dc2626';
  const r = 20;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/15 active:scale-95 transition-transform ${size === 'lg' ? 'text-sm' : 'text-xs'}`}
        aria-label={`Health score ${score}/100 — ${label}. Tap for breakdown.`}
      >
        {/* Mini ring */}
        <svg width="28" height="28" viewBox="0 0 48 48" className="flex-shrink-0">
          <circle cx="24" cy="24" r={r} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="5" />
          <circle
            cx="24" cy="24" r={r}
            fill="none"
            stroke={ringColour}
            strokeWidth="5"
            strokeDasharray={`${dash} ${circ}`}
            strokeLinecap="round"
            transform="rotate(-90 24 24)"
            style={{ transition: 'stroke-dasharray 0.5s ease' }}
          />
          <text x="24" y="28" textAnchor="middle" fontSize="13" fontWeight="900" fill="white">{score}</text>
        </svg>
        <span className="font-bold">Health {score}/100</span>
        <span className="opacity-70">{label}</span>
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>

      {open && (
        <div
          className="absolute top-full mt-2 left-0 z-50 bg-card border-2 border-border rounded-2xl shadow-2xl p-4 w-72 space-y-2"
          style={{ color: 'hsl(var(--foreground))' }}
        >
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Score Breakdown</p>
          {breakdown.map((item, i) => (
            <div key={i} className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                {item.ok
                  ? <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
                  : <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />}
                <span className={item.ok ? 'text-foreground' : 'text-red-600 dark:text-red-400 font-medium'}>{item.label}</span>
              </div>
              {!item.ok && (
                <span className="text-red-600 dark:text-red-400 font-bold flex-shrink-0">−{item.deduction}</span>
              )}
            </div>
          ))}
          <div className="border-t pt-2 flex items-center justify-between font-bold text-sm">
            <span>Total Score</span>
            <span style={{ color: ringColour }}>{score} / 100</span>
          </div>
        </div>
      )}
    </div>
  );
};
