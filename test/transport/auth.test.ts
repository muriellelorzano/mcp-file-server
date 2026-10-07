import { describe, expect, it } from "vitest";
import { parseAgentTokens } from "../../src/config.js";
import { createAuthenticator } from "../../src/transport/auth.js";

const T1 = "a".repeat(40);
const T2 = "b".repeat(40);

describe("parseAgentTokens", () => {
  it("parses token:agent pairs", () => {
    const m = parseAgentTokens(`${T1}:agent-a, ${T2}:agent-b`);
    expect(m.get(T1)).toBe("agent-a");
    expect(m.get(T2)).toBe("agent-b");
  });

  it.each([
    ["no colon", T1],
    ["short token", `short:agent-a`],
    ["bad agent id", `${T1}:Agent_A`],
    ["empty agent id", `${T1}:`],
    ["duplicate token", `${T1}:agent-a,${T1}:agent-b`],
    ["duplicate agent", `${T1}:agent-a,${T2}:agent-a`],
    ["only commas", ",,"],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseAgentTokens(raw)).toThrow();
  });

  it("never echoes token values in error messages", () => {
    try {
      parseAgentTokens(`${T1}:BAD ID`);
    } catch (e) {
      expect((e as Error).message).not.toContain(T1);
    }
  });
});

describe("authenticator", () => {
  const auth = createAuthenticator(parseAgentTokens(`${T1}:agent-a,${T2}:agent-b`));

  it("maps each token to its own agent", () => {
    expect(auth(`Bearer ${T1}`)).toBe("agent-a");
    expect(auth(`Bearer ${T2}`)).toBe("agent-b");
  });

  it("accepts the scheme case-insensitively", () => {
    expect(auth(`bearer ${T1}`)).toBe("agent-a");
  });

  it.each([
    ["missing header", undefined],
    ["empty", ""],
    ["wrong token", `Bearer ${"c".repeat(40)}`],
    ["prefix of a real token", `Bearer ${T1.slice(0, 39)}`],
    ["token plus extra char", `Bearer ${T1}x`],
    ["wrong scheme", `Basic ${T1}`],
    ["no scheme", T1],
    ["two tokens", `Bearer ${T1} ${T2}`],
  ])("rejects %s", (_name, header) => {
    expect(auth(header as string | undefined)).toBeNull();
  });
});