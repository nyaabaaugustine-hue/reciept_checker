'use client';
import { useLocalStorage } from './use-local-storage';

export interface BlacklistEntry {
  vendorKey: string;
  name: string;
  reason: string;
  addedAt: string;
}

export type Blacklist = Record<string, BlacklistEntry>;

export function useBlacklist() {
  const [blacklist, setBlacklist] = useLocalStorage<Blacklist>('invoiceguard_blacklist', {});

  const add = (vendorKey: string, name: string, reason: string) => {
    setBlacklist(prev => ({
      ...prev,
      [vendorKey]: { vendorKey, name, reason, addedAt: new Date().toISOString() },
    }));
  };

  const remove = (vendorKey: string) => {
    setBlacklist(prev => {
      const next = { ...prev };
      delete next[vendorKey];
      return next;
    });
  };

  const isBlocked = (vendorKey: string): boolean => !!blacklist[vendorKey];
  const get = (vendorKey: string): BlacklistEntry | undefined => blacklist[vendorKey];

  return { blacklist, add, remove, isBlocked, get };
}
