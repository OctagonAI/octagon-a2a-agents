import { RedisClient } from "bun";
import type { ListTasksRequest, ListTasksResponse, Task } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { TaskState } from "@a2a-js/sdk";
import { logger } from "./logger.js";

/**
 * A2A tasks outlive the request that created them: `tasks/get` and
 * `tasks/resubscribe` come back later, possibly to a different instance. The
 * SDK's InMemoryTaskStore keeps them in process memory, so both break the
 * moment a second replica exists, and every task is lost on restart.
 *
 * This is the same store backed by Redis. Semantics are deliberately identical
 * to the in-memory one — the same tenant/owner scoping, the same filters, the
 * same newest-first ordering, the same opaque `timestamp|id` page token — so
 * swapping stores changes durability and nothing an A2A client can observe.
 */

/** How long a task remains readable. Tasks are working state, not an archive;
 *  without a bound the keyspace grows forever on a `noeviction` instance. */
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_PAGE_SIZE = 50;

/** Mirrors the SDK's scoping: tenant, then owner. With no authentication both
 *  are empty, which is one shared bucket — the same behaviour as today. */
function scopeOf(context: ServerCallContext): string {
  const tenant = (context as { tenant?: string }).tenant ?? "";
  const user = (context as { user?: { username?: string; id?: string } }).user;
  const owner = user?.username ?? user?.id ?? "";
  return `${tenant}|${owner}`;
}

function encodeCursor(task: Task): string {
  return Buffer.from(`${task.status?.timestamp || ""}|${task.id}`, "utf-8").toString("base64");
}

export class RedisTaskStore implements TaskStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  private taskKey(scope: string, taskId: string): string {
    return `a2a:task:${scope}:${taskId}`;
  }

  private indexKey(scope: string): string {
    return `a2a:tasks:${scope}`;
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const scope = scopeOf(context);
    await this.redis.set(this.taskKey(scope, task.id), JSON.stringify(task), "EX", this.ttlSeconds);
    await this.redis.sadd(this.indexKey(scope), task.id);
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const raw = await this.redis.get(this.taskKey(scopeOf(context), taskId));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Task;
    } catch (error) {
      // A corrupt value must not take down every later read of this scope.
      logger.error({ err: error, taskId }, "discarding unparseable task");
      return undefined;
    }
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const scope = scopeOf(context);
    const ids: string[] = (await this.redis.smembers(this.indexKey(scope))) ?? [];

    const loaded = await Promise.all(ids.map((id) => this.load(id, context)));
    let tasks: Task[] = [];
    const expired: string[] = [];
    ids.forEach((id, i) => {
      const task = loaded[i];
      // A task whose TTL elapsed leaves its id behind in the index. Pruning on
      // read keeps the index from growing without a sweeper process.
      if (task) tasks.push(task);
      else expired.push(id);
    });
    if (expired.length > 0) {
      await this.redis.srem(this.indexKey(scope), ...expired).catch(() => {});
    }

    const { contextId, status, pageToken, statusTimestampAfter } = params;
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;

    if (contextId) tasks = tasks.filter((t) => t.contextId === contextId);
    if (status !== undefined && status !== TaskState.TASK_STATE_UNSPECIFIED) {
      tasks = tasks.filter((t) => t.status?.state === status);
    }
    if (statusTimestampAfter) {
      const after = new Date(statusTimestampAfter).getTime();
      tasks = tasks.filter(
        (t) => t.status?.timestamp && new Date(t.status.timestamp).getTime() > after,
      );
    }

    // Newest first, id as the tie-break — identical to the in-memory store, so
    // a page token minted by one is meaningful to the other.
    tasks.sort((a, b) => {
      const ta = a.status?.timestamp || "";
      const tb = b.status?.timestamp || "";
      return tb !== ta ? tb.localeCompare(ta) : b.id.localeCompare(a.id);
    });

    const totalSize = tasks.length;
    if (pageToken) {
      const decoded = Buffer.from(pageToken, "base64").toString("utf-8");
      const [cursorTimestamp, ...idParts] = decoded.split("|");
      const cursorId = idParts.join("|");
      const at = tasks.findIndex(
        (t) => (t.status?.timestamp || "") === cursorTimestamp && t.id === cursorId,
      );
      if (at !== -1) tasks = tasks.slice(at + 1);
    }

    const page = tasks.slice(0, pageSize);
    const last = page[page.length - 1];
    return {
      tasks: page,
      // Only when more remain: a token on the final page invites a request
      // that returns nothing.
      nextPageToken: tasks.length > pageSize && last ? encodeCursor(last) : "",
      pageSize,
      totalSize,
    };
  }
}

/**
 * Connect to Redis, or return null when none is configured.
 *
 * Never falls back silently on a *failed* connection: running multi-replica
 * against process memory is the exact bug this exists to prevent, and it would
 * only show up as clients losing tasks. No URL means single-instance, which is
 * a legitimate configuration; a bad URL means a broken one.
 */
export async function connectTaskRedis(url: string | undefined): Promise<RedisClient | null> {
  if (!url) return null;
  const client = new RedisClient(url);
  await client.connect();
  return client;
}
