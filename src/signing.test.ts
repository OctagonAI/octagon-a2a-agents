import { describe, expect, test } from "bun:test";
import * as jose from "jose";
import { verifyAgentCardSignature } from "@a2a-js/sdk";
import { buildCardSigner, SIGNING_ALG } from "./signing.js";
import { buildAgentCard } from "./agentCard.js";

const JWKS_URL = "https://a2a.example.test/.well-known/jwks.json";

async function privateJwk(kid = "octagon-a2a-1"): Promise<string> {
  const { privateKey } = await jose.generateKeyPair(SIGNING_ALG, { extractable: true });
  return JSON.stringify({ ...(await jose.exportJWK(privateKey)), kid, alg: SIGNING_ALG });
}

describe("agent card signing", () => {
  test("no key configured means no signer, and the card stays valid", async () => {
    // Unsigned is a legitimate card. The default must not become "broken".
    expect(await buildCardSigner(undefined, JWKS_URL)).toBeNull();
    expect(await buildCardSigner("   ", JWKS_URL)).toBeNull();
  });

  test("a signed card verifies against the published JWKS", async () => {
    // The real contract: the signature must check out against exactly the key
    // this service publishes at `jku`. Anything less is theatre.
    const signer = (await buildCardSigner(await privateJwk(), JWKS_URL))!;
    const signed = await signer.sign(buildAgentCard("https://a2a.example.test"));

    expect(signed.signatures.length).toBeGreaterThan(0);
    const verify = verifyAgentCardSignature(async (kid) => {
      const jwk = signer.publicJwks.keys.find((k) => k.kid === kid);
      if (!jwk) throw new Error(`unknown kid ${kid}`);
      return jwk;
    });
    await verify(signed); // throws if no signature validates
  });

  test("the protected header names the key and where to fetch it", async () => {
    // A verifier that cannot locate the key cannot verify. `kid` selects it,
    // `jku` says where it lives.
    const signer = (await buildCardSigner(await privateJwk("key-42"), JWKS_URL))!;
    const signed = await signer.sign(buildAgentCard("https://a2a.example.test"));
    const header = JSON.parse(
      Buffer.from(signed.signatures[0]!.protected, "base64url").toString("utf-8"),
    );
    expect(header.kid).toBe("key-42");
    expect(header.jku).toBe(JWKS_URL);
    expect(header.alg).toBe(SIGNING_ALG);
  });

  test("the published JWKS carries no private material", async () => {
    // Publishing `d` would hand anyone the ability to sign as Octagon.
    const signer = (await buildCardSigner(await privateJwk(), JWKS_URL))!;
    for (const key of signer.publicJwks.keys) {
      expect(key.d).toBeUndefined();
      expect(key.kid).toBeDefined();
      expect(key.use).toBe("sig");
    }
  });

  test("tampering with a signed card breaks verification", async () => {
    // The signature has to actually cover the card's contents.
    const signer = (await buildCardSigner(await privateJwk(), JWKS_URL))!;
    const signed = await signer.sign(buildAgentCard("https://a2a.example.test"));
    const tampered = { ...signed, name: "Not Octagon" };
    const verify = verifyAgentCardSignature(async () => signer.publicJwks.keys[0]!);
    await expect(verify(tampered)).rejects.toThrow();
  });

  test("a key with no kid is rejected outright", async () => {
    // Silently signing with an unidentifiable key produces signatures nobody
    // can select a key for.
    const { privateKey } = await jose.generateKeyPair(SIGNING_ALG, { extractable: true });
    const noKid = JSON.stringify(await jose.exportJWK(privateKey));
    await expect(buildCardSigner(noKid, JWKS_URL)).rejects.toThrow(/kid/i);
  });
});
