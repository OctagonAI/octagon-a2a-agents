import { beforeEach, describe, expect, test } from "bun:test";
import type { RedisClient } from "bun";
import { TaskState, type Task } from "@a2a-js/sdk";
import type { ServerCallContext } from "@a2a-js/sdk/server";
import { RedisTaskStore } from "./taskStore.js";

/** Only the five commands the store uses. Enough to exercise the logic that
 *  actually holds the bugs: filtering, ordering, paging and index pruning. */
class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  async set(k: string, v: string) { this.strings.set(k, v); }
  async get(k: string) { return this.strings.get(k) ?? null; }
  async sadd(k: string, ...m: string[]) { const s = this.sets.get(k) ?? new Set(); m.forEach((x) => s.add(x)); this.sets.set(k, s); }
  async smembers(k: string) { return [...(this.sets.get(k) ?? [])]; }
  async srem(k: string, ...m: string[]) { const s = this.sets.get(k); m.forEach((x) => s?.delete(x)); }
  /** Simulates a TTL elapsing: the value goes, the index entry lingers. */
  expire(taskId: string) { for (const k of [...this.strings.keys()]) if (k.endsWith(`:${taskId}`)) this.strings.delete(k); }
}

const ctx = {} as ServerCallContext;
const task = (id: string, ts: string, state = TaskState.TASK_STATE_COMPLETED, contextId = "c1"): Task =>
  ({ id, contextId, status: { state, timestamp: ts, message: undefined }, artifacts: [], history: [], metadata: undefined }) as Task;

let redis: FakeRedis;
let store: RedisTaskStore;
beforeEach(() => { redis = new FakeRedis(); store = new RedisTaskStore(redis as unknown as RedisClient); });

describe("redis task store", () => {
  test("a saved task is readable again", async () => {
    // The whole point: this survives the process that created it.
    await store.save(task("t1", "2026-01-01T00:00:00Z"), ctx);
    expect((await store.load("t1", ctx))?.id).toBe("t1");
    expect(await store.load("missing", ctx)).toBeUndefined();
  });

  test("listing is newest first", async () => {
    // Matches InMemoryTaskStore so a client sees the same order either way.
    for (const [id, ts] of [["a","2026-01-01T00:00:00Z"],["b","2026-03-01T00:00:00Z"],["c","2026-02-01T00:00:00Z"]] as const) {
      await store.save(task(id, ts), ctx);
    }
    const { tasks, totalSize } = await store.list({} as never, ctx);
    expect(tasks.map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(totalSize).toBe(3);
  });

  test("filters by contextId and state", async () => {
    await store.save(task("a", "2026-01-01T00:00:00Z", TaskState.TASK_STATE_COMPLETED, "c1"), ctx);
    await store.save(task("b", "2026-01-02T00:00:00Z", TaskState.TASK_STATE_FAILED, "c1"), ctx);
    await store.save(task("c", "2026-01-03T00:00:00Z", TaskState.TASK_STATE_COMPLETED, "c2"), ctx);
    expect((await store.list({ contextId: "c1" } as never, ctx)).tasks.map((t) => t.id)).toEqual(["b", "a"]);
    expect((await store.list({ status: TaskState.TASK_STATE_FAILED } as never, ctx)).tasks.map((t) => t.id)).toEqual(["b"]);
  });

  test("TASK_STATE_UNSPECIFIED is not a filter", async () => {
    // Zero is the enum's unset value; treating it as a real filter would
    // return nothing for a caller who simply omitted status.
    await store.save(task("a", "2026-01-01T00:00:00Z"), ctx);
    expect((await store.list({ status: TaskState.TASK_STATE_UNSPECIFIED } as never, ctx)).tasks).toHaveLength(1);
  });

  test("paging walks every task exactly once", async () => {
    for (let i = 0; i < 5; i++) await store.save(task(`t${i}`, `2026-01-0${i + 1}T00:00:00Z`), ctx);
    const seen: string[] = [];
    let token = "";
    for (let guard = 0; guard < 10; guard++) {
      const page: any = await store.list({ pageSize: 2, pageToken: token } as never, ctx);
      seen.push(...page.tasks.map((t: Task) => t.id));
      if (!page.nextPageToken) break;
      token = page.nextPageToken;
    }
    expect(seen).toEqual(["t4", "t3", "t2", "t1", "t0"]);
    expect(new Set(seen).size).toBe(5);
  });

  test("the last page carries no next token", async () => {
    // A token on the final page invites a request that returns nothing.
    await store.save(task("a", "2026-01-01T00:00:00Z"), ctx);
    expect((await store.list({ pageSize: 10 } as never, ctx)).nextPageToken).toBe("");
  });

  test("an expired task is dropped and its index entry pruned", async () => {
    // Without pruning the index grows forever on a noeviction instance.
    await store.save(task("a", "2026-01-01T00:00:00Z"), ctx);
    await store.save(task("b", "2026-01-02T00:00:00Z"), ctx);
    redis.expire("a");
    const { tasks, totalSize } = await store.list({} as never, ctx);
    expect(tasks.map((t) => t.id)).toEqual(["b"]);
    expect(totalSize).toBe(1);
    expect(await redis.smembers("a2a:tasks:|")).toEqual(["b"]);
  });

  test("a corrupt value does not poison the whole scope", async () => {
    await store.save(task("a", "2026-01-01T00:00:00Z"), ctx);
    redis.strings.set("a2a:task:|:a", "{not json");
    expect(await store.load("a", ctx)).toBeUndefined();
    expect((await store.list({} as never, ctx)).tasks).toHaveLength(0);
  });
});
