import { randomUUID } from "node:crypto";
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import { TaskState } from "@a2a-js/sdk";
import type { Message, Part } from "@a2a-js/sdk";
import { DEFAULT_SKILL, isSkillId, resolveModel, type SkillId } from "./agents.js";
import { authorizationFrom, resolveApiKey } from "./auth.js";
import { logger } from "./logger.js";
import { octagonClient, streamAgent } from "./octagon.js";

/** A2A 1.x wraps part content in a discriminated union. */
function textPart(text: string): Part {
  return { content: { $case: "text", value: text } } as Part;
}

/** Text carried by an A2A message, joined across its parts. */
export function promptFromMessage(message: unknown): string {
  const parts = (message as { parts?: unknown[] } | undefined)?.parts ?? [];
  return parts
    .map((part) => {
      const p = part as Record<string, any>;
      // 1.x shape first, then the v0.3 shape, because the server accepts both
      // protocol versions and a v0.3 client's text would otherwise be dropped
      // silently — producing an empty prompt rather than an error.
      if (p?.content?.$case === "text") return p.content.value;
      if (p?.part?.$case === "text") return p.part.value?.text;
      return p?.text;
    })
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n")
    .trim();
}

/**
 * Which Octagon agent answers this message.
 *
 * A caller names a skill in message metadata; absent that, the default is the
 * orchestrator, which exists precisely to route an unclassified question. This
 * never guesses from the text — an inferred route that lands on the wrong agent
 * produces a confidently wrong answer, and the orchestrator already does that
 * job properly.
 */
export function selectSkill(message: unknown): SkillId {
  const metadata = (message as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  const requested = metadata?.["skillId"] ?? metadata?.["skill"];
  return isSkillId(requested) ? requested : DEFAULT_SKILL;
}

/** Optional `cache` hint for the prediction-markets agent. */
export function selectCache(message: unknown): boolean | undefined {
  const value = (message as { metadata?: Record<string, unknown> } | undefined)?.metadata?.["cache"];
  return typeof value === "boolean" ? value : undefined;
}

export class OctagonAgentExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>();

  cancelTask = async (taskId: string, _eventBus: ExecutionEventBus): Promise<void> => {
    // Recorded rather than acted on here: the in-flight loop checks this
    // between chunks and emits the terminal state itself, so exactly one place
    // closes a task out.
    this.cancelled.add(taskId);
  };

  execute = async (requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> => {
    const { taskId, contextId, userMessage } = requestContext as unknown as {
      taskId: string;
      contextId: string;
      userMessage: unknown;
    };

    const status = (state: TaskState, text?: string) => {
      const message: Message | undefined = text
        ? ({
            messageId: randomUUID(),
            role: "ROLE_AGENT",
            parts: [textPart(text)],
            taskId,
            contextId,
          } as unknown as Message)
        : undefined;
      eventBus.publish({
        kind: "statusUpdate",
        data: {
          taskId,
          contextId,
          status: { state, message, timestamp: new Date().toISOString() },
          metadata: undefined,
        },
      });
    };

    const finish = (state: TaskState, text?: string) => {
      status(state, text);
      eventBus.finished();
    };

    // A2A requires the task to exist before anything can be published against
    // it. Without this the SDK rejects the run with "Agent execution finished
    // without a result, and no task context found" — the status updates below
    // have nothing to attach to.
    if (!(requestContext as unknown as { task?: unknown }).task) {
      eventBus.publish({
        kind: "task",
        data: {
          id: taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_SUBMITTED,
            message: undefined,
            timestamp: new Date().toISOString(),
          },
          artifacts: [],
          history: userMessage ? [userMessage as Message] : [],
          metadata: undefined,
        },
      });
    }

    const prompt = promptFromMessage(userMessage);
    if (!prompt) {
      // A task with no question cannot be worked on; failing immediately is
      // more useful than a completed task holding an empty artifact.
      finish(TaskState.TASK_STATE_FAILED, "No text content in the message to research.");
      return;
    }

    const apiKey = resolveApiKey(authorizationFrom((requestContext as any)?.context));
    if (!apiKey) {
      finish(
        TaskState.TASK_STATE_AUTH_REQUIRED,
        "An Octagon API key is required. Present it as `Authorization: Bearer <key>`; keys are issued at https://app.octagonai.co/subscribe.",
      );
      return;
    }

    const skill = selectSkill(userMessage);
    const model = resolveModel(skill, selectCache(userMessage));
    logger.info({ taskId, skill, model }, "dispatching to Octagon");

    status(TaskState.TASK_STATE_WORKING);

    const artifactId = randomUUID();
    let answer = "";
    try {
      for await (const chunk of streamAgent(octagonClient(apiKey), model, prompt)) {
        if (this.cancelled.has(taskId)) {
          finish(TaskState.TASK_STATE_CANCELED);
          return;
        }
        answer += chunk.text;
        eventBus.publish({
          kind: "artifactUpdate",
          data: {
            taskId,
            contextId,
            append: true,
            lastChunk: false,
            artifact: {
            artifactId,
            name: "answer",
            description: `${skill} answer from ${model}`,
              parts: [textPart(chunk.text)],
              metadata: undefined,
              extensions: [],
            },
            metadata: undefined,
          },
        });
      }
    } catch (error) {
      logger.error({ err: error, model }, "Octagon request failed");
      // Surface Octagon's own message where there is one — "insufficient
      // credits" is something the caller can act on; "Error" is not.
      finish(TaskState.TASK_STATE_FAILED, error instanceof Error ? error.message : String(error));
      return;
    }

    if (this.cancelled.has(taskId)) {
      finish(TaskState.TASK_STATE_CANCELED);
      return;
    }
    if (answer.length === 0) {
      finish(TaskState.TASK_STATE_FAILED, "The agent returned no content.");
      return;
    }

    eventBus.publish({
      kind: "artifactUpdate",
      data: {
        taskId,
        contextId,
        append: true,
        lastChunk: true,
        artifact: {
          artifactId,
          name: "answer",
          description: `${skill} answer from ${model}`,
          parts: [textPart("")],
          metadata: undefined,
          extensions: [],
        },
        metadata: undefined,
      },
    });
    finish(TaskState.TASK_STATE_COMPLETED);
  };
}
