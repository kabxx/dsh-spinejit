import assert from "node:assert/strict";
import test from "node:test";
import { createNodeSpineRuntime, validateSpineToolInput as upstreamValidate } from "@spinejit/spine-sdk/node";
import { checkpointBuild, createCheckpointNodeRuntime, validateSpineToolInput } from "../dist/checkpoint-runtime.js";

const options = { thread: "checkpoint-wrapper-test", features: ["jit", "spawn"] };
const observe = (boundary, role, content) => ({
  type: "observe_sources",
  characters: [{ type: "message", role, boundary, content }],
});

async function finish(runtime) {
  const prepared = await runtime.client.execute({ type: "prepare_finish", terminal: "completed", input_tokens: 140 });
  return runtime.client.execute({ type: "install_prepared", transaction_id: prepared.transaction_id });
}

test("checkpoint wrapper preserves upstream tooling and resumes the untouched active sampling in a shadow runtime", async () => {
  const patched = createCheckpointNodeRuntime(options);
  const stock = createNodeSpineRuntime(options);
  const clone = createCheckpointNodeRuntime(options);
  const different = createCheckpointNodeRuntime({ ...options, thread: "other-thread" });
  try {
    assert.match(checkpointBuild(), /^[0-9a-f]{64}$/);
    assert.equal(patched.nodePrompt(), stock.nodePrompt());
    assert.equal(patched.extendSystemPrompt("first"), stock.extendSystemPrompt("first"));
    assert.deepEqual(patched.toolCatalog(), stock.toolCatalog());
    for (const [role, args] of [["open", { summary: "inspect behavior" }], ["close", { memory: "result" }],
      ["next", { memory: "result", goal: "next" }],
      ["spawn", { tasks: [{ summary: "first", prompt: "one" }, { summary: "second", prompt: "two" }] }]]) {
      assert.deepEqual(validateSpineToolInput(role, args), upstreamValidate(role, args));
    }
    for (const runtime of [patched, stock]) {
      await runtime.client.execute(observe(1, "user", "Inspect the test"));
    }
    const before = await patched.exportCheckpoint();
    await assert.rejects(patched.exportPreSamplingCheckpoint(), (error) => error.code === "invalid_state");
    await assert.rejects(different.importCheckpoint(before), (error) => error.code === "invalid_input");
    const started = await patched.client.execute({ type: "begin_sampling" });
    assert.deepEqual(started, await stock.client.execute({ type: "begin_sampling" }));
    assert.equal(await patched.exportPreSamplingCheckpoint(), before);
    await assert.rejects(patched.exportCheckpoint(), (error) => error.code === "invalid_state");
    await clone.importCheckpoint(await patched.exportPreSamplingCheckpoint());
    assert.deepEqual(started, await clone.client.execute({ type: "begin_sampling" }));
    for (const runtime of [patched, stock, clone]) {
      await runtime.client.execute({ type: "register_execution", key: "open-1" });
      await runtime.client.execute({ type: "stage_execution", key: "open-1", execution_ref: "open-1", operation: { type: "open", summary: "inspect behavior" } });
      await runtime.client.execute({ type: "finish_execution", key: "open-1", succeeded: true });
      await runtime.client.execute(observe(2, "assistant", "I will inspect it"));
    }
    await assert.rejects(patched.exportPreSamplingCheckpoint(), (error) => error.code === "invalid_state");
    const outputs = await Promise.all([finish(patched), finish(stock), finish(clone)]);
    assert.deepEqual(outputs[0], outputs[1]);
    assert.deepEqual(outputs[0], outputs[2]);
    assert.equal(await patched.exportCheckpoint(), await clone.exportCheckpoint());
    for (const runtime of [patched, clone]) await runtime.client.execute({ type: "begin_sampling" });
    await patched.client.execute(observe(3, "assistant", "source-only change"));
    await assert.rejects(patched.exportPreSamplingCheckpoint(), (error) => error.code === "invalid_state");
  } finally {
    for (const runtime of [patched, stock, clone, different]) runtime.dispose();
  }
});
