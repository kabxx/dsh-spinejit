import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createDeveloperMessage,
  createSystemMessage,
  createUserMessage,
  EMPTY_RESPONSE_CODE,
  LlmError,
  projectToolUpdates,
} from "@deepseek-ai/dsh-llm";
import { canonicalHeader } from "@deepseek-ai/dsh-session";
import TokenMeter from "@deepseek-ai/dsh-token-meter";

import { compactStatsDefinition } from "../dist/compact-stats.js";
import { pruneOversizedToolResults } from "../dist/compact-summarizer.js";
import { arrivalMessage } from "../dist/events.js";
import { WITHOUT_REASONING } from "../dist/reasoning.js";
import { mountDsh } from "./harness.mjs";

const commandModule = new URL("../dist/compact.js", import.meta.url).href;

async function mountAutoCompact(replies, {
  root,
  compactConfig,
  withTokenMeter = false,
  modelWindows = { scripted: { contextWindow: 32_768, defaultMaxTokens: 2048 } },
} = {}) {
  const dsh = await mountDsh(replies, { root });
  if (withTokenMeter) {
    await dsh.ctx.plugin(TokenMeter).await();
  }
  let command;
  dsh.ctx.reflect.provide("commands", {
    register(definition) {
      command = definition;
      return () => { command = undefined; };
    },
  });
  await dsh.ctx.loader.root.update([
    { id: "spinejit", name: new URL("../dist/index.js", import.meta.url).href },
    { id: "spine-compact", name: commandModule, ...(compactConfig === undefined ? {} : { config: compactConfig }) },
  ]);
  await dsh.ctx.loader.await();
  const baseResolve = dsh.adapter.resolveModel.bind(dsh.adapter);
  dsh.adapter.resolveModel = async (provider, model, signal) => {
    const base = await baseResolve(provider, model, signal);
    const override = modelWindows[model];
    if (override === undefined) return base;
    return {
      ...base,
      context: { contextWindow: override.contextWindow },
      ...(override.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: override.defaultMaxTokens }),
      ...(override.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: override.systemPromptUpdate }),
      ...(override.toolUpdate === undefined ? {} : { toolUpdate: override.toolUpdate }),
    };
  };
  return {
    ...dsh,
    compact: (agent, rawInput = "", signal = new AbortController().signal) =>
      command.handler({ agent, rawInput, signal }),
  };
}

function checkpoints(agent) {
  return agent.session.snapshotEvents().filter(
    event => event.type === "user/message" && event.data.source.kind === "spine-compact",
  );
}

function text(messages) {
  return messages.flatMap(message =>
    message.content.filter(block => block.type === "text").map(block => block.text),
  ).join("\n");
}

function registerEchoTool(dsh, name = "echo") {
  dsh.ctx.tools.register({
    name,
    description: "Return supplied payload text.",
    parameters: { type: "object", properties: { payload: { type: "string" } }, required: ["payload"] },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    execute: async ({ payload }) => ({ text: payload }),
  });
}

test("cache-warm compaction reuses exact system, tools, toolHistory, sessionId, and message prefix", async () => {
  const dsh = await mountAutoCompact([
    "first-reply-body",
    request => {
      assert.equal(request.purpose, "compaction");
      const prev = dsh.adapter.requests[0];
      assert.equal(request.sessionId, prev.sessionId);
      assert.deepEqual(request.tools, prev.tools);
      assert.ok(request.toolHistory !== undefined);
      // Every message from the prior request plus the assistant reply stays verbatim at the prefix.
      assert.equal(request.messages[0].role, "system");
      assert.deepEqual(request.messages[0], prev.messages[0]);
      assert.ok(request.messages.some(m => m.role === "assistant" && text([m]).includes("first-reply-body")));
      const last = request.messages.at(-1);
      assert.equal(last.role, "user");
      assert.match(text([last]), /DO NOT call any tools/);
      return { text: "warm checkpoint summary", usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 20 } };
    },
  ]);
  try {
    const agent = await dsh.run("hello warm cache");
    const result = await dsh.compact(agent);
    assert.equal(result.kind, "success", result.text);
    assert.equal(dsh.adapter.requests.length, 2);
    assert.equal(checkpoints(agent).length, 1);
  } finally {
    await dsh.dispose();
  }
});

test("warm compaction fails directly on empty text or tool calls without clean fallback", async () => {
  // Part A: whitespace-only summary fails directly (no clean tool-free retry).
  const dshEmpty = await mountAutoCompact([
    "reply-before-empty-warm",
    request => {
      assert.equal(request.purpose, "compaction");
      assert.ok(Array.isArray(request.tools) && request.tools.length > 0);
      return { text: "   ", usage: { inputTokens: 50, cacheReadTokens: 400, outputTokens: 2 } };
    },
  ]);
  try {
    const agent = await dshEmpty.run("trigger empty warm error");
    const before = agent.session.deriveMessages();
    const result = await dshEmpty.compact(agent);
    assert.equal(result.kind, "error");
    assert.match(result.text, /empty summary/i);
    assert.equal(checkpoints(agent).length, 0);
    assert.equal(dshEmpty.adapter.requests.length, 2, "must NOT retry with a clean fallback request");
    assert.deepEqual(agent.session.deriveMessages(), before);
  } finally {
    await dshEmpty.dispose();
  }

  // Part B: warm attempt returning tool-calls fails directly (no clean tool-free retry).
  const dshTool = await mountAutoCompact([
    "reply-before-tool-warm",
    request => {
      assert.equal(request.purpose, "compaction");
      assert.ok(Array.isArray(request.tools) && request.tools.length > 0);
      return [["echo", { payload: "accidental call" }]];
    },
  ]);
  registerEchoTool(dshTool);
  try {
    const agent = await dshTool.run("trigger tool-call warm error");
    const before = agent.session.deriveMessages();
    const result = await dshTool.compact(agent);
    assert.equal(result.kind, "error");
    assert.match(result.text, /attempted to call a tool/i);
    assert.equal(checkpoints(agent).length, 0);
    assert.equal(dshTool.adapter.requests.length, 2, "must NOT retry with a clean fallback request");
    assert.deepEqual(agent.session.deriveMessages(), before);
  } finally {
    await dshTool.dispose();
  }
});

test("oversized non-Spine tool results are pruned in memory for a single summary without mutating session.surface", async () => {
  const hugeToolOutput = `HEAD_FRAME_OK ${"verbose-stdout-line ".repeat(1_200)} TAIL_FRAME_OK`;
  assert.ok(hugeToolOutput.length > 20_000);
  const compactRequests = [];
  const dsh = await mountAutoCompact([
    [["spine_open", { goal: "branch with summary" }]],
    [["spine_close", { memory: "CRITICAL_SPINE_MEMORY_MUST_STAY_INTACT" }]],
    [["read_huge_log", { path: "/var/log/app.log" }]],
    "inspected huge output",
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.tools, undefined, "oversized compaction skips warm path and runs single pruned clean summary");
      compactRequests.push(request);
      const body = text(request.messages);
      assert.match(body, /CRITICAL_SPINE_MEMORY_MUST_STAY_INTACT/, "Spine memory must never be pruned");
      assert.match(body, /HEAD_FRAME_OK/, "head 4096 chars of oversized tool result preserved");
      assert.match(body, /TAIL_FRAME_OK/, "tail 1024 chars of oversized tool result preserved");
      assert.match(body, /\[\.\.\. tool result middle pruned \.\.\.\]/, "middle replaced with DSH prune marker");
      return "single pruned checkpoint";
    },
    "continued-after-pruned-compact",
  ], {
    compactConfig: { auto: false },
    // safeInputBudget = floor((6000 - 512) * 0.85) = 4,664 tokens.
    // Raw hugeToolOutput (~6,000+ tokens) exceeds warm safeInputBudget;
    // in-memory pruning (4096 + 1024 = 5120 chars ~1,300 tokens) fits cleanly in 1 request!
    modelWindows: { scripted: { contextWindow: 6_000, defaultMaxTokens: 512 } },
  });
  dsh.ctx.tools.register({
    name: "read_huge_log",
    description: "Read a huge log file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    execute: async () => ({ text: hugeToolOutput }),
  });

  let root;
  try {
    const agent = await dsh.run("inspect giant output");
    // Before compaction, the unpruned tool result is still untouched on session.surface.
    const toolBefore = agent.session.deriveMessages().find(m => m.role === "tool");
    assert.ok(toolBefore !== undefined && text([toolBefore]).length > 20_000);
    const result = await dsh.compact(agent);
    assert.equal(result.kind, "success", result.text);
    assert.equal(compactRequests.length, 1, "must summarize in a single request without chunking");
    assert.match(text(agent.session.deriveMessages()), /single pruned checkpoint/);
    root = await dsh.crashed();
  } finally {
    await dsh.dispose();
  }

  const resumed = await mountAutoCompact(["resumed-ok"], { root, compactConfig: { auto: false } });
  try {
    const agent = await resumed.resume("session-1");
    await resumed.send(agent, "continue after pruned restart");
    assert.equal(resumed.adapter.requests.length, 1);
    assert.match(text(resumed.adapter.requests[0].messages), /single pruned checkpoint/);
    assert.doesNotMatch(text(resumed.adapter.requests[0].messages), /verbose-stdout-line/);
  } finally {
    await resumed.dispose();
  }
});

test("dedicated summarization model bypasses warm prefix cache and records its own route", async () => {
  const dsh = await mountAutoCompact([
    "conversation-answer",
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.provider, "scripted");
      assert.equal(request.model, "summarizer-fast");
      assert.equal(request.tools, undefined);
      assert.match(text(request.messages), /conversation-answer/);
      return { text: "dedicated model summary", usage: { inputTokens: 200, outputTokens: 12 } };
    },
  ], {
    compactConfig: {
      auto: false,
      summarizationProvider: "scripted",
      summarizationModel: "summarizer-fast",
    },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 2048 },
      "summarizer-fast": { contextWindow: 16_384, defaultMaxTokens: 1024 },
    },
  });
  try {
    const agent = await dsh.run("main conversation");
    const result = await dsh.compact(agent);
    assert.equal(result.kind, "success", result.text);
    const [marker] = checkpoints(agent);
    assert.equal(marker.data.source.calls[0].model, "summarizer-fast");
  } finally {
    await dsh.dispose();
  }
});

test("agent/pre-step auto-compacts under pressure, retains unfinished turn tail, drops non-Gemini reasoning, and survives restart + second compact", async () => {
  // Turn 1 alone stays below 50% of 10,000 (~5,000 tokens); Turn 2's tool output pushes total over 5,000.
  const turn1Body = "historical-fact ".repeat(500);
  const turn2ToolBody = "turn2-tool-output ".repeat(300);
  const dsh = await mountAutoCompact([
    // Turn 1: stays under threshold.
    `turn1-reply ${turn1Body}`,
    // Turn 2 Step 1: calls echo tool with reasoning block; output pushes total over threshold.
    { reasoning: "secret old-prefix reasoning", calls: [["echo", { payload: turn2ToolBody }]] },
    // Automatic pre-step pressure compaction fires before Turn 2 Step 2!
    request => {
      assert.equal(request.purpose, "compaction");
      const content = text(request.messages);
      assert.match(content, /historical-fact/, "Turn 1 history is summarized");
      assert.doesNotMatch(content, /turn2-tool-output/, "Current unfinished turn tail is retained, not summarized");
      return { text: "auto pressure checkpoint", usage: { inputTokens: 500, cacheReadTokens: 3000, outputTokens: 30 } };
    },
    // Turn 2 Step 2: model sees checkpoint + retained Turn 2 tail (without old reasoning!).
    request => {
      assert.notEqual(request.purpose, "compaction");
      const content = text(request.messages);
      assert.match(content, /auto pressure checkpoint/);
      assert.doesNotMatch(content, /historical-fact/);
      assert.match(content, /turn2-task-prompt/);
      assert.match(content, /turn2-tool-output/);
      // Retained assistant message had its non-Gemini reasoning dropped after prefix replacement.
      const assistants = request.messages.filter(m => m.role === "assistant");
      assert.equal(assistants.length, 1);
      assert.equal(assistants[0].content.some(b => b.type === "reasoning"), false);
      return "turn2-final-answer";
    },
    // Second compaction (manual) verifies boundaryOffset > 0 stays strictly monotonic.
    request => {
      assert.equal(request.purpose, "compaction");
      assert.match(text(request.messages), /turn2-final-answer/);
      return "second-checkpoint-after-offset";
    },
  ], {
    withTokenMeter: true,
    compactConfig: {
      auto: true,
      thresholdRatio: 0.5,
      retainTokens: 3_000,
    },
    modelWindows: { scripted: { contextWindow: 10_000, defaultMaxTokens: 512 } },
  });
  registerEchoTool(dsh);

  let root;
  try {
    const agent = await dsh.run("turn1-prompt");
    await dsh.send(agent, "turn2-task-prompt");

    const markers = checkpoints(agent);
    assert.equal(markers.length, 1, "exactly one automatic pressure compaction ran during Turn 2");
    const [autoMarker] = markers;
    assert.equal(autoMarker.data.source.trigger, "pressure");
    assert.equal(autoMarker.data.source.turn, 2);
    assert.ok(autoMarker.data.source.retainedSeqs.length >= 3, "retained Turn 2 user + assistant + tool result");
    assert.ok(autoMarker.data.source.shadowedTokens > 0);

    // Statistics attaches an open-turn auto-compaction directly to its turn without stats-turn-end.
    const statsState = compactStatsDefinition.start(
      {},
      { event: autoMarker, location: { kind: "session" } },
      { previous() { assert.fail("open-turn auto compaction should not need stats-turn-end"); } },
    );
    const statsNode = compactStatsDefinition.buildViewNode({
      key: `spine-compact:${autoMarker.seq}`,
      kind: compactStatsDefinition.kind,
      id: `spine-compact:${autoMarker.seq}`,
      start: { event: autoMarker, location: { kind: "session" } },
      state: statsState,
    });
    assert.equal(statsNode.data.metrics.turn, 2);
    assert.equal(statsNode.data.metrics.shadowedTokens, autoMarker.data.source.shadowedTokens);

    // A subsequent compaction after boundaryOffset > 0 succeeds cleanly.
    const second = await dsh.compact(agent);
    assert.equal(second.kind, "success", second.text);
    assert.equal(checkpoints(agent).length, 2);
    root = await dsh.crashed();
  } finally {
    await dsh.dispose();
  }

  // Resume from persisted JSONL log after retained-tail compaction + second compaction and run Spine operations!
  const resumed = await mountAutoCompact([
    [["spine_open", { goal: "post-restart work" }]],
    [["spine_close", { memory: "post-restart done" }]],
    "post-restart-reply",
  ], {
    root,
    withTokenMeter: true,
    compactConfig: { auto: true },
    modelWindows: { scripted: { contextWindow: 32_768, defaultMaxTokens: 2048 } },
  });
  try {
    const agent = await resumed.resume("session-1");
    await resumed.send(agent, "verify Spine tree works after retained compact + restart");
    assert.match(text(resumed.adapter.requests[0].messages), /second-checkpoint-after-offset/);
    assert.equal(resumed.adapter.requests.length, 3);
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === "turn/end").at(-1).data.reason.kind, "completed");
  } finally {
    await resumed.dispose();
  }
});

test("spine_close fold reduction prevents false automatic pressure compaction at the next pre-step", async () => {
  const hugeToolOutput = "folded-detail ".repeat(1100);
  const dsh = await mountAutoCompact([
    [["spine_open", { goal: "heavy inspection" }]],
    [["echo", { payload: hugeToolOutput }]],
    // Close folds the huge tool output into a tiny memory!
    [["spine_close", { memory: "tiny folded conclusion" }]],
    // Next step MUST NOT auto-compact because pending fold brings context well below threshold.
    request => {
      assert.notEqual(request.purpose, "compaction");
      const content = text(request.messages);
      assert.match(content, /tiny folded conclusion/);
      assert.doesNotMatch(content, /folded-detail/);
      return "done-without-compacting";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.6 },
    modelWindows: { scripted: { contextWindow: 8_192, defaultMaxTokens: 512 } },
  });
  registerEchoTool(dsh);

  try {
    const agent = await dsh.run("inspect and fold");
    assert.equal(checkpoints(agent).length, 0, "no compaction should fire after spine_close folds away pressure");
    assert.equal(dsh.adapter.requests.length, 4);
  } finally {
    await dsh.dispose();
  }
});

test("automatic compaction defers while parallel Spawn branches are running and runs after they arrive", async () => {
  // Keep Turn 1 under threshold so Turn 2 spawns children first, then push pressure above threshold
  // while children are still unarrived.
  const mediumBody = "parent-context ".repeat(350);
  const heavyToolOutput = "spawn-pressure ".repeat(650);
  let sawCompactionBeforeAllArrived = false;
  let arrivalsAtCompaction = -1;
  let agentRef;
  const scriptedParent = [
    `setup ${mediumBody}`,
    [["spine_spawn", { tasks: [
      { summary: "branch-a", prompt: "Shared blackboard: /tmp/bb\nDo A" },
      { summary: "branch-b", prompt: "Shared blackboard: /tmp/bb\nDo B" },
    ] }]],
    // While spawns are open, do a heavy tool call to push pressure over threshold.
    [["echo", { payload: heavyToolOutput }]],
    "waiting-for-spawns",
    "received-first-arrival",
    "received-second-arrival",
    "continued-after-post-spawn-compact",
  ];
  const dsh = await mountAutoCompact({}, {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.5 },
    modelWindows: { scripted: { contextWindow: 10_000, defaultMaxTokens: 512 } },
  });
  registerEchoTool(dsh);

  const releaseChildren = Promise.withResolvers();
  let childrenStarted = 0;
  const bothStarted = Promise.withResolvers();
  dsh.adapter.stream = async function* (request) {
    dsh.adapter.requests.push(request);
    if (request.sessionId !== "session-1") {
      childrenStarted += 1;
      if (childrenStarted === 2) bothStarted.resolve();
      await releaseChildren.promise;
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: `child-done-${request.sessionId}` } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (request.purpose === "compaction") {
      const arrived = agentRef.session.snapshotEvents().filter(
        e => e.type === "user/message" && e.data.source.kind === "spine-arrival",
      ).length;
      arrivalsAtCompaction = arrived;
      if (arrived < 2) sawCompactionBeforeAllArrived = true;
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "post-spawn checkpoint" } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    const next = scriptedParent.shift() ?? "fallback-reply";
    const blocks = typeof next === "string"
      ? [{ type: "text", text: next }]
      : next.map(([name, input], index) => ({
        type: "tool-call",
        id: `call-${dsh.adapter.requests.length}-${index}`,
        name,
        arguments: JSON.stringify(input),
      }));
    for (const [index, block] of blocks.entries()) {
      yield { type: "block-start", index, blockType: block.type };
      yield { type: "block-end", index, block };
    }
    yield { type: "finish", reason: { kind: typeof next === "string" ? "stop" : "tool-calls" } };
  };

  try {
    const agent = await dsh.run("build base context");
    agentRef = agent;
    // Spawn children while holding them open until parent hits high pressure and goes idle waiting.
    const turn2 = dsh.send(agent, "spawn two workers");
    await bothStarted.promise;
    await turn2;
    assert.equal(sawCompactionBeforeAllArrived, false);
    assert.equal(checkpoints(agent).length, 0, "compaction deferred while spawns were open");

    // Now release both children and wait for both arrivals to complete.
    releaseChildren.resolve();
    while (true) {
      await agent.whenIdle();
      const idleSeq = agent.session.seq;
      if (!await (dsh.ctx.subagents.waitForTreeWork?.(agent) ?? dsh.ctx.subagents.waitForChildren(agent)) && agent.status === "idle" && agent.session.seq === idleSeq) break;
    }
    const arrivals = agent.session.snapshotEvents().filter(
      e => e.type === "user/message" && e.data.source.kind === "spine-arrival",
    );
    assert.equal(arrivals.length, 2);

    // Next user turn after all children arrived triggers automatic pressure compaction cleanly.
    await dsh.send(agent, "synthesize everything");
    assert.equal(sawCompactionBeforeAllArrived, false);
    assert.equal(arrivalsAtCompaction, 2, "compaction ran only after both Spawn children had arrived");
    assert.equal(checkpoints(agent).length, 1);
  } finally {
    releaseChildren.resolve();
    await dsh.dispose();
  }
});

test("model switch to a smaller window auto-compacts with the previous model and blocks on failure", async () => {
  const bigHistory = "big-model-knowledge ".repeat(900);
  let targetModel = "scripted";
  const dsh = await mountAutoCompact([
    // Turn 1 on initial 100K model ("scripted") builds up history exceeding small model's 4K window.
    `big-answer ${bigHistory}`,
    // Turn 2 switches to "small" -> auto-compaction runs on previous "scripted" model!
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.model, "scripted", "model-switch compaction must summarize with previous model");
      assert.match(text(request.messages), /big-model-knowledge/);
      return "compact-for-small-model";
    },
    // Now the actual Turn 2 request goes to "small" with the compacted checkpoint.
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.equal(request.model, "small");
      assert.match(text(request.messages), /compact-for-small-model/);
      assert.doesNotMatch(text(request.messages), /big-model-knowledge/);
      return "small-model-reply";
    },
    // Turn 3 switches to "big" (100K) and fills history again, then switches to "tiny" whose compaction fails.
    `more-big-history ${bigHistory}`,
    () => { throw new Error("summarizer unavailable"); },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.75 },
    modelWindows: {
      scripted: { contextWindow: 100_000, defaultMaxTokens: 2048 },
      big: { contextWindow: 100_000, defaultMaxTokens: 2048 },
      small: { contextWindow: 4_096, defaultMaxTokens: 512 },
      tiny: { contextWindow: 4_096, defaultMaxTokens: 512 },
    },
  });

  // DSH 0.2.1 routes model selection through agent/request; DSH 0.2.2+ uses agent.model.select().
  dsh.ctx.on("agent/request", async (payload, next) => {
    const config = await next();
    if (typeof payload.agent?.model?.select === "function") return config;
    return { ...config, model: targetModel };
  });

  const switchModel = (agent, model) => {
    targetModel = model;
    if (typeof agent.model?.select === "function") {
      agent.model.select({ provider: "scripted", model });
    }
  };

  try {
    const agent = await dsh.run("start on initial 100K model");
    assert.equal(agent.session.requestHeader().config.model, "scripted");

    switchModel(agent, "small");
    await dsh.send(agent, "continue on small model");
    assert.equal(checkpoints(agent).length, 1);
    assert.equal(checkpoints(agent)[0].data.source.trigger, "model-switch");
    assert.equal(agent.session.requestHeader().config.model, "small");

    // Switch to big (100K), build history again, then fail compaction when switching to tiny (4K).
    switchModel(agent, "big");
    await dsh.send(agent, "back to big");
    assert.equal(agent.session.requestHeader().config.model, "big");
    switchModel(agent, "tiny");
    await dsh.send(agent, "try tiny with failing compaction");
    const lastTurnEnd = agent.session.snapshotEvents().filter(e => e.type === "turn/end").at(-1);
    assert.equal(lastTurnEnd.data.reason.kind, "error");
    assert.match(String(lastTurnEnd.data.reason.error?.code ?? ""), /MODEL_SWITCH_COMPACTION_FAILED/);
    assert.equal(agent.session.requestHeader().config.model, "big", "previous model preserved on switch failure");
  } finally {
    await dsh.dispose();
  }
});

test("agent/request-error recovers context overflow automatically and enforces maxOverflowRetries", async () => {
  const overflow = () => { throw new LlmError("Context window exceeded", "CONTEXT_WINDOW_EXCEEDED"); };
  const dsh = await mountAutoCompact([
    // Turn 1 succeeds.
    "turn1-ok",
    // Turn 2 hits provider CONTEXT_WINDOW_EXCEEDED -> triggers overflow recovery compaction + retry!
    overflow,
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.tools, undefined, "overflow recovery skips warm path and uses clean summarizer");
      assert.match(text(request.messages), /turn1-ok/);
      assert.match(text(request.messages), /turn2-huge-user-msg/);
      return "overflow recovery checkpoint";
    },
    // Automatic retry succeeds with the checkpoint!
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.match(text(request.messages), /overflow recovery checkpoint/);
      assert.doesNotMatch(text(request.messages), /turn1-ok/);
      return "recovered-turn2-answer";
    },
    // Turn 3 hits persistent overflow: retries once (maxOverflowRetries=1), then surfaces the error.
    overflow,
    "second overflow checkpoint",
    overflow,
  ], {
    compactConfig: { auto: true, maxOverflowRetries: 1 },
  });

  try {
    const agent = await dsh.run("turn1-msg");
    await dsh.send(agent, "turn2-huge-user-msg");
    const turns = agent.session.snapshotEvents().filter(e => e.type === "turn/end");
    assert.equal(turns.at(-1).data.reason.kind, "completed");
    assert.equal(checkpoints(agent).length, 1);
    assert.equal(checkpoints(agent)[0].data.source.trigger, "context-overflow");

    // Turn 3 overflows twice -> stops after maxOverflowRetries=1 instead of looping forever.
    await dsh.send(agent, "turn3-persistent-overflow");
    const turn3End = agent.session.snapshotEvents().filter(e => e.type === "turn/end").at(-1);
    assert.equal(turn3End.data.reason.kind, "error");
    assert.equal(checkpoints(agent).length, 2);
  } finally {
    await dsh.dispose();
  }
});

test("compaction/summary-error waterfall recovers transient image-offload errors during summarization", async () => {
  let recovered = 0;
  let attempts = 0;
  const dsh = await mountAutoCompact([
    "reply-with-image-context",
    () => {
      attempts += 1;
      throw new LlmError("Image too large", "IMAGE_OFFLOAD_REQUIRED");
    },
    () => {
      attempts += 1;
      return "checkpoint after image offload";
    },
  ], { compactConfig: { auto: false } });

  dsh.ctx.on("compaction/summary-error", (payload, next) => {
    if (payload.error instanceof LlmError && payload.error.code === "IMAGE_OFFLOAD_REQUIRED") {
      recovered += 1;
      return true;
    }
    return next();
  });

  try {
    const agent = await dsh.run("analyze screenshot");
    const result = await dsh.compact(agent);
    assert.equal(result.kind, "success", result.text);
    assert.equal(recovered, 1);
    assert.equal(attempts, 2);
    assert.match(result.text, /checkpoint after image offload/);
  } finally {
    await dsh.dispose();
  }
});

test("auto-compaction during an unfinished turn does not retain old-epoch Spine tool calls", async () => {
  // Keep Turn 1 (~4,200 tokens) below threshold (5,000 = 0.5 * 10,000), then let Turn 2 Step 1
  // call spine_open + echo to push Step 2 over threshold so pressure compaction fires mid-turn!
  const largeHistory = "old-background ".repeat(450);
  const step1Payload = "step1-pressure ".repeat(260);
  const dsh = await mountAutoCompact([
    `turn1-large ${largeHistory}`,
    // Turn 2 Step 1 calls spine_open alongside echo; Step 2 triggers pressure compaction.
    [["spine_open", { goal: "opened before auto compact" }], ["echo", { payload: step1Payload }]],
    request => {
      assert.equal(request.purpose, "compaction");
      return "checkpoint absorbing old spine_open";
    },
    // Step 2 MUST start at clean Root without leaking the old spine_open tool-call/result!
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.match(text(request.messages), /checkpoint absorbing old spine_open/);
      const spineCalls = request.messages
        .filter(m => m.role === "assistant")
        .flatMap(m => m.content.filter(b => b.type === "tool-call" && b.name === "spine_open"));
      assert.equal(spineCalls.length, 0, "old-epoch spine_open must not leak into new epoch");
      // Opening a fresh node in the new epoch works cleanly!
      return [["spine_open", { goal: "fresh node in new epoch" }]];
    },
    [["spine_close", { memory: "fresh node done" }]],
    "turn2-completed-cleanly",
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.5, retainTokens: 2_500 },
    modelWindows: { scripted: { contextWindow: 10_000, defaultMaxTokens: 512 } },
  });
  registerEchoTool(dsh);

  try {
    const agent = await dsh.run("build background");
    await dsh.send(agent, "start turn 2 with spine_open");
    assert.equal(checkpoints(agent).length, 1);
    assert.equal(checkpoints(agent)[0].data.source.retainedSeqs, undefined);
    const turnEnd = agent.session.snapshotEvents().filter(e => e.type === "turn/end").at(-1);
    assert.equal(turnEnd.data.reason.kind, "completed");
  } finally {
    await dsh.dispose();
  }
});

test("forked Spawn children after a retained-tail auto-compaction remap boundaries cleanly", async () => {
  // Turn 1 builds heavy history; Turn 2 runs echo tool -> triggers retained-tail auto-compact
  // (boundaryOffset > 0), then immediately spawns two forked children in the SAME turn so the
  // forked children inherit the live retained-tail cells directly across continueNamespace()!
  const turn1Body = "historical-fact ".repeat(550);
  const turn2ToolBody = "turn2-tool-output ".repeat(250);
  const parentReplies = [
    `turn1-reply ${turn1Body}`,
    [["echo", { payload: turn2ToolBody }]],
    // Immediately after retained-tail auto-compact in Turn 2 Step 2, spawn 2 children!
    [["spine_spawn", { tasks: [
      { summary: "post-compact-child-1", prompt: "Shared blackboard: /tmp/bb\nCheck 1" },
      { summary: "post-compact-child-2", prompt: "Shared blackboard: /tmp/bb\nCheck 2" },
    ] }]],
    "waiting-post-compact-children",
    "merged-child-1",
    "merged-child-2",
  ];
  const dsh = await mountAutoCompact({}, {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.5, retainTokens: 3_000 },
    modelWindows: { scripted: { contextWindow: 10_000, defaultMaxTokens: 512 } },
  });
  registerEchoTool(dsh);

  let childRequests = 0;
  dsh.adapter.stream = async function* (request) {
    dsh.adapter.requests.push(request);
    if (request.sessionId !== "session-1") {
      if (request.purpose === "compaction") {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "child-compacted-checkpoint" } };
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      childRequests += 1;
      const body = text(request.messages);
      assert.match(body, /retained-tail checkpoint|child-compacted-checkpoint/);
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: `child-result-${childRequests}` } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (request.purpose === "compaction") {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "retained-tail checkpoint" } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    const next = parentReplies.shift() ?? "done";
    const blocks = typeof next === "string"
      ? [{ type: "text", text: next }]
      : next.map(([name, input], index) => ({
        type: "tool-call",
        id: `call-${dsh.adapter.requests.length}-${index}`,
        name,
        arguments: JSON.stringify(input),
      }));
    for (const [index, block] of blocks.entries()) {
      yield { type: "block-start", index, blockType: block.type };
      yield { type: "block-end", index, block };
    }
    yield { type: "finish", reason: { kind: typeof next === "string" ? "stop" : "tool-calls" } };
  };

  try {
    const agent = await dsh.run("turn1");
    agent.followup(createUserMessage({ content: [{ type: "text", text: "turn2 with compact then spawn" }], source: { kind: "user" } }));
    while (true) {
      await agent.whenIdle();
      const idleSeq = agent.session.seq;
      if (!await (dsh.ctx.subagents.waitForTreeWork?.(agent) ?? dsh.ctx.subagents.waitForChildren(agent)) && agent.status === "idle" && agent.session.seq === idleSeq) break;
    }
    assert.equal(checkpoints(agent).length, 1);
    assert.ok(checkpoints(agent)[0].data.source.retainedSeqs.length >= 3, "boundaryOffset > 0 established");
    assert.equal(childRequests, 2);
    const arrivals = agent.session.snapshotEvents().filter(
      e => e.type === "user/message" && e.data.source.kind === "spine-arrival",
    );
    assert.equal(arrivals.length, 2);
    assert.ok(arrivals.every(a => a.data.source.arrival.outcome === "completed"));
  } finally {
    await dsh.dispose();
  }
});

function setupModelSwitcher(dsh, initialModel = "scripted") {
  let targetModel = initialModel;
  dsh.ctx.on("agent/request", async (payload, next) => {
    const config = await next();
    if (typeof payload.agent?.model?.select === "function") return config;
    return { ...config, model: targetModel };
  });
  return (agent, model) => {
    targetModel = model;
    if (typeof agent.model?.select === "function") {
      agent.model.select({ provider: "scripted", model });
    }
  };
}

test("model-switch compaction failure restores the claimed user message so switching back delivers it once", async () => {
  const bigHistory = "large-turn1-context ".repeat(700);
  const errors = [];
  const dsh = await mountAutoCompact([
    `big-reply ${bigHistory}`,
    // Compaction attempt while switching to small model fails.
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.model, "scripted");
      return { fail: "transient summary outage" };
    },
    // After switching back to big ("scripted") and sending "continue", the restored next-turn prompt
    // runs first, followed by "continue-after-restore" in the queued turn.
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.equal(request.model, "scripted");
      const body = text(request.messages);
      assert.match(body, /crucial-question-must-not-drop/);
      return "answered-original";
    },
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.equal(request.model, "scripted");
      const body = text(request.messages);
      assert.match(body, /crucial-question-must-not-drop/);
      assert.match(body, /continue-after-restore/);
      return "answered-continue";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.5 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
      small: { contextWindow: 6_000, defaultMaxTokens: 512 },
    },
  });

  const switchModel = setupModelSwitcher(dsh);
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));

  try {
    const agent = await dsh.run("build history on big");

    switchModel(agent, "small");
    await dsh.send(agent, "crucial-question-must-not-drop");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "MODEL_SWITCH_COMPACTION_FAILED");
    assert.equal(agent.status, "idle");
    // The claimed prompt was NOT lost: it sits back at the head of nextTurn (Web QueueDock editable) and not nextStep.
    assert.equal(agent.inbox.nextTurn.length, 1);
    assert.equal(agent.inbox.nextStep.length, 0);
    assert.match(text(agent.inbox.nextTurn), /crucial-question-must-not-drop/);

    switchModel(agent, "scripted");
    await dsh.send(agent, "continue-after-restore");
    assert.equal(errors.length, 1, "switching back and draining restored + follow-up turns must succeed cleanly");
    assert.equal(agent.inbox.nextTurn.length, 0);
    assert.equal(agent.inbox.nextStep.length, 0);
    const loggedMatches = agent.session.snapshotEvents().filter(
      e => e.type === "user/message" && text([e.data]).includes("crucial-question-must-not-drop"),
    );
    assert.equal(loggedMatches.length, 1, "restored user message must be delivered exactly once");
  } finally {
    await dsh.dispose();
  }
});

test("model-switch compaction failure restores a waking spine-arrival so the parent is not stuck waiting", async () => {
  const bigHistory = "parent-history ".repeat(700);
  const errors = [];
  const dsh = await mountAutoCompact([
    `parent-reply ${bigHistory}`,
    request => {
      assert.equal(request.purpose, "compaction");
      return { fail: "summary failed during arrival wake" };
    },
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.equal(request.model, "scripted");
      const body = text(request.messages);
      assert.match(body, /child-result-must-survive/);
      assert.match(body, /resume-parent/);
      return "parent-consumed-arrival";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.5 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
      small: { contextWindow: 4_096, defaultMaxTokens: 512 },
    },
  });

  const switchModel = setupModelSwitcher(dsh);
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));

  try {
    const agent = await dsh.run("seed parent context");
    switchModel(agent, "small");
    const arrival = arrivalMessage({
      producer: [1, 1],
      summary: "child-task",
      outcome: "completed",
      content: "child-result-must-survive",
    });
    agent.steer(arrival);
    await agent.whenIdle();

    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "MODEL_SWITCH_COMPACTION_FAILED");
    assert.equal(agent.inbox.nextStep.length, 1);
    assert.equal(agent.inbox.nextStep[0].source.kind, "spine-arrival");

    switchModel(agent, "scripted");
    await dsh.send(agent, "resume-parent");
    assert.equal(agent.inbox.nextStep.length, 0);
    const loggedArrivals = agent.session.snapshotEvents().filter(
      e => e.type === "user/message" && e.data.source.kind === "spine-arrival",
    );
    assert.equal(loggedArrivals.length, 1, "waking spine-arrival must be delivered exactly once");
  } finally {
    await dsh.dispose();
  }
});

test("model-switch budget includes the newly claimed user message before sending to the smaller model", async () => {
  // System + tools (~2,000 tokens) + existing history (~1,100 tokens) = ~3,100 < threshold (~3,567).
  // Adding the newly claimed user message (~1,100 tokens) pushes total to ~4,200 >= 3,567.
  // Model-switch compaction must run on the old model BEFORE sending to the small model,
  // after which system + tools + checkpoint + new message (~3,200) fits cleanly on small.
  const oldHistory = "old-history ".repeat(350);
  const bigNewPrompt = "new-question ".repeat(350);
  let compactedBeforeSmall = false;

  const dsh = await mountAutoCompact([
    `big-turn1 ${oldHistory}`,
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.model, "scripted");
      compactedBeforeSmall = true;
      return "compact checkpoint before small model";
    },
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.equal(request.model, "small");
      assert.equal(compactedBeforeSmall, true);
      assert.match(text(request.messages), /compact checkpoint before small model/);
      assert.match(text(request.messages), /new-question/);
      return "small-answered-cleanly";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.65 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
      small: { contextWindow: 6_000, defaultMaxTokens: 512 },
    },
  });

  const switchModel = setupModelSwitcher(dsh);

  try {
    const agent = await dsh.run("start modest history");
    // Prove old history alone is strictly below the small model's threshold (~3,567 tokens),
    // so only counting the newly claimed user message can trigger model-switch compaction.
    const beforeSwitch = dsh.ctx.tokenMeter.measure(agent.session, agent.session.requestHeader());
    const smallThreshold = Math.floor((6_000 - 512) * 0.65);
    assert.ok(
      beforeSwitch.totalTokens < smallThreshold,
      `expected existing history (${beforeSwitch.totalTokens}) < small threshold (${smallThreshold})`,
    );

    switchModel(agent, "small");
    await dsh.send(agent, bigNewPrompt);
    assert.equal(compactedBeforeSmall, true);
    assert.equal(checkpoints(agent).length, 1);
    assert.equal(dsh.adapter.requests.filter(r => r.model === "small" && r.purpose !== "compaction").length, 1);
  } finally {
    await dsh.dispose();
  }
});

test("manual /compact still compacts retained tool outputs after an auto-compaction whose follow-up request failed", async () => {
  const turn1Body = "historical-fact ".repeat(500);
  const turn2ToolBody = "retained-tool-output ".repeat(300);
  const errors = [];

  const dsh = await mountAutoCompact([
    `turn1-reply ${turn1Body}`,
    // Turn 2 Step 1 calls echo -> Step 2 triggers auto-compaction retaining the tool call & result.
    [["echo", { payload: turn2ToolBody }]],
    request => {
      assert.equal(request.purpose, "compaction");
      return "auto checkpoint keeping tool tail";
    },
    // Step 2 model request fails before producing any new assistant output.
    { fail: "network disconnected before assistant reply" },
    // Immediate manual /compact MUST compact the retained tool output into a fresh checkpoint!
    request => {
      assert.equal(request.purpose, "compaction");
      assert.match(text(request.messages), /retained-tool-output/);
      return "manual checkpoint absorbing retained tool output";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.5, retainTokens: 4_000 },
    modelWindows: { scripted: { contextWindow: 10_000, defaultMaxTokens: 512 } },
  });
  registerEchoTool(dsh);
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));

  try {
    const agent = await dsh.run("turn1");
    await dsh.send(agent, "run tool then disconnect");
    assert.equal(errors.length, 1);
    assert.equal(checkpoints(agent).length, 1);
    assert.ok(checkpoints(agent)[0].data.source.retainedSeqs.length >= 3);

    const manual = await dsh.compact(agent);
    assert.equal(manual.kind, "success", manual.text);
    assert.match(manual.text, /manual checkpoint absorbing retained tool output/);
    assert.equal(checkpoints(agent).length, 2);
    assert.equal(checkpoints(agent)[1].data.source.retainedSeqs, undefined);

    // Now there truly is no new or retained history left.
    const repeat = await dsh.compact(agent);
    assert.equal(repeat.kind, "success");
    assert.equal(repeat.text, "No new conversation history to compact.");
  } finally {
    await dsh.dispose();
  }
});

test("warm compaction surfaces EMPTY_RESPONSE throw and error finish directly without clean fallback", async () => {
  // Part A: Adapter throws LlmError(..., EMPTY_RESPONSE_CODE).
  const dshThrow = await mountAutoCompact([
    "history-for-empty-throw",
    request => {
      assert.equal(request.purpose, "compaction");
      assert.ok(Array.isArray(request.tools) && request.tools.length > 0);
      throw new LlmError("DeepSeek returned zero content blocks", EMPTY_RESPONSE_CODE);
    },
  ]);
  try {
    const agent = await dshThrow.run("trigger empty throw");
    const result = await dshThrow.compact(agent);
    assert.equal(result.kind, "error");
    assert.match(result.text, /DeepSeek returned zero content blocks/);
    assert.equal(dshThrow.adapter.requests.length, 2, "must not retry clean fallback on EMPTY_RESPONSE throw");
    assert.equal(checkpoints(agent).length, 0);
  } finally {
    await dshThrow.dispose();
  }

  // Part B: Adapter emits finish { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE } }.
  const dshFinish = await mountAutoCompact([
    "history-for-empty-finish",
  ]);
  const baseStream = dshFinish.adapter.stream.bind(dshFinish.adapter);
  let compactCall = 0;
  dshFinish.adapter.stream = async function* (request) {
    if (request.purpose !== "compaction") {
      yield* baseStream(request);
      return;
    }
    dshFinish.adapter.requests.push(request);
    compactCall += 1;
    assert.ok(Array.isArray(request.tools) && request.tools.length > 0);
    yield {
      type: "finish",
      reason: { kind: "error", failure: { code: EMPTY_RESPONSE_CODE, message: "empty stream" } },
    };
  };
  try {
    const agent = await dshFinish.run("trigger empty finish");
    const result = await dshFinish.compact(agent);
    assert.equal(result.kind, "error");
    assert.match(result.text, /empty stream/);
    assert.equal(compactCall, 1, "must not retry clean fallback on EMPTY_RESPONSE finish");
    assert.equal(checkpoints(agent).length, 0);
  } finally {
    await dshFinish.dispose();
  }
});

test("retained-tail reasoning strip precedes checkpoint durability and still recovers if a crash omits the record", async () => {
  const turn1Body = "historical-fact ".repeat(500);
  const turn2ToolBody = "turn2-tool-output ".repeat(300);
  const dsh1 = await mountAutoCompact([
    `turn1-reply ${turn1Body}`,
    { reasoning: "stale-secret-thought", calls: [["echo", { payload: turn2ToolBody }]] },
    request => {
      assert.equal(request.purpose, "compaction");
      return "checkpoint with droppedReasoningSeqs";
    },
    "turn2-finished-cleanly",
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.5, retainTokens: 3_000 },
    modelWindows: { scripted: { contextWindow: 10_000, defaultMaxTokens: 512 } },
  });
  registerEchoTool(dsh1);

  const root = dsh1.root;
  let sessionId;
  try {
    const agent = await dsh1.run("turn1");
    sessionId = agent.id;
    await dsh1.send(agent, "turn2 with reasoning");

    const events = agent.session.snapshotEvents();
    const [marker] = checkpoints(agent);
    const dropEvents = events.filter(
      e => e.type === WITHOUT_REASONING,
    );
    assert.equal(dropEvents.length, 1);
    assert.ok(
      dropEvents[0].seq < marker.seq,
      "without-reasoning must be appended before the compact checkpoint so both share the durability flush",
    );
    assert.ok(
      Array.isArray(marker.data.source.droppedReasoningSeqs)
      && marker.data.source.droppedReasoningSeqs.length === 1,
      "checkpoint metadata must record droppedReasoningSeqs for recovery",
    );
    await dsh1.ctx.sessions.flush(agent.session);
  } finally {
    await dsh1.dispose();
  }

  // Simulate a log where the separate without-reasoning record was missing on disk at crash time
  // (keep seq monotonic by turning that ignorable plugin record into a no-op record type).
  const sessionsDir = join(root, "sessions");
  const findJsonl = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await findJsonl(full);
        if (found !== null) return found;
      } else if (entry.name.endsWith(".jsonl")) {
        return full;
      }
    }
    return null;
  };
  const logPath = await findJsonl(sessionsDir);
  assert.ok(logPath !== null, "expected persisted session jsonl file");
  const raw = await readFile(logPath, "utf8");
  assert.ok(raw.includes(WITHOUT_REASONING));
  await writeFile(logPath, raw.replaceAll(WITHOUT_REASONING, "plugin:test/simulated-crash-missing"), "utf8");

  // Reopen the session and send another turn: recovery MUST re-strip stale reasoning before calling the LLM!
  const dsh2 = await mountAutoCompact([
    request => {
      assert.notEqual(request.purpose, "compaction");
      const assistantReasoning = request.messages
        .filter(m => m.role === "assistant")
        .flatMap(m => m.content.filter(b => b.type === "reasoning"));
      assert.equal(assistantReasoning.length, 0, "stale reasoning must not be sent after crash recovery");
      return "recovered-without-stale-reasoning";
    },
  ], {
    root,
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.9 },
    modelWindows: { scripted: { contextWindow: 32_768, defaultMaxTokens: 512 } },
  });
  registerEchoTool(dsh2);
  try {
    const resumed = await dsh2.resume(sessionId);
    await dsh2.send(resumed, "after crash recovery");
    assert.equal(dsh2.adapter.requests.length, 1);
  } finally {
    await dsh2.dispose();
  }
});

test("two-pass model-switch compaction records separate usage per checkpoint without double-counting", async () => {
  const turn1Body = "turn1-padding ".repeat(550);
  // Echo takes { payload }, so both the tool-call args and tool/result carry step1ToolBody:
  // ~200 repeats (~800 tokens each -> ~1,650 tokens combined) fits inside retainTokens=2,000,
  // keeping Pass 1 total (~2,350 + 1,650 = ~4,000 >= 3,000) above small threshold to trigger Pass 2!
  const step1ToolBody = "step1-tool-tail ".repeat(200);
  let compactPass = 0;
  let smallAnswered = false;
  const errors = [];

  const dsh = await mountAutoCompact([
    // Turn 1 on big ("scripted") model.
    `turn1-reply ${turn1Body}`,
    // Turn 2 Step 1 on big model calls echo tool; right after tool execution, switch to small model.
    [["echo", { payload: step1ToolBody }]],
    // Model-switch Pass 1 (retains Step 1 tool tail, but retained tail + system + tools still >= small threshold).
    request => {
      assert.equal(request.purpose, "compaction");
      compactPass += 1;
      assert.equal(compactPass, 1);
      return { text: "pass-1 checkpoint", usage: { inputTokens: 1_000, outputTokens: 20 } };
    },
    // Model-switch Pass 2 (retainTokens: 0, compacts the retained tail too).
    request => {
      assert.equal(request.purpose, "compaction");
      compactPass += 1;
      assert.equal(compactPass, 2);
      return { text: "pass-2 full checkpoint", usage: { inputTokens: 300, outputTokens: 15 } };
    },
    // Now fits cleanly in small model.
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.equal(request.model, "small");
      assert.match(text(request.messages), /pass-2 full checkpoint/);
      smallAnswered = true;
      return "small-finished-turn2";
    },
  ], {
    withTokenMeter: true,
    // Small model: window=6000, defaultMaxTokens=500 -> threshold=3000 (> ~2350 system+tools floor);
    // retainTokens=2000 so Pass 1 keeps the ~1700-token tool tail (+ ~2350 floor => >= 3000),
    // triggering Pass 2 (retainTokens: 0), after which ~2375 < 3000 fits cleanly!
    compactConfig: { auto: true, thresholdRatio: 0.5, retainTokens: 2_000 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 500 },
      small: { contextWindow: 6_000, defaultMaxTokens: 500 },
    },
  });
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));
  const switchModel = setupModelSwitcher(dsh);
  let activeAgent;
  dsh.ctx.tools.register({
    name: "echo",
    description: "Return supplied payload text and switch to small model for the next step.",
    parameters: { type: "object", properties: { payload: { type: "string" } }, required: ["payload"] },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    execute: async ({ payload }) => {
      if (activeAgent !== undefined) switchModel(activeAgent, "small");
      return { text: payload };
    },
  });

  try {
    const agent = await dsh.run("turn1 on big");
    activeAgent = agent;
    await dsh.send(agent, "turn2 runs tool then switches to small");
    assert.equal(errors.length, 0, `unexpected agent error: ${errors[0]?.message}`);
    assert.equal(compactPass, 2, "expected two-pass model-switch compaction");
    assert.equal(smallAnswered, true, "small model must complete turn 2 after pass 2");
    const markers = checkpoints(agent);
    assert.equal(markers.length, 2);
    assert.equal(markers[0].data.source.calls.length, 1);
    assert.equal(markers[0].data.source.calls[0].usage.inputTokens, 1_000);
    assert.equal(markers[1].data.source.calls.length, 1);
    assert.equal(markers[1].data.source.calls[0].usage.inputTokens, 300);

    // Verify compactStats projection reports 1,000 and 300 (NOT 1,000 and 1,300).
    const rows = markers.map((marker) => {
      const state = compactStatsDefinition.start(
        {},
        { event: marker, location: { kind: "session" } },
        { previous() { return undefined; } },
      );
      return compactStatsDefinition.buildViewNode({
        key: `spine-compact:${marker.seq}`,
        kind: compactStatsDefinition.kind,
        id: `spine-compact:${marker.seq}`,
        start: { event: marker, location: { kind: "session" } },
        state,
      });
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].data.metrics.context, 1_000);
    assert.equal(rows[1].data.metrics.context, 300);
  } finally {
    await dsh.dispose();
  }
});

test("final Spawn arrival waking a parent switched to a smaller model compacts and completes without deadlocking", async () => {
  const bigBase = "parent-context-before-spawn ".repeat(500);
  const child1Release = Promise.withResolvers();
  const child2Release = Promise.withResolvers();
  const child1Started = Promise.withResolvers();
  const child2Started = Promise.withResolvers();
  const childIds = [];
  let parentTurn = 0;
  let compactedOnSwitch = false;
  let smallSynthesized = false;
  const errors = [];

  const dsh = await mountAutoCompact([], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.75, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
      small: { contextWindow: 4_500, defaultMaxTokens: 512 },
    },
  });
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));
  const switchModel = setupModelSwitcher(dsh);

  dsh.adapter.stream = async function* (request) {
    dsh.adapter.requests.push(request);
    if (request.sessionId?.includes(":spawn:")) {
      if (!childIds.includes(request.sessionId)) childIds.push(request.sessionId);
      const isFirst = childIds[0] === request.sessionId;
      if (isFirst) {
        child1Started.resolve();
        await child1Release.promise;
      } else {
        child2Started.resolve();
        await child2Release.promise;
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "text", text: isFirst ? "child-one-output" : "child-two-final-output" },
      };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (request.purpose === "compaction") {
      assert.equal(request.model, "scripted");
      compactedOnSwitch = true;
      assert.match(text(request.messages), /child-one-output/);
      assert.match(text(request.messages), /child-two-final-output/);
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "checkpoint with both child arrivals" } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    parentTurn += 1;
    if (parentTurn === 1) {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: `seeded ${bigBase}` } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (parentTurn === 2) {
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: "call-spawn-final",
          name: "spine_spawn",
          arguments: JSON.stringify({
            tasks: [
              { summary: "branch-1", prompt: "Shared blackboard: /tmp/bb\ndo 1" },
              { summary: "branch-2", prompt: "Shared blackboard: /tmp/bb\ndo 2" },
            ],
          }),
        },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    if (parentTurn === 3) {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "waiting for spawned branches" } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (request.model === "small") {
      assert.equal(compactedOnSwitch, true);
      assert.match(text(request.messages), /checkpoint with both child arrivals/);
      smallSynthesized = true;
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "small-model-synthesized" } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "noted-child-one" } };
    yield { type: "finish", reason: { kind: "stop" } };
  };

  try {
    const agent = await dsh.run("seed big context");
    const spawnTurn = dsh.send(agent, "launch two spawn tasks");
    await Promise.all([child1Started.promise, child2Started.promise]);
    await spawnTurn;

    // Release child 1 while still on big model so parent is waiting solely on child 2.
    child1Release.resolve();
    await agent.whenIdle();
    const waitChild1 = async () => {
      for (let i = 0; i < 40; i += 1) {
        await agent.whenIdle();
        const arrivals = agent.session.snapshotEvents().filter(
          e => e.type === "user/message" && e.data.source.kind === "spine-arrival",
        );
        if (arrivals.length >= 1) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await waitChild1();

    // User switches to the smaller model while waiting for the FINAL child (child 2).
    switchModel(agent, "small");

    // Release child 2: its arrival wakes the parent directly on the smaller model.
    // Compaction must recognize the claimed final arrival, compact cleanly, and finish on "small".
    child2Release.resolve();
    while (true) {
      await agent.whenIdle();
      const idleSeq = agent.session.seq;
      if (!await (dsh.ctx.subagents.waitForTreeWork?.(agent) ?? dsh.ctx.subagents.waitForChildren(agent)) && agent.status === "idle" && agent.session.seq === idleSeq) {
        break;
      }
    }

    assert.equal(errors.length, 0, `expected no deadlock error, got: ${errors[0]?.message}`);
    assert.equal(compactedOnSwitch, true, "expected model-switch compaction using previous model");
    assert.equal(smallSynthesized, true, "expected smaller model to answer directly after final arrival");
    assert.equal(checkpoints(agent).length, 1);
    assert.equal(agent.session.requestHeader().config.model, "small");
    const loggedArrivals = agent.session.snapshotEvents().filter(
      e => e.type === "user/message" && e.data.source.kind === "spine-arrival",
    );
    assert.equal(loggedArrivals.length, 2, "each child arrival must be logged exactly once");
  } finally {
    child1Release.resolve();
    child2Release.resolve();
    await dsh.dispose();
  }
});

test("newly claimed image blocks use DSH route imageRequestPricing for model-switch and pre-step budgets", async () => {
  const modestHistory = "modest-history ".repeat(150);
  let compactedForImageSwitch = false;
  let compactedForImagePreStep = false;

  const dsh = await mountAutoCompact([
    `turn1-reply ${modestHistory}`,
    // Model-switch compaction triggered ONLY because imageRequestPricing prices the new image at +2,500 visual tokens.
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.model, "scripted");
      compactedForImageSwitch = true;
      return "checkpoint before small vision switch";
    },
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.equal(request.model, "small");
      assert.equal(compactedForImageSwitch, true);
      return "small-answered-with-image";
    },
    // Same-model pre-step compaction on "small" triggered ONLY because a second image adds +2,500 visual tokens.
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.model, "small");
      compactedForImagePreStep = true;
      return "checkpoint before second small vision message";
    },
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.equal(request.model, "small");
      assert.equal(compactedForImagePreStep, true);
      return "small-answered-second-image";
    },
  ], {
    withTokenMeter: true,
    // Small window=9000, defaultMaxTokens=500 -> threshold=5400 (0.6*9000).
    // System+tools (~2000) + modest history (~1200) + raw JSON image ref (~30) = ~3230 < 5400.
    // With route visualTokens = 2500 -> ~5730 >= 5400 -> triggers compaction!
    compactConfig: { auto: true, thresholdRatio: 0.6, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 500 },
      small: { contextWindow: 9_000, defaultMaxTokens: 500 },
    },
  });

  // Expose route visual pricing on the adapter (mirrors DSH vision adapters like Anthropic/OpenAI/Gemini).
  dsh.adapter.imageRequestPricing = (_provider, model) => {
    if (model !== "small") return undefined;
    return {
      priceImages: (images) => images.map(() => ({ visualTokens: 2_500, text: "" })),
    };
  };

  const switchModel = setupModelSwitcher(dsh);

  try {
    const agent = await dsh.run("seed modest history");
    const imageMsg1 = createUserMessage({
      content: [
        { type: "text", text: "inspect screenshot 1" },
        {
          type: "image",
          attachment: { id: "img-1", mimeType: "image/png", size: 1024, sha256: "a".repeat(64) },
        },
      ],
      source: { kind: "user" },
    });

    switchModel(agent, "small");
    agent.followup(imageMsg1);
    await agent.whenIdle();
    assert.equal(compactedForImageSwitch, true, "model-switch must price newly claimed images with imageRequestPricing");
    assert.equal(checkpoints(agent).length, 1);

    const imageMsg2 = createUserMessage({
      content: [
        { type: "text", text: "inspect screenshot 2" },
        {
          type: "image",
          attachment: { id: "img-2", mimeType: "image/png", size: 1024, sha256: "b".repeat(64) },
        },
      ],
      source: { kind: "user" },
    });
    agent.followup(imageMsg2);
    await agent.whenIdle();
    assert.equal(compactedForImagePreStep, true, "same-model pre-step must price newly claimed images with imageRequestPricing");
    assert.equal(checkpoints(agent).length, 2);
  } finally {
    await dsh.dispose();
  }
});

test("same-model turns do not scan the session log in agent/request when the model did not change", async () => {
  const dsh = await mountAutoCompact([
    "reply-1",
    "reply-2",
    "reply-3",
    "reply-4",
    "reply-5",
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.9 },
    modelWindows: { scripted: { contextWindow: 100_000, defaultMaxTokens: 512 } },
  });

  try {
    const agent = await dsh.run("turn-1");
    await dsh.send(agent, "turn-2");
    await dsh.send(agent, "turn-3");
    await dsh.send(agent, "turn-4");

    const beforeSeq = agent.session.seq;
    assert.ok(beforeSeq >= 20, `expected substantial log length (${beforeSeq})`);

    let totalReqCalls = 0;
    let requestWindow = false;
    const seenSeqs = [];
    const origEventAt = agent.session.eventAt.bind(agent.session);
    agent.session.eventAt = (seq) => {
      if (requestWindow) {
        totalReqCalls += 1;
        seenSeqs.push(seq);
      }
      return origEventAt(seq);
    };
    dsh.ctx.on("agent/request", async (_payload, next) => {
      requestWindow = true;
      try {
        return await next();
      } finally {
        requestWindow = false;
      }
    }, { prepend: true });

    await dsh.send(agent, "turn-5 same model");
    // If filterUnloggedMessages ran on same-model requests, it would walk every seq from
    // session.seq - 1 down to 0 — including non-surface events like turn/start (seq 0) and
    // step/start (seq 1). Surface-only enterStep never touches seq 0 or seq 1.
    assert.ok(!seenSeqs.includes(0), `same-model agent/request must not scan seq 0 (saw ${totalReqCalls} eventAt calls)`);
    assert.ok(!seenSeqs.includes(1), `same-model agent/request must not scan non-surface seq 1`);
  } finally {
    await dsh.dispose();
  }
});

test("/compact receipt distinguishes replaced history size from summary input usage across recovery retries", async () => {
  let attempt = 0;
  const dsh = await mountAutoCompact([
    "alpha-segment ".repeat(60),
    "beta-segment ".repeat(60),
  ], {
    withTokenMeter: true,
    compactConfig: { auto: false },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
    },
  });
  const baseStream = dsh.adapter.stream.bind(dsh.adapter);
  dsh.adapter.stream = async function* (request) {
    if (request.purpose !== "compaction") {
      yield* baseStream(request);
      return;
    }
    dsh.adapter.requests.push(request);
    attempt += 1;
    if (attempt === 1) {
      yield { type: "usage", usage: { inputTokens: 600, outputTokens: 20 } };
      yield {
        type: "finish",
        reason: { kind: "error", failure: { code: "IMAGE_OFFLOAD_REQUIRED", message: "offload images" } },
      };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "recovered final checkpoint" } };
    yield { type: "usage", usage: { inputTokens: 800, outputTokens: 30 } };
    yield {
      type: "finish",
      reason: { kind: "stop" },
    };
  };
  dsh.ctx.on("compaction/summary-error", (payload, next) => {
    if (payload.error instanceof LlmError && payload.error.code === "IMAGE_OFFLOAD_REQUIRED") {
      return true;
    }
    return next();
  });

  try {
    const agent = await dsh.run("part 1");
    await dsh.send(agent, "part 2");
    const result = await dsh.compact(agent);
    assert.equal(result.kind, "success", result.text);
    const [marker] = checkpoints(agent);
    assert.equal(marker.data.source.calls.length, 2);
    const shadowed = marker.data.source.shadowedTokens;
    assert.ok(shadowed > 0);
    assert.equal(
      result.text,
      `Compacted conversation (~${shadowed.toLocaleString("en-US")} history tokens; summary used ~1,400 input tokens).\n\nrecovered final checkpoint`,
    );
  } finally {
    await dsh.dispose();
  }
});

test("model-switch fails fast without summarizing or mutating history when the new message alone exceeds target threshold", async () => {
  const existingReply = "valuable-uncompacted-history ".repeat(150);
  const oversizedNewPrompt = "giant-pasted-text ".repeat(1_000);
  let compactionCalls = 0;
  const errors = [];

  const dsh = await mountAutoCompact([
    `turn1 ${existingReply}`,
    request => {
      if (request.purpose === "compaction") {
        compactionCalls += 1;
        return "SHOULD NOT RUN";
      }
      assert.equal(request.model, "scripted");
      const body = text(request.messages);
      assert.match(body, /valuable-uncompacted-history/, "original history must stay uncompacted");
      assert.match(body, /giant-pasted-text/, "restored oversized input must be delivered on big model");
      return "answered-on-big-model-with-full-history";
    },
    request => {
      assert.equal(request.model, "scripted");
      assert.match(text(request.messages), /continue on big model/);
      return "answered-continue-on-big";
    },
  ], {
    withTokenMeter: true,
    // Small threshold = 0.7 * 5000 = 3500; oversizedNewPrompt alone is ~4,500 tokens > 3500.
    compactConfig: { auto: true, thresholdRatio: 0.7 },
    modelWindows: {
      scripted: { contextWindow: 64_000, defaultMaxTokens: 512 },
      small: { contextWindow: 5_000, defaultMaxTokens: 512 },
    },
  });
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));
  const switchModel = setupModelSwitcher(dsh);

  try {
    const agent = await dsh.run("seed valuable history");
    const surfaceBefore = [...agent.session.surface.nodes];

    switchModel(agent, "small");
    await dsh.send(agent, oversizedNewPrompt);

    assert.equal(compactionCalls, 0, "must NOT issue any summarization request when new input alone exceeds threshold");
    assert.equal(checkpoints(agent).length, 0, "must NOT write any checkpoint or mutate old history");
    assert.deepEqual(agent.session.surface.nodes, surfaceBefore, "session surface must remain untouched");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "MODEL_SWITCH_COMPACTION_FAILED");
    assert.match(errors[0].message, /shorten the input|exceed target threshold/i);
    assert.equal(agent.inbox.nextTurn.length, 1, "oversized message must be restored to nextTurn queue");
    assert.equal(agent.inbox.nextStep.length, 0);

    // Switching back to the larger model sees the full uncompacted history AND the restored message.
    switchModel(agent, "scripted");
    await dsh.send(agent, "continue on big model");
    assert.equal(checkpoints(agent).length, 0);
  } finally {
    await dsh.dispose();
  }
});

test("oversized pure-text history with no prunable tool results fails fast before sending any summary request", async () => {
  let summaryRequests = 0;
  const turnBody = "long-pure-text-conversation-segment ".repeat(200);
  const dsh = await mountAutoCompact([
    `turn-1 ${turnBody}`,
    `turn-2 ${turnBody}`,
  ], {
    compactConfig: { auto: false, summarizationProvider: "scripted", summarizationModel: "tiny-sum" },
    modelWindows: {
      scripted: { contextWindow: 128_000, defaultMaxTokens: 512 },
      "tiny-sum": { contextWindow: 1_200, defaultMaxTokens: 200 },
    },
  });

  const baseStream = dsh.adapter.stream.bind(dsh.adapter);
  dsh.adapter.stream = async function* (request) {
    if (request.purpose === "compaction") {
      summaryRequests += 1;
      throw new Error("should have failed before issuing any summary request");
    }
    yield* baseStream(request);
  };

  try {
    const agent = await dsh.run("msg-1");
    await dsh.send(agent, "msg-2");
    const surfaceBefore = [...agent.session.surface.nodes];
    const result = await dsh.compact(agent);
    assert.equal(result.kind, "error");
    assert.match(result.text, /exceeds the model's context window even after pruning oversized tool results/i);
    assert.equal(summaryRequests, 0, "must fail fast without sending doomed or chunked summary requests");
    assert.equal(checkpoints(agent).length, 0);
    assert.deepEqual(agent.session.surface.nodes, surfaceBefore);
  } finally {
    await dsh.dispose();
  }
});

test("model-switch budget uses the target model's active tool list (both added and removed tools)", async () => {
  const hugeDescription = "detailed-tool-schema-documentation ".repeat(220); // ~1,925 tokens
  const modestHistory = "baseline-history ".repeat(140); // ~600 tokens

  // Case A: target model ("small") enables an extra large tool -> pushes total OVER small threshold -> must compact!
  let compactedCaseA = false;
  const dshA = await mountAutoCompact([
    `history-a ${modestHistory}`,
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.model, "scripted");
      compactedCaseA = true;
      return "checkpoint-for-tool-heavy-small";
    },
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.equal(request.model, "small");
      assert.equal(compactedCaseA, true);
      return "small-a-ok";
    },
  ], {
    withTokenMeter: true,
    // Small threshold = 0.7 * 6500 = 4550.
    // Without extra tool: system+spineTools (~2300) + history (~700) = ~3000 < 4550 (old tools would skip!).
    // With extra tool (~1950): ~4950 >= 4550 -> MUST compact!
    compactConfig: { auto: true, thresholdRatio: 0.7, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 500 },
      small: { contextWindow: 6_500, defaultMaxTokens: 500 },
    },
  });
  const switchModelA = setupModelSwitcher(dshA);
  const extraToolDef = {
    name: "heavy_extra_tool",
    description: hugeDescription,
    parameters: { type: "object", properties: { query: { type: "string", description: hugeDescription.slice(0, 400) } } },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      render: () => [{ type: "text", text: "ok" }],
    },
    execute: async () => ({ ok: true }),
  };

  const supportsConditionalTools = typeof dshA.ctx.tools.resolve === "function";
  if (supportsConditionalTools) {
    // DSH 0.2.2+: native model-scoped activation via `when`.
    dshA.ctx.tools.register(extraToolDef, {
      when: ({ modelSelection }) => modelSelection?.model === "small",
    });
  }

  try {
    const agent = await dshA.run("turn1 on scripted without heavy tool");
    if (!supportsConditionalTools) {
      // DSH 0.2.1: tool becomes active before switching to small.
      dshA.ctx.tools.register(extraToolDef);
    }
    switchModelA(agent, "small");
    await dshA.send(agent, "now switch to small with heavy tool");
    assert.equal(compactedCaseA, true, "must compact when target model enables heavy extra tools");
    assert.equal(checkpoints(agent).length, 1);
  } finally {
    await dshA.dispose();
  }

  // Case B: target model ("small") disables a heavy tool -> fits cleanly WITHOUT wasteful compaction!
  let compactedCaseB = false;
  const dshB = await mountAutoCompact([
    `history-b ${modestHistory}`,
    request => {
      if (request.purpose === "compaction") {
        compactedCaseB = true;
        return "UNEXPECTED COMPACTION";
      }
      assert.equal(request.model, "small");
      return "small-b-direct-ok";
    },
  ], {
    withTokenMeter: true,
    // Small threshold = 0.7 * 6500 = 4550.
    // With old heavy tool: ~4950 >= 4550 (old tools would wastefully compact!).
    // Without heavy tool on "small": ~3000 < 4550 -> MUST NOT compact!
    compactConfig: { auto: true, thresholdRatio: 0.7, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 500 },
      small: { contextWindow: 6_500, defaultMaxTokens: 500 },
    },
  });
  const switchModelB = setupModelSwitcher(dshB);
  const disposeHeavyToolB = supportsConditionalTools
    ? dshB.ctx.tools.register(extraToolDef, {
      when: ({ modelSelection }) => modelSelection?.model === "scripted",
    })
    : dshB.ctx.tools.register(extraToolDef);

  try {
    const agent = await dshB.run("turn1 on scripted with heavy tool");
    if (!supportsConditionalTools) {
      disposeHeavyToolB();
    }
    switchModelB(agent, "small");
    await dshB.send(agent, "switch to small without heavy tool");
    assert.equal(compactedCaseB, false, "must NOT compact wastefully when target model drops heavy tools");
    assert.equal(checkpoints(agent).length, 0);
  } finally {
    await dshB.dispose();
  }
});

test("auto-compaction absorbs folded Spine branch memory into the summary instead of dropping it at the retained tail", async () => {
  const turn1Pad = "earlier-session-history ".repeat(500);
  const logBody = "fetched-application-log-line ".repeat(150);
  let summaryReceivedFoldedMemory = false;
  let resumedSawSummaryAndLog = false;

  const dsh = await mountAutoCompact([
    // Turn 1 builds history.
    `turn1-done ${turn1Pad}`,
    // Turn 2 Step 1: open a Spine child branch to diagnose login failure.
    [["spine_open", { goal: "diagnose login failure" }]],
    // Turn 2 Step 2: close the branch with a critical memory conclusion.
    [["spine_close", { memory: "login failed because TLS cert expired" }]],
    // Turn 2 Step 3: parent now calls echo (simulating reading a log) while the folded
    // <spine_memory> sits right before it in the same turn.
    [["echo", { payload: logBody }]],
    // Turn 2 Step 4 triggers auto pressure compaction with retainTokens large enough
    // to keep the echo tool call + result tail. The folded <spine_memory> MUST enter
    // the summary instead of falling into tailNodes and being erased in the new epoch!
    request => {
      assert.equal(request.purpose, "compaction");
      const summaryInput = text(request.messages);
      summaryReceivedFoldedMemory = summaryInput.includes("login failed because TLS cert expired");
      assert.equal(summaryReceivedFoldedMemory, true, "folded branch memory must be passed to summarizer");
      return "checkpoint preserving TLS cert expired finding";
    },
    request => {
      assert.notEqual(request.purpose, "compaction");
      const body = text(request.messages);
      assert.match(body, /checkpoint preserving TLS cert expired finding/);
      assert.match(body, /fetched-application-log-line/, "trailing tool log should still be retained");
      resumedSawSummaryAndLog = true;
      return "final-answer-using-both";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.5, retainTokens: 2_500 },
    modelWindows: { scripted: { contextWindow: 12_000, defaultMaxTokens: 512 } },
  });
  registerEchoTool(dsh);

  try {
    const agent = await dsh.run("turn1");
    await dsh.send(agent, "investigate login and check log");
    assert.equal(summaryReceivedFoldedMemory, true);
    assert.equal(resumedSawSummaryAndLog, true);
    assert.equal(checkpoints(agent).length, 1);
  } finally {
    await dsh.dispose();
  }
});

test("pruning an oversized failing tool result preserves toolCallId, isError, head/tail frames, and code-point safety", async () => {
  // Build >8,192 Unicode code points with emoji surrogate pairs near boundaries and clear head/tail frames.
  const hugeErrorLog = [
    "ERR_HEAD_0: root cause header 🚀",
    ...Array.from({ length: 420 }, (_, i) => `ERR_LINE_${i}: stack trace frame detail payload 🔥`),
    "ERR_TAIL_LAST: decisive failing assertion line ✅",
  ].join("\n");
  assert.ok(Array.from(hugeErrorLog).length > 18_000);
  let seenToolEntry = null;
  let compactCount = 0;

  const dsh = await mountAutoCompact([
    [["fail_tool", {}]],
    "handled failure",
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.tools, undefined);
      compactCount += 1;
      const raw = text(request.messages);
      for (const line of raw.split("\n")) {
        const parsed = JSON.parse(line);
        if (parsed.role === "tool") seenToolEntry = parsed;
      }
      return "pruned-failing-tool-checkpoint";
    },
  ], {
    compactConfig: { auto: false, summarizationProvider: "scripted", summarizationModel: "small-sum" },
    modelWindows: {
      scripted: { contextWindow: 64_000, defaultMaxTokens: 512 },
      // Raw tool output (~5,500+ tokens) exceeds small-sum safeInputBudget (~2,850);
      // after DSH 4096+1024 pruning (~1,500 tokens), it fits in a single request!
      "small-sum": { contextWindow: 4_000, defaultMaxTokens: 512 },
    },
  });
  dsh.ctx.tools.register({
    name: "fail_tool",
    description: "Always fails with a long error log.",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      render: () => [{ type: "text", text: "ok" }],
    },
    execute: async () => {
      throw new Error(hugeErrorLog);
    },
  });

  try {
    const agent = await dsh.run("run failing tool");
    const result = await dsh.compact(agent);
    assert.equal(result.kind, "success", result.text);
    assert.equal(compactCount, 1, "pruning must allow summarizing in 1 single request");
    assert.ok(seenToolEntry !== null);
    assert.equal(seenToolEntry.role, "tool");
    assert.ok(typeof seenToolEntry.toolCallId === "string" && seenToolEntry.toolCallId.length > 0);
    assert.equal(seenToolEntry.isError, true);
    const prunedText = seenToolEntry.content.map(b => b.text ?? "").join("");
    assert.match(prunedText, /ERR_HEAD_0: root cause header 🚀/);
    assert.match(prunedText, /\[\.\.\. tool result middle pruned \.\.\.\]/);
    assert.match(prunedText, /ERR_TAIL_LAST: decisive failing assertion line ✅/);
    assert.ok(Array.from(prunedText).length <= 8_192, "pruned tool result stays within DSH threshold");
  } finally {
    await dsh.dispose();
  }
});

test("manual /compact reports completed summary usage when a follow-up attempt fails or is cancelled", async () => {
  // Part A: warm attempt reports usage and overflows -> pruned Stage 2 attempt fails with network error.
  let failAttempt = 0;
  const dshFail = await mountAutoCompact([
    "turn-1 history",
  ], {
    compactConfig: { auto: false },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
    },
  });
  const baseFailStream = dshFail.adapter.stream.bind(dshFail.adapter);
  dshFail.adapter.stream = async function* (request) {
    if (request.purpose !== "compaction") {
      yield* baseFailStream(request);
      return;
    }
    failAttempt += 1;
    if (failAttempt === 1) {
      yield { type: "usage", usage: { inputTokens: 600, cacheReadTokens: 50, outputTokens: 20 } };
      yield {
        type: "finish",
        reason: { kind: "error", failure: { code: "CONTEXT_WINDOW_EXCEEDED", message: "context overflow" } },
      };
      return;
    }
    throw new Error("connection reset during stage 2 summary");
  };
  try {
    const agent = await dshFail.run("part 1");
    const result = await dshFail.compact(agent);
    assert.equal(result.kind, "error");
    assert.match(result.text, /connection reset during stage 2 summary/);
    assert.match(result.text, /Completed summary usage: ~650 input \/ 20 output tokens across 1 call\./);
  } finally {
    await dshFail.dispose();
  }

  // Part B: warm attempt reports usage and triggers image-offload recovery -> user cancels during retry.
  const controller = new AbortController();
  let cancelAttempt = 0;
  const dshCancel = await mountAutoCompact([
    "turn-1 history",
  ], {
    compactConfig: { auto: false },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
    },
  });
  const baseCancelStream = dshCancel.adapter.stream.bind(dshCancel.adapter);
  dshCancel.adapter.stream = async function* (request) {
    if (request.purpose !== "compaction") {
      yield* baseCancelStream(request);
      return;
    }
    cancelAttempt += 1;
    if (cancelAttempt === 1) {
      yield { type: "usage", usage: { inputTokens: 700, outputTokens: 25 } };
      yield {
        type: "finish",
        reason: { kind: "error", failure: { code: "IMAGE_OFFLOAD_REQUIRED", message: "offload images" } },
      };
      return;
    }
    controller.abort();
    throw new Error("aborted");
  };
  dshCancel.ctx.on("compaction/summary-error", (payload, next) => {
    if (payload.error instanceof LlmError && payload.error.code === "IMAGE_OFFLOAD_REQUIRED") {
      return true;
    }
    return next();
  });
  try {
    const agent = await dshCancel.run("part 1");
    const result = await dshCancel.compact(agent, "", controller.signal);
    assert.equal(result.kind, "error");
    assert.match(result.text, /Compaction cancelled\./);
    assert.match(result.text, /Completed summary usage: ~700 input \/ 25 output tokens across 1 call\./);
  } finally {
    await dshCancel.dispose();
  }
});

test("two-pass model-switch failure after pass 1 reports that an earlier compaction checkpoint was already saved", async () => {
  const bigHistory = "turn1-history-context ".repeat(550);
  const largeTail = "step1-tool-tail ".repeat(200);
  let compactCalls = 0;
  const errors = [];

  const dsh = await mountAutoCompact([
    bigHistory,
    [["echo", { payload: largeTail }]],
    (request) => {
      assert.equal(request.purpose, "compaction");
      compactCalls += 1;
      return { text: "pass 1 summary saved", usage: { inputTokens: 900, outputTokens: 25 } };
    },
    (request) => {
      assert.equal(request.purpose, "compaction");
      compactCalls += 1;
      throw new Error("upstream disconnect on pass 2");
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.5, retainTokens: 2_000 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 500 },
      small: { contextWindow: 6_000, defaultMaxTokens: 500 },
    },
  });
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));
  const switchModel = setupModelSwitcher(dsh);
  let activeAgent;
  dsh.ctx.tools.register({
    name: "echo",
    description: "Return payload and switch to small model.",
    parameters: { type: "object", properties: { payload: { type: "string" } }, required: ["payload"] },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    execute: async ({ payload }) => {
      if (activeAgent !== undefined) switchModel(activeAgent, "small");
      return { text: payload };
    },
  });

  try {
    const agent = await dsh.run("turn 1 on big");
    activeAgent = agent;
    await dsh.send(agent, "turn 2 triggers two-pass switch");
    assert.equal(compactCalls, 2);
    assert.equal(checkpoints(agent).length, 1, "pass 1 checkpoint should already be saved");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "MODEL_SWITCH_COMPACTION_FAILED");
    assert.match(errors[0].message, /upstream disconnect on pass 2/);
    assert.match(
      errors[0].message,
      /earlier compaction checkpoint was already saved/i,
      `expected error to inform user that pass 1 checkpoint was already saved: ${errors[0].message}`,
    );
  } finally {
    await dsh.dispose();
  }
});

test("irreducible new input on small-model switch returns to Web-editable next-turn queue and lets user remove/retry", async () => {
  const bigNewMessage = "oversized-pasted-input ".repeat(900);
  const errors = [];

  const dsh = await mountAutoCompact([
    "short initial reply",
    request => {
      assert.equal(request.model, "small");
      const body = text(request.messages);
      assert.doesNotMatch(body, /oversized-pasted-input/, "removed oversized message must not be re-claimed");
      assert.match(body, /short-follow-up-after-removing-long/);
      return "small-answered-short-question";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.8, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
      small: { contextWindow: 4_000, defaultMaxTokens: 512 },
    },
  });
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));
  const switchModel = setupModelSwitcher(dsh);

  try {
    const agent = await dsh.run("hello");
    switchModel(agent, "small");
    await dsh.send(agent, bigNewMessage);
    assert.equal(checkpoints(agent).length, 0, "must not compact prior history before failing fast");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "MODEL_SWITCH_COMPACTION_FAILED");
    assert.match(
      errors[0].message,
      /returned to the pending queue/i,
      `expected error to state original message is queued: ${errors[0].message}`,
    );
    assert.match(
      errors[0].message,
      /edit or remove that queued message/i,
      `expected error to explain editing/removing the queued message: ${errors[0].message}`,
    );
    // Web QueueDock reads and provides edit/remove actions exclusively on `next-turn`.
    assert.equal(agent.inbox.nextTurn.length, 1, "original oversized message must return to nextTurn for Web editing/removal");
    assert.equal(agent.inbox.nextStep.length, 0, "followup message must not be trapped in non-editable nextStep");

    // Simulate Web QueueDock removing the oversized message and sending a short prompt on the small model.
    assert.equal(agent.inbox.remove(agent.inbox.nextTurn[0].id), true);
    assert.equal(agent.inbox.nextTurn.length, 0);
    await dsh.send(agent, "short-follow-up-after-removing-long");
    assert.equal(errors.length, 1, "short prompt after removing queued oversized message must succeed on small model");
  } finally {
    await dsh.dispose();
  }

  // Control: a steering message originating from `next-step` returns to `next-step` with accurate guidance.
  const steerErrors = [];
  const dshSteer = await mountAutoCompact(["short initial reply"], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.8, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
      small: { contextWindow: 4_000, defaultMaxTokens: 512 },
    },
  });
  dshSteer.ctx.on("agent/error", ({ error }) => steerErrors.push(error));
  const switchSteer = setupModelSwitcher(dshSteer);
  try {
    const agent = await dshSteer.run("hello");
    switchSteer(agent, "small");
    agent.steer(createUserMessage({
      content: [{ type: "text", text: bigNewMessage }],
      source: { kind: "user" },
    }));
    await agent.whenIdle();
    assert.equal(steerErrors.length, 1);
    assert.equal(steerErrors[0].code, "MODEL_SWITCH_COMPACTION_FAILED");
    assert.equal(agent.inbox.nextStep.length, 1, "steer message must return to nextStep");
    assert.equal(agent.inbox.nextTurn.length, 0);
    assert.match(steerErrors[0].message, /next-step input/i);
    assert.doesNotMatch(steerErrors[0].message, /edit or remove that queued message/i);
  } finally {
    await dshSteer.dispose();
  }
});

test("same step claiming a user follow-up before the final Spawn arrival preserves their original chronological order", async () => {
  const bigBase = "parent-history-before-spawn ".repeat(480);
  const child1Release = Promise.withResolvers();
  const child2Release = Promise.withResolvers();
  const child1Started = Promise.withResolvers();
  const child2Started = Promise.withResolvers();
  const childIds = [];
  let parentTurn = 0;
  let smallRequestMessages = null;
  const errors = [];

  const dsh = await mountAutoCompact([], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.75, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
      small: { contextWindow: 4_500, defaultMaxTokens: 512 },
    },
  });
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));
  const switchModel = setupModelSwitcher(dsh);

  dsh.adapter.stream = async function* (request) {
    dsh.adapter.requests.push(request);
    if (request.sessionId?.includes(":spawn:")) {
      if (!childIds.includes(request.sessionId)) childIds.push(request.sessionId);
      const isFirst = childIds[0] === request.sessionId;
      if (isFirst) {
        child1Started.resolve();
        await child1Release.promise;
      } else {
        child2Started.resolve();
        await child2Release.promise;
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "text", text: isFirst ? "child-1-result" : "child-2-final-result" },
      };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (request.purpose === "compaction") {
      assert.equal(request.model, "scripted");
      // Verify the summarizer received the user follow-up strictly BEFORE the final arrival.
      const combinedText = text(request.messages);
      const followUpPos = combinedText.indexOf("USER_FOLLOWUP_BEFORE_ARRIVAL");
      const arrivalPos = combinedText.indexOf("child-2-final-result");
      assert.ok(followUpPos >= 0, "user follow-up should be present in compacted span");
      assert.ok(arrivalPos >= 0, "final child arrival should be present in compacted span");
      assert.ok(followUpPos < arrivalPos, `expected user follow-up (${followUpPos}) before final arrival (${arrivalPos})`);
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "summary preserving followup-then-arrival order" } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    parentTurn += 1;
    if (parentTurn === 1) {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: `seeded ${bigBase}` } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (parentTurn === 2) {
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: "call-spawn-order",
          name: "spine_spawn",
          arguments: JSON.stringify({
            tasks: [
              { summary: "order-1", prompt: "Shared blackboard: /tmp/bb\npart 1" },
              { summary: "order-2", prompt: "Shared blackboard: /tmp/bb\npart 2" },
            ],
          }),
        },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    if (parentTurn === 3) {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "waiting for both children" } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    if (parentTurn === 4) {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "received child 1, waiting for child 2" } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    smallRequestMessages = request.messages;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "final answer in order" } };
    yield { type: "finish", reason: { kind: "stop" } };
  };

  try {
    const agent = await dsh.run("seed big context");
    const spawnTurn = dsh.send(agent, "spawn two branches");
    await Promise.all([child1Started.promise, child2Started.promise]);
    await spawnTurn;

    // Child 1 arrives while on the big model.
    child1Release.resolve();
    for (let i = 0; i < 40; i += 1) {
      await agent.whenIdle();
      const arrivals = agent.session.snapshotEvents().filter(
        (ev) => ev.type === "user/message" && ev.data.source.kind === "spine-arrival",
      );
      if (arrivals.length >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Queue a user follow-up WITHOUT waking (`inject` puts it in `nextStep`),
    // switch to the small model, and then let child 2 arrive (which calls `steer`
    // and appends AFTER the user follow-up in `nextStep` before waking the parent).
    agent.inject(createUserMessage({
      content: [{ type: "text", text: "USER_FOLLOWUP_BEFORE_ARRIVAL" }],
      source: { kind: "user" },
    }));
    switchModel(agent, "small");
    child2Release.resolve();
    while (true) {
      await agent.whenIdle();
      const idleSeq = agent.session.seq;
      if (!await (dsh.ctx.subagents.waitForTreeWork?.(agent) ?? dsh.ctx.subagents.waitForChildren(agent)) && agent.status === "idle" && agent.session.seq === idleSeq) {
        break;
      }
    }

    assert.equal(errors.length, 0, `unexpected errors: ${errors.map((e) => e.message).join("; ")}`);
    assert.ok(smallRequestMessages !== null, "small model should answer after compaction");

    // Check durable session log order: user follow-up event seq MUST be strictly less than child 2 arrival seq.
    const events = agent.session.snapshotEvents();
    const followUpEvent = events.find(
      (ev) => ev.type === "user/message" && text([ev.data]).includes("USER_FOLLOWUP_BEFORE_ARRIVAL"),
    );
    const arrival2Event = events.find(
      (ev) => ev.type === "user/message" && ev.data.source.kind === "spine-arrival" && text([ev.data]).includes("child-2-final-result"),
    );
    assert.ok(followUpEvent !== undefined, "user follow-up should be logged in session");
    assert.ok(arrival2Event !== undefined, "child 2 arrival should be logged in session");
    assert.ok(
      followUpEvent.seq < arrival2Event.seq,
      `expected user follow-up (seq ${followUpEvent.seq}) before child 2 arrival (seq ${arrival2Event.seq})`,
    );
  } finally {
    await dsh.dispose();
  }
});

test("persona.complete replaces default system sections in model-switch budget so a small model is not falsely rejected", async () => {
  const errors = [];
  const dsh = await mountAutoCompact([
    "reply on big",
    "reply on small",
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.8, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 256 },
      // Small model threshold is ~2,195 tokens. Default sections + Spine prompt exceed
      // 3,500 tokens, but `complete: true` replaces all of them with ~5 tokens!
      small: { contextWindow: 3_000, defaultMaxTokens: 256 },
    },
  });
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));
  const switchModel = setupModelSwitcher(dsh);

  // Add a huge default section that WOULD overflow the small model if not replaced,
  // plus a tiny `complete: true` persona section that replaces every default section.
  dsh.ctx.systemPrompt.section({
    name: "default-verbose-guide",
    order: 500,
    text: "verbose-default-instruction ".repeat(600),
  });
  dsh.ctx.systemPrompt.section({
    name: "custom-complete-persona",
    order: 0,
    text: "Be concise.",
    complete: true,
  });

  try {
    const agent = await dsh.run("hi on big");
    switchModel(agent, "small");
    await dsh.send(agent, "hi on small");
    assert.equal(errors.length, 0, `switch with persona.complete should succeed, got: ${errors[0]?.message}`);
    assert.equal(checkpoints(agent).length, 0, "short history + complete persona should fit without compaction");
    const lastRequest = dsh.adapter.requests.at(-1);
    assert.equal(lastRequest.model, "small");
  } finally {
    await dsh.dispose();
  }
});

test("changed runtime context (e.g. working directory update) is included in model-switch budget before sending to the smaller model", async () => {
  const mediumHistory = "existing-history ".repeat(110); // ~600 tokens
  let dynamicCwdText = "Working directory: /tmp/short";
  let compactedWith = null;
  let smallRequest = null;
  const errors = [];

  const dsh = await mountAutoCompact([
    mediumHistory,
    (request) => {
      if (request.purpose === "compaction") {
        compactedWith = request.model;
        return "compact summary before big runtime context";
      }
      smallRequest = request;
      return "answered on small after compact";
    },
    (request) => {
      smallRequest = request;
      return "answered on small after compact";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.8, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 256 },
      // Floor without dynamic runtime-context is ~2,300 tokens; history adds ~600 -> ~2,900 (< 3,795).
      // When runtime context grows by ~1,200 tokens, total becomes ~4,100 (>= 3,795),
      // while irreducible floor after compact (~3,500) still fits under 3,795!
      small: { contextWindow: 5_000, defaultMaxTokens: 256 },
    },
  });
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));
  const switchModel = setupModelSwitcher(dsh);

  dsh.ctx.systemPrompt.context({
    name: "dynamic-workdir-context",
    order: 100,
    text: () => dynamicCwdText,
  });

  try {
    const agent = await dsh.run("turn 1 with short cwd");

    // Runtime context grows substantially right before switching to the smaller model:
    // floor (~2,300) + new runtime context (~950) = ~3,250 < 3,796 (fits after compact),
    // while floor (~2,300) + history (~650) + new runtime context (~950) = ~3,900 >= 3,796 (triggers compact).
    dynamicCwdText = `Working directory: /workspace/new\n${"environment-detail-entry ".repeat(140)}`;
    switchModel(agent, "small");
    await dsh.send(agent, "turn 2 after cwd change");

    assert.equal(errors.length, 0, `unexpected error: ${errors[0]?.message}`);
    assert.equal(compactedWith, "scripted", "model-switch budget must account for the newly grown runtime context and compact with previous model first");
    assert.ok(smallRequest !== null && smallRequest.model === "small");
    assert.equal(checkpoints(agent).length, 1);
  } finally {
    await dsh.dispose();
  }
});

test("oversized tool-call arguments are not stripped or chunked; overflow after tool-result pruning surfaces cleanly", async () => {
  const hugeReplacement = Array.from({ length: 160 }, (_, i) => `const line_${i} = "replacement payload ${i}";`).join("\n");
  const editArgs = {
    file_path: "src/app.ts",
    old_string: "const old = 1;",
    new_string: hugeReplacement,
  };
  let summaryCalls = 0;

  const dsh = await mountAutoCompact([
    [["edit_file", editArgs]],
    "edit completed",
  ], {
    compactConfig: { auto: false, summarizationProvider: "scripted", summarizationModel: "tiny-sum" },
    modelWindows: {
      scripted: { contextWindow: 64_000, defaultMaxTokens: 512 },
      "tiny-sum": { contextWindow: 1_200, defaultMaxTokens: 200 },
    },
  });
  const baseStream = dsh.adapter.stream.bind(dsh.adapter);
  dsh.adapter.stream = async function* (request) {
    if (request.purpose === "compaction") {
      summaryCalls += 1;
      throw new Error("should fail fast when non-prunable tool-call args exceed single summary window");
    }
    yield* baseStream(request);
  };
  dsh.ctx.tools.register({
    name: "edit_file",
    description: "Edit a file with replacement text.",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      render: () => [{ type: "text", text: "ok" }],
    },
    execute: async () => ({ ok: true }),
  });

  try {
    const agent = await dsh.run("apply large edit");
    const result = await dsh.compact(agent);
    assert.equal(result.kind, "error");
    assert.match(result.text, /exceeds the model's context window even after pruning oversized tool results/i);
    assert.equal(summaryCalls, 0);
    assert.equal(checkpoints(agent).length, 0);
  } finally {
    await dsh.dispose();
  }
});

test("warm compaction skips the cache-warm attempt when historical images exceed safeInputBudget under imageRequestPricing", async () => {
  const compactionRequests = [];
  const dsh = await mountAutoCompact([
    "initial reply",
    "analyzed all attached screenshots",
    (request) => {
      compactionRequests.push(request);
      return "clean summary of image-heavy history";
    },
  ], {
    compactConfig: { auto: false },
    modelWindows: {
      // safeInputBudget = floor((8000 - 2000) * 0.85) = 5100 tokens.
      // 6 historical images priced at 1,000 visual tokens each = 6,000 > 5,100,
      // even though their JSON references total only ~200 tokens!
      scripted: { contextWindow: 8_000, defaultMaxTokens: 2_000 },
    },
  });
  dsh.adapter.imageRequestPricing = () => ({
    priceImages: (images) => images.map(() => ({ visualTokens: 1_000, text: "" })),
  });

  try {
    const agent = await dsh.run("start session");
    const imageBlocks = Array.from({ length: 6 }, (_, i) => ({
      type: "image",
      attachment: {
        id: `hist-img-${i}`,
        mimeType: "image/png",
        size: 120_000,
        sha256: String(i).repeat(64),
      },
    }));
    agent.followup(createUserMessage({
      content: [
        { type: "text", text: "review these six screenshots" },
        ...imageBlocks,
      ],
      source: { kind: "user" },
    }));
    await agent.whenIdle();

    const result = await dsh.compact(agent);
    assert.equal(result.kind, "success", result.text);
    assert.equal(compactionRequests.length, 1, "should go straight to clean summary without a wasted warm attempt");
    assert.equal(compactionRequests[0].tools, undefined, "clean fallback request must not carry conversation tools");
  } finally {
    await dsh.dispose();
  }
});

test("pruneOversizedToolResults prunes multi-block tool results by code point even when call IDs repeat, leaving non-tool messages intact", () => {
  const spineMemoryText = `<spine_memory node_id="1.1">\n${"M".repeat(12_000)}\n</spine_memory>`;
  const reusedIdText = "R".repeat(12_000);
  const block1 = "A".repeat(3_000);
  const block2 = "B".repeat(4_000);
  const block3 = "C".repeat(3_000); // total = 10,000 > 8,192 across 3 text blocks
  const messages = [
    {
      role: "developer",
      source: { kind: "spine" },
      content: [{ type: "text", text: spineMemoryText }],
    },
    {
      role: "assistant",
      source: { kind: "assistant" },
      content: [
        { type: "tool-call", id: "call-1", name: "spine_open", arguments: "{}" },
      ],
    },
    {
      role: "tool",
      source: { kind: "tool" },
      toolCallId: "call-1",
      content: [{ type: "text", text: "The node is open." }],
    },
    // Later step reuses the same toolCallId ("call-1") for a normal oversized tool result.
    {
      role: "assistant",
      source: { kind: "assistant" },
      content: [
        { type: "tool-call", id: "call-1", name: "bash", arguments: "{}" },
        { type: "tool-call", id: "bash-call-2", name: "bash", arguments: "{}" },
      ],
    },
    {
      role: "tool",
      source: { kind: "tool" },
      toolCallId: "call-1",
      content: [{ type: "text", text: reusedIdText }],
    },
    {
      role: "tool",
      source: { kind: "tool" },
      toolCallId: "bash-call-2",
      content: [
        { type: "text", text: block1 },
        { type: "text", text: block2 },
        { type: "text", text: block3 },
      ],
    },
  ];

  const { messages: pruned, prunedCount } = pruneOversizedToolResults(messages);
  assert.equal(prunedCount, 2);
  // Folded <spine_memory> (non-tool role) and short Spine tool result are untouched.
  assert.equal(pruned[0], messages[0]);
  assert.equal(pruned[0].content[0].text.length, spineMemoryText.length);
  assert.equal(pruned[2], messages[2]);
  // Oversized tool result reusing a past Spine toolCallId is still pruned.
  const reusedCombined = pruned[4].content.map((b) => b.text).join("");
  assert.ok(reusedCombined.includes("\n\n[... tool result middle pruned ...]\n\n"));
  assert.equal(Array.from(reusedCombined).length, 4_096 + Array.from("\n\n[... tool result middle pruned ...]\n\n").length + 1_024);
  // Multi-block tool result preserves head 4096 ("A"*3000 + "B"*1096) + marker + tail 1024 ("C"*1024).
  const combined = pruned[5].content.map((b) => b.text).join("");
  assert.ok(combined.startsWith("A".repeat(3_000) + "B".repeat(1_096)));
  assert.ok(combined.includes("\n\n[... tool result middle pruned ...]\n\n"));
  assert.ok(combined.endsWith("C".repeat(1_024)));
  assert.equal(Array.from(combined).length, 4_096 + Array.from("\n\n[... tool result middle pruned ...]\n\n").length + 1_024);
  // Original message array is untouched (in-memory only).
  assert.equal(messages[5].content[0].text.length, 3_000);
  assert.equal(messages[5].content[1].text.length, 4_000);
  assert.equal(messages[5].content[2].text.length, 3_000);
});

test("same-model compaction preserves session reasoningEffort in both warm and Stage 2 overflow paths", async () => {
  const compactionRequests = [];
  const hugeOutput = "H".repeat(12_000);
  const dsh = await mountAutoCompact([
    // Turn 1: regular reply under reasoningEffort: "xhigh"
    "turn-1-answer",
    // Manual /compact (Stage 1 warm)
    request => {
      compactionRequests.push(request);
      return {
        text: "Warm summary preserving reasoning effort.",
        usage: { inputTokens: 120, outputTokens: 20 },
      };
    },
    // Turn 2: call echo tool producing an oversized result, then hit overflow on next step
    [["echo", { payload: hugeOutput }]],
    () => {
      throw new LlmError("context length exceeded", "CONTEXT_WINDOW_EXCEEDED");
    },
    // Stage 2 clean pruned overflow recovery summary
    request => {
      compactionRequests.push(request);
      return {
        text: "Overflow pruned summary preserving reasoning effort.",
        usage: { inputTokens: 90, outputTokens: 18 },
      };
    },
    // Retried main request after overflow compaction
    "recovered-after-overflow",
  ], {
    modelWindows: {
      scripted: { contextWindow: 64_000, defaultMaxTokens: 2_000 },
    },
  });
  registerEchoTool(dsh, "echo");
  const baseResolve = dsh.adapter.resolveModel.bind(dsh.adapter);
  dsh.adapter.resolveModel = async (provider, model, signal) => {
    const info = await baseResolve(provider, model, signal);
    return {
      ...info,
      reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "xhigh", name: "Extra High" }] },
    };
  };

  try {
    const { agent } = await dsh.ctx.agents.create({
      sessionId: "session-reasoning-effort",
      meta: { cwd: dsh.root },
      agentOptions: {
        provider: "scripted",
        model: "scripted",
        reasoningEffort: "xhigh",
      },
    });
    await dsh.send(agent, "hello with xhigh reasoning");
    assert.equal(dsh.adapter.requests[0].reasoningEffort, "xhigh");

    const manual = await dsh.compact(agent);
    assert.equal(manual.kind, "success", manual.text);
    assert.equal(compactionRequests.length, 1);
    assert.equal(compactionRequests[0].reasoningEffort, "xhigh");
    assert.ok(Array.isArray(compactionRequests[0].tools), "Stage 1 warm request should carry tools");
    const saved = checkpoints(agent);
    assert.equal(saved.length, 1);
    assert.equal("reasoningEffort" in saved[0].data.source.calls[0], false, "CompactCall record must stay schema-clean");

    await dsh.send(agent, "trigger oversized tool result and overflow");
    assert.equal(compactionRequests.length, 2);
    assert.equal(compactionRequests[1].tools, undefined, "Stage 2 overflow request should be clean/tool-free");
    assert.equal(compactionRequests[1].reasoningEffort, "xhigh", "Stage 2 overflow summary must keep session reasoningEffort");
  } finally {
    await dsh.dispose();
  }
});

test("dedicated summarization model does not inherit a different conversation model's reasoningEffort", async () => {
  const compactionRequests = [];
  const dsh = await mountAutoCompact([
    "turn-1-answer",
    request => {
      compactionRequests.push(request);
      return "Dedicated summary.";
    },
  ], {
    compactConfig: {
      summarizationProvider: "scripted",
      summarizationModel: "summary-fast",
    },
    modelWindows: {
      scripted: { contextWindow: 64_000, defaultMaxTokens: 2_000 },
      "summary-fast": { contextWindow: 64_000, defaultMaxTokens: 2_000 },
    },
  });
  const baseResolve = dsh.adapter.resolveModel.bind(dsh.adapter);
  dsh.adapter.resolveModel = async (provider, model, signal) => {
    const info = await baseResolve(provider, model, signal);
    if (model === "scripted") {
      return { ...info, reasoning: { efforts: [{ id: "xhigh", name: "Extra High" }] } };
    }
    return info;
  };

  try {
    const { agent } = await dsh.ctx.agents.create({
      sessionId: "session-dedicated-summary",
      meta: { cwd: dsh.root },
      agentOptions: {
        provider: "scripted",
        model: "scripted",
        reasoningEffort: "xhigh",
      },
    });
    await dsh.send(agent, "hello on reasoning model");
    assert.equal(dsh.adapter.requests[0].reasoningEffort, "xhigh");

    const result = await dsh.compact(agent);
    assert.equal(result.kind, "success", result.text);
    assert.equal(compactionRequests.length, 1);
    assert.equal(compactionRequests[0].model, "summary-fast");
    assert.equal(compactionRequests[0].reasoningEffort, undefined);
  } finally {
    await dsh.dispose();
  }
});

test("/compact on a fresh session with no prior model requests invokes agent.model.current() cleanly", async () => {
  const compactionRequests = [];
  const dsh = await mountAutoCompact([
    request => {
      compactionRequests.push(request);
      return "Summary using agent.model.current() before any prior LLM request.";
    },
  ], {
    modelWindows: {
      scripted: { contextWindow: 64_000, defaultMaxTokens: 2_000 },
    },
  });
  const baseResolve = dsh.adapter.resolveModel.bind(dsh.adapter);
  dsh.adapter.resolveModel = async (provider, model, signal) => {
    const info = await baseResolve(provider, model, signal);
    return {
      ...info,
      reasoning: { efforts: [{ id: "xhigh", name: "Extra High" }] },
    };
  };

  try {
    // 1. Fresh session with configured model but zero LLM requests yet.
    const { agent: fresh } = await dsh.ctx.agents.create({
      sessionId: "session-fresh-no-requests",
      meta: { cwd: dsh.root },
      agentOptions: { provider: "scripted", model: "scripted" },
    });
    assert.equal(fresh.session.requestHeader(), undefined);
    const freshResult = await dsh.compact(fresh);
    assert.equal(freshResult.kind, "success", freshResult.text);
    assert.equal(freshResult.text, "No new conversation history to compact.");
    assert.equal(compactionRequests.length, 0);

    // 2. Fresh session with no model configured at all still reports no new history cleanly.
    const { agent: unconfigured } = await dsh.ctx.agents.create({
      sessionId: "session-fresh-no-model",
      meta: { cwd: dsh.root },
      agentOptions: {},
    });
    const unconfiguredResult = await dsh.compact(unconfigured);
    assert.equal(unconfiguredResult.kind, "success", unconfiguredResult.text);
    assert.equal(unconfiguredResult.text, "No new conversation history to compact.");
    assert.equal(compactionRequests.length, 0);

    // 3. Session with logged conversation but no requestHeader resolves agent.model.current() (including reasoningEffort).
    const { agent: selectedOnly } = await dsh.ctx.agents.create({
      sessionId: "session-selected-model-no-header",
      meta: { cwd: dsh.root },
      agentOptions: {},
    });
    selectedOnly.model.select({ provider: "scripted", model: "scripted", reasoningEffort: "xhigh" });
    selectedOnly.session.append(
      "user/message",
      createUserMessage({ content: [{ type: "text", text: "Unanswered history before first LLM request." }], source: { kind: "user" } }),
      { surfaceOp: "append" },
    );
    assert.equal(selectedOnly.session.requestHeader(), undefined);
    const selectedResult = await dsh.compact(selectedOnly);
    assert.equal(selectedResult.kind, "success", selectedResult.text);
    assert.equal(compactionRequests.length, 1);
    assert.equal(compactionRequests[0].provider, "scripted");
    assert.equal(compactionRequests[0].model, "scripted");
    assert.equal(compactionRequests[0].reasoningEffort, "xhigh");
  } finally {
    await dsh.dispose();
  }
});

test("same-model pre-step skips compaction when one new message alone exceeds the model input budget", async () => {
  const preservedHistory = "must-not-be-compacted-uselessly ".repeat(60);
  const giantPaste = "huge-pasted-document ".repeat(1_600);
  let compactionCalls = 0;
  const errors = [];

  const dsh = await mountAutoCompact([
    `reply ${preservedHistory}`,
    request => {
      if (request.purpose === "compaction") {
        compactionCalls += 1;
        return "SHOULD NOT SUMMARIZE";
      }
      throw new LlmError("context length exceeded", CONTEXT_WINDOW_EXCEEDED_CODE);
    },
    request => {
      if (request.purpose === "compaction") {
        compactionCalls += 1;
        return "SHOULD NOT SUMMARIZE ON OVERFLOW";
      }
      throw new Error(`unexpected retry request: ${request.model}`);
    },
  ], {
    withTokenMeter: true,
    // Keep default overflow retry enabled and route summaries to a larger model so an
    // unguarded agent/request-error hook would reach the scripted summarizer and compact.
    compactConfig: {
      auto: true,
      thresholdRatio: 0.75,
      summarizationProvider: "scripted",
      summarizationModel: "large-summary",
    },
    modelWindows: {
      scripted: { contextWindow: 8_000, defaultMaxTokens: 512 },
      "large-summary": { contextWindow: 64_000, defaultMaxTokens: 1_024 },
    },
  });
  dsh.ctx.on("agent/error", ({ error }) => errors.push(error));

  try {
    const agent = await dsh.run("seed history");
    await dsh.send(agent, giantPaste);

    assert.equal(compactionCalls, 0, "must not summarize old history during pre-step or overflow recovery when the new message alone exceeds input capacity");
    assert.equal(dsh.adapter.requests.length, 2, "only the seed request and the rejected oversized request should run");
    assert.equal(checkpoints(agent).length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, CONTEXT_WINDOW_EXCEEDED_CODE);
    assert.match(text(agent.session.deriveMessages()), /must-not-be-compacted-uselessly/);
  } finally {
    await dsh.dispose();
  }

  // Control: when the new message alone exceeds the ratio threshold (55% of 12,000 = 6,600)
  // but still fits inside the hard input budget (12,000 - 512 = 11,488) once prior history is
  // compacted, same-model pre-step compaction MUST still run.
  const bulkyOld = "compactable-prior-history ".repeat(450);
  const largeRecoverableNew = "moderate-new-input ".repeat(1_450);
  let controlCompactions = 0;
  const dshFit = await mountAutoCompact([
    `turn1 ${bulkyOld}`,
    request => {
      assert.equal(request.purpose, "compaction");
      controlCompactions += 1;
      return "compacted old history to make room";
    },
    request => {
      assert.notEqual(request.purpose, "compaction");
      assert.match(text(request.messages), /moderate-new-input/);
      return "fit-after-compaction";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.55, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 12_000, defaultMaxTokens: 512 },
    },
  });
  try {
    const agent = await dshFit.run("seed bulky history");
    await dshFit.send(agent, largeRecoverableNew);
    assert.equal(controlCompactions, 1, "recoverable same-model pressure above ratio threshold must still auto-compact");
    assert.equal(checkpoints(agent).length, 1);
  } finally {
    await dshFit.dispose();
  }
});

test("auto-compaction retains Anthropic thinking on the open tool-round assistant while stripping earlier rounds", async () => {
  const turn1Body = "turn1-padding ".repeat(900);
  const step2ToolPayload = "step2-result ".repeat(380);
  const anthropicReplay = (sig) => ({
    response: {
      kind: "pi-ai",
      version: 2,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "scripted",
      stopReason: "toolUse",
    },
    blocks: [{ type: "reasoning", thinkingSignature: sig }, { type: "tool-call" }],
  });

  let resumedStepMessages = null;
  const dsh = await mountAutoCompact([
    // Turn 1: build baseline history.
    `turn1-done ${turn1Body}`,
    // Turn 2 Step 1: earlier Anthropic tool round (will NOT be the open trailing round).
    {
      reasoning: "earlier-anthropic-thought",
      replayState: anthropicReplay("sig-earlier-round"),
      calls: [["echo", { payload: "small-step1-result" }]],
    },
    // Turn 2 Step 2: trailing open Anthropic tool round whose result crosses threshold.
    {
      reasoning: "open-tool-round-required-thought",
      replayState: anthropicReplay("sig-open-round"),
      calls: [["echo", { payload: step2ToolPayload }]],
    },
    // Auto-compaction summary call.
    request => {
      assert.equal(request.purpose, "compaction");
      return "Checkpoint before retained Anthropic tool rounds.";
    },
    // Turn 2 Step 3: continues the open tool round after auto-compaction.
    request => {
      assert.notEqual(request.purpose, "compaction");
      resumedStepMessages = request.messages;
      return "continued-anthropic-tool-round-ok";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.55, retainTokens: 3_500 },
    modelWindows: {
      scripted: { contextWindow: 12_000, defaultMaxTokens: 512 },
    },
  });
  registerEchoTool(dsh);

  try {
    const agent = await dsh.run("seed turn1");
    await dsh.send(agent, "run two anthropic tool rounds");

    const saved = checkpoints(agent);
    assert.equal(saved.length, 1, "expected one automatic compaction");
    assert.ok(resumedStepMessages !== null, "expected follow-up request continuing the open tool round");

    const assistants = resumedStepMessages.filter(m => m.role === "assistant");
    assert.equal(assistants.length, 2, "both unfinished-turn tool rounds should be retained in the tail");

    // Earlier round (not the open trailing round): reasoning and replayState MUST be stripped.
    assert.equal(
      assistants[0].content.some(b => b.type === "reasoning"),
      false,
      "earlier non-trailing Anthropic round must still have its stale reasoning stripped",
    );
    assert.equal(assistants[0].source.replayState, undefined);

    // Open trailing tool round: Anthropic thinking block and replayState MUST be preserved
    // so budget-based thinking can continue the tool round (and DSH bindThinkingToPrefix handles adaptive).
    const openReasoning = assistants[1].content.filter(b => b.type === "reasoning");
    assert.equal(openReasoning.length, 1, "open trailing Anthropic tool round must keep its thinking block");
    assert.equal(openReasoning[0].text, "open-tool-round-required-thought");
    assert.deepEqual(assistants[1].source.replayState, anthropicReplay("sig-open-round"));

    // Checkpoint metadata must list ONLY the earlier round in droppedReasoningSeqs, not the open round.
    const dropped = saved[0].data.source.droppedReasoningSeqs ?? [];
    assert.equal(dropped.length, 1, "only the earlier assistant should be recorded in droppedReasoningSeqs");
  } finally {
    await dsh.dispose();
  }
});

test("single retained Anthropic open tool-round assistant writes empty droppedReasoningSeqs and survives flush/reopen", async () => {
  const turn1Body = "turn1-padding ".repeat(900);
  const stepToolPayload = "step1-result ".repeat(380);
  const anthropicReplay = (sig) => ({
    response: {
      kind: "pi-ai",
      version: 2,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "scripted",
      stopReason: "toolUse",
    },
    blocks: [{ type: "reasoning", thinkingSignature: sig }, { type: "tool-call" }],
  });

  let liveResumedMessages = null;
  const dsh1 = await mountAutoCompact([
    // Turn 1: build baseline history.
    `turn1-done ${turn1Body}`,
    // Turn 2 Step 1: single Anthropic tool round whose result crosses threshold and is retained alone.
    {
      reasoning: "single-open-round-thought",
      replayState: anthropicReplay("sig-single-open-round"),
      calls: [["echo", { payload: stepToolPayload }]],
    },
    // Auto-compaction summary call.
    request => {
      assert.equal(request.purpose, "compaction");
      return "Checkpoint before single retained Anthropic tool round.";
    },
    // Turn 2 Step 2: live continuation after auto-compaction.
    request => {
      assert.notEqual(request.purpose, "compaction");
      liveResumedMessages = request.messages;
      return "continued-single-anthropic-round-ok";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.55, retainTokens: 3_500 },
    modelWindows: {
      scripted: { contextWindow: 12_000, defaultMaxTokens: 512 },
    },
  });
  registerEchoTool(dsh1);

  const root = dsh1.root;
  let sessionId;
  try {
    const agent = await dsh1.run("seed turn1");
    sessionId = agent.id;
    await dsh1.send(agent, "run single anthropic tool round");

    const saved = checkpoints(agent);
    assert.equal(saved.length, 1, "expected one automatic compaction");
    assert.equal(
      Object.hasOwn(saved[0].data.source, "droppedReasoningSeqs"),
      true,
      "checkpoint must explicitly persist droppedReasoningSeqs even when empty",
    );
    assert.deepEqual(
      saved[0].data.source.droppedReasoningSeqs,
      [],
      "single preserved Anthropic open tool-round assistant must record empty droppedReasoningSeqs",
    );
    const retainedEvents = (saved[0].data.source.retainedSeqs ?? []).map(seq => agent.session.eventAt(seq));
    assert.equal(
      retainedEvents.filter(e => e?.type === "assistant/message").length,
      1,
      "only the single open tool-round assistant should be retained in the tail",
    );
    assert.equal(
      retainedEvents.filter(e => e?.type === "tool/result").length,
      1,
      "the single open tool round's tool result should be retained in the tail",
    );
    assert.equal(
      agent.session.snapshotEvents().filter(e => e.type === WITHOUT_REASONING).length,
      0,
      "no without-reasoning event should be emitted when only the open Anthropic round is retained",
    );

    assert.ok(liveResumedMessages !== null, "expected live continuation request");
    const liveAssistants = liveResumedMessages.filter(m => m.role === "assistant");
    assert.equal(liveAssistants.length, 1);
    assert.equal(liveAssistants[0].content.filter(b => b.type === "reasoning")[0]?.text, "single-open-round-thought");
    assert.deepEqual(liveAssistants[0].source.replayState, anthropicReplay("sig-single-open-round"));

    await dsh1.ctx.sessions.flush(agent.session);
  } finally {
    await dsh1.dispose();
  }

  // Reopen the persisted session and send one follow-up request: recovery must NOT
  // treat explicit `droppedReasoningSeqs: []` as a legacy log and strip the retained assistant.
  let reopenedRequestMessages = null;
  const dsh2 = await mountAutoCompact([
    request => {
      assert.notEqual(request.purpose, "compaction");
      reopenedRequestMessages = request.messages;
      return "reopened-ok";
    },
  ], {
    root,
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.9 },
    modelWindows: {
      scripted: { contextWindow: 32_768, defaultMaxTokens: 512 },
    },
  });
  registerEchoTool(dsh2);

  try {
    const resumed = await dsh2.resume(sessionId);
    await dsh2.send(resumed, "follow up after reopen");

    assert.equal(
      resumed.session.snapshotEvents().filter(e => e.type === WITHOUT_REASONING).length,
      0,
      "reopen recovery must not emit without-reasoning for an explicit empty droppedReasoningSeqs checkpoint",
    );
    assert.ok(reopenedRequestMessages !== null, "expected follow-up request after reopen");
    const toolRoundAssistant = reopenedRequestMessages.find(
      m => m.role === "assistant" && m.content.some(b => b.type === "tool-call"),
    );
    assert.ok(toolRoundAssistant !== undefined, "expected retained Anthropic tool-round assistant after reopen");
    const reasoning = toolRoundAssistant.content.filter(b => b.type === "reasoning");
    assert.equal(reasoning.length, 1, "reopened request must keep reasoning for the adapter to decide");
    assert.equal(reasoning[0].text, "single-open-round-thought");
    assert.deepEqual(
      toolRoundAssistant.source.replayState,
      anthropicReplay("sig-single-open-round"),
      "reopened request must keep source.replayState for the adapter to decide",
    );
  } finally {
    await dsh2.dispose();
  }
});

test("model-switch budget subtracts mid-history system messages that DSH clears for non-in-history targets", async () => {
  const extraSystemText = "extra-mid-history-system-prompt ".repeat(260); // ~2,100 tokens
  let noInHistoryCompactions = 0;

  const dsh1 = await mountAutoCompact([
    "turn1 brief reply",
    request => {
      if (request.purpose === "compaction") {
        noInHistoryCompactions += 1;
        return "SHOULD NOT COMPACT";
      }
      assert.equal(request.model, "small-head-only");
      return "switched-without-unnecessary-compaction";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.75, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 64_000, defaultMaxTokens: 512, systemPromptUpdate: "in-history" },
      // Threshold = min(0.75*5600=4200, (5600-512)*0.8=4070) = 4,070.
      // Base (~2,300) + mid-history system (~2,100) = ~4,400 >= 4,070;
      // after clearing mid-history system: ~2,300 < 4,070 -> no compaction needed!
      "small-head-only": { contextWindow: 5_600, defaultMaxTokens: 512 },
    },
  });
  const switchModel1 = setupModelSwitcher(dsh1);

  try {
    const agent = await dsh1.run("hello");
    // Append a mid-history system/message as DSH does on `systemPromptUpdate: "in-history"` routes.
    agent.session.append(
      "system/message",
      { turn: 1, step: 1, message: createSystemMessage(extraSystemText) },
      { surfaceOp: "append" },
    );
    switchModel1(agent, "small-head-only");
    await dsh1.send(agent, "short follow-up");

    assert.equal(noInHistoryCompactions, 0, "must subtract mid-history system nodes that DSH clears for head-only targets");
    assert.equal(checkpoints(agent).length, 0);
  } finally {
    await dsh1.dispose();
  }

  // Control: when the target model ALSO supports `systemPromptUpdate: "in-history"`,
  // DSH keeps the mid-history system node, so the budget MUST still include it and compact.
  let inHistoryCompactions = 0;
  const dsh2 = await mountAutoCompact([
    "turn1 brief reply",
    request => {
      assert.equal(request.purpose, "compaction");
      inHistoryCompactions += 1;
      return "compacted for in-history target";
    },
    request => {
      assert.equal(request.model, "small-in-history");
      return "switched-after-compaction";
    },
  ], {
    withTokenMeter: true,
    compactConfig: { auto: true, thresholdRatio: 0.75, retainTokens: 0 },
    modelWindows: {
      scripted: { contextWindow: 64_000, defaultMaxTokens: 512, systemPromptUpdate: "in-history" },
      "small-in-history": { contextWindow: 5_600, defaultMaxTokens: 512, systemPromptUpdate: "in-history" },
    },
  });
  const switchModel2 = setupModelSwitcher(dsh2);

  try {
    const agent = await dsh2.run("hello");
    agent.session.append(
      "system/message",
      { turn: 1, step: 1, message: createSystemMessage(extraSystemText) },
      { surfaceOp: "append" },
    );
    switchModel2(agent, "small-in-history");
    await dsh2.send(agent, "short follow-up");

    assert.equal(inHistoryCompactions, 1, "in-history target keeps mid-history system nodes and must compact");
    assert.equal(checkpoints(agent).length, 1);
  } finally {
    await dsh2.dispose();
  }
});

test("warm summary budget accounts for retired historical tool declarations via projectToolUpdates", async () => {
  // Helper: seed one turn with `huge_legacy_tool` registered, then append a clean
  // declaration series baseline followed by a legal non-series `change` header and
  // `tool-removal` developer message (avoiding SpineJIT's empty `developer/message`
  // slots in `toolHistory.updates` so `projectToolUpdates` keeps the retired schema).
  async function runScenario(toolUpdate) {
    const compactionRequests = [];
    const dsh = await mountAutoCompact([
      "turn1 with huge legacy tool active",
      request => {
        assert.equal(request.purpose, "compaction");
        compactionRequests.push(request);
        return toolUpdate === "in-history"
          ? "clean summary skipping doomed warm request"
          : "warm summary when route ignores retired tools";
      },
    ], {
      withTokenMeter: true,
      compactConfig: { auto: false },
      modelWindows: {
        // summaryMaxTokens = 1000 -> safeInputBudget = floor(7000 * 0.85) = 5,950.
        // Active tools + messages (~2,800) fit below 5,950, but projectToolUpdates restores
        // the retired ~4,500-token legacy tool declaration -> ~7,300 > 5,950 -> skip warm directly!
        scripted: {
          contextWindow: 8_000,
          defaultMaxTokens: 1_000,
          ...(toolUpdate === undefined ? {} : { toolUpdate }),
        },
      },
    });

    dsh.ctx.tools.register({
      name: "huge_legacy_tool",
      description: `Retired tool with massive schema documentation. ${"schema-details ".repeat(1_200)}`,
      parameters: { type: "object", properties: { value: { type: "string" } } },
      output: {
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        render: () => [{ type: "text", text: "ok" }],
      },
      execute: async () => ({ ok: true }),
    });

    try {
      const agent = await dsh.run("turn1 enable legacy tool");
      const baselineHeader = agent.session.requestHeader();
      assert.ok(baselineHeader !== undefined);
      const activeTools = (baselineHeader.tools ?? []).filter(t => t.name !== "huge_legacy_tool");
      const retiredHeader = canonicalHeader({ ...baselineHeader, tools: activeTools });
      agent.session.append("request/header", { header: baselineHeader, reason: "series" });
      agent.session.append("request/header", { header: retiredHeader, reason: "change" });
      agent.session.append(
        "developer/message",
        {
          turn: 1,
          step: 1,
          message: createDeveloperMessage({
            source: { kind: "tool-registry" },
            content: [{ type: "tool-removal", toolName: "huge_legacy_tool" }],
          }),
        },
        { surfaceOp: "append" },
      );

      // Verify the active request header no longer lists `huge_legacy_tool`, while toolHistory still holds it.
      const activeToolNames = (agent.session.requestHeader()?.tools ?? []).map(t => t.name);
      assert.equal(activeToolNames.includes("huge_legacy_tool"), false, "active header tools must not list retired tool");
      const history = agent.session.toolHistory();
      assert.ok(
        history.tools.some(t => t.name === "huge_legacy_tool"),
        "session.toolHistory() must still retain the retired tool declaration",
      );
      const projected = projectToolUpdates(
        agent.session.deriveMessages(),
        agent.session.requestHeader()?.tools,
        toolUpdate,
        history,
      );
      assert.equal(
        projected.tools?.some(t => t.name === "huge_legacy_tool") ?? false,
        toolUpdate === "in-history",
        "projectToolUpdates should restore the retired tool iff toolUpdate is in-history",
      );

      const res = await dsh.compact(agent);
      assert.equal(res.kind, "success", res.text);
      return compactionRequests;
    } finally {
      await dsh.dispose();
    }
  }

  const inHistoryRequests = await runScenario("in-history");
  assert.equal(inHistoryRequests.length, 1, "must skip the doomed cache-warm call and issue only 1 clean call");
  assert.equal(inHistoryRequests[0].tools, undefined, "clean fallback summary must run without tools");

  // Control: with identical history on a route without toolUpdate, active tools alone fit
  // under safeInputBudget so cache-warm compaction runs with the active tool list.
  const noToolUpdateRequests = await runScenario(undefined);
  assert.equal(noToolUpdateRequests.length, 1);
  assert.ok(Array.isArray(noToolUpdateRequests[0].tools) && noToolUpdateRequests[0].tools.length > 0, "control route must use warm path");
  assert.equal(noToolUpdateRequests[0].tools.some(t => t.name === "huge_legacy_tool"), false);
});

test("user stop during model-switch or same-model pressure compaction restores claimed prompt to next-turn without auto-wakeup and delivers it once", { timeout: 10_000 }, async () => {
  const bigHistory = "large-turn1-context ".repeat(1200);

  for (const mode of ["model-switch", "same-model-pressure"]) {
    const promptText = `prompt-interrupted-during-${mode}`;
    const summaryStarted = Promise.withResolvers();
    const errors = [];
    let resumedCompactions = 0;

    const replies = [
      `big-reply ${bigHistory}`,
      async request => {
        assert.equal(request.purpose, "compaction");
        assert.equal(request.model, "scripted");
        await new Promise((_resolve, reject) => {
          const onAbort = () => reject(request.signal.reason ?? new Error("aborted"));
          if (request.signal.aborted) {
            onAbort();
            return;
          }
          request.signal.addEventListener("abort", onAbort, { once: true });
          summaryStarted.resolve();
        });
        return "unreachable-aborted-summary";
      },
      ...(mode === "same-model-pressure"
        ? [
          request => {
            assert.equal(request.purpose, "compaction");
            assert.equal(request.model, "scripted");
            resumedCompactions += 1;
            return "Resumed pressure checkpoint preserving turn 1 context.";
          },
        ]
        : []),
      request => {
        assert.notEqual(request.purpose, "compaction");
        assert.equal(request.model, "scripted");
        assert.match(text(request.messages), new RegExp(promptText));
        return `answered-restored-${mode}`;
      },
      request => {
        assert.notEqual(request.purpose, "compaction");
        assert.equal(request.model, "scripted");
        const body = text(request.messages);
        assert.match(body, new RegExp(promptText));
        assert.match(body, /continue-after-stop/);
        return `answered-continue-${mode}`;
      },
    ];

    const dsh = await mountAutoCompact(replies, {
      withTokenMeter: true,
      compactConfig: { auto: true, thresholdRatio: 0.5, retainTokens: 0 },
      modelWindows: {
        scripted: { contextWindow: mode === "model-switch" ? 32_768 : 12_000, defaultMaxTokens: 512 },
        small: { contextWindow: 6_000, defaultMaxTokens: 512 },
      },
    });
    const switchModel = setupModelSwitcher(dsh);
    dsh.ctx.on("agent/error", ({ error }) => errors.push(error));
    let agent;

    try {
      agent = await dsh.run("build turn 1 history");
      assert.equal(checkpoints(agent).length, 0);

      if (mode === "model-switch") {
        switchModel(agent, "small");
      }

      agent.followup(createUserMessage({
        content: [{ type: "text", text: promptText }],
        source: { kind: "user" },
      }));
      const idle = agent.whenIdle();
      await Promise.race([
        summaryStarted.promise,
        idle.then(() => assert.fail(`agent settled idle before ${mode} compaction started`)),
      ]);

      // Prompt has been claimed from inbox but has not yet been written to the session log.
      assert.equal(agent.inbox.nextTurn.length, 0, `${mode}: prompt should already be claimed from next-turn`);
      assert.equal(agent.inbox.nextStep.length, 0, `${mode}: prompt should not sit in next-step before cancel`);
      assert.equal(
        agent.session.snapshotEvents().filter(e => e.type === "user/message" && text([e.data]).includes(promptText)).length,
        0,
        `${mode}: prompt should not yet be appended to the session while summarizing`,
      );

      // Mimic Web Stop: user cancel with keepInbox: true.
      agent.cancel({ kind: "user" }, { keepInbox: true });
      await idle;

      assert.equal(agent.status, "idle", `${mode}: agent must settle idle after user stop`);
      assert.equal(dsh.adapter.requests.length, 2, `${mode}: only turn 1 and the cancelled compaction request may have run`);
      assert.equal(errors.length, 0, `${mode}: user stop must not emit an agent/error`);
      assert.equal(checkpoints(agent).length, 0, `${mode}: cancelled compaction must not commit a checkpoint`);
      assert.equal(agent.inbox.nextTurn.length, 1, `${mode}: claimed prompt must be restored to next-turn`);
      assert.equal(agent.inbox.nextStep.length, 0, `${mode}: claimed prompt must not be restored to next-step`);
      assert.match(text(agent.inbox.nextTurn), new RegExp(promptText));

      // Restoring to inbox must NOT auto-wake the agent.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(agent.status, "idle", `${mode}: restoring claimed prompt must not auto-wake the agent`);
      assert.equal(dsh.adapter.requests.length, 2, `${mode}: no request may run while stopped`);

      // Next turn resumes cleanly and delivers the restored prompt exactly once.
      if (mode === "model-switch") {
        switchModel(agent, "scripted");
      }
      await dsh.send(agent, "continue-after-stop");

      assert.equal(errors.length, 0, `${mode}: resume must complete without error`);
      assert.equal(agent.inbox.nextTurn.length, 0);
      assert.equal(agent.inbox.nextStep.length, 0);
      if (mode === "same-model-pressure") {
        assert.equal(resumedCompactions, 1, "same-model pressure resume must re-run compaction once");
        assert.equal(checkpoints(agent).length, 1);
      } else {
        assert.equal(checkpoints(agent).length, 0);
      }
      const loggedMatches = agent.session.snapshotEvents().filter(
        e => e.type === "user/message" && text([e.data]).includes(promptText),
      );
      assert.equal(loggedMatches.length, 1, `${mode}: restored prompt must be delivered exactly once`);
    } finally {
      agent?.cancel({ kind: "disposed" }, { keepInbox: true });
      await dsh.dispose();
    }
  }
});

test("archived session cancel and non-user cancel during compaction do not restore claimed input", { timeout: 10_000 }, async () => {
  const bigHistory = "large-turn1-context ".repeat(1200);

  const cases = [
    { label: "archive-during-model-switch", mode: "model-switch", archive: true, cause: { kind: "user" }, keepInbox: false },
    { label: "archive-during-pressure", mode: "same-model-pressure", archive: true, cause: { kind: "user" }, keepInbox: false },
    { label: "parent-cancel-during-model-switch", mode: "model-switch", archive: false, cause: { kind: "parent" }, keepInbox: true },
    { label: "disposed-cancel-during-pressure", mode: "same-model-pressure", archive: false, cause: { kind: "disposed" }, keepInbox: true },
  ];

  for (const scenario of cases) {
    const promptText = `prompt-dropped-${scenario.label}`;
    const summaryStarted = Promise.withResolvers();
    const archivedSessionIds = [];

    const dsh = await mountAutoCompact([
      `big-reply ${bigHistory}`,
      async request => {
        assert.equal(request.purpose, "compaction");
        await new Promise((_resolve, reject) => {
          const onAbort = () => reject(request.signal.reason ?? new Error("aborted"));
          if (request.signal.aborted) {
            onAbort();
            return;
          }
          request.signal.addEventListener("abort", onAbort, { once: true });
          summaryStarted.resolve();
        });
        return "unreachable";
      },
    ], {
      withTokenMeter: true,
      compactConfig: { auto: true, thresholdRatio: 0.5, retainTokens: 0 },
      modelWindows: {
        scripted: { contextWindow: scenario.mode === "model-switch" ? 32_768 : 12_000, defaultMaxTokens: 512 },
        small: { contextWindow: 6_000, defaultMaxTokens: 512 },
      },
    });
    dsh.ctx.reflect.provide("workspaceRegistry", { archivedSessionIds });
    const switchModel = setupModelSwitcher(dsh);
    let agent;

    try {
      agent = await dsh.run("build turn 1 history");
      if (scenario.mode === "model-switch") {
        switchModel(agent, "small");
      }

      agent.followup(createUserMessage({
        content: [{ type: "text", text: promptText }],
        source: { kind: "user" },
      }));
      const idle = agent.whenIdle();
      await Promise.race([
        summaryStarted.promise,
        idle.then(() => assert.fail(`agent settled idle before ${scenario.label} compaction started`)),
      ]);

      assert.equal(agent.inbox.nextTurn.length, 0);
      assert.equal(agent.inbox.nextStep.length, 0);

      if (scenario.archive) {
        // DSH updates the durable archive set before cancelling active work with { kind: "user" }.
        archivedSessionIds.push(agent.session.id);
      }
      agent.cancel(scenario.cause, { keepInbox: scenario.keepInbox });
      await idle;

      assert.equal(agent.status, "idle", `${scenario.label}: agent must settle idle`);
      assert.equal(dsh.adapter.requests.length, 2, `${scenario.label}: only turn 1 and the cancelled compaction request may have run`);
      assert.equal(checkpoints(agent).length, 0, `${scenario.label}: no checkpoint should commit`);
      assert.equal(agent.inbox.nextTurn.length, 0, `${scenario.label}: must NOT restore prompt to next-turn`);
      assert.equal(agent.inbox.nextStep.length, 0, `${scenario.label}: must NOT restore prompt to next-step`);
    } finally {
      agent?.cancel({ kind: "disposed" }, { keepInbox: true });
      await dsh.dispose();
    }
  }
});
