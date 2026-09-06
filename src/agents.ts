/**
 * The two Octagon agents this service exposes, and the A2A skills that map onto
 * them.
 *
 * Both are *models* on Octagon's OpenAI-compatible API, not separate services:
 * calling them is `chat.completions.create({ model, ... })`. So this file is the
 * whole mapping layer — an A2A skill id in, an Octagon model name out.
 *
 * They are exposed as two skills of one A2A agent rather than two agents,
 * because `/.well-known/agent-card.json` is a single well-known location and
 * `skills[]` is exactly the mechanism A2A provides for an agent that can do
 * more than one thing.
 */

export const SKILL_MARKET_RESEARCH = "market-research";
export const SKILL_PREDICTION_MARKETS = "prediction-markets";

export type SkillId = typeof SKILL_MARKET_RESEARCH | typeof SKILL_PREDICTION_MARKETS;

/** Octagon model names. These are the API's identifiers, not ours to invent. */
export const MODEL_BY_SKILL: Record<SkillId, string> = {
  [SKILL_MARKET_RESEARCH]: "octagon-agent",
  [SKILL_PREDICTION_MARKETS]: "octagon-prediction-markets-agent",
};

/**
 * The skill used when a caller does not name one.
 *
 * `octagon-agent` is itself a router across Octagon's specialised agents, so
 * defaulting to it is not a guess — an unrouted question is exactly what it
 * exists to handle.
 */
export const DEFAULT_SKILL: SkillId = SKILL_MARKET_RESEARCH;

export function isSkillId(value: unknown): value is SkillId {
  return value === SKILL_MARKET_RESEARCH || value === SKILL_PREDICTION_MARKETS;
}

/**
 * Resolve the Octagon model for a request.
 *
 * The prediction-markets agent takes `:cache` / `:refresh` suffixes: a fresh
 * report costs credits and can take minutes, a cached one is free and instant.
 * Omitting the suffix lets Octagon decide (cached if available), which is the
 * right default for a caller who did not express a preference.
 */
export function resolveModel(skill: SkillId, cache?: boolean): string {
  const model = MODEL_BY_SKILL[skill];
  if (skill !== SKILL_PREDICTION_MARKETS || cache === undefined) return model;
  return cache ? `${model}:cache` : `${model}:refresh`;
}
