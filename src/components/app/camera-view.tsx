'use client';

import { useRef, useState, useEffect } from 'react';
import { Camera, LoaderCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface CameraViewProps {
  onCapture: (dataUri: string) => void;
  onOpenChange: (isOpen: boolean) => void;
}

export const CameraView = ({ onCapture, onOpenChange }: CameraViewProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasCameraPermission, setHasCameraPermission] = useState<boolean | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    let stream: MediaStream | undefined;

    const getCameraPermission = async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Camera not supported by this browser.');
        }
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        setHasCameraPermission(true);

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (error: any) {
        console.error('Error accessing camera:', error);
        setHasCameraPermission(false);
        toast({
          variant: 'destructive',
          title: 'Camera Access Denied',
          description: error.message || 'Please enable camera permissions in your browser settings.',
        });
      }
    };

    getCameraPermission();

    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [toast]);

  const handleCapture = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      context?.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
      const dataUri = canvas.toDataURL('image/jpeg');
      onCapture(dataUri);
    }
  };

  return (
    <DialogContent className="sm:max-w-[625px]">
      <DialogHeader>
        <DialogTitle>Take Photo of Invoice</DialogTitle>
      </DialogHeader>
      <div className="relative">
        <video ref={videoRef} className="w-full aspect-video rounded-md bg-muted" autoPlay muted playsInline />
        <div className="absolute inset-2 pointer-events-none border-2 border-dashed border-white/50 rounded-md" aria-hidden="true" />
        <canvas ref={canvasRef} className="hidden" />
        
        {hasCameraPermission === false && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 rounded-md">
            <Alert variant="destructive" className="w-auto">
              <AlertTitle>Camera Access Required</AlertTitle>
              <AlertDescription>
                Please allow camera access to use this feature.
              </AlertDescription>
            </Alert>
          </div>
        )}
        {hasCameraPermission === null && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 rounded-md">
            <LoaderCircle className="h-10 w-10 text-white animate-spin" />
          </div>
        )}
      </div>
      <DialogFooter className="sm:justify-between">
        <DialogClose asChild>
          <Button type="button" variant="secondary">Cancel</Button>
        </DialogClose>
        <Button type="button" onClick={handleCapture} disabled={!hasCameraPermission}>
          <Camera className="mr-2" /> Capture
        </Button>
      </DialogFooter>
    </DialogContent>
  );
};
