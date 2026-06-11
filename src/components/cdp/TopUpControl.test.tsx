// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AccountContext, ANON_ACCOUNT, type Account, type TopUpResult } from "./account";
import { TopUpControl } from "./TopUpControl";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => cleanup());

function renderWith(topUp: (amount: number) => Promise<TopUpResult>) {
  const account: Account = {
    ...ANON_ACCOUNT,
    enabled: true,
    status: "signed-in",
    address: "0x" + "ab".repeat(20),
    topUp,
  };
  return render(
    <AccountContext.Provider value={account}>
      <TopUpControl />
    </AccountContext.Provider>,
  );
}

describe("TopUpControl", () => {
  it("renders the preset amounts", () => {
    renderWith(async () => ({ ok: true }));
    expect(screen.getByText("$1")).toBeDefined();
    expect(screen.getByText("$5")).toBeDefined();
    expect(screen.getByText("$20")).toBeDefined();
  });

  it("calls topUp with the chosen amount and shows the credited result", async () => {
    const topUp = vi.fn(async () => ({ ok: true, credited: 5, txHash: "0xdeadbeefcafe" }));
    renderWith(topUp);

    fireEvent.click(screen.getByText("$5"));

    expect(topUp).toHaveBeenCalledWith(5);
    expect(await screen.findByText(/Added \$5\.00/)).toBeDefined();
    // Truncated tx hash is shown.
    expect(screen.getByText(/0xdeadbee/)).toBeDefined();
  });

  it("shows the error reason when a top-up fails", async () => {
    const topUp = vi.fn(async () => ({ ok: false, error: "insufficient credit — top up" }));
    renderWith(topUp);

    fireEvent.click(screen.getByText("$1"));

    expect(topUp).toHaveBeenCalledWith(1);
    expect(await screen.findByText(/insufficient credit/)).toBeDefined();
  });
});
