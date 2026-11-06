/**
 * Transactions over the editor store. The model commands only ever read `getSource()` and write
 * `commit()`, so they run unchanged against a scratch {@link Store} seeded with the live source;
 * whatever they produce lands on the live store as one commit - one undo step, all or nothing.
 */

import type { SourceState } from "../model/editorState";
import type { ChangeKind } from "../model/history";
import { SignalBus } from "../model/signals";
import { Store } from "../model/store";
import { AgentError } from "./errors";

/**
 * How agent edits reach a document: the source edits read, and the way a body of command calls is
 * applied. Top-level calls apply each body as its own transaction; inside `edit()` every body
 * shares the one open scratch store.
 */
export interface EditSession {
  source(): SourceState;
  mutate<T>(body: (store: Store) => T): T;
}

/** A scratch store: commits change only its own state, remembering whether any was structural. */
class StagingStore extends Store {
  private structural = false;

  constructor(source: SourceState) {
    super({ source, derived: {} }, new SignalBus());
  }

  /** The kind the whole transaction commits with: structural if any step was. */
  public get changeKind(): ChangeKind {
    return this.structural ? "structural" : "view";
  }

  public override commit(next: SourceState, kind: ChangeKind): void {
    super.commit(next, kind);
    if (kind === "structural") {
      this.structural = true;
    }
  }
}

/** Live stores with a body running against a scratch copy right now. */
const openTransactions = new WeakSet<Store>();

/**
 * Runs `body` against a scratch copy of `store`'s source and hands its outcome to `apply` when
 * anything changed. A throwing body applies nothing. The body must be synchronous: an `await`
 * inside it would let the live document move on underneath the scratch copy. A body never
 * overwrites a document that moved while it ran (a top-level edit, an undo, a project load from
 * inside it) - the outcome is refused instead, since applying it would silently drop that change.
 */
function stage<T>(
  store: Store,
  body: (staging: Store) => T,
  apply: (next: SourceState, kind: ChangeKind) => void,
): T {
  if (openTransactions.has(store)) {
    throw new AgentError(
      "invalid_argument",
      "An edit() body is running; edit through its transaction argument, not window.sparcoon.",
    );
  }
  const base = store.getSource();
  const staging = new StagingStore(base);
  openTransactions.add(store);
  let result: T;
  try {
    result = body(staging);
  } finally {
    openTransactions.delete(store);
  }
  if (result instanceof Promise) {
    throw new AgentError("invalid_argument", "An edit body must be synchronous (no async/await).");
  }
  if (store.getSource() !== base) {
    throw new AgentError(
      "rejected",
      "The document changed while the edit body ran (undo, load...); the body was not applied.",
    );
  }
  const next = staging.getSource();
  if (next !== base) {
    apply(next, staging.changeKind);
  }
  return result;
}

/** Runs `body` as one transaction: a single undo step, nothing applied if it throws. */
export function runTransaction<T>(store: Store, body: (staging: Store) => T): T {
  return stage(store, body, (next, kind) => store.commit(next, kind));
}

/**
 * Runs `body` like {@link runTransaction} but applies the result without an undo step - for
 * bookkeeping the agent does on its own behalf (focusing an owner to read its status), which must
 * not stand between the agent's `undo()` and its last real edit.
 */
export function runUnrecorded<T>(store: Store, body: (staging: Store) => T): T {
  return stage(store, body, (next, kind) => store.commitLive(next, kind));
}

/** The session top-level API calls use: every mutation is its own transaction on `store`. */
export function liveSession(store: Store): EditSession {
  return {
    source: () => store.getSource(),
    mutate: (body) => runTransaction(store, body),
  };
}

/** The session inside one open transaction: every mutation writes the same scratch store. */
export function stagedSession(staging: Store): EditSession {
  return {
    source: () => staging.getSource(),
    mutate: (body) => body(staging),
  };
}
