'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
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
} from '@/lib/invoice-intelligence';
import { exportAllHistory, importHistory } from '@/lib/utils';
import { Camera, Upload, History, LayoutDashboard, X } from 'lucide-react';

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
  useEffect(() => setMounted(true), []);
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
  const [isUnlocked, setIsUnlocked] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wakeLockRef = useRef<any>(null);
  const { toast } = useToast();

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
    if (exceeded) {
      toast({
        variant: 'destructive',
        title: '🚨 Risk Threshold Exceeded',
        description: `${settings.currency} ${atRisk.toFixed(2)} at risk — above your ${settings.currency} ${threshold.toFixed(2)} alert threshold.`,
        duration: 12000,
      });
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
      toast({ variant: 'destructive', title: 'Poor Image Quality', description: quality.reason, duration: 10000 });
      return null;
    }

    setProcessingStatus('Optimising image…');
    const optimised = await preprocessImage(imageUri);

    setProcessingStatus('Reading invoice with AI — this may take a moment…');
    let result: InvoiceProcessingResult;
    try {
      result = await processInvoice(optimised, settings.taxRatePct, slimHistory(history));
    } catch (error: any) {
      const raw: string = error?.message ?? '';
      const friendly = raw.replace('Invoice processing failed: ', '').replace('Error: ', '')
        || 'Could not read the invoice. Try again with better lighting.';
      setView('dashboard');
      toast({ variant: 'destructive', title: 'Processing Failed', description: friendly, duration: 10000 });
      return null;
    }

    setProcessingStatus('Finalising analysis…');

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
      // Haptic pulse for urgent verdicts
      if (isUrgent && 'vibrate' in navigator) navigator.vibrate([100, 50, 100, 50, 200]);
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
      toast({ title: '📵 Offline — Queued', description: 'Will process when back online.', duration: 8000 });
      return;
    }
    try { await submitImage(imageUri); }
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
    const now = new Date().toISOString();
    setHistory(prev => prev.map(i => i.id === id ? { ...i, status: 'approved', approvedAt: now } : i));
    setActiveResult(prev => prev ? { ...prev, status: 'approved', approvedAt: now } : null);
    toast({ title: '✅ Approved', description: 'Invoice approved. Safe to collect payment.' });
  };
  const handleReject = (id: string, reason: string) => {
    const now = new Date().toISOString();
    setHistory(prev => prev.map(i => i.id === id ? { ...i, status: 'rejected', rejectedAt: now, rejectionReason: reason } : i));
    setActiveResult(prev => prev ? { ...prev, status: 'rejected', rejectedAt: now, rejectionReason: reason } : null);
    toast({ title: '❌ Rejected', description: `Reason: ${reason}` });
  };
  const handleClearHistory = () => { setHistory([]); handleReset(); };

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
            ) : null}
            <button className="action-btn-secondary flex-1 min-w-0" onClick={handleHistoryToggle}>
              <History className="h-4 w-4 flex-shrink-0" />
              <span className="truncate text-sm">
                History{mounted && history.length > 0 && (
                  <span className="ml-1 bg-primary text-primary-foreground text-xs rounded-full px-1.5 py-0.5">
                    {history.length}
                  </span>
                )}
              </span>
            </button>
            <button className="action-btn-secondary flex-1 min-w-0" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4 flex-shrink-0" />
              <span className="truncate text-sm">Upload</span>
            </button>
            <button className="action-btn-primary flex-1 min-w-0" onClick={() => setIsCameraOpen(true)}>
              <Camera className="h-4 w-4 flex-shrink-0" />
              <span className="truncate text-sm">Scan</span>
            </button>
          </div>
        )}

        {showInstallPrompt && (
          <div className="pwa-banner no-print">
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

      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onExportAll={() => exportAllHistory(history, settings.salesmanName)}
          onImportAll={handleImportAll}
          historyCount={history.length}
        />
      )}
    </>
  );
}
