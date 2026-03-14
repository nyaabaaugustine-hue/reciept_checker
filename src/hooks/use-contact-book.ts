'use client';
import { useLocalStorage } from './use-local-storage';

export interface ContactEntry {
  vendorKey: string;
  name: string;
  phone: string;
  addedAt: string;
}

export type ContactBook = Record<string, ContactEntry>;

export function useContactBook() {
  const [contacts, setContacts] = useLocalStorage<ContactBook>('invoiceguard_contacts', {});

  const upsert = (vendorKey: string, name: string, phone: string) => {
    setContacts(prev => ({
      ...prev,
      [vendorKey]: { vendorKey, name, phone: phone.trim(), addedAt: prev[vendorKey]?.addedAt ?? new Date().toISOString() },
    }));
  };

  const remove = (vendorKey: string) => {
    setContacts(prev => {
      const next = { ...prev };
      delete next[vendorKey];
      return next;
    });
  };

  const get = (vendorKey: string): ContactEntry | undefined => contacts[vendorKey];

  return { contacts, upsert, remove, get };
}
