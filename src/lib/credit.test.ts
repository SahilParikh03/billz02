import { describe, it, expect, beforeEach } from "vitest";
import {
  isWalletUser,
  grantWelcomeCredit,
  getCreditBalance,
  hasCredit,
  chargeCredit,
  addCredit,
  creditStatus,
} from "./credit";
import { resetStore } from "./store";

const WALLET = "0x" + "ab".repeat(20); // 0xabab… 42 chars

beforeEach(() => {
  resetStore();
});

describe("isWalletUser", () => {
  it("recognizes a 0x-prefixed 40-hex address", () => {
    expect(isWalletUser(WALLET)).toBe(true);
    expect(isWalletUser("0xABCDEF0123456789abcdef0123456789ABCDEF01")).toBe(true);
  });

  it("rejects session ids, empties, and malformed addresses", () => {
    expect(isWalletUser("sess_abc123")).toBe(false);
    expect(isWalletUser("0x123")).toBe(false); // too short
    expect(isWalletUser("0x" + "zz".repeat(20))).toBe(false); // non-hex
    expect(isWalletUser("")).toBe(false);
    expect(isWalletUser(undefined)).toBe(false);
    expect(isWalletUser(null)).toBe(false);
  });
});

describe("credit ledger", () => {
  it("new user has zero balance and no grant", async () => {
    expect(await getCreditBalance(WALLET)).toBe(0);
    expect(await hasCredit(WALLET)).toBe(false);
    const s = await creditStatus(WALLET);
    expect(s).toEqual({ userId: WALLET, balance: 0, granted: false });
  });

  it("grants the welcome credit once and is idempotent", async () => {
    const first = await grantWelcomeCredit(WALLET, 1);
    expect(first).toEqual({ userId: WALLET, balance: 1, granted: true });
    expect(await hasCredit(WALLET)).toBe(true);

    // Spend some, then re-grant: balance must NOT be topped back up.
    await chargeCredit(WALLET, 0.4);
    const second = await grantWelcomeCredit(WALLET, 1);
    expect(second.granted).toBe(true);
    expect(second.balance).toBeCloseTo(0.6, 5);
  });

  it("chargeCredit deducts and floors at zero", async () => {
    await grantWelcomeCredit(WALLET, 1);
    expect(await chargeCredit(WALLET, 0.3)).toBeCloseTo(0.7, 5);
    expect(await chargeCredit(WALLET, 0.5)).toBeCloseTo(0.2, 5);
    // Overdraw → clamped to 0, not negative.
    expect(await chargeCredit(WALLET, 5)).toBe(0);
    expect(await getCreditBalance(WALLET)).toBe(0);
    expect(await hasCredit(WALLET)).toBe(false);
  });

  it("chargeCredit is a no-op for non-positive amounts", async () => {
    await grantWelcomeCredit(WALLET, 1);
    expect(await chargeCredit(WALLET, 0)).toBe(1);
    expect(await chargeCredit(WALLET, -1)).toBe(1);
  });

  it("addCredit tops up a never-granted user (no welcome grant required)", async () => {
    expect(await getCreditBalance(WALLET)).toBe(0);
    expect(await addCredit(WALLET, 5)).toBeCloseTo(5, 5);
    expect(await hasCredit(WALLET)).toBe(true);
    // Top-up alone does not flip the welcome-grant marker.
    expect((await creditStatus(WALLET)).granted).toBe(false);
  });

  it("addCredit stacks on the existing balance and round-trips with chargeCredit", async () => {
    await grantWelcomeCredit(WALLET, 1);
    expect(await addCredit(WALLET, 2.5)).toBeCloseTo(3.5, 5);
    expect(await chargeCredit(WALLET, 0.5)).toBeCloseTo(3.0, 5);
  });

  it("addCredit is a no-op for non-positive amounts", async () => {
    await grantWelcomeCredit(WALLET, 1);
    expect(await addCredit(WALLET, 0)).toBe(1);
    expect(await addCredit(WALLET, -3)).toBe(1);
  });

  it("creditStatus reflects grant + remaining balance", async () => {
    await grantWelcomeCredit(WALLET, 2);
    await chargeCredit(WALLET, 0.75);
    const s = await creditStatus(WALLET);
    expect(s.userId).toBe(WALLET);
    expect(s.granted).toBe(true);
    expect(s.balance).toBeCloseTo(1.25, 5);
  });
});
