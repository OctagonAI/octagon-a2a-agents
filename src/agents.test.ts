import { describe, expect, test } from "bun:test";
process.env.HOST_URL ??= "https://a2a.example.test";

import {
  DEFAULT_SKILL,
  MODEL_BY_SKILL,
  SKILL_MARKET_RESEARCH,
  SKILL_PREDICTION_MARKETS,
  isSkillId,
  resolveModel,
} from "./agents.js";
import { promptFromMessage, selectCache, selectSkill } from "./executor.js";
import { resolveApiKey } from "./auth.js";

describe("skill to model mapping", () => {
  test("the two skills map to Octagon's own model names", () => {
    // These strings are the API's identifiers. Renaming one here silently
    // routes to a model that does not exist.
    expect(MODEL_BY_SKILL[SKILL_MARKET_RESEARCH]).toBe("octagon-agent");
    expect(MODEL_BY_SKILL[SKILL_PREDICTION_MARKETS]).toBe("octagon-prediction-markets-agent");
  });

  test("the cache hint only applies to the prediction-markets agent", () => {
    // A `:cache` suffix on octagon-agent is not a model; sending one would 404
    // at the API for a caller who set the flag on the wrong skill.
    expect(resolveModel(SKILL_MARKET_RESEARCH, true)).toBe("octagon-agent");
    expect(resolveModel(SKILL_MARKET_RESEARCH, false)).toBe("octagon-agent");
  });

  test("cache true/false/absent are three distinct requests", () => {
    // Absent must not collapse to either: it means "let Octagon decide", which
    // returns a cached report if one exists and generates otherwise.
    expect(resolveModel(SKILL_PREDICTION_MARKETS, true)).toBe("octagon-prediction-markets-agent:cache");
    expect(resolveModel(SKILL_PREDICTION_MARKETS, false)).toBe("octagon-prediction-markets-agent:refresh");
    expect(resolveModel(SKILL_PREDICTION_MARKETS, undefined)).toBe("octagon-prediction-markets-agent");
  });

  test("only the two published skill ids are accepted", () => {
    expect(isSkillId(SKILL_MARKET_RESEARCH)).toBe(true);
    expect(isSkillId("octagon-deep-research-agent")).toBe(false);
    expect(isSkillId(undefined)).toBe(false);
  });
});

describe("routing a message", () => {
  const msg = (metadata?: Record<string, unknown>) => ({ metadata, parts: [] });

  test("an unrouted message goes to the orchestrator", () => {
    // Not a fallback so much as the right answer: octagon-agent exists to route
    // questions it has not been told how to classify.
    expect(selectSkill(msg())).toBe(DEFAULT_SKILL);
    expect(DEFAULT_SKILL).toBe(SKILL_MARKET_RESEARCH);
  });

  test("an explicit skill is honoured, an unknown one is not", () => {
    expect(selectSkill(msg({ skillId: SKILL_PREDICTION_MARKETS }))).toBe(SKILL_PREDICTION_MARKETS);
    // Falling through to the orchestrator beats failing: the caller still gets
    // a real answer rather than an error about a skill name.
    expect(selectSkill(msg({ skillId: "no-such-skill" }))).toBe(DEFAULT_SKILL);
  });

  test("cache is only read when it is a boolean", () => {
    expect(selectCache(msg({ cache: true }))).toBe(true);
    expect(selectCache(msg({ cache: "true" }))).toBeUndefined();
    expect(selectCache(msg())).toBeUndefined();
  });
});

describe("reading the prompt", () => {
  test("accepts both the 1.x and v0.3 part shapes", () => {
    // The server advertises both protocol versions, so dropping either shape
    // would send an empty prompt for half the ecosystem.
    expect(promptFromMessage({ parts: [{ content: { $case: "text", value: "one" } }] })).toBe("one");
    expect(promptFromMessage({ parts: [{ part: { $case: "text", value: { text: "two" } } }] })).toBe("two");
    expect(promptFromMessage({ parts: [{ kind: "text", text: "three" }] })).toBe("three");
  });

  test("joins multiple parts and ignores non-text ones", () => {
    expect(
      promptFromMessage({
        parts: [
          { kind: "text", text: "first" },
          { kind: "file", file: { uri: "x" } },
          { kind: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond");
  });

  test("an empty or textless message yields no prompt", () => {
    // The executor turns this into a failed task rather than calling Octagon
    // with an empty string and billing the caller for it.
    expect(promptFromMessage({ parts: [] })).toBe("");
    expect(promptFromMessage(undefined)).toBe("");
    expect(promptFromMessage({ parts: [{ kind: "text", text: "   " }] })).toBe("");
  });
});

describe("credential resolution", () => {
  test("the caller's bearer token wins", () => {
    // Usage bills against the caller, not the operator.
    expect(resolveApiKey("Bearer sk-caller")).toBe("sk-caller");
    expect(resolveApiKey("bearer sk-caller")).toBe("sk-caller");
  });

  test("no header and no server key means no credential", () => {
    // Which the executor reports as auth-required. Inventing one here would
    // spend someone else's credits.
    expect(resolveApiKey(undefined)).toBeUndefined();
    expect(resolveApiKey("Bearer   ")).toBeUndefined();
    expect(resolveApiKey("Basic abc")).toBeUndefined();
  });
});
