"use client";

import { useEffect, useState } from "react";

export interface ModelOption {
  id: string;
  label?: string;
  provider: string;
  tags?: string[];
  inputPricePerM?: number;
  outputPricePerM?: number;
}

export function useModels(): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((r) => r.json())
      .then((data: ModelOption[]) => {
        if (!cancelled && Array.isArray(data)) setModels(data);
      })
      .catch(() => {/* models are optional */});
    return () => {
      cancelled = true;
    };
  }, []);

  return models;
}
