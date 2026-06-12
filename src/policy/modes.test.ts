import { describe, it, expect, afterEach } from "vitest";
import { resolvePolicyMode, policyParams } from "./modes";

describe("policy modes", () => {
  afterEach(() => {
    delete process.env.BEAMR_POLICY_MODE;
  });

  it("defaults to frugal (cheap-tier bias when nothing is set)", () => {
    delete process.env.BEAMR_POLICY_MODE;
    expect(resolvePolicyMode()).toBe("frugal");
  });

  it("honors the env mode over the frugal default", () => {
    process.env.BEAMR_POLICY_MODE = "balanced";
    expect(resolvePolicyMode()).toBe("balanced");
  });

  it("honors a valid per-request override", () => {
    expect(resolvePolicyMode("premium")).toBe("premium");
  });

  it("ignores an invalid override and falls back to the env mode", () => {
    process.env.BEAMR_POLICY_MODE = "frugal";
    expect(resolvePolicyMode("garbage")).toBe("frugal");
  });

  it("frugal routes cheaper than premium (higher difficulty bar)", () => {
    expect(policyParams("frugal").difficultyThreshold).toBeGreaterThan(
      policyParams("premium").difficultyThreshold,
    );
  });
});
