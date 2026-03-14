'use client';

import { LoaderCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface ProcessingViewProps {
  statusMessage: string | null;
  qualityScore?: number | null; // 0-100 from checkImageQuality
}

function QualityBar({ score }: { score: number }) {
  const colour =
    score >= 75 ? 'bg-green-500' :
    score >= 45 ? 'bg-amber-400' :
    'bg-red-500';
  const label =
    score >= 75 ? 'Good' :
    score >= 45 ? 'Fair — hold camera steady' :
    'Poor — retake in better light';
  const textColour =
    score >= 75 ? 'text-green-700 dark:text-green-400' :
    score >= 45 ? 'text-amber-700 dark:text-amber-400' :
    'text-red-700 dark:text-red-400';

  return (
    <div className="space-y-1.5 pt-3 border-t border-border">
      <div className="flex items-center justify-between text-xs font-semibold">
        <span className="text-muted-foreground">Image Quality</span>
        <span className={textColour}>{score}/100 — {label}</span>
      </div>
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${colour}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

export const ProcessingView = ({ statusMessage, qualityScore }: ProcessingViewProps) => (
    <div className="w-full max-w-lg animate-fade-in-up">
        <Card className="text-center">
            <CardHeader>
                <CardTitle className="text-2xl font-bold flex items-center justify-center gap-3">
                    <LoaderCircle className="animate-spin h-8 w-8" />
                    Processing Invoice
                </CardTitle>
                <CardDescription>
                    Please wait while we analyse your document.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
                <div className="bg-muted text-muted-foreground rounded-md p-4">
                    <p>{statusMessage || 'Initializing...'}</p>
                </div>
                {qualityScore != null && <QualityBar score={qualityScore} />}
            </CardContent>
        </Card>
    </div>
);
