"use client";
import { useLocalStorage } from './use-local-storage';
import type { AppSettings } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/types';

export function useSettings(): [AppSettings, (s: AppSettings | ((prev: AppSettings) => AppSettings)) => void] {
  return useLocalStorage<AppSettings>('invoiceguard_settings', DEFAULT_SETTINGS);
}

// Simple PIN hash using Web Crypto (SHA-256)
export async function hashPin(pin: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(pin + 'invoiceguard_salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
