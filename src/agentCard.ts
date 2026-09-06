import type { AgentCard } from "@a2a-js/sdk";
import { config } from "./config.js";
import { SKILL_MARKET_RESEARCH, SKILL_PREDICTION_MARKETS } from "./agents.js";

/** Every skill needs the same credential, so the requirement is declared once. */
const SECURITY = { schemes: { octagonApiKey: { list: [] } } };

/**
 * The A2A agent card.
 *
 * Every claim here has to be true of the running service, because a card is a
 * promise other agents act on without asking. In particular `supportedInterfaces[].url`
 * is built from the configured host rather than hardcoded: a card advertising a
 * URL that does not answer is worse than no card at all.
 */
export function buildAgentCard(): AgentCard {
  return {
    name: "Octagon Research",
    description:
      "Financial and prediction-market research. Routes questions across Octagon's specialised agents for public and private markets, and produces analytical reports on Kalshi prediction markets comparing Octagon's model probabilities against market prices.",
    version: "0.1.0",
    documentationUrl: "https://www.octagonai.co/docs/guide/agents/octagon-agent",
    iconUrl: "https://www.octagonai.co/favicon.svg",
    provider: {
      organization: "Octagon",
      url: "https://www.octagonai.co",
    },
    // Both protocol versions on one URL. A client that sends no version header
    // is treated as 0.3 by the SDK, which is still most of the ecosystem, so
    // declaring only 1.0 would reject the majority of callers before they got
    // as far as authenticating. The v0.3 entry is what licenses `legacyCompat`
    // in index.ts; drop both together once 1.0 clients are the norm.
    supportedInterfaces: [
      {
        url: `${config.hostUrl}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: "",
      },
      {
        url: `${config.hostUrl}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "0.3",
        tenant: "",
      },
    ],
    capabilities: {
      // Both agents stream from Octagon, and that is forwarded as artifact
      // updates rather than buffered.
      streaming: true,
      // Not implemented: there is no webhook sender in this service, and
      // advertising it would have callers register callbacks that never fire.
      pushNotifications: false,
      extensions: [],
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/markdown", "text/plain"],
    securitySchemes: {
      octagonApiKey: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            scheme: "bearer",
            bearerFormat: "opaque",
            description:
              "An Octagon API key, presented as a bearer token. Forwarded to Octagon so usage bills against the caller. Keys are issued at https://app.octagonai.co/subscribe.",
          },
        },
      },
    },
    securityRequirements: [SECURITY],
    signatures: [],
    skills: [
      {
        id: SKILL_MARKET_RESEARCH,
        name: "Market and company research",
        description:
          "Answers financial research questions by routing across Octagon's specialised agents — SEC filings, earnings call transcripts, financial metrics, stock data, institutional holdings, private company and funding data, M&A, and news — and synthesising a cited answer.",
        tags: ["finance", "research", "sec-filings", "earnings", "equities", "private-markets"],
        examples: [
          "Analyze the latest 10-K filing for AAPL and extract key financial metrics and risk factors",
          "Retrieve the daily closing prices for AAPL over the last 30 days",
          "Analyze AAPL's latest earnings call transcript and extract key insights about future guidance",
          "Provide a comprehensive overview of Stripe, including its business model and key metrics",
        ],
        inputModes: ["text/plain"],
        outputModes: ["text/markdown"],
        securityRequirements: [SECURITY],
      },
      {
        id: SKILL_PREDICTION_MARKETS,
        name: "Prediction market research",
        description:
          "Researches Kalshi prediction markets: compares Octagon's model probability against the market price, explains what is driving the price, and surfaces potential mispricings. Accepts a Kalshi market URL, a ticker, or a plain-English description of the market.",
        tags: ["prediction-markets", "kalshi", "forecasting", "probability"],
        examples: [
          "https://kalshi.com/markets/kxbtcy/btc-price-range-eoy/kxbtcy-27jan0100",
          "Where does the Octagon model disagree most with market prices in Politics?",
          "Find markets about Fed rate cuts",
        ],
        inputModes: ["text/plain"],
        outputModes: ["text/markdown"],
        securityRequirements: [SECURITY],
      },
    ],
  };
}
