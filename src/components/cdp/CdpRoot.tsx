"use client";

import { CDPHooksProvider } from "@coinbase/cdp-hooks";
import { CdpAccountSync } from "./CdpAccountSync";

/**
 * The real CDP tree (loaded client-only by CdpProvider). Wraps the app in the
 * CDP hooks provider and the bridge that maps CDP state onto our AccountContext.
 */
export function CdpRoot({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  return (
    <CDPHooksProvider config={{ projectId }}>
      <CdpAccountSync>{children}</CdpAccountSync>
    </CDPHooksProvider>
  );
}
