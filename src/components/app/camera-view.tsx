'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { Camera, LoaderCircle, X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { createPortal } from 'react-dom';

interface CameraViewProps {
  onCapture: (dataUri: string) => void;
  onOpenChange: (isOpen: boolean) => void;
}

export const CameraView = ({ onCapture, onOpenChange }: CameraViewProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [hasCameraPermission, setHasCameraPermission] = useState<boolean | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [flash, setFlash] = useState(false);
  const { toast } = useToast();

  const startCamera = useCallback(async (facing: 'environment' | 'user') => {
    // Stop any existing stream first
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera not supported by this browser.');
      }

      // Request the highest resolution available for better OCR
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: facing,
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      setHasCameraPermission(true);
      setErrorMsg('');

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {/* autoplay policy — handled by playsInline */});
      }
    } catch (error: any) {
      console.error('Camera error:', error);
      setHasCameraPermission(false);

      let msg = 'Please allow camera access in your browser settings.';
      if (error.name === 'NotAllowedError') msg = 'Camera permission denied. Tap the camera icon in your address bar to allow access.';
      else if (error.name === 'NotFoundError') msg = 'No camera found on this device.';
      else if (error.name === 'NotReadableError') msg = 'Camera is in use by another app. Close it and try again.';
      else if (error.message) msg = error.message;

      setErrorMsg(msg);
      toast({ variant: 'destructive', title: 'Camera Error', description: msg });
    }
  }, [toast]);

  useEffect(() => {
    startCamera(facingMode);
    // Lock body scroll while camera is open
    document.body.style.overflow = 'hidden';
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      document.body.style.overflow = '';
    };
  }, []);// eslint-disable-line react-hooks/exhaustive-deps

  const flipCamera = async () => {
    const next = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(next);
    setHasCameraPermission(null);
    await startCamera(next);
  };

  const handleCapture = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !hasCameraPermission) return;

    // Use the native video resolution — never downscale
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);

    // JPEG quality 0.92 — good balance of size vs clarity for OCR
    const dataUri = canvas.toDataURL('image/jpeg', 0.92);

    // Flash effect feedback
    setFlash(true);
    setTimeout(() => setFlash(false), 200);

    // Stop camera then hand off
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    onCapture(dataUri);
  };

  const handleClose = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    onOpenChange(false);
  };

  // Render into a portal so it truly covers the whole viewport
  const content = (
    <div
      className="camera-fullscreen"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* ── TOP BAR ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        paddingTop: 'max(12px, env(safe-area-inset-top))',
        background: 'rgba(0,0,0,0.6)',
        color: '#fff',
        flexShrink: 0,
        zIndex: 2,
      }}>
        <span style={{ fontWeight: 700, fontSize: 16 }}>Scan Invoice</span>
        <button
          onClick={handleClose}
          style={{
            background: 'rgba(255,255,255,0.15)',
            border: 'none',
            borderRadius: '50%',
            width: 40,
            height: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: '#fff',
          }}
          aria-label="Close camera"
        >
          <X size={22} />
        </button>
      </div>

      {/* ── VIDEO ── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />

        {/* Capture guide overlay */}
        {hasCameraPermission && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            {/* Corner markers — show the target capture area */}
            <div style={{
              width: '88%',
              height: '72%',
              position: 'relative',
            }}>
              {/* Top-left */}
              <div style={{ position: 'absolute', top: 0, left: 0, width: 32, height: 32, borderTop: '3px solid #2dd4bf', borderLeft: '3px solid #2dd4bf', borderRadius: '4px 0 0 0' }} />
              {/* Top-right */}
              <div style={{ position: 'absolute', top: 0, right: 0, width: 32, height: 32, borderTop: '3px solid #2dd4bf', borderRight: '3px solid #2dd4bf', borderRadius: '0 4px 0 0' }} />
              {/* Bottom-left */}
              <div style={{ position: 'absolute', bottom: 0, left: 0, width: 32, height: 32, borderBottom: '3px solid #2dd4bf', borderLeft: '3px solid #2dd4bf', borderRadius: '0 0 0 4px' }} />
              {/* Bottom-right */}
              <div style={{ position: 'absolute', bottom: 0, right: 0, width: 32, height: 32, borderBottom: '3px solid #2dd4bf', borderRight: '3px solid #2dd4bf', borderRadius: '0 0 4px 0' }} />
            </div>
          </div>
        )}

        {/* Flash effect */}
        {flash && (
          <div style={{
            position: 'absolute',
            inset: 0,
            background: '#fff',
            opacity: 0.6,
            pointerEvents: 'none',
            transition: 'opacity 0.15s',
          }} />
        )}

        {/* Loading state */}
        {hasCameraPermission === null && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#000',
            color: '#fff',
            gap: 12,
          }}>
            <LoaderCircle size={48} style={{ animation: 'spin 1s linear infinite' }} />
            <p style={{ fontSize: 14, opacity: 0.7 }}>Starting camera…</p>
          </div>
        )}

        {/* Error state */}
        {hasCameraPermission === false && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#1a0a0a',
            color: '#fff',
            gap: 16,
            padding: 32,
            textAlign: 'center',
          }}>
            <div style={{
              background: 'rgba(220,38,38,0.2)',
              border: '1px solid rgba(220,38,38,0.5)',
              borderRadius: 16,
              padding: '24px 20px',
              maxWidth: 320,
            }}>
              <p style={{ fontWeight: 700, fontSize: 16, marginBottom: 8, color: '#fca5a5' }}>Camera Access Required</p>
              <p style={{ fontSize: 14, opacity: 0.85, lineHeight: 1.5 }}>{errorMsg}</p>
            </div>
            <button
              onClick={() => startCamera(facingMode)}
              style={{
                background: '#2dd4bf',
                color: '#000',
                border: 'none',
                borderRadius: 12,
                padding: '12px 28px',
                fontWeight: 700,
                fontSize: 15,
                cursor: 'pointer',
              }}
            >
              Try Again
            </button>
          </div>
        )}
      </div>

      {/* ── HINT TEXT ── */}
      {hasCameraPermission && (
        <div style={{
          textAlign: 'center',
          color: 'rgba(255,255,255,0.65)',
          fontSize: 13,
          padding: '8px 16px 4px',
          background: 'rgba(0,0,0,0.6)',
          flexShrink: 0,
        }}>
          Align the invoice within the guide — hold steady
        </div>
      )}

      {/* ── BOTTOM CONTROLS ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        padding: '20px 32px',
        paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
        background: 'rgba(0,0,0,0.75)',
        flexShrink: 0,
      }}>
        {/* Flip camera */}
        <button
          onClick={flipCamera}
          disabled={!hasCameraPermission}
          style={{
            background: 'rgba(255,255,255,0.12)',
            border: 'none',
            borderRadius: '50%',
            width: 52,
            height: 52,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: '#fff',
            opacity: hasCameraPermission ? 1 : 0.3,
          }}
          aria-label="Flip camera"
        >
          <RotateCcw size={22} />
        </button>

        {/* Shutter button */}
        <button
          onClick={handleCapture}
          disabled={!hasCameraPermission}
          style={{
            background: hasCameraPermission ? '#2dd4bf' : '#555',
            border: '4px solid rgba(255,255,255,0.3)',
            borderRadius: '50%',
            width: 76,
            height: 76,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: hasCameraPermission ? 'pointer' : 'not-allowed',
            color: '#000',
            boxShadow: hasCameraPermission ? '0 0 0 6px rgba(45,212,191,0.25)' : 'none',
            transition: 'all 0.15s',
          }}
          aria-label="Capture photo"
        >
          <Camera size={32} />
        </button>

        {/* Spacer to balance layout */}
        <div style={{ width: 52 }} />
      </div>

      <canvas ref={canvasRef} style={{ display: 'none' }} />

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );

  // Portal to document.body so no parent clips or constrains it
  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
};
