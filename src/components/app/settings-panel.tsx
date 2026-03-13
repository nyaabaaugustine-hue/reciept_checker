'use client';

import { useState } from 'react';
import { useSettings, hashPin } from '@/hooks/use-settings';
import { DEFAULT_SETTINGS } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import {
  X, User, DollarSign, Percent, AlertTriangle, Tag,
  Lock, Unlock, ShieldCheck, Plus, Trash2, Eye, EyeOff,
} from 'lucide-react';
import { Input } from '@/components/ui/input';

const CURRENCIES = ['GHS', 'USD', 'EUR', 'GBP', 'NGN', 'KES', 'ZAR', 'XOF', 'TZS', 'UGX', 'ETB', 'MAD'];
const DEFAULT_CATEGORIES = ['Groceries', 'Office Supplies', 'Utilities', 'Transport', 'Dining', 'Electronics', 'Healthcare', 'Other'];

interface SettingsPanelProps {
  onClose: () => void;
  onExportAll: () => void;
  onImportAll: (file: File) => void;
  historyCount: number;
}

export const SettingsPanel = ({ onClose, onExportAll, onImportAll, historyCount }: SettingsPanelProps) => {
  const [settings, setSettings] = useSettings();
  const { toast } = useToast();
  const [newCategory, setNewCategory] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinStep, setPinStep] = useState<'idle' | 'enter' | 'confirm'>('idle');

  const update = (patch: Partial<typeof settings>) => {
    setSettings(prev => ({ ...prev, ...patch }));
  };

  const addCategory = () => {
    const cat = newCategory.trim();
    if (!cat) return;
    if (DEFAULT_CATEGORIES.includes(cat) || settings.customCategories.includes(cat)) {
      toast({ title: 'Category already exists' }); return;
    }
    update({ customCategories: [...settings.customCategories, cat] });
    setNewCategory('');
  };

  const removeCategory = (cat: string) => {
    update({ customCategories: settings.customCategories.filter(c => c !== cat) });
  };

  const handleEnablePin = () => {
    setPinStep('enter');
    setPinInput('');
    setPinConfirm('');
  };

  const handlePinEntry = async () => {
    if (pinInput.length < 4) { toast({ variant: 'destructive', title: 'PIN must be 4 digits' }); return; }
    if (pinStep === 'enter') {
      setPinStep('confirm');
      setPinConfirm('');
      return;
    }
    // confirm step
    if (pinInput !== pinConfirm) {
      toast({ variant: 'destructive', title: 'PINs do not match. Try again.' });
      setPinStep('enter');
      setPinInput('');
      return;
    }
    const hash = await hashPin(pinInput);
    update({ pinEnabled: true, pinHash: hash });
    setPinStep('idle');
    setPinInput('');
    toast({ title: '🔒 PIN lock enabled' });
  };

  const handleDisablePin = () => {
    update({ pinEnabled: false, pinHash: '' });
    toast({ title: '🔓 PIN lock disabled' });
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) onImportAll(file);
    };
    input.click();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background overflow-y-auto"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Header */}
      <div className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b flex items-center justify-between px-4 py-3">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" /> Settings
        </h2>
        <button
          onClick={onClose}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-muted active:scale-95"
          aria-label="Close settings"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="p-4 space-y-6 max-w-lg mx-auto w-full pb-16">

        {/* ── SALESMAN PROFILE ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <User className="h-4 w-4" /> Profile
          </h3>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Your Name (shown in reports)</label>
            <Input
              value={settings.salesmanName}
              onChange={e => update({ salesmanName: e.target.value })}
              placeholder="e.g. Kofi Mensah"
              className="h-12 text-base rounded-xl"
            />
          </div>
        </section>

        {/* ── CURRENCY & TAX ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <DollarSign className="h-4 w-4" /> Currency & Tax
          </h3>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Default Currency</label>
            <div className="grid grid-cols-4 gap-2">
              {CURRENCIES.map(c => (
                <button
                  key={c}
                  onClick={() => update({ currency: c })}
                  className={`h-11 rounded-xl text-sm font-bold border-2 transition-colors ${settings.currency === c ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-foreground active:scale-95'}`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Percent className="h-3 w-3" /> Expected Tax / VAT Rate (%)
            </label>
            <Input
              type="number"
              min={0}
              max={100}
              value={settings.taxRatePct}
              onChange={e => update({ taxRatePct: parseFloat(e.target.value) || 0 })}
              className="h-12 text-base rounded-xl"
              placeholder="15"
            />
            <p className="text-xs text-muted-foreground">Used to flag invoices with unusual tax rates</p>
          </div>
        </section>

        {/* ── RISK ALERT THRESHOLD ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> Risk Alert
          </h3>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Alert when money-at-risk exceeds ({settings.currency})
            </label>
            <Input
              type="number"
              min={0}
              value={settings.riskThreshold}
              onChange={e => update({ riskThreshold: e.target.value })}
              className="h-12 text-base rounded-xl"
              placeholder={`e.g. 5000`}
            />
            <p className="text-xs text-muted-foreground">Leave blank to disable. Shows a warning on the dashboard.</p>
          </div>
        </section>

        {/* ── CUSTOM CATEGORIES ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Tag className="h-4 w-4" /> Custom Categories
          </h3>
          <div className="flex gap-2">
            <Input
              value={newCategory}
              onChange={e => setNewCategory(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addCategory()}
              placeholder="Add a category..."
              className="h-12 text-base rounded-xl flex-1"
            />
            <button
              onClick={addCategory}
              className="h-12 w-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0 active:scale-95"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
          {/* Built-in categories */}
          <div className="flex flex-wrap gap-2">
            {DEFAULT_CATEGORIES.map(c => (
              <span key={c} className="px-3 py-1 rounded-full bg-muted text-xs font-medium text-muted-foreground">{c}</span>
            ))}
            {settings.customCategories.map(c => (
              <span key={c} className="px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center gap-1">
                {c}
                <button onClick={() => removeCategory(c)} className="ml-1 text-primary/70 hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        </section>

        {/* ── PIN LOCK ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Lock className="h-4 w-4" /> App PIN Lock
          </h3>
          {settings.pinEnabled ? (
            <div className="rounded-2xl border-2 border-green-300 bg-green-50 dark:bg-green-950/30 p-4 space-y-3">
              <p className="text-sm font-bold text-green-700 dark:text-green-400 flex items-center gap-2">
                <Lock className="h-4 w-4" /> PIN lock is active
              </p>
              <button
                onClick={handleDisablePin}
                className="w-full h-11 rounded-xl border-2 border-red-400 text-red-600 font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
              >
                <Unlock className="h-4 w-4" /> Disable PIN
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {pinStep === 'idle' ? (
                <button
                  onClick={handleEnablePin}
                  className="w-full h-12 rounded-xl border-2 border-primary text-primary font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
                >
                  <Lock className="h-4 w-4" /> Enable 4-digit PIN
                </button>
              ) : (
                <div className="rounded-2xl border-2 border-primary/30 bg-primary/5 p-4 space-y-3">
                  <p className="text-sm font-semibold text-center">
                    {pinStep === 'enter' ? 'Enter a 4-digit PIN' : 'Confirm your PIN'}
                  </p>
                  <div className="relative">
                    <Input
                      type={showPin ? 'text' : 'password'}
                      inputMode="numeric"
                      maxLength={4}
                      value={pinStep === 'enter' ? pinInput : pinConfirm}
                      onChange={e => {
                        const val = e.target.value.replace(/\D/g, '').slice(0, 4);
                        if (pinStep === 'enter') setPinInput(val);
                        else setPinConfirm(val);
                      }}
                      className="h-12 text-center text-2xl tracking-[0.5em] rounded-xl"
                      placeholder="••••"
                      autoFocus
                    />
                    <button
                      onClick={() => setShowPin(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    >
                      {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handlePinEntry}
                      className="flex-1 h-11 rounded-xl bg-primary text-primary-foreground font-bold text-sm active:scale-95"
                    >
                      {pinStep === 'enter' ? 'Next' : 'Set PIN'}
                    </button>
                    <button
                      onClick={() => { setPinStep('idle'); setPinInput(''); setPinConfirm(''); }}
                      className="flex-1 h-11 rounded-xl border-2 border-border font-bold text-sm active:scale-95"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground text-center">Protect invoice data with a PIN on app launch</p>
            </div>
          )}
        </section>

        {/* ── DATA & BACKUP ── */}
        <section className="space-y-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Data & Backup</h3>
          <div className="rounded-2xl border bg-muted/40 p-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              {historyCount} invoice{historyCount !== 1 ? 's' : ''} stored on this device
            </p>
            <p className="text-xs text-muted-foreground">
              🔒 Your data stays on your device. Only invoice images are sent to the AI for reading — nothing is stored on our servers.
            </p>
            <button
              onClick={onExportAll}
              className="w-full h-11 rounded-xl border-2 border-primary text-primary font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
            >
              Export All History (JSON)
            </button>
            <button
              onClick={handleImport}
              className="w-full h-11 rounded-xl border-2 border-border font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
            >
              Import History (JSON)
            </button>
          </div>
        </section>

        {/* ── RESET ── */}
        <section className="space-y-3">
          <button
            onClick={() => {
              setSettings(DEFAULT_SETTINGS);
              toast({ title: 'Settings reset to defaults' });
            }}
            className="w-full h-11 rounded-xl border-2 border-destructive/40 text-destructive font-bold text-sm flex items-center justify-center gap-2 active:scale-95"
          >
            <Trash2 className="h-4 w-4" /> Reset All Settings
          </button>
        </section>
      </div>
    </div>
  );
};
