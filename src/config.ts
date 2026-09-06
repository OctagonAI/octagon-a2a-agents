/**
 * Configuration, resolved once at startup.
 *
 * `OCTAGON_API_KEY` is deliberately optional. This service prefers the caller's
 * own credential — an A2A client authenticates to us, and we forward that
 * credential to Octagon so usage is billed and rate-limited against the caller,
 * not against a shared server key. The env key is a fallback for local
 * development and single-tenant deployments; see `resolveApiKey` in auth.ts.
 */
function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    console.error(`Error: ${name} is not set in the environment`);
    process.exit(1);
  }
  return value;
}

const port = Number.parseInt(env("PORT", "4000"), 10);

export const config = {
  port,
  /**
   * Public origin, when it is pinned. Optional on purpose: when unset the agent
   * card derives its origin from the incoming request, so the card is correct on
   * whatever hostname actually served it — the Render URL today, a custom domain
   * the moment DNS moves — without a redeploy. Set it only to force a canonical
   * origin, and only to a hostname that already resolves: a card advertising a
   * URL that does not answer is worse than no card.
   */
  hostUrl: process.env.HOST_URL?.replace(/\/$/, ""),
  /** Fallback when neither HOST_URL nor a request origin is available. */
  localUrl: `http://localhost:${port}`,
  /** Octagon's OpenAI-compatible API. Both agents are models on it. */
  octagonApiUrl: env("OCTAGON_API_URL", "https://api.octagonai.co/v1"),
  /** Optional fallback credential; see the note above. */
  octagonApiKey: process.env.OCTAGON_API_KEY,
  logLevel: env("LOG_LEVEL", "info"),
} as const;
