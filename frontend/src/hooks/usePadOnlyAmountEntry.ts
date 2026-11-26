import { useState } from 'react';

function detectPadOnly(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.electronAPI?.platform === 'android') return true;
  const media = window.matchMedia?.bind(window);
  return !!media && media('(any-pointer: coarse)').matches && !media('(any-pointer: fine)').matches;
}

/**
 * True where checkout amounts should come only from the on-screen number pad: the Android app,
 * or a touch-only screen. Android's keyboard ignores `inputMode="none"` on number fields, so those
 * fields are made read-only there; a desktop with a mouse keeps typing.
 */
export function usePadOnlyAmountEntry(): boolean {
  const [padOnly] = useState(detectPadOnly);
  return padOnly;
}
