'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Mic, MicOff, Sparkles, CheckCircle, RotateCcw, Loader2, Volume2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { InvoiceProcessingResult, ValidatedData } from '@/lib/types';

interface VoiceInvoiceModalProps {
  onClose: () => void;
  onSubmit: (result: InvoiceProcessingResult) => void;
  currency: string;
}

interface ParsedItem {
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

interface ParsedInvoice {
  customer_name?: string;
  invoice_number?: string;
  items: ParsedItem[];
  subtotal: number;
  tax: number;
  total: number;
  notes?: string;
}

function generateId() {
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

type Stage = 'idle' | 'listening' | 'processing' | 'review' | 'done';

const PULSE_COLORS = [
  'rgba(99,102,241,0.4)',
  'rgba(139,92,246,0.3)',
  'rgba(167,139,250,0.2)',
];

// Parse AI response text into structured invoice
function parseAIResponse(text: string): ParsedInvoice {
  try {
    // Try to find JSON block in response
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const raw = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(raw.trim());
      return normalizeInvoice(parsed);
    }
  } catch {}
  // Fallback: return empty structure
  return { items: [], subtotal: 0, tax: 0, total: 0 };
}

function normalizeInvoice(raw: any): ParsedInvoice {
  const items: ParsedItem[] = (raw.items || []).map((item: any) => {
    const qty = parseFloat(item.quantity ?? item.qty ?? 1);
    const price = parseFloat(item.unit_price ?? item.price ?? item.unitPrice ?? 0);
    const line = parseFloat(item.line_total ?? item.lineTotal ?? item.total ?? qty * price);
    return { name: String(item.name || item.description || 'Item'), quantity: qty, unit_price: price, line_total: line };
  });
  const subtotal = parseFloat(raw.subtotal ?? items.reduce((s, i) => s + i.line_total, 0));
  const tax = parseFloat(raw.tax ?? raw.tax_amount ?? 0);
  const total = parseFloat(raw.total ?? raw.grand_total ?? subtotal + tax);
  return {
    customer_name: raw.customer_name || raw.customer || undefined,
    invoice_number: raw.invoice_number || raw.invoice_no || undefined,
    items,
    subtotal,
    tax,
    total,
    notes: raw.notes || undefined,
  };
}

export function VoiceInvoiceModal({ onClose, onSubmit, currency }: VoiceInvoiceModalProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [transcript, setTranscript] = useState('');
  const [interimText, setInterimText] = useState('');
  const [parsedInvoice, setParsedInvoice] = useState<ParsedInvoice | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [audioLevel, setAudioLevel] = useState(0);

  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Animate audio levels
  const startAudioAnalysis = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length;
        setAudioLevel(avg / 128); // 0..~1.5
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {}
  }, []);

  const stopAudioAnalysis = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    audioContextRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach(t => t.stop());
    setAudioLevel(0);
  }, []);

  const startListening = useCallback(async () => {
    setErrorMsg('');
    setTranscript('');
    setInterimText('');
    setStage('listening');
    await startAudioAnalysis();

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setErrorMsg('Speech recognition is not supported in this browser. Try Chrome or Edge.');
      setStage('idle');
      stopAudioAnalysis();
      return;
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    recognition.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalTranscript += t + ' ';
          setTranscript(finalTranscript);
        } else {
          interim = t;
        }
      }
      setInterimText(interim);
    };

    recognition.onerror = (e: any) => {
      if (e.error !== 'aborted') {
        setErrorMsg(`Mic error: ${e.error}. Please try again.`);
        setStage('idle');
        stopAudioAnalysis();
      }
    };

    recognition.onend = () => {
      stopAudioAnalysis();
      const text = finalTranscript.trim();
      if (text.length > 5) {
        setTranscript(text);
        processTranscript(text);
      } else {
        setStage('idle');
      }
    };

    recognition.start();
  }, [startAudioAnalysis, stopAudioAnalysis]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    stopAudioAnalysis();
  }, [stopAudioAnalysis]);

  const processTranscript = async (text: string) => {
    setStage('processing');
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{
            role: 'user',
            content: `You are an invoice parser. The user has verbally described items for an invoice. Extract the line items, customer name (if mentioned), and compute totals. Apply 15% tax unless the user specifies otherwise.

Respond ONLY with a valid JSON object (no markdown fences, no preamble) with this exact structure:
{
  "customer_name": "string or null",
  "invoice_number": "string or null",
  "items": [
    {"name": "string", "quantity": number, "unit_price": number, "line_total": number}
  ],
  "subtotal": number,
  "tax": number,
  "total": number,
  "notes": "string or null"
}

User said: "${text}"`,
          }],
        }),
      });
      const data = await response.json();
      const aiText = data.content?.find((c: any) => c.type === 'text')?.text || '';
      // Try parsing directly as JSON first (no fences)
      let parsed: ParsedInvoice;
      try {
        parsed = normalizeInvoice(JSON.parse(aiText.trim()));
      } catch {
        parsed = parseAIResponse(aiText);
      }
      setParsedInvoice(parsed);
      setStage('review');
    } catch (err: any) {
      setErrorMsg('Could not process speech. Please try again.');
      setStage('idle');
    }
  };

  const handleConfirm = () => {
    if (!parsedInvoice) return;
    const validatedData: ValidatedData = {
      invoice_number: parsedInvoice.invoice_number,
      date: new Date().toISOString().split('T')[0],
      customer_name: parsedInvoice.customer_name,
      category: 'Other',
      items: parsedInvoice.items,
      subtotal: parsedInvoice.subtotal,
      tax: parsedInvoice.tax,
      total: parsedInvoice.total,
    };
    const result: InvoiceProcessingResult = {
      id: generateId(),
      isValid: true,
      errors: [],
      validatedData,
      ocrText: `[Voice] ${transcript}`,
      status: 'verified',
      createdAt: new Date().toISOString(),
      notes: parsedInvoice.notes || undefined,
      healthScore: 85,
      riskVerdict: { verdict: 'ACCEPT', reason: 'Voice entry — assumed valid', details: [], moneyAtRisk: 0 },
      salesmanSummary: `Voice invoice${parsedInvoice.customer_name ? ` for ${parsedInvoice.customer_name}` : ''} — ${currency} ${fmt(parsedInvoice.total)}`,
    };
    onSubmit(result);
  };

  const handleRedo = () => {
    setParsedInvoice(null);
    setTranscript('');
    setInterimText('');
    setStage('idle');
    setErrorMsg('');
  };

  useEffect(() => () => {
    recognitionRef.current?.abort();
    stopAudioAnalysis();
  }, [stopAudioAnalysis]);

  const pulseScale = 1 + audioLevel * 0.5;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/10 flex items-center justify-center">
            <Sparkles className="h-5 w-5 text-violet-500" />
          </div>
          <div>
            <h2 className="font-bold text-base leading-tight">Voice Invoice</h2>
            <p className="text-xs text-muted-foreground">Speak your items aloud</p>
          </div>
        </div>
        <button onClick={onClose} className="tap-target rounded-full p-2 hover:bg-muted">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col items-center px-4 py-6 gap-6">

        {/* Instructions */}
        {stage === 'idle' && (
          <div className="w-full max-w-sm space-y-4 text-center animate-fade-in-up">
            <div className="rounded-2xl bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 p-4 text-sm text-violet-800 dark:text-violet-300 space-y-2">
              <p className="font-bold text-base">🎙️ How it works</p>
              <p>Tap the mic and clearly say your items. For example:</p>
              <p className="italic font-medium mt-1 bg-white/60 dark:bg-black/20 rounded-xl px-3 py-2 text-xs leading-relaxed">
                "Customer is Asante Trading. 3 bags of rice at 50 cedis each, 5 bottles of cooking oil at 30 cedis, and 2 cartons of milk at 45 cedis each."
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Volume2 className="h-4 w-4" />
              <span>Speak clearly — AI will parse your items automatically</span>
            </div>
          </div>
        )}

        {/* Mic button + visualizer */}
        {(stage === 'idle' || stage === 'listening') && (
          <div className="flex flex-col items-center gap-6">
            {/* Animated mic */}
            <div className="relative flex items-center justify-center" style={{ width: 160, height: 160 }}>
              {stage === 'listening' && PULSE_COLORS.map((color, i) => (
                <div
                  key={i}
                  className="absolute rounded-full border-2"
                  style={{
                    width: 80 + i * 30,
                    height: 80 + i * 30,
                    borderColor: color,
                    transform: `scale(${1 + audioLevel * (0.3 + i * 0.15)})`,
                    transition: 'transform 0.08s ease-out',
                    opacity: 0.8 - i * 0.2,
                  }}
                />
              ))}
              <button
                onClick={stage === 'idle' ? startListening : stopListening}
                className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center shadow-lg transition-all duration-200 active:scale-95
                  ${stage === 'listening'
                    ? 'bg-red-500 hover:bg-red-600 shadow-red-300 dark:shadow-red-900'
                    : 'bg-violet-500 hover:bg-violet-600 shadow-violet-300 dark:shadow-violet-900'
                  }`}
                style={{ transform: stage === 'listening' ? `scale(${pulseScale})` : 'scale(1)', transition: 'transform 0.08s ease-out, background-color 0.2s' }}
              >
                {stage === 'listening'
                  ? <MicOff className="h-8 w-8 text-white" />
                  : <Mic className="h-8 w-8 text-white" />
                }
              </button>
            </div>

            <p className="text-sm font-semibold text-center">
              {stage === 'idle' ? 'Tap to start recording' : '🔴 Recording — tap to stop'}
            </p>
          </div>
        )}

        {/* Live transcript */}
        {stage === 'listening' && (transcript || interimText) && (
          <Card className="w-full max-w-sm rounded-2xl p-4 border-2 border-violet-200 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-950/20 space-y-2">
            <p className="text-xs font-bold text-violet-600 uppercase tracking-wider">Hearing you…</p>
            <p className="text-sm leading-relaxed">
              <span className="text-foreground">{transcript}</span>
              <span className="text-muted-foreground italic">{interimText}</span>
            </p>
          </Card>
        )}

        {/* Processing */}
        {stage === 'processing' && (
          <div className="flex flex-col items-center gap-4 animate-fade-in-up">
            <div className="w-16 h-16 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
              <Loader2 className="h-8 w-8 text-violet-500 animate-spin" />
            </div>
            <p className="text-sm font-semibold text-center">AI is parsing your invoice…</p>
            {transcript && (
              <Card className="w-full max-w-sm rounded-2xl p-4 border bg-muted/30">
                <p className="text-xs text-muted-foreground italic leading-relaxed">"{transcript}"</p>
              </Card>
            )}
          </div>
        )}

        {/* Review */}
        {stage === 'review' && parsedInvoice && (
          <div className="w-full max-w-sm space-y-4 animate-fade-in-up">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <p className="font-bold text-base">Invoice parsed! Review below:</p>
            </div>

            {parsedInvoice.customer_name && (
              <div className="rounded-xl bg-muted/40 px-4 py-3 flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Customer</span>
                <span className="text-sm font-bold">{parsedInvoice.customer_name}</span>
              </div>
            )}

            <Card className="rounded-2xl border-2 overflow-hidden">
              <div className="bg-muted/30 px-4 py-2">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Items</p>
              </div>
              <div className="divide-y">
                {parsedInvoice.items.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-muted-foreground italic">No items detected — please re-record</p>
                ) : parsedInvoice.items.map((item, i) => (
                  <div key={i} className="px-4 py-3 flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{item.quantity} × {currency} {fmt(item.unit_price)}</p>
                    </div>
                    <span className="text-sm font-bold text-primary flex-shrink-0">{currency} {fmt(item.line_total)}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="rounded-2xl p-4 space-y-2 border-2 border-primary/30 bg-primary/5">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{currency} {fmt(parsedInvoice.subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Tax</span>
                <span>{currency} {fmt(parsedInvoice.tax)}</span>
              </div>
              <div className="border-t pt-2 flex justify-between font-bold text-base">
                <span>Total</span>
                <span className="text-primary text-xl font-black">{currency} {fmt(parsedInvoice.total)}</span>
              </div>
            </Card>

            {parsedInvoice.notes && (
              <div className="rounded-xl bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                📝 {parsedInvoice.notes}
              </div>
            )}

            {/* What was heard */}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground transition-colors">What was heard ▾</summary>
              <p className="mt-2 italic leading-relaxed px-2">"{transcript}"</p>
            </details>
          </div>
        )}

        {/* Error */}
        {errorMsg && (
          <div className="w-full max-w-sm rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-300 p-4 text-sm text-red-700 dark:text-red-400 text-center">
            {errorMsg}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="border-t px-4 py-3 flex gap-3 flex-shrink-0">
        {stage === 'review' ? (
          <>
            <button onClick={handleRedo} className="action-btn-secondary flex-1 gap-2">
              <RotateCcw className="h-4 w-4" /> Re-record
            </button>
            <button onClick={handleConfirm} className="action-btn-primary flex-1 gap-2" disabled={!parsedInvoice?.items.length}>
              <CheckCircle className="h-4 w-4" /> Save Invoice
            </button>
          </>
        ) : (
          <button onClick={onClose} className="action-btn-secondary flex-1">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
