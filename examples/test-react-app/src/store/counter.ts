import { create } from "zustand";

// Plain Zustand store. Lives in its own module so the import paths in
// Home.tsx are relative — that is what exercises the loader's
// "resolve relative imports to absolute paths" code path when the
// nugget chunk re-imports useCounter.
type CounterState = {
  count: number;
  history: number[];
  lastChangedAt: string | null;
  increment: (by?: number) => void;
  decrement: (by?: number) => void;
  reset: () => void;
  recordSnapshot: () => void;
};

export const useCounter = create<CounterState>((set, get) => ({
  count: 0,
  history: [],
  lastChangedAt: null,
  increment: (by = 1) =>
    set({
      count: get().count + by,
      lastChangedAt: new Date().toLocaleTimeString(),
    }),
  decrement: (by = 1) =>
    set({
      count: get().count - by,
      lastChangedAt: new Date().toLocaleTimeString(),
    }),
  reset: () => set({ count: 0, history: [], lastChangedAt: null }),
  recordSnapshot: () =>
    set((state) => ({ history: [...state.history, state.count] })),
}));
