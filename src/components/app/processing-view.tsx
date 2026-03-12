'use client';

import { LoaderCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface ProcessingViewProps {
  statusMessage: string | null;
}

export const ProcessingView = ({ statusMessage }: ProcessingViewProps) => (
    <div className="w-full max-w-lg animate-fade-in-up">
        <Card className="text-center">
            <CardHeader>
                <CardTitle className="text-2xl font-bold flex items-center justify-center gap-3">
                    <LoaderCircle className="animate-spin h-8 w-8" />
                    Processing Invoice
                </CardTitle>
                <CardDescription>
                    Please wait while we analyze your document.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <div className="bg-muted text-muted-foreground rounded-md p-4">
                    <p>{statusMessage || 'Initializing...'}</p>
                </div>
            </CardContent>
        </Card>
    </div>
);
