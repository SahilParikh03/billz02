import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, isSharedStore, type Store } from "./store";

describe("memory store", () => {
  let s: Store;
  beforeEach(() => {
    s = createMemoryStore();
  });

  it("ping returns true (always reachable in-process)", async () => {
    expect(await s.ping()).toBe(true);
  });

  it("is not a shared store", () => {
    expect(isSharedStore(s)).toBe(false);
  });

  it("returns null for a missing key", async () => {
    expect(await s.get("nope")).toBeNull();
  });

  it("set then get", async () => {
    await s.set("k", "v");
    expect(await s.get("k")).toBe("v");
  });

  it("incrByFloat creates at 0 and accumulates", async () => {
    expect(await s.incrByFloat("c", 1.5)).toBe(1.5);
    expect(await s.incrByFloat("c", 2.25)).toBeCloseTo(3.75);
    expect(await s.get("c")).toBe("3.75");
  });

  it("del removes a key", async () => {
    await s.set("k", "v");
    await s.del("k");
    expect(await s.get("k")).toBeNull();
  });

  it("expires a key after its TTL", async () => {
    await s.set("k", "v", 10);
    expect(await s.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 25));
    expect(await s.get("k")).toBeNull();
  });

  it("keeps a fixed expiry window across increments", async () => {
    await s.incrByFloat("c", 1, 10);
    await s.incrByFloat("c", 1); // must not extend the TTL
    await new Promise((r) => setTimeout(r, 25));
    expect(await s.get("c")).toBeNull();
  });
});
