import OpenAI from "openai";
import { config } from "./config.js";

/**
 * Octagon's API is OpenAI-compatible, and both agents are models on it — so
 * calling an agent is a chat completion, not a bespoke protocol. This is the
 * only place that knows that.
 */
export function octagonClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: config.octagonApiUrl });
}

export type StreamChunk = { text: string };

/**
 * Stream an agent's answer as text deltas.
 *
 * Octagon streams in both the Chat Completions and Responses shapes depending
 * on the agent, so both are handled — dropping one would silently yield an
 * empty answer for that agent rather than failing loudly.
 */
export async function* streamAgent(
  client: OpenAI,
  model: string,
  prompt: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const stream = await client.chat.completions.create(
    {
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      // Marks the traffic source in Octagon's own telemetry, matching what the
      // MCP server sends.
      metadata: { tool: "a2a" },
    } as never,
    { signal },
  );

  for await (const chunk of stream as unknown as AsyncIterable<Record<string, any>>) {
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      yield { text: delta };
      continue;
    }
    if (chunk?.type === "response.output_text.delta") {
      const text = chunk?.text?.delta ?? chunk?.delta;
      if (typeof text === "string" && text.length > 0) yield { text };
    }
  }
}
