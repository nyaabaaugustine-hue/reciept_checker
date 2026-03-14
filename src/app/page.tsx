'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { processInvoice } from '@/app/actions';
import { useToast } from '@/hooks/use-toast';
import { useLocalStorage } from '@/hooks/use-local-storage';
import { useSettings } from '@/hooks/use-settings';
import { AppHeader } from '@/components/app/app-header';
import { DashboardView } from '@/components/app/dashboard-view';
import { ProcessingView } from '@/components/app/processing-view';
import { ResultsView } from '@/components/app/results-view';
import { HistorySidebar } from '@/components/app/history-sidebar';
import { CameraView } from '@/components/app/camera-view';
import { SettingsPanel } from '@/components/app/settings-panel';
import { PinLockScreen } from '@/components/app/pin-lock-screen';
import type { InvoiceProcessingResult, SlimInvoiceResult, ValidatedData } from '@/lib/types';
import {
  getOfflineQueue, removeFromOfflineQueue, addToOfflineQueue,
  preprocessImage, checkImageQuality,
  checkRiskThreshold,
  checkCustomerCreditHistory,
} from '@/lib/invoice-intelligence';
import { exportAllHistory, importHistory } from '@/lib/utils';
import { Camera, Upload, History, LayoutDashboard, X, Mic, BarChart2, BarChart } from 'lucide-react';
import { NewInvoiceChooser } from '@/components/app/new-invoice-chooser';
import { ManualInvoiceModal } from '@/components/app/manual-invoice-modal';
import { VoiceInvoiceModal } from '@/components/app/voice-invoice-modal';
import { AIHelpModal, buildHelpFields, shouldShowHelpModal } from '@/components/app/ai-help-modal';
import { WeeklySummary } from '@/components/app/weekly-summary';
import { DebtLedger } from '@/components/app/debt-ledger';
import { OnboardingModal } from '@/components/app/onboarding-modal';
import { useCreditDueNotifications } from '@/hooks/use-credit-notifications';
import { useBlacklist } from '@/hooks/use-blacklist';
import { normaliseVendorKey } from '@/lib/invoice-intelligence';
import { exportMonthlyReport } from '@/lib/monthly-report';

type ViewState = 'dashboard' | 'processing' | 'results';

// ── strip ocrText before sending history to server ──
function slimHistory(history: InvoiceProcessingResult[]): SlimInvoiceResult[] {
  return history.map(({ ocrText: _ocr, ...rest }) => rest);
}

const HistorySkeletons = () => (
  <div className="space-y-2 p-3">
    {[1, 2, 3].map(i => (
      <div key={i} className="rounded-2xl border bg-card p-3 space-y-2 animate-pulse">
        <div className="flex justify-between">
          <div className="h-4 bg-muted rounded w-1/2" />
          <div className="h-4 bg-muted rounded w-16" />
        </div>
        <div className="h-3 bg-muted rounded w-1/3" />
      </div>
    ))}
  </div>
);

export default function HomePage() {
  const [history, setHistory] = useLocalStorage<InvoiceProcessingResult[]>('invoice-history', []);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    // Show onboarding on first launch
    if (!localStorage.getItem('invoiceguard_onboarded')) {
      setShowOnboarding(true);
    }
  }, []);
  const [settings, setSettings] = useSettings();
  const [view, setView] = useState<ViewState>('dashboard');
  const [activeResult, setActiveResult] = useState<InvoiceProcessingResult | null>(null);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showHistoryLoading, setShowHistoryLoading] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewInvoiceChooser, setShowNewInvoiceChooser] = useState(false);
  const [showManualModal, setShowManualModal] = useState(false);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [helpModalResult, setHelpModalResult] = useState<InvoiceProcessingResult | null>(null);
  const [lastImageUri, setLastImageUri] = useState<string>('');
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [showWeeklySummary, setShowWeeklySummary] = useState(false);
  const [showDebtLedger, setShowDebtLedger] = useState(false);
  const [showMonthlyReportPicker, setShowMonthlyReportPicker] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wakeLockRef = useRef<any>(null);
  const riskAlertedRef = useRef(false);
  const { toast } = useToast();
  const { isBlocked: isVendorBlocked, get: getBlacklistEntry } = useBlacklist();

  // #8 — today's scan count
  const todayScanCount = useMemo(() => {
    if (!mounted) return 0;
    const today = new Date().toDateString();
    return history.filter(h => new Date(h.createdAt).toDateString() === today).length;
  }, [history, mounted]);

  // #3 — Credit due date push notifications
  useCreditDueNotifications(history, (title, description) => {
    toast({ title, description, duration: 12000 });
  });

  const pinRequired = settings.pinEnabled && settings.pinHash && !isUnlocked;

  useEffect(() => {
    if (sessionStorage.getItem('pwa-dismissed')) return;
    const handler = (e: any) => { e.preventDefault(); setDeferredPrompt(e); setShowInstallPrompt(true); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []); 

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setShowInstallPrompt(false);
  };

  useEffect(() => {
    const handleOnline = () => { setIsOnline(true); processOfflineQueue(); };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    setIsOnline(navigator.onLine);
    setOfflineQueueCount(getOfflineQueue().length);
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); };
  }, []);// eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'PROCESS_OFFLINE_QUEUE') processOfflineQueue();
    };
    navigator.serviceWorker?.addEventListener('message', handleMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', handleMessage);
  }, []);// eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!settings.riskThreshold) return;
    const { exceeded, atRisk, threshold } = checkRiskThreshold(history, settings.riskThreshold);
    if (exceeded && !riskAlertedRef.current) {
      riskAlertedRef.current = true;
      toast({
        variant: 'destructive',
        title: '🚨 Risk Threshold Exceeded',
        description: `${settings.currency} ${atRisk.toFixed(2)} at risk — above your ${settings.currency} ${threshold.toFixed(2)} alert threshold.`,
        duration: 12000,
      });
    } else if (!exceeded) {
      riskAlertedRef.current = false;
    }
  }, [history]);// eslint-disable-line react-hooks/exhaustive-deps

  const processOfflineQueue = useCallback(async () => {
    const queue = getOfflineQueue();
    if (!queue.length) return;
    toast({ title: `Processing ${queue.length} queued invoice(s)…` });
    for (const item of queue) {
      try {
        await submitImage(item.imageBase64);
        removeFromOfflineQueue(item.id);
        setOfflineQueueCount(getOfflineQueue().length);
      } catch { /* leave in queue */ }
    }
  }, []);// eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isCameraOpen && 'wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(lock => { wakeLockRef.current = lock; }).catch(() => {});
    } else if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }, [isCameraOpen]);

  const submitImage = async (imageUri: string): Promise<InvoiceProcessingResult | null> => {
    setView('processing');
    setProcessingStatus('Checking image quality…');

    const quality = await checkImageQuality(imageUri);
    if (!quality.ok) {
      setView('dashboard');
      // Block the scan completely — show retake screen
      toast({
        variant: 'destructive',
        title: '📷 Retake Photo',
        description: `${quality.reason} The scan cannot proceed with a bad photo.`,
        duration: 0, // stays until dismissed
      });
      // Re-open camera automatically so salesman retakes immediately
      setTimeout(() => setIsCameraOpen(true), 800);
      return null;
    }

    setLastImageUri(imageUri);
    setProcessingStatus('Optimising image…');
    const optimised = await preprocessImage(imageUri);

    setProcessingStatus('Verifying this is an invoice…');
    let result: InvoiceProcessingResult;
    try {
      result = await processInvoice(optimised, settings.taxRatePct, slimHistory(history));
    } catch (error: any) {
      const raw: string = error?.message ?? '';
      // #22 — user-friendly rate limit message
      let friendly = raw.replace('Invoice processing failed: ', '').replace('Error: ', '')
        || 'Could not read the invoice. Try again with better lighting.';
      if (raw.includes('429') || raw.includes('rate limit') || raw.includes('quota') || raw.includes('exhausted')) {
        friendly = 'Too many scans right now — all AI services are busy. Wait 1 minute and try again.';
      } else if (raw.includes('network') || raw.includes('fetch') || raw.includes('Failed to fetch')) {
        friendly = 'No internet connection. The invoice has been saved and will process when your signal returns.';
      }
      setView('dashboard');
      toast({ variant: 'destructive', title: 'Processing Failed', description: friendly, duration: 10000 });
      return null;
    }

    setProcessingStatus('Finalising analysis…');

    // ── Ask for human help if AI couldn't read critical fields ──
    if (shouldShowHelpModal(result.validatedData, result.errors)) {
      setHelpModalResult(result);
      setView('results'); // show results in bg
      setActiveResult(result);
      return result;
    }

    // ── Verdict toast ──
    const verdict = result.riskVerdict;
    if (verdict) {
      const isUrgent = verdict.verdict === 'REJECT' || verdict.verdict === 'ESCALATE';
      if (verdict.verdict === 'REJECT') {
        toast({ variant: 'destructive', title: '🔴 REJECT — Do NOT collect money', description: verdict.reason, duration: 15000 });
      } else if (verdict.verdict === 'ESCALATE') {
        toast({ variant: 'destructive', title: '🟠 ESCALATE — Check this invoice carefully', description: verdict.reason, duration: 15000 });
      } else if (verdict.verdict === 'CAUTION') {
        toast({ title: '🟡 CAUTION — Review before collecting', description: verdict.reason, duration: 10000 });
      } else {
        toast({ title: '🟢 ACCEPT — Safe to collect', description: verdict.reason, duration: 8000 });
      }
      // #9 — Haptic: urgent = strong pulse, ACCEPT = gentle single buzz
      if (isUrgent && 'vibrate' in navigator) navigator.vibrate([100, 50, 100, 50, 200]);
      else if (verdict.verdict === 'ACCEPT' && 'vibrate' in navigator) navigator.vibrate(80);
    }

    // Secondary toasts
    if (result.isDuplicate && verdict?.verdict !== 'REJECT') {
      toast({ variant: 'destructive', title: '⚠️ Duplicate Invoice', description: 'Already scanned. Do NOT collect money again.', duration: 12000 });
    }
    if (result.isPartialPayment && result.partialPaymentOriginalTotal !== undefined && verdict?.verdict !== 'CAUTION') {
      toast({ variant: 'destructive', title: '💰 Partial Payment', description: `Original total was ${result.partialPaymentOriginalTotal.toFixed(2)}. Verify with manager.`, duration: 12000 });
    }
    if (result.priceWarnings?.length && verdict?.verdict === 'ACCEPT') {
      toast({ title: '📈 Price Change', description: result.priceWarnings[0], duration: 10000 });
    }
    if (result.reconciliationApplied) {
      toast({ title: '🔄 Total Re-verified', description: 'Grand total was re-read and confirmed.', duration: 6000 });
    }
    // Credit history warning
    if (result.isCreditSale) {
      const creditHistory = checkCustomerCreditHistory(result.validatedData.customer_name, history);
      if (creditHistory.hasOutstandingCredit) {
        toast({
          variant: 'destructive',
          title: `📋 ${result.validatedData.customer_name} Already Owes GH¢${creditHistory.totalOwed.toFixed(2)}`,
          description: `This customer has ${creditHistory.count} outstanding credit invoice${creditHistory.count !== 1 ? 's' : ''} unpaid. Collect the old debt before giving more credit.`,
          duration: 15000,
        });
      }
    }

    // Blacklist check — warn after scan
    const scannedVendorKey = normaliseVendorKey(result.validatedData.customer_name);
    if (isVendorBlocked(scannedVendorKey)) {
      const entry = getBlacklistEntry(scannedVendorKey);
      toast({
        variant: 'destructive',
        title: `⛔ BLACKLISTED: ${result.validatedData.customer_name}`,
        description: entry?.reason || 'This vendor is on your blacklist. Do not collect money without manager approval.',
        duration: 15000,
      });
    }

    setHistory(prev => [result, ...prev]);
    setActiveResult(result);
    setView('results');
    return result;
  };

  const handleImageSubmit = async (imageUri: string) => {
    setIsCameraOpen(false);
    setShowHistory(false);
    if ('vibrate' in navigator) navigator.vibrate(50);
    if (!isOnline) {
      addToOfflineQueue(imageUri);
      setOfflineQueueCount(getOfflineQueue().length);
      toast({
        title: '📵 No Internet — Invoice Saved',
        description: `Invoice saved to queue (${getOfflineQueue().length} waiting). It will be processed automatically when your signal returns. You can keep scanning.`,
        duration: 10000,
      });
      return;
    }
    try { await submitImage(imageUri); }
    catch (err: any) {
      // If the scan fails due to network error, queue it
      if (err?.message?.includes('fetch') || err?.message?.includes('network') || err?.message?.includes('NetworkError')) {
        addToOfflineQueue(imageUri);
        setOfflineQueueCount(getOfflineQueue().length);
        setView('dashboard');
        toast({
          title: '📵 Network Error — Invoice Queued',
          description: 'Could not reach the server. Invoice saved and will retry automatically when connection is restored.',
          duration: 10000,
        });
      }
    }
    finally { setProcessingStatus(null); }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 12 * 1024 * 1024) {
        toast({ variant: 'destructive', title: 'File Too Large', description: 'Please use an image under 12MB.', duration: 8000 });
        if (e.target) e.target.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = async (ev) => {
        if (typeof ev.target?.result === 'string') await handleImageSubmit(ev.target.result);
      };
      reader.readAsDataURL(file);
    }
    if (e.target) e.target.value = '';
  };

  const handleHistorySelect = (result: InvoiceProcessingResult) => {
    setActiveResult(result); setView('results'); setShowHistory(false);
  };
  const handleReset = () => { setActiveResult(null); setView('dashboard'); };
  const handleUpdate = (id: string, data: ValidatedData) => {
    setHistory(prev => prev.map(i => i.id === id ? { ...i, validatedData: data, status: 'corrected' } : i));
    setActiveResult(prev => prev ? { ...prev, validatedData: data, status: 'corrected' } : null);
  };
  const handleNotesUpdate = (id: string, notes: string) => {
    setHistory(prev => prev.map(i => i.id === id ? { ...i, notes } : i));
    setActiveResult(prev => prev ? { ...prev, notes } : null);
  };
  const handleDueDateUpdate = (id: string, dueDate: string) => {
    setHistory(prev => prev.map(i => i.id === id ? { ...i, dueDate } : i));
    setActiveResult(prev => prev ? { ...prev, dueDate } : null);
  };
  const handleApprove = (id: string) => {
    const result = history.find(i => i.id === id) ?? activeResult;
    // Block submission of credit sale if no due date set
    if (result?.isCreditSale && !result?.dueDate) {
      toast({
        variant: 'destructive',
        title: '📋 Credit Sale — Due Date Required',
        description: 'You must set a payment due date before submitting a credit sale. Scroll up and set the due date.',
        duration: 8000,
      });
      return;
    }
    const now = new Date().toISOString();
    setHistory(prev => prev.map(i => i.id === id ? { ...i, status: 'approved', approvedAt: now } : i));
    setActiveResult(prev => prev ? { ...prev, status: 'approved', approvedAt: now } : null);
    const msg = result?.isCreditSale
      ? `Credit sale recorded. Follow up for payment on ${result.dueDate}.`
      : 'Invoice submitted successfully.';
    toast({ title: '✅ Submitted', description: msg });
  };
  const handleReject = (id: string, reason: string) => {
    const now = new Date().toISOString();
    setHistory(prev => prev.map(i => i.id === id ? { ...i, status: 'rejected', rejectedAt: now, rejectionReason: reason } : i));
    setActiveResult(prev => prev ? { ...prev, status: 'rejected', rejectedAt: now, rejectionReason: reason } : null);
    toast({ title: '❌ Rejected', description: `Reason: ${reason}` });
  };
  const handleClearHistory = () => { setHistory([]); handleReset(); };

  const handleHelpSubmit = (filled: Record<string, string>) => {
    if (!helpModalResult) return;
    const updated: InvoiceProcessingResult = {
      ...helpModalResult,
      validatedData: {
        ...helpModalResult.validatedData,
        ...(filled.total ? { total: parseFloat(filled.total) } : {}),
        ...(filled.invoice_number ? { invoice_number: filled.invoice_number } : {}),
        ...(filled.customer_name ? { customer_name: filled.customer_name } : {}),
        ...(filled.date ? { date: filled.date } : {}),
      },
    };
    // Remove errors for fields the user just filled
    updated.errors = updated.errors.filter(e => {
      if (filled.total && (e.field === 'total' || e.message.includes('Grand total'))) return false;
      if (filled.invoice_number && e.field === 'invoice_number') return false;
      if (filled.customer_name && e.field === 'customer_name') return false;
      if (filled.date && e.field === 'date') return false;
      return true;
    });
    updated.isValid = updated.errors.length === 0;
    setHistory(prev => [updated, ...prev.filter(i => i.id !== updated.id)]);
    setActiveResult(updated);
    setHelpModalResult(null);
    finishInvoice(updated);
  };

  const handleHelpSkip = () => {
    if (!helpModalResult) return;
    setHistory(prev => [helpModalResult, ...prev.filter(i => i.id !== helpModalResult.id)]);
    setHelpModalResult(null);
    finishInvoice(helpModalResult);
  };

  const finishInvoice = (result: InvoiceProcessingResult) => {
    setProcessingStatus(null);
    const verdict = result.riskVerdict;
    if (verdict) {
      const isUrgent = verdict.verdict === 'REJECT' || verdict.verdict === 'ESCALATE';
      if (verdict.verdict === 'REJECT') {
        toast({ variant: 'destructive', title: '🔴 REJECT — Do NOT collect money', description: verdict.reason, duration: 15000 });
      } else if (verdict.verdict === 'ESCALATE') {
        toast({ variant: 'destructive', title: '🟠 ESCALATE — Check this invoice carefully', description: verdict.reason, duration: 15000 });
      } else if (verdict.verdict === 'CAUTION') {
        toast({ title: '🟡 CAUTION — Review before collecting', description: verdict.reason, duration: 10000 });
      } else {
        toast({ title: '🟢 ACCEPT — Safe to collect', description: verdict.reason, duration: 8000 });
      }
      if (isUrgent && 'vibrate' in navigator) navigator.vibrate([100, 50, 100, 50, 200]);
    }
  };

  const handleManualInvoiceSubmit = (result: InvoiceProcessingResult) => {
    setShowManualModal(false);
    setHistory(prev => [result, ...prev]);
    setActiveResult(result);
    setView('results');
    toast({ title: '✅ Invoice Created', description: `Manual invoice saved for ${result.validatedData.customer_name || 'customer'}.` });
  };

  const handleVoiceInvoiceSubmit = (result: InvoiceProcessingResult) => {
    setShowVoiceModal(false);
    setHistory(prev => [result, ...prev]);
    setActiveResult(result);
    setView('results');
    toast({ title: '🎙️ Voice Invoice Saved', description: `Invoice created for ${result.validatedData.customer_name || 'customer'}.` });
  };

  const handleImportAll = async (file: File) => {
    try {
      const imported = await importHistory(file);
      setHistory(prev => {
        const existingIds = new Set(prev.map(i => i.id));
        const newEntries = imported.filter(i => !existingIds.has(i.id));
        return [...newEntries, ...prev];
      });
      toast({ title: `✅ Imported ${imported.length} invoices` });
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Import Failed', description: err.message });
    }
  };

  const handleHistoryToggle = () => {
    if (!showHistory) {
      setShowHistoryLoading(true);
      setTimeout(() => setShowHistoryLoading(false), 400);
    }
    setShowHistory(v => !v);
  };

  const renderMain = () => {
    if (view === 'processing') return <ProcessingView statusMessage={processingStatus} />;
    if (view === 'results' && activeResult) return (
      <ResultsView
        result={activeResult}
        onReset={handleReset}
        onUpdate={handleUpdate}
        onNotesUpdate={handleNotesUpdate}
        onDueDateUpdate={handleDueDateUpdate}
        onApprove={handleApprove}
        onReject={handleReject}
        currency={settings.currency}
      />
    );
    return (
      <DashboardView
        history={history}
        onUploadClick={() => fileInputRef.current?.click()}
        onCameraClick={() => setIsCameraOpen(true)}
        onNewInvoiceClick={() => setShowNewInvoiceChooser(true)}
        onWeeklyClick={() => setShowWeeklySummary(true)}
        onHistoryToggle={handleHistoryToggle}
        onDebtLedgerClick={() => setShowDebtLedger(true)}
        onMonthlyReportClick={() => {
          const now = new Date();
          exportMonthlyReport(history, now.getMonth(), now.getFullYear(), settings.currency, settings.salesmanName);
        }}
        historyCount={history.length}
        isOnline={isOnline}
        offlineQueueCount={offlineQueueCount}
      />
    );
  };

  if (pinRequired) return <PinLockScreen pinHash={settings.pinHash} onUnlock={() => setIsUnlocked(true)} />;

  return (
    <>
      <div className="flex flex-col" style={{ minHeight: '100dvh' }}>
        <AppHeader
          isOnline={isOnline}
          offlineQueueCount={offlineQueueCount}
          onHistoryToggle={handleHistoryToggle}
          historyCount={history.length}
          onSettingsOpen={() => setShowSettings(true)}
        />

        <main className="flex-1 overflow-y-auto pb-28" style={{ WebkitOverflowScrolling: 'touch' }}>
          <div className="container mx-auto px-3 py-4 max-w-2xl lg:max-w-6xl">
            {renderMain()}
          </div>
        </main>

        {showHistory && (
          <div className="fixed inset-0 z-40 flex flex-col" onClick={() => setShowHistory(false)}>
            <div className="flex-1 bg-black/40" />
            <div
              className="bg-card rounded-t-3xl shadow-2xl overflow-hidden animate-fade-in-up"
              style={{ maxHeight: '80dvh' }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between p-4 border-b">
                <h2 className="text-lg font-bold">Invoice History</h2>
                <button className="tap-target rounded-full" onClick={() => setShowHistory(false)}>
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: 'calc(80dvh - 64px)' }}>
                {showHistoryLoading ? <HistorySkeletons /> : (
                  <HistorySidebar
                    history={history}
                    onSelect={handleHistorySelect}
                    onClear={handleClearHistory}
                    isOpen={true}
                    inline={true}
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {view !== 'processing' && (
          <div className="bottom-bar no-print">
            {view === 'results' ? (
              <button className="action-btn-secondary flex-1 min-w-0" onClick={handleReset}>
                <LayoutDashboard className="h-4 w-4 flex-shrink-0" />
                <span className="truncate text-sm">Home</span>
              </button>
            ) : (
              <button className="action-btn-secondary flex-1 min-w-0" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4 flex-shrink-0" />
                <span className="truncate text-sm">Upload</span>
              </button>
            )}

            {/* #5 — Voice mic directly in bar */}
            <button className="action-btn-secondary flex-1 min-w-0" onClick={() => setShowVoiceModal(true)}>
              <Mic className="h-4 w-4 flex-shrink-0" />
              <span className="truncate text-sm">Voice</span>
            </button>
            <button className="action-btn-primary flex-1 min-w-0" onClick={() => setIsCameraOpen(true)}>
              <span className="relative flex-shrink-0">
                <Camera className="h-4 w-4" />
                {mounted && todayScanCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-0.5 flex items-center justify-center rounded-full bg-white/40 text-white text-[9px] font-bold leading-none">
                    {todayScanCount}
                  </span>
                )}
              </span>
              <span className="text-sm">Scan</span>
            </button>
          </div>
        )}

        {showInstallPrompt && (
          <div className="pwa-banner no-print" style={{ bottom: 'calc(72px + env(safe-area-inset-bottom, 0px) + 8px)' }}>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm truncate">Add to Home Screen</p>
              <p className="text-xs opacity-80 truncate">Use InvoiceGuard like a native app</p>
            </div>
            <button
              className="bg-white text-primary font-bold px-3 py-2 rounded-xl text-sm active:scale-95 flex-shrink-0"
              onClick={handleInstall}
            >
              Install
            </button>
            <button className="opacity-60 p-2 flex-shrink-0" onClick={() => { sessionStorage.setItem('pwa-dismissed', '1'); setShowInstallPrompt(false); }}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="image/png,image/jpeg,image/webp" className="hidden" />

      {isCameraOpen && (
        <CameraView
          onCapture={async (d) => { setIsCameraOpen(false); await handleImageSubmit(d); }}
          onOpenChange={setIsCameraOpen}
        />
      )}

      {helpModalResult && (
        <AIHelpModal
          fields={buildHelpFields(helpModalResult.validatedData, helpModalResult.errors)}
          previewImageUri={lastImageUri || undefined}
          onSubmit={handleHelpSubmit}
          onSkip={handleHelpSkip}
        />
      )}

      {showNewInvoiceChooser && (
        <NewInvoiceChooser
          onClose={() => setShowNewInvoiceChooser(false)}
          onSelectManual={() => { setShowNewInvoiceChooser(false); setShowManualModal(true); }}
          onSelectVoice={() => { setShowNewInvoiceChooser(false); setShowVoiceModal(true); }}
        />
      )}

      {showManualModal && (
        <ManualInvoiceModal
          onClose={() => setShowManualModal(false)}
          onSubmit={handleManualInvoiceSubmit}
          currency={settings.currency}
        />
      )}

      {showVoiceModal && (
        <VoiceInvoiceModal
          onClose={() => setShowVoiceModal(false)}
          onSubmit={handleVoiceInvoiceSubmit}
          currency={settings.currency}
        />
      )}

      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onExportAll={() => exportAllHistory(history, settings.salesmanName)}
          onImportAll={handleImportAll}
          historyCount={history.length}
        />
      )}

      {/* Weekly Summary */}
      {showWeeklySummary && (
        <WeeklySummary
          history={history}
          currency={settings.currency}
          onClose={() => setShowWeeklySummary(false)}
          onSelectInvoice={(result) => {
            setActiveResult(result);
            setView('results');
            setShowWeeklySummary(false);
          }}
        />
      )}

      {/* Debt Ledger */}
      {showDebtLedger && (
        <DebtLedger
          history={history}
          currency={settings.currency}
          onClose={() => setShowDebtLedger(false)}
          onSelectInvoice={(result) => {
            setActiveResult(result);
            setView('results');
            setShowDebtLedger(false);
          }}
        />
      )}

      {/* Onboarding — first launch only */}
      {showOnboarding && (
        <OnboardingModal
          onDone={() => {
            localStorage.setItem('invoiceguard_onboarded', '1');
            setShowOnboarding(false);
          }}
        />
      )}
    </>
  );
}
