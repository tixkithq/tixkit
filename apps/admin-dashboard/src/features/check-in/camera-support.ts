'use client';

/**
 * Detects whether the current environment can access a camera. Guarded so it
 * never throws during SSR or in jsdom (where `navigator.mediaDevices` is
 * undefined).
 */
export function isCameraSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!navigator.mediaDevices) return false;
  if (typeof navigator.mediaDevices.getUserMedia !== 'function') return false;
  if (typeof window !== 'undefined' && window.isSecureContext === false) return false;
  return true;
}
