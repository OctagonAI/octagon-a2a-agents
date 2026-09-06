# octagon-a2a

An [Agent2Agent (A2A)](https://a2a-protocol.org) interface to Octagon's research
agents, so other people's autonomous agents can delegate work to them.

This is a **protocol façade, not a reimplementation**. Both agents are models on
Octagon's OpenAI-compatible API, and calling one is a chat completion:

```
A2A JSON-RPC  ->  this service  ->  api.octagonai.co/v1  (chat.completions)
```

Everything specific to Octagon lives in two small files: `src/agents.ts` (which
skill maps to which model) and `src/octagon.ts` (how to call it).

## What it exposes

One A2A agent with two skills, rather than two agents — `/.well-known/agent-card.json`
is a single well-known location, and `skills[]` is exactly the mechanism A2A
provides for an agent that can do more than one thing.

| A2A skill | Octagon model | What it does |
| --- | --- | --- |
| `market-research` | `octagon-agent` | Routes across Octagon's specialised agents — SEC filings, earnings calls, financial metrics, stock data, institutional holdings, private companies, funding, M&A, news — and synthesises a cited answer. |
| `prediction-markets` | `octagon-prediction-markets-agent` | Kalshi research: model probability vs market price, what is driving it, potential mispricings. |

### Choosing a skill

Set `skillId` in message metadata. Omit it and the request goes to
`octagon-agent`, which is itself a router — an unclassified question is exactly
what it exists to handle, so this is the right answer rather than a fallback.

```json
{"message": {"metadata": {"skillId": "prediction-markets", "cache": true}, "parts": [...]}}
```

`cache` applies only to `prediction-markets`, and has three meanings, not two:

| `cache` | Model sent | Meaning |
| --- | --- | --- |
| `true` | `…-agent:cache` | Cached report only. Free, instant. |
| `false` | `…-agent:refresh` | Force a fresh report. Costs credits, can take minutes. |
| omitted | `…-agent` | Let Octagon decide — cached if one exists. |

## Authentication

Callers present their own Octagon API key as a bearer token, and it is forwarded
to Octagon so **usage bills and rate-limits against the caller**, not against
whoever runs this service:

```
Authorization: Bearer <OCTAGON_API_KEY>
```

`OCTAGON_API_KEY` in the environment is a fallback for local development and
single-tenant deployments. In a multi-tenant deployment, leaving it unset is
what forces every caller to bring their own credential. With neither, a request
returns the A2A `auth-required` state and a message saying where to get a key.

This service does not validate keys — Octagon's API is the authority on that, so
there is no second identity system here.

## Running it

```bash
bun install
OCTAGON_API_KEY=sk-... HOST_URL=http://localhost:4000 bun start
```

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4000` | |
| `HOST_URL` | `http://localhost:$PORT` | **Must be the public origin.** The agent card advertises `$HOST_URL/a2a`; if this is wrong, clients that trust the card get a 404. |
| `OCTAGON_API_URL` | `https://api.octagonai.co/v1` | |
| `OCTAGON_API_KEY` | unset | Optional fallback; see above. |
| `LOG_LEVEL` | `info` | |

Endpoints: `/.well-known/agent-card.json`, `/a2a` (JSON-RPC), `/health`.

## Protocol versions

The card declares both A2A `1.0` and `0.3` on the same URL, and the server runs
the SDK's `legacyCompat` layer. This is not belt-and-braces: the SDK treats a
client that sends **no** version header as `0.3`, which is still most of the
ecosystem, so declaring only `1.0` would reject the majority of callers before
they got as far as authenticating. Drop the v0.3 interface from the card and
`legacyCompat` in `src/index.ts` together, once 1.0 clients are the norm.

## Known rough edges

- **Task state is in memory.** `InMemoryTaskStore` means task history does not
  survive a restart and does not work across replicas. Fine for one instance;
  a shared store is needed before scaling out.
- **Octagon returns some errors as text.** A malformed prediction-markets
  request comes back as a normal completion whose content is an error string,
  so the A2A task reports `completed` with that text as the artifact. Detecting
  it would mean pattern-matching Octagon's error prose, which breaks the moment
  the wording changes.
- **No push notifications.** The card says `pushNotifications: false` because
  there is no webhook sender here. Advertising it would have callers register
  callbacks that never fire.

## Tests

```bash
bun test        # pure logic: routing, model resolution, prompt parsing, the card
bun run typecheck
```

The tests deliberately cover the decisions rather than the plumbing — which
model a skill resolves to, that `cache` has three states, that both the 1.x and
v0.3 message part shapes are read, and that the card advertises only what the
service actually implements.
