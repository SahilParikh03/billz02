"use client";

import dynamic from "next/dynamic";
import { AccountContext, ANON_ACCOUNT } from "./account";

/**
 * Root account provider.
 *
 * - No `NEXT_PUBLIC_CDP_PROJECT_ID` → render children under the anonymous
 *   account context. The whole app works (per-session budget), the Sign-in UI
 *   shows a "not configured" hint. This is the zero-setup default.
 * - Project id set → mount the real CDP tree. It's loaded with `ssr: false`
 *   because the CDP SDK is browser-only (touches window/IndexedDB); rendering it
 *   on the server would throw.
 */

// Browser-only: the CDP SDK must not run during SSR.
const CdpRoot = dynamic(() => import("./CdpRoot").then((m) => m.CdpRoot), {
  ssr: false,
});

export function CdpProvider({ children }: { children: React.ReactNode }) {
  const projectId = process.env.NEXT_PUBLIC_CDP_PROJECT_ID;

  if (!projectId) {
    return (
      <AccountContext.Provider value={ANON_ACCOUNT}>
        {children}
      </AccountContext.Provider>
    );
  }

  return <CdpRoot projectId={projectId}>{children}</CdpRoot>;
}
