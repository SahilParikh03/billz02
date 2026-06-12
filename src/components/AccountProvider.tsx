"use client";

import { WalletProvider } from "./wallet/WalletProvider";
import { WalletAccountSync } from "./wallet/WalletAccountSync";

/**
 * Root account provider (Phase E) — replaces the CDP provider tree.
 *
 * Composes the wagmi wallet rail (WalletProvider) with the bridge that maps both
 * the connected wallet and the email identity onto AccountContext. No env gate:
 * the wallet + card affordances always render, so there's no "Guest" dead end.
 */
export function AccountProvider({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <WalletAccountSync>{children}</WalletAccountSync>
    </WalletProvider>
  );
}
