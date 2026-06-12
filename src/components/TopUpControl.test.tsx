// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AccountContext, ANON_ACCOUNT, type Account, type TopUpResult } from "./account";
import { TopUpControl } from "./TopUpControl";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => cleanup());

const WALLET = "0x" + "ab".repeat(20);

/** Render with a wallet identity that routes presets to `topUp`. */
function renderWallet(topUp: (amount: number) => Promise<TopUpResult>) {
  const account: Account = {
    ...ANON_ACCOUNT,
    status: "signed-in",
    identity: { kind: "wallet", id: WALLET },
    walletAddress: WALLET,
    topUp,
  };
  return render(
    <AccountContext.Provider value={account}>
      <TopUpControl />
    </AccountContext.Provider>,
  );
}

/** Render with an email identity that routes presets to `payByCard`. */
function renderEmail(payByCard: (amount: number) => Promise<{ ok: boolean; error?: string }>) {
  const account: Account = {
    ...ANON_ACCOUNT,
    status: "signed-in",
    identity: { kind: "email", id: "email:alice@example.com" },
    email: "alice@example.com",
    payByCard,
  };
  return render(
    <AccountContext.Provider value={account}>
      <TopUpControl />
    </AccountContext.Provider>,
  );
}

describe("TopUpControl", () => {
  it("renders the preset amounts", () => {
    renderWallet(async () => ({ ok: true }));
    expect(screen.getByText("$1")).toBeDefined();
    expect(screen.getByText("$5")).toBeDefined();
    expect(screen.getByText("$20")).toBeDefined();
  });

  it("routes a wallet identity to topUp and shows the credited result", async () => {
    const topUp = vi.fn(async () => ({ ok: true, credited: 5, txHash: "0xdeadbeefcafe" }));
    renderWallet(topUp);

    fireEvent.click(screen.getByText("$5"));

    expect(topUp).toHaveBeenCalledWith(5);
    expect(await screen.findByText(/Added \$5\.00/)).toBeDefined();
    expect(screen.getByText(/0xdeadbee/)).toBeDefined();
  });

  it("shows the error reason when a wallet top-up fails", async () => {
    const topUp = vi.fn(async () => ({ ok: false, error: "insufficient credit — top up" }));
    renderWallet(topUp);

    fireEvent.click(screen.getByText("$1"));

    expect(topUp).toHaveBeenCalledWith(1);
    expect(await screen.findByText(/insufficient credit/)).toBeDefined();
  });

  it("routes an email identity to payByCard", async () => {
    const payByCard = vi.fn(async () => ({ ok: true }));
    renderEmail(payByCard);

    fireEvent.click(screen.getByText("$20"));

    expect(payByCard).toHaveBeenCalledWith(20);
    expect(screen.getByText(/pay by card/)).toBeDefined();
  });

  it("shows the error reason when checkout can't start", async () => {
    const payByCard = vi.fn(async () => ({ ok: false, error: "could not start checkout (502)" }));
    renderEmail(payByCard);

    fireEvent.click(screen.getByText("$5"));

    expect(await screen.findByText(/could not start checkout/)).toBeDefined();
  });
});
