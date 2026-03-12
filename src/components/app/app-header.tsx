'use client';

import { ShieldCheck, WifiOff } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Badge } from '@/components/ui/badge';

interface AppHeaderProps {
  isOnline?: boolean;
  offlineQueueCount?: number;
  onHistoryToggle?: () => void;
  historyCount?: number;
}

export const AppHeader = ({ isOnline = true, offlineQueueCount = 0 }: AppHeaderProps) => (
  <header className="sticky top-0 z-30 border-b bg-card/95 backdrop-blur no-print pt-safe" role="banner">
    <div className="container mx-auto px-3 max-w-2xl lg:max-w-6xl flex items-center justify-between gap-2" style={{ minHeight: 56 }}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-7 w-7 text-primary flex-shrink-0" aria-hidden="true" />
        <h1 className="text-lg font-bold text-foreground leading-tight">InvoiceGuard <span className="text-primary">AI</span></h1>
      </div>

      <div className="flex items-center gap-2">
        {!isOnline ? (
          <Badge variant="destructive" className="flex items-center gap-1 text-xs px-2 py-1">
            <WifiOff className="h-3 w-3" />
            Offline {offlineQueueCount > 0 ? `· ${offlineQueueCount}` : ''}
          </Badge>
        ) : offlineQueueCount > 0 ? (
          <Badge variant="outline" className="text-xs text-blue-600 border-blue-300 px-2 py-1">
            Syncing {offlineQueueCount}...
          </Badge>
        ) : null}
        <ThemeToggle />
      </div>
    </div>
  </header>
);
