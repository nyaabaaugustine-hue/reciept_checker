'use client';

import { useState } from 'react';
import { hashPin } from '@/hooks/use-settings';
import { ShieldCheck, Eye, EyeOff } from 'lucide-react';

interface PinLockScreenProps {
  pinHash: string;
  onUnlock: () => void;
  onForgotPin?: () => void;
}

export const PinLockScreen = ({ pinHash, onUnlock, onForgotPin }: PinLockScreenProps) => {
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);

  const handleDigit = (d: string) => {
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 4) verifyPin(next);
  };

  const handleDelete = () => setPin(p => p.slice(0, -1));

  const verifyPin = async (p: string) => {
    const hash = await hashPin(p);
    if (hash === pinHash) {
      onUnlock();
    } else {
      setError('Wrong PIN. Try again.');
      setShake(true);
      setTimeout(() => { setShake(false); setPin(''); setError(''); }, 700);
    }
  };

  const digits = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex flex-col items-center gap-8 w-full max-w-xs px-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-2">
          <ShieldCheck className="h-16 w-16 text-primary" />
          <h1 className="text-2xl font-black">InvoiceGuard AI</h1>
          <p className="text-sm text-muted-foreground">Enter your PIN to continue</p>
        </div>

        {/* PIN dots */}
        <div
          className={`flex gap-4 ${shake ? 'animate-bounce' : ''}`}
          style={shake ? { animation: 'shake 0.5s ease' } : {}}
        >
          {[0,1,2,3].map(i => (
            <div
              key={i}
              className={`w-5 h-5 rounded-full border-2 transition-all ${pin.length > i ? 'bg-primary border-primary' : 'border-muted-foreground/40'}`}
            />
          ))}
        </div>

        {/* Error */}
        {error && (
          <p className="text-sm text-destructive font-semibold -mt-4">{error}</p>
        )}

        {/* Forgot PIN */}
        {onForgotPin && (
          <button
            onClick={onForgotPin}
            className="text-xs text-muted-foreground underline underline-offset-2 -mt-4"
          >
            Forgot PIN? Reset (clears PIN lock)
          </button>
        )}

        {/* Dial pad */}
        <div className="grid grid-cols-3 gap-3 w-full">
          {digits.map((d, i) => {
            if (d === '') return <div key={i} />;
            const isDelete = d === '⌫';
            return (
              <button
                key={i}
                onClick={() => isDelete ? handleDelete() : handleDigit(d)}
                className={`h-16 rounded-2xl text-2xl font-bold flex items-center justify-center transition-all active:scale-90 ${
                  isDelete
                    ? 'bg-muted text-muted-foreground text-xl'
                    : 'bg-card border-2 border-border text-foreground active:bg-primary active:text-primary-foreground active:border-primary'
                }`}
              >
                {d}
              </button>
            );
          })}
        </div>
      </div>

      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }
      `}</style>
    </div>
  );
};
