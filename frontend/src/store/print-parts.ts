import { create } from 'zustand';

export interface PrintPartLabel {
  id: number;
  kind: 'kot' | 'bill' | 'other';
  station?: string;
}

/** Parts a no-cutter printer in "print in parts" mode is holding for the operator. */
export interface PrintPartsState {
  printed: number;
  total: number;
  pending: PrintPartLabel[];
}

interface PrintPartsStore {
  parts: PrintPartsState | null;
  setParts: (parts: PrintPartsState | null | undefined) => void;
}

export const usePrintPartsStore = create<PrintPartsStore>((set) => ({
  parts: null,
  setParts: (parts) => set({ parts: parts && parts.pending.length > 0 ? parts : null }),
}));
