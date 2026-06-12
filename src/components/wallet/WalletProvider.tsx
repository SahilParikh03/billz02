"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * wagmi + react-query providers for the self-custody wallet rail (Rail A).
 *
 * Connectors: `injected` (MetaMask/Rabby/Brave + most browser wallets) and
 * `walletConnect` (covers mobile + many others) when a project id is configured.
 * We intentionally do NOT register the Coinbase Wallet connector — it lazy-loads
 * an `@coinbase/*` SDK at runtime, and Phase E's goal is zero Coinbase code on
 * the runtime path. The chain order follows `NEXT_PUBLIC_BEAMR_NETWORK` (the
 * public mirror of BEAMR_NETWORK) so the default chain matches what the server
 * settles on; both chains are registered so a user on either can still sign.
 */

function buildConfig() {
  const walletConnectId = process.env.NEXT_PUBLIC_WALLETCONNECT_ID;
  const connectors = [
    injected(),
    ...(walletConnectId ? [walletConnect({ projectId: walletConnectId })] : []),
  ];

  const mainnet = process.env.NEXT_PUBLIC_BEAMR_NETWORK === "base";
  const chains = mainnet ? ([base, baseSepolia] as const) : ([baseSepolia, base] as const);

  return createConfig({
    chains,
    connectors,
    transports: {
      [base.id]: http(),
      [baseSepolia.id]: http(),
    },
    ssr: true,
  });
}

export function WalletProvider({ children }: { children: ReactNode }) {
  // Build once per mount — wagmi config + QueryClient must be stable identities.
  const [config] = useState(buildConfig);
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
