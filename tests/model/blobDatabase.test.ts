import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as blobDatabase from "../../src/persistence/blobDatabase.Internal";

/**
 * A minimal stand-in for `indexedDB`: `open` hands back a request the test answers by hand
 * (`succeed`, `block`) or never; every transaction completes on the next microtask.
 */
interface FakeOpen {
  readonly request: {
    result: FakeDatabase;
    onsuccess?: () => void;
    onerror?: () => void;
    onblocked?: () => void;
    onupgradeneeded?: () => void;
  };
  succeed(): void;
  block(): void;
}

interface FakeDatabase {
  closed: boolean;
  onversionchange?: () => void;
  onclose?: () => void;
  objectStoreNames: { contains: () => boolean };
  close(): void;
  transaction(): unknown;
}

function fakeDatabase(): FakeDatabase {
  const database: FakeDatabase = {
    closed: false,
    objectStoreNames: { contains: () => true },
    close: () => {
      database.closed = true;
    },
    transaction: () => {
      if (database.closed) {
        throw new Error("InvalidStateError");
      }
      const transaction: { oncomplete?: () => void; objectStore: () => unknown } = {
        objectStore: () => ({
          get: () => {
            const request: { result: unknown; onsuccess?: () => void } = { result: "payload" };
            queueMicrotask(() => {
              request.onsuccess?.();
              transaction.oncomplete?.();
            });
            return request;
          },
        }),
      };
      return transaction;
    },
  };
  return database;
}

let opens: FakeOpen[] = [];

beforeEach(() => {
  opens = [];
  vi.resetModules();
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request: FakeOpen["request"] = { result: fakeDatabase() };
      opens.push({
        request,
        succeed: () => request.onsuccess?.(),
        block: () => request.onblocked?.(),
      });
      return request;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function load(): Promise<typeof blobDatabase> {
  return import("../../src/persistence/blobDatabase.Internal");
}

function get(
  module: Awaited<ReturnType<typeof load>>,
): ReturnType<typeof module.runBlobRequest<unknown>> {
  return module.runBlobRequest<unknown>(module.TEXTURE_BLOB_STORE, "readonly", (store) =>
    (store as unknown as { get: () => IDBRequest<unknown> }).get(),
  );
}

describe("the editor's IndexedDB connection", () => {
  it("opens once and serves every request of the session from it", async () => {
    const module = await load();
    const first = get(module);
    opens[0]?.succeed();
    expect(await first).toEqual({ ok: true, result: "payload" });
    expect(await get(module)).toEqual({ ok: true, result: "payload" });
    expect(opens).toHaveLength(1);
  });

  it("gives up on an open that never answers, and tries again on the next request", async () => {
    vi.useFakeTimers();
    const module = await load();
    const stuck = get(module);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await stuck).toEqual({ ok: false, result: undefined });

    const retry = get(module);
    expect(opens).toHaveLength(2);
    opens[1]?.succeed();
    expect(await retry).toEqual({ ok: true, result: "payload" });
    // The abandoned open answering late is closed: nobody holds it.
    opens[0]?.succeed();
    expect(opens[0]?.request.result.closed).toBe(true);
  });

  it("closes a connection that opens after being blocked", async () => {
    const module = await load();
    const blocked = get(module);
    opens[0]?.block();
    expect(await blocked).toEqual({ ok: false, result: undefined });
    opens[0]?.succeed();
    expect(opens[0]?.request.result.closed).toBe(true);
  });

  it("lets a newer page upgrade, then reopens", async () => {
    const module = await load();
    const first = get(module);
    opens[0]?.succeed();
    await first;
    opens[0]?.request.result.onversionchange?.();
    expect(opens[0]?.request.result.closed).toBe(true);
    await Promise.resolve();
    const next = get(module);
    expect(opens).toHaveLength(2);
    opens[1]?.succeed();
    expect(await next).toEqual({ ok: true, result: "payload" });
  });
});
