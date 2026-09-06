import { config } from "./config.js";
import { AUTHORIZATION_STATE_KEY } from "./context.js";

/**
 * The Octagon credential to use for one request.
 *
 * Prefers the caller's own bearer token so usage is billed and rate-limited
 * against them. Falls back to a server key only when one is configured, which
 * is for local development and single-tenant deployments — in a multi-tenant
 * deployment leaving OCTAGON_API_KEY unset is what forces every caller to bring
 * their own credential rather than silently spending the operator's.
 */
export function resolveApiKey(authorizationHeader: string | undefined): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec((authorizationHeader ?? "").trim());
  const caller = bearer?.[1]?.trim();
  return caller && caller.length > 0 ? caller : config.octagonApiKey;
}

/**
 * The Authorization header for this call, as stashed by `octagonContextBuilder`.
 * The SDK's own context does not retain headers, so this is the only route.
 */
export function authorizationFrom(context: unknown): string | undefined {
  const state = (context as { state?: Map<string, unknown> } | undefined)?.state;
  const value = state?.get(AUTHORIZATION_STATE_KEY);
  return typeof value === "string" ? value : undefined;
}
