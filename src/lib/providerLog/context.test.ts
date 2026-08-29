import { test } from "node:test";
import assert from "node:assert/strict";
import { currentCallContext, enterCallContext, withCallContext } from "./context";

const EMPTY = { userId: null, feature: null, captureBodies: false };

test("with no context established, the caller is unknown rather than guessed", () => {
  // A row naming the wrong user is worse than one naming nobody: the first is believed.
  assert.deepEqual(currentCallContext(), EMPTY);
});

test("the context survives an await, because every provider call is asynchronous", async () => {
  await withCallContext({ ...EMPTY, userId: "u1" }, async () => {
    await new Promise(r => setTimeout(r, 5));
    assert.equal(currentCallContext().userId, "u1");
  });
});

test("ENTERWITH: two concurrent tasks that each enter their own context never cross", async () => {
  // This is the risk the design accepts. enterWith sets the store for the current execution
  // instead of wrapping a callback — which is what lets one hook cover 122 routes, and is the
  // part that can bleed if the runtime reuses an execution. Each task here enters its context
  // the way workspaceUserId does: partway through, after an await, with no wrapper around it.
  const failures: string[] = [];
  const task = (id: string, delay: number) => (async () => {
    await new Promise(r => setTimeout(r, delay));       // mirrors getWorkspace()'s await
    enterCallContext({ ...EMPTY, userId: id });
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, delay));
      const seen = currentCallContext().userId;
      if (seen !== id) failures.push(`${id} saw ${seen}`);
    }
  })();
  await Promise.all([task("a", 1), task("b", 3), task("c", 2), task("d", 1)]);
  assert.deepEqual(failures, []);
});

test("entering a context does not retroactively claim work that started before it", async () => {
  let observed: string | null = "not-run";
  const sibling = (async () => {
    await new Promise(r => setTimeout(r, 5));
    observed = currentCallContext().userId;
  })();
  await (async () => {
    enterCallContext({ ...EMPTY, userId: "u9" });
    await new Promise(r => setTimeout(r, 10));
  })();
  await sibling;
  assert.equal(observed, null);
});
