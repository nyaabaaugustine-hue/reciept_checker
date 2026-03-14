"use client";

import { useState, useEffect, useCallback } from 'react';

export function useLocalStorage<T>(key: string, initialValue: T): [T, (value: T | ((val: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === 'undefined') {
      return initialValue;
    }
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue = useCallback((value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(key, JSON.stringify(valueToStore));
        } catch (storageError: any) {
          // QuotaExceededError — storage full (common with base64 image queue)
          if (storageError?.name === 'QuotaExceededError' || storageError?.code === 22) {
            console.warn(`[useLocalStorage] Storage quota exceeded for key "${key}". Data saved in memory only.`);
          } else {
            console.error('[useLocalStorage] Write error:', storageError);
          }
        }
      }
    } catch (error) {
      console.error('[useLocalStorage] Unexpected error:', error);
    }
  }, [key, storedValue]);
  
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === key && e.newValue) {
        try {
            setStoredValue(JSON.parse(e.newValue));
        } catch(err) {
            console.error(err);
        }
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [key]);

  return [storedValue, setValue];
}
