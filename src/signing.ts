import * as jose from "jose";
import { generateAgentCardSignature } from "@a2a-js/sdk";
import type { AgentCard } from "@a2a-js/sdk";
import { logger } from "./logger.js";

/**
 * Signing the agent card, per A2A §8.4.1: a JWS over the RFC 8785 canonical
 * form of the card.
 *
 * A signature is only worth anything if a verifier can find the public key, so
 * the protected header carries `jku` — a JWKS URL this service also serves —
 * alongside the `kid` that selects the key within it. Signing without
 * publishing the key would produce a card that looks trustworthy and cannot be
 * checked, which is worse than an unsigned one.
 *
 * Unsigned is a valid card and remains the default: with no key configured the
 * service publishes exactly what it does today.
 */

export const SIGNING_ALG = "ES256";
export const JWKS_PATH = "/.well-known/jwks.json";

export type CardSigner = {
  /** `jwksUrl` must be absolute: it becomes the signature's `jku`, and a
   *  verifier fetches it directly. A relative value silently produces
   *  signatures nobody outside this process can check. */
  sign: (card: AgentCard, jwksUrl: string) => Promise<AgentCard>;
  publicJwks: { keys: jose.JWK[] };
};

/**
 * Build a signer from a private JWK, or null when none is configured.
 *
 * Throws on a malformed key rather than falling back to unsigned: a deployment
 * that meant to sign and silently did not is a security regression that no
 * client can detect.
 */
export async function buildCardSigner(
  privateJwkJson: string | undefined,
): Promise<CardSigner | null> {
  if (!privateJwkJson?.trim()) return null;

  const jwk = JSON.parse(privateJwkJson) as jose.JWK;
  const kid = jwk.kid;
  if (!kid) throw new Error("Signing JWK must carry a `kid`; verifiers select the key by it.");

  const privateKey = await jose.importJWK(jwk, SIGNING_ALG);
  // Strip the private components; what remains is safe to publish and is what
  // a verifier fetches from `jku`.
  const publicJwk = await jose.exportJWK(
    await jose.importJWK({ ...jwk, d: undefined } as jose.JWK, SIGNING_ALG),
  );

  // The protected header is fixed when the generator is built, and it carries
  // `jku` — which depends on the host the card was requested on. Built per
  // distinct URL and cached, rather than once at startup with a host we do not
  // know yet.
  const generators = new Map<string, ReturnType<typeof generateAgentCardSignature>>();
  const generatorFor = (jwksUrl: string) => {
    let generator = generators.get(jwksUrl);
    if (!generator) {
      generator = generateAgentCardSignature(privateKey as jose.CryptoKey, {
        alg: SIGNING_ALG,
        kid,
        typ: "JOSE",
        jku: jwksUrl,
      });
      generators.set(jwksUrl, generator);
    }
    return generator;
  };

  logger.info({ kid }, "agent card signing enabled");
  return {
    sign: async (card, jwksUrl) => {
      // async so the guard rejects rather than throwing synchronously: the
      // signature says Promise, and a caller with a .catch() would otherwise
      // miss it entirely.
      if (!/^https?:\/\//.test(jwksUrl)) {
        // Fail loudly: an unverifiable signature looks like a working one.
        throw new Error(`jku must be an absolute URL, got "${jwksUrl}"`);
      }
      return generatorFor(jwksUrl)(card);
    },
    publicJwks: { keys: [{ ...publicJwk, kid, alg: SIGNING_ALG, use: "sig" }] },
  };
}
