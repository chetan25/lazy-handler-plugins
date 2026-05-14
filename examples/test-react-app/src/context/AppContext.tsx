import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark";

type AppContextValue = {
  theme: Theme;
  appName: string;
  visits: number;
  setTheme: (t: Theme) => void;
  recordVisit: (label: string) => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [visits, setVisits] = useState(0);
  const [trail, setTrail] = useState<string[]>([]);

  const value = useMemo<AppContextValue>(
    () => ({
      theme,
      appName: "Nugget Test",
      visits,
      setTheme,
      recordVisit: (label) => {
        setVisits((v) => v + 1);
        setTrail((t) => [...t, label]);
      },
    }),
    [theme, visits]
  );

  return (
    <AppContext.Provider value={value}>
      <div data-theme={theme} data-trail={trail.join(",")}>
        {children}
      </div>
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useAppContext must be used inside <AppProvider>");
  }
  return ctx;
}
