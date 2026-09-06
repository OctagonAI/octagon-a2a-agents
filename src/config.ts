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
  /** Public origin this service is reachable at. Used to build the agent card's
   *  interface URL, which must be the address a client can actually reach. */
  hostUrl: env("HOST_URL", `http://localhost:${port}`).replace(/\/$/, ""),
  /** Octagon's OpenAI-compatible API. Both agents are models on it. */
  octagonApiUrl: env("OCTAGON_API_URL", "https://api.octagonai.co/v1"),
  /** Optional fallback credential; see the note above. */
  octagonApiKey: process.env.OCTAGON_API_KEY,
  logLevel: env("LOG_LEVEL", "info"),
} as const;
