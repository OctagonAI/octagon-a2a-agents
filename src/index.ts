import express from "express";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import type { TaskStore } from "@a2a-js/sdk/server";
import { JWKS_PATH, buildCardSigner } from "./signing.js";
import { RedisTaskStore, connectTaskRedis } from "./taskStore.js";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { buildAgentCard } from "./agentCard.js";
import { config } from "./config.js";
import { octagonContextBuilder } from "./context.js";
import { OctagonAgentExecutor } from "./executor.js";
import { logger } from "./logger.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * The origin this request arrived on, used to name the card's interface URL.
 *
 * Deliberately reads `host`, not `x-forwarded-host`. `host` is the name this
 * service was actually addressed as — routing to it depends on that being
 * right. `x-forwarded-host` is whatever an upstream proxy claims, and when
 * octagonai.co proxies this document it sets that to `www.octagonai.co`, which
 * serves no /a2a: trusting it would publish a card pointing at a dead endpoint.
 * The scheme still comes from `x-forwarded-proto`, since TLS terminates
 * upstream and the local connection is plain HTTP.
 */
function requestOrigin(req: express.Request): string {
  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "https").split(",")[0]!.trim();
  const host = (req.get("host") ?? "").split(",")[0]!.trim();
  return host ? `${proto}://${host}` : config.localUrl;
}

// Built per request so the advertised URL tracks the hostname actually serving
// it. Cheap: a plain object literal.
const staticCard = buildAgentCard();

// The card is the discovery entrypoint, so it is served at the well-known path
// A2A clients look at, and cross-origin — a browser-based agent cannot read it
// otherwise.
app.get("/.well-known/agent-card.json", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const card = buildAgentCard(requestOrigin(req));
  // Signed on the way out rather than at startup: the card names the origin it
  // was requested on, so the bytes differ per host and each set needs its own
  // signature over exactly what is served.
  const body = signer ? await signer.sign(card) : card;
  res.type("application/json").send(JSON.stringify(body, null, 2));
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Signing is optional; when configured the public key must be fetchable, since
// the card's `jku` points here and a signature nobody can verify is worthless.
const signer = await buildCardSigner(config.agentCardPrivateJwk, `${config.hostUrl ?? ""}${JWKS_PATH}`);
if (signer) {
  app.get(JWKS_PATH, (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.type("application/json").send(JSON.stringify(signer.publicJwks, null, 2));
  });
}

// Shared task state. Without it `tasks/get` and `tasks/resubscribe` only work
// against the replica that handled the original request.
const redis = await connectTaskRedis(config.redisUrl);
const taskStore: TaskStore = redis ? new RedisTaskStore(redis) : new InMemoryTaskStore();
logger.info({ store: redis ? "redis" : "in-memory" }, "task store selected");
if (!redis) {
  logger.warn("REDIS_URL is unset: task state is per-process. Do not run more than one instance.");
}

const requestHandler = new DefaultRequestHandler(
  staticCard,
  taskStore,
  new OctagonAgentExecutor(),
);

// Mounted at the same path the card advertises. If these two ever disagree, a
// client that trusted the card gets a 404 — so the card builds its URL from the
// same config this mount point uses.
app.use(
  "/a2a",
  jsonRpcHandler({
    requestHandler,
    // Octagon's own API is the authority on whether a key is valid; this
    // service forwards the credential rather than adjudicating it, so there is
    // no second identity to build here.
    userBuilder: UserBuilder.noAuthentication,
    // Clients that send no A2A version header are treated as v0.3, which is
    // still most of them. The card declares the matching v0.3 interface.
    legacyCompat: { enabled: true },
    // Carries the caller's Authorization header through to the executor.
    contextBuilder: octagonContextBuilder,
  }),
);

app.listen(config.port, () => {
  // hostUrl is optional now — the card names whatever host serves it — so log
  // the port actually bound rather than interpolating an undefined origin.
  const origin = config.hostUrl ?? `port ${config.port}`;
  logger.info(`A2A server listening on ${origin} (agent card at /.well-known/agent-card.json)`);
});
