import { describe, expect, test } from "bun:test";

const { buildAgentCard } = await import("./agentCard.js");
const { SKILL_MARKET_RESEARCH, SKILL_PREDICTION_MARKETS } = await import("./agents.js");
const { config } = await import("./config.js");

describe("agent card", () => {
  test("the advertised URL is the host the server actually mounts on", () => {
    // A card is a promise other agents act on without asking. The invariant is
    // that the URL it publishes is derived from the same config the server uses
    // to mount /a2a — a hardcoded literal here would ship a card pointing at
    // localhost, or at a path nothing serves.
    const card = buildAgentCard();
    for (const iface of card.supportedInterfaces) {
      expect(iface.url).toBe(`${config.hostUrl}/a2a`);
    }
  });

  test("it declares both protocol versions it actually serves", () => {
    // The SDK treats a client that sends no version header as 0.3, so
    // declaring only 1.0 rejects most callers. The v0.3 entry is what licenses
    // legacyCompat in index.ts — drop one and the other must go too.
    const versions = buildAgentCard().supportedInterfaces.map((i) => i.protocolVersion);
    expect(versions).toContain("1.0");
    expect(versions).toContain("0.3");
  });

  test("it advertises exactly the two skills that are wired up", () => {
    const ids = buildAgentCard().skills.map((s) => s.id);
    expect(ids).toEqual([SKILL_MARKET_RESEARCH, SKILL_PREDICTION_MARKETS]);
  });

  test("it does not claim push notifications", () => {
    // There is no webhook sender in this service. Advertising it would have
    // callers register callbacks that never fire.
    expect(buildAgentCard().capabilities?.pushNotifications).toBe(false);
    expect(buildAgentCard().capabilities?.streaming).toBe(true);
  });

  test("every skill carries examples and a security requirement", () => {
    for (const skill of buildAgentCard().skills) {
      expect(skill.examples.length).toBeGreaterThan(0);
      expect(skill.securityRequirements.length).toBeGreaterThan(0);
      expect(skill.tags.length).toBeGreaterThan(0);
    }
  });

  test("it is JSON-serialisable with no undefined-only required fields", () => {
    // The card is served as JSON; a required field that serialises away would
    // produce a card that validates in TypeScript and fails on the wire.
    const parsed = JSON.parse(JSON.stringify(buildAgentCard()));
    for (const field of [
      "name", "description", "version", "provider", "capabilities",
      "supportedInterfaces", "skills", "securitySchemes", "securityRequirements",
      "defaultInputModes", "defaultOutputModes",
    ]) {
      expect(parsed[field]).toBeDefined();
    }
  });
});
