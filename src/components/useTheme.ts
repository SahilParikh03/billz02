"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

/**
 * Reads/writes the active theme. The initial class is set pre-paint by the
 * inline script in layout.tsx (following saved choice, else OS preference);
 * this hook syncs to it on mount and persists manual toggles.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(
      document.documentElement.classList.contains("light") ? "light" : "dark",
    );
  }, []);

  const apply = useCallback((next: Theme) => {
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    root.classList.add(next);
    try {
      localStorage.setItem("beamr-theme", next);
    } catch {
      /* storage unavailable — session-only */
    }
    setTheme(next);
  }, []);

  const toggle = useCallback(
    () => apply(theme === "dark" ? "light" : "dark"),
    [theme, apply],
  );

  return { theme, toggle, setTheme: apply };
}
