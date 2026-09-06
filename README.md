# Octagon: A2A Agents for Public & Prediction Markets Intelligence

![Favicon](https://octagonai.co/docs/logo.svg) An [Agent2Agent (A2A)](https://a2a-protocol.org) interface to Octagon's research agents — so **other people's autonomous agents can delegate research to yours**. Point any A2A client at one URL and it discovers two skills: multi-source financial research across SEC filings, earnings calls, financials, stock and crypto data, private markets and news; and Kalshi prediction-market research comparing Octagon's model probability against the live market price.

MCP exposes tools to *a model you control*. A2A lets *someone else's agent* hire yours.

## Skills

✅ `market-research` → **`octagon-agent`**

- Routes across Octagon's specialized agents and synthesizes one cited answer
- SEC filings (10-K, 10-Q, 20-F, 8-K, S-1, 13-F, DEF 14A), earnings call transcripts
- Financial metrics and ratios, stock & crypto market data, news and press releases
- Private companies, funding rounds, M&A and IPO transactions, institutional holdings

✅ `prediction-markets` → **`octagon-prediction-markets-agent`**

- Research reports on Kalshi events: model probability vs. market price
- What's driving the price, catalysts, decision-flipping events, historical resolutions
- Edge screening and market discovery from a URL, a ticker, or plain English

✅ Protocol surface

- A2A `1.0` **and** `0.3` on one URL — streaming (`message/stream`), task lifecycle, cancellation
- Agent card at `/.well-known/agent-card.json`
- Caller-supplied credentials: usage bills against the caller, not the operator

## Get Your Octagon API Key

1. Sign up for a free account at [Octagon](https://app.octagonai.co/signup/?redirectToAfterSignup=https://app.octagonai.co/api-keys)
2. After logging in, from the left menu, navigate to **API Keys**
3. Generate a new API key
4. Present it as a bearer token (below), or set it as `OCTAGON_API_KEY`

## Quickstart

```bash
bun install
bun start
```

Discover the agent:

```bash
curl -s http://localhost:4000/.well-known/agent-card.json | jq '.skills[].id'
# "market-research"
# "prediction-markets"
```

Ask it something:

```bash
curl -s -X POST http://localhost:4000/a2a \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $OCTAGON_API_KEY" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "message/send",
    "params": { "message": { "kind": "message", "role": "user", "messageId": "1",
      "parts": [{ "kind": "text", "text": "What was Apple'\''s most recent quarterly revenue?" }] } }
  }' | jq -r '.result.artifacts[0].parts[0].text'
```

```
Apple (AAPL) most recently reported quarterly revenue of $109.42 billion for
fiscal 2026 Q3 (period ended 2026-06-27).

## Sources used
- `octagon-financials-agent`
```

### Choosing a skill

Set `skillId` in message metadata. **Omit it and the request goes to `octagon-agent`**, which is itself a router — an unclassified question is exactly what it exists to handle.

```json
{ "message": { "metadata": { "skillId": "prediction-markets", "cache": true },
               "parts": [{ "kind": "text", "text": "https://kalshi.com/markets/kxbtcy/..." }] } }
```

`cache` applies only to `prediction-markets`, and has **three** meanings:

| `cache` | Model | Meaning |
| --- | --- | --- |
| `true` | `octagon-prediction-markets-agent:cache` | Cached report only — free, instant |
| `false` | `octagon-prediction-markets-agent:refresh` | Force a fresh report — costs credits, can take minutes |
| omitted | `octagon-prediction-markets-agent` | Let Octagon decide — cached if one exists |

### Streaming

```bash
curl -N -X POST http://localhost:4000/a2a \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -H "Authorization: Bearer $OCTAGON_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/stream","params":{"message":{
       "kind":"message","role":"user","messageId":"1",
       "parts":[{"kind":"text","text":"Summarize NVDA'\''s last earnings call"}]}}}'
```

Emits the A2A sequence: `task` → `status-update` (working) → `artifact-update` (streamed text) → `status-update` (completed).

## Authentication

Callers present **their own** Octagon API key as a bearer token, and it is forwarded upstream — so usage bills and rate-limits against the caller, not against whoever operates the service.

```
Authorization: Bearer <OCTAGON_API_KEY>
```

`OCTAGON_API_KEY` in the environment is a fallback for local development and single-tenant deployments. **In a multi-tenant deployment, leave it unset** — that is what forces every caller to bring their own credential. With neither, a request returns the A2A `auth-required` state and a message pointing at the signup page.

This service does not validate keys. Octagon's API is the authority, so there is no second identity system here.

## Deployment

A2A is remote-first: the agent card publishes a URL that **other people's agents call over the network**, so unlike an MCP stdio server this has to run somewhere reachable.

```
Remote agent  ──►  https://your-host/.well-known/agent-card.json   (discovery)
              ──►  https://your-host/a2a                           (JSON-RPC + SSE)
                        │
                        └──►  api.octagonai.co/v1  (chat completions)
```

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4000` | |
| `HOST_URL` | *(derived from the request)* | Optional. The card names the origin the request arrived on, so it is correct on any hostname without a redeploy. Set it only to force one canonical origin — and only to a host that already resolves. |
| `OCTAGON_API_URL` | `https://api.octagonai.co/v1` | |
| `OCTAGON_API_KEY` | unset | Optional fallback — see Authentication |
| `REDIS_URL` | unset | Shared task store. **Required before running more than one instance** — see below. |
| `AGENT_CARD_PRIVATE_JWK` | unset | Private JWK (JSON) for signing the agent card. Unset = unsigned, which is valid. |
| `LOG_LEVEL` | `info` | |

Endpoints: `/.well-known/agent-card.json` · `/a2a` · `/health`

### Task state

A2A tasks are long-running and resumable: `tasks/get` and `tasks/resubscribe` arrive later and may land on a different instance. Set `REDIS_URL` and the service uses a Redis-backed store; leave it unset and it falls back to process memory, logging a warning that says not to run more than one instance.

The Redis store mirrors the in-memory one exactly — same tenant/owner scoping, filters, newest-first ordering and opaque page tokens — so swapping stores changes durability and nothing an A2A client can observe. Tasks carry a 7-day TTL, and index entries for expired tasks are pruned on read, so the keyspace stays bounded on a `noeviction` instance.

A *failed* connection is fatal rather than a silent fallback: running multi-replica against process memory is the exact bug this exists to prevent, and it would surface only as clients losing tasks.

### Signing the agent card

A2A supports signed agent cards (JWS over the RFC 8785 canonical form, §8.4.1). Set `AGENT_CARD_PRIVATE_JWK` to a private JWK containing a `kid`, and the service signs each card it serves and publishes the matching public key at `/.well-known/jwks.json`. The signature's protected header carries `kid` and `jku`, so a verifier can fetch the key without out-of-band configuration — signing without publishing the key would produce a card that looks trustworthy and cannot be checked.

Generate a key:

```bash
bun -e "import * as jose from 'jose';
const { privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
console.log(JSON.stringify({ ...(await jose.exportJWK(privateKey)), kid: 'octagon-a2a-1', alg: 'ES256' }))"
```

Cards are signed per request, because the card names the origin it was requested on — the bytes differ per host, and each set needs a signature over exactly what is served. An unsigned card remains valid; leaving the key unset changes nothing about how the service behaves.

## Architecture

This is a **protocol façade, not a reimplementation**. Both agents are models on Octagon's OpenAI-compatible API, so answering an A2A task is a chat completion. Everything Octagon-specific lives in two small files:

| File | Responsibility |
| --- | --- |
| `src/agents.ts` | Which A2A skill maps to which Octagon model, and how `cache` becomes a model suffix |
| `src/octagon.ts` | How to call it, and how to read both streaming response shapes |
| `src/executor.ts` | A2A task lifecycle: submitted → working → artifacts → completed/failed/canceled |
| `src/agentCard.ts` | What this agent publicly claims it can do |
| `src/context.ts` | Carries the caller's `Authorization` header through to the executor |

It is exposed as **one A2A agent with two skills** rather than two agents: `/.well-known/agent-card.json` is a single well-known location, and `skills[]` is exactly the mechanism A2A provides for an agent that does more than one thing.

### Protocol versions

The card declares both A2A `1.0` and `0.3` on the same URL. This is not belt-and-braces — the SDK treats a client that sends **no** version header as `0.3`, which is still most of the ecosystem, so declaring only `1.0` rejects the majority of callers before they get as far as authenticating. Drop the v0.3 interface from the card and `legacyCompat` in `src/index.ts` together, once 1.0 clients are the norm.

## Known limitations

- **Task state is in memory unless `REDIS_URL` is set.** See Deployment above.
- **Octagon returns some errors as text.** A malformed prediction-markets request comes back as a normal completion whose content is an error string, so the task reports `completed` with that text as the artifact. Detecting it would mean pattern-matching Octagon's error prose, which breaks the moment the wording changes.
- **No push notifications.** The card says `pushNotifications: false` because there is no webhook sender here. Advertising it would have callers register callbacks that never fire.
- **Routing is explicit, never inferred.** An unrouted message goes to `octagon-agent`. Guessing a skill from the message text would produce confidently wrong answers from the wrong agent.

## Development

```bash
bun install
bun test           # routing, model resolution, prompt parsing, agent card
bun run typecheck
bun dev            # hot reload
```

## Documentation

- [Octagon documentation](https://octagonai.co/docs)
- [`octagon-agent`](https://www.octagonai.co/docs/guide/agents/octagon-agent)
- [`octagon-prediction-markets-agent`](https://www.octagonai.co/docs/guide/agents/prediction-markets-agent)
- [A2A protocol specification](https://a2a-protocol.org)

## Related

- [octagon-mcp-server](https://github.com/OctagonAI/octagon-mcp-server) — the same intelligence over MCP, for Claude Desktop, Cursor and other MCP clients

## License

MIT
