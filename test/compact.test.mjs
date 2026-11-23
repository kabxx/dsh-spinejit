import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { LlmError } from "@deepseek-ai/dsh-llm";

import { compactStatsDefinition } from "../dist/compact-stats.js";
import { mountDsh } from "./harness.mjs";

const commandModule = new URL("../dist/compact.js", import.meta.url).href;

async function mountCompact(replies, options, CommandRuntime, compactConfig) {
  const dsh = await mountDsh(replies, options);
  let command;
  if (CommandRuntime) await dsh.ctx.plugin(CommandRuntime).await();
  else dsh.ctx.reflect.provide("commands", {
    register(definition) {
      assert.equal(command, undefined);
      command = definition;
      return () => { command = undefined; };
    },
  });
  await dsh.ctx.loader.root.update([
    { id: "spinejit", name: new URL("../dist/index.js", import.meta.url).href },
    { id: "spine-compact", name: commandModule, ...(compactConfig === undefined ? {} : { config: compactConfig }) },
  ]);
  await dsh.ctx.loader.await();
  if (!CommandRuntime) assert.equal(command?.name, "compact");
  return { ...dsh, compact: (agent, rawInput = "", signal = new AbortController().signal) => command.handler({ agent, rawInput, signal }) };
}

async function disableSpine(dsh, agent) {
  const entry = dsh.ctx.loader.resolve("spinejit");
  const prior = entry.fiber;
  await entry.update({ disabled: true });
  await prior.dispose();
  assert.equal(dsh.ctx.agents.get(agent.id), agent);
  return async () => {
    await entry.update({ disabled: false });
    await dsh.ctx.loader.await();
    assert.notEqual(entry.fiber, prior);
    assert.equal(dsh.ctx.agents.get(agent.id), agent);
  };
}

function checkpoints(agent) {
  return agent.session.snapshotEvents().filter(event => event.type === "user/message" && event.data.source.kind === "spine-compact");
}

function statistics(event, history) {
  const definition = compactStatsDefinition;
  const match = definition.match(event);
  assert.equal(match?.role, "start");
  const start = { event, location: { kind: "session" } };
  const end = history.filter(item => item.seq < event.seq && item.type === "turn/end").at(-1);
  const state = definition.start({}, start, {
    previous(kind) {
      assert.equal(kind, "stats-turn-end");
      return end === undefined ? undefined : { matches: [{ event: end }] };
    },
  });
  return definition.buildViewNode({ ...match, key: match.id, kind: definition.kind, start, state });
}

test("Statistics counts only the summary body in a saved compact checkpoint", () => {
  const prefix = "Conversation checkpoint from SpineJIT /compact:\n\n";
  const history = [{ seq: 1, type: "turn/end", data: { turn: 1 } }];
  for (const [saved, expected] of [
    [prefix + "Done", 4],
    ["Done", 4],
    [prefix + prefix + "Done", prefix.length + 4],
    ["Before: " + prefix + "Done", "Before: ".length + prefix.length + 4],
  ]) {
    const event = {
      seq: 2,
      time: 0,
      type: "user/message",
      data: {
        source: { kind: "spine-compact", calls: [{ provider: "scripted", model: "scripted" }] },
        content: [{ type: "text", text: saved }],
      },
    };
    assert.equal(statistics(event, history).data.metrics.summaryChars, expected);
    assert.equal(event.data.content[0].text, saved);
  }
});

function text(messages) {
  return messages.flatMap(message => message.content.filter(block => block.type === "text").map(block => block.text)).join("\n");
}

async function resumeAndContinue(root) {
  const resumed = await mountCompact(["continued"], { root });
  try {
    const agent = await resumed.resume("session-1");
    await resumed.send(agent, "continue after checkpoint");
    assert.equal(resumed.adapter.requests.length, 1);
    assert.match(text(resumed.adapter.requests[0].messages), /checkpoint body/);
    assert.doesNotMatch(text(resumed.adapter.requests[0].messages), /original-answer-only/);
    assert.equal(checkpoints(agent).length, 1);
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === "turn/end").at(-1).data.reason.kind, "completed");
  } finally {
    await resumed.dispose();
  }
}

test("/compact applies a durable Spine checkpoint and can continue before or after restart", async () => {
  const summary = "checkpoint body\n\n- Preserved decision\n- Remaining work";
  const dsh = await mountCompact([
    [["spine_open", { goal: "old active task" }]],
    "original-answer-only",
    request => {
      assert.equal(request.purpose, "compaction");
      assert.match(text(request.messages), /original-answer-only/);
      return { text: summary, usage: { inputTokens: 1200, cacheReadTokens: 300, outputTokens: 9 } };
    },
    "kept working",
  ]);
  let recoveredRoot;
  try {
    const agent = await dsh.run("remember this");
    const oldLog = agent.session.snapshotEvents();
    const expectedShadowed = agent.session.surface.nodes.filter(
      seq => agent.session.eventAt(seq)?.type !== "system/message",
    );
    const result = await dsh.compact(agent);
    assert.equal(result.kind, "success", result.text);
    const [marker] = checkpoints(agent);
    assert.equal(result.sourceEventSeq, marker.seq);
    assert.equal(
      result.text,
      `Compacted conversation (~${marker.data.source.shadowedTokens.toLocaleString("en-US")} history tokens; summary used ~1,500 input tokens).\n\n${summary}`,
    );
    assert.equal(text([marker.data]), `Conversation checkpoint from SpineJIT /compact:\n\n${summary}`);
    // Replaces the entire non-system surface span atomically so token pressure
    // drops immediately and default Fork includes the replacement after the turn.
    const oldReply = oldLog.find(event => event.type === "assistant/message" &&
      event.data.message.content.some(block => block.type === "text" && block.text === "original-answer-only"));
    assert.ok(oldReply);
    assert.deepEqual(marker.surfaceOp, {
      op: "replace",
      startSeq: expectedShadowed[0],
      endSeq: expectedShadowed.at(-1),
    });
    assert.deepEqual(marker.sourceEventSeqs, expectedShadowed);
    const shadowPrice = agent.session.eventAt(marker.seq - 1);
    assert.equal(shadowPrice.type, "compaction/prune");
    assert.deepEqual(shadowPrice.data.shadowedRange, {
      start: expectedShadowed[0],
      end: expectedShadowed.at(-1),
    });
    assert.deepEqual(shadowPrice.data.shadowedSeqs, expectedShadowed);
    assert.ok(shadowPrice.data.shadowedTokenCount > 0);
    assert.match(text(agent.session.deriveMessages()), /checkpoint body/);
    assert.doesNotMatch(text(agent.session.deriveMessages()), /original-answer-only/);
    assert.doesNotMatch(text(agent.session.deriveMessages()), /remember this/);
    const stats = statistics(marker, oldLog);
    assert.equal(stats.target, "stats");
    assert.equal(stats.data.kind, "compaction");
    assert.equal(stats.data.metrics.turn, oldLog.filter(event => event.type === "turn/end").at(-1).data.turn);
    assert.equal(stats.data.metrics.context, 1500);
    assert.equal(stats.data.metrics.output, 9);
    assert.equal(stats.data.metrics.summaryChars, summary.length);
    assert.equal(stats.data.metrics.cacheHit, 0.2);
    assert.equal(stats.data.metrics.provider, "scripted");
    assert.equal(stats.data.metrics.model, "scripted");
    const reportedCall = marker.data.source.calls[0];
    const unreportedCall = { provider: reportedCall.provider, model: reportedCall.model };
    const withCalls = (calls) => ({ ...marker, data: { ...marker.data, source: { ...marker.data.source, calls } } });
    const partial = statistics(withCalls([reportedCall, unreportedCall]), oldLog).data.metrics;
    assert.equal(partial.context, 1500);
    assert.equal(partial.output, 9);
    assert.equal(partial.cacheRead, 300);
    assert.equal(partial.cacheHit, null);
    assert.equal(partial.model, "scripted");
    const absent = statistics(withCalls([unreportedCall]), oldLog).data.metrics;
    assert.equal(absent.context, null);
    assert.equal(absent.output, null);
    assert.equal(absent.cacheRead, null);
    assert.equal(absent.model, "scripted");
    assert.equal(statistics(marker, []), null, "an unloaded turn must not be guessed");
    assert.equal(compactStatsDefinition.match(oldLog.find(event => event.type === "user/message")), null);
    assert.equal(marker.data.source.barrier.boundary, marker.seq - 1);
    assert.deepEqual(marker.data.source.barrier.replacement_boundaries, [marker.seq]);
    assert.equal(marker.data.source.barrier.next_epoch, marker.data.source.barrier.previous_epoch + 1);
    assert.deepEqual(agent.session.snapshotEvents().slice(0, oldLog.length), oldLog);
    assert.match(text(agent.session.deriveMessages()), /checkpoint body/);
    assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages());
    const second = await dsh.compact(agent);
    assert.match(second.text, /No new conversation history/);
    assert.equal(checkpoints(agent).length, 1);
    recoveredRoot = await dsh.crashed();
    await dsh.send(agent, "live next request");
    assert.match(text(dsh.adapter.requests.at(-1).messages), /checkpoint body/);
    assert.doesNotMatch(text(dsh.adapter.requests.at(-1).messages), /original-answer-only/);
  } finally {
    await dsh.dispose();
  }
  await resumeAndContinue(recoveredRoot);
});

for (const cut of ["user message", "user anchor"]) {
  test(`/compact preserves user numbering after a crash at the ${cut}`, async () => {
    const pending = "pending source before compact";
    const first = await mountCompact(["original-answer-only", "reply lost to crash"]);
    let root;
    let pendingSeq;
    try {
      const agent = await first.run("start");
      await first.send(agent, pending);
      root = await first.crashed();
      const dir = join(root, "sessions");
      const files = (await readdir(dir, { recursive: true })).filter(name => name.endsWith(".jsonl"));
      assert.equal(files.length, 1);
      const path = join(dir, files[0]);
      const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
      const events = lines.map(line => JSON.parse(line));
      const user = events.findIndex(event => event.type === "user/message" &&
        event.data.content.some(block => block.text === pending));
      assert.ok(user > 0);
      pendingSeq = events[user].seq;
      const anchor = events.findIndex((event, index) => index > user && event.type === "plugin:spinejit/user-anchors" &&
        event.data.anchors.some(entry => entry.seq === pendingSeq));
      assert.ok(anchor > user);
      const last = cut === "user message" ? user : anchor;
      await writeFile(path, lines.slice(0, last + 1).join("\n") + "\n");
    } finally {
      await first.dispose();
    }

    const dsh = await mountCompact([
      request => {
        assert.equal(request.purpose, "compaction");
        assert.match(text(request.messages), new RegExp(pending));
        return "checkpoint body";
      },
      "continued without restarting",
    ], { root });
    let recoveredRoot;
    try {
      const agent = await dsh.resume("session-1");
      assert.ok(agent.session.surface.nodes.includes(pendingSeq));
      const result = await dsh.compact(agent);
      assert.equal(result.kind, "success", result.text);
      const [marker] = checkpoints(agent);
      assert.equal(
        result.text,
        `Compacted conversation (~${marker.data.source.shadowedTokens.toLocaleString("en-US")} history tokens).\n\ncheckpoint body`,
      );
      assert.equal(marker.surfaceOp.op, "replace");
      assert.equal(marker.surfaceOp.endSeq, pendingSeq);
      assert.ok(marker.sourceEventSeqs.includes(pendingSeq));
      const anchors = agent.session.snapshotEvents().filter(event => event.type === "plugin:spinejit/user-anchors" &&
        event.data.anchors.some(entry => entry.seq === pendingSeq));
      assert.equal(anchors.length, 1);
      assert.ok(anchors[0].seq < marker.seq, "record the user's number before replacing the message");
      recoveredRoot = await dsh.crashed();
      await dsh.send(agent, "continue without restarting");
      assert.equal(dsh.adapter.requests.length, 2);
      assert.match(text(dsh.adapter.requests[1].messages), /checkpoint body/);
      assert.match(text(dsh.adapter.requests[1].messages), /continue without restarting/);
    } finally {
      await dsh.dispose();
    }
    await resumeAndContinue(recoveredRoot);
  });
}

test("/compact preserves the call ID and failure status of each tool result in both warm and clean modes", async () => {
  const identicalContent = [{ type: "text", text: "Error: identical result" }];
  const probeTool = {
    name: "probe",
    description: "Return the same text for success and failure.",
    parameters: { type: "object", properties: { fail: { type: "boolean" } }, required: ["fail"] },
    output: { schema: { type: "object", properties: {} }, render: () => identicalContent },
    execute: async ({ fail }) => {
      if (fail) throw new Error("identical result");
      return {};
    },
  };

  // Part A: cache-warm mode preserves native tool-call IDs and tool-result isError flags.
  const dshWarm = await mountCompact([
    [["probe", { fail: false }], ["probe", { fail: true }]],
    "both tools returned",
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.messages[0].role, "system");
      assert.ok(Array.isArray(request.tools) && request.tools.length > 0);
      const calls = request.messages.filter(message => message.role === "assistant")
        .flatMap(message => message.content.filter(block => block.type === "tool-call"));
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0].id, calls[1].id);
      const results = request.messages.filter(message => message.role === "tool");
      assert.equal(results.length, 2);
      const okResult = results.find(result => result.toolCallId === calls[0].id);
      const errResult = results.find(result => result.toolCallId === calls[1].id);
      assert.deepEqual(okResult.content, identicalContent);
      assert.equal(okResult.isError === true, false);
      assert.deepEqual(errResult.content, identicalContent);
      assert.equal(errResult.isError, true);
      return "warm checkpoint body";
    },
  ]);
  try {
    dshWarm.ctx.tools.register(probeTool);
    const agent = await dshWarm.run("try both tools warm");
    const results = agent.session.deriveMessages().filter(message => message.role === "tool");
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.content[0]?.text === identicalContent[0].text));
    assert.deepEqual(results.map(result => result.isError === true).sort(), [false, true]);
    const result = await dshWarm.compact(agent);
    assert.equal(result.kind, "success", result.text);
  } finally {
    await dshWarm.dispose();
  }

  // Part B: clean tool-free mode (e.g. dedicated summarization model) preserves toolCallId and isError in JSONL.
  const dshClean = await mountCompact([
    [["probe", { fail: false }], ["probe", { fail: true }]],
    "both tools returned",
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.tools, undefined);
      const transcript = text(request.messages).split("\n").map(line => JSON.parse(line));
      const calls = transcript.filter(message => message.role === "assistant")
        .flatMap(message => message.content.filter(block => block.type === "tool-call"));
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0].id, calls[1].id);
      const results = transcript.filter(message => message.role === "tool");
      assert.equal(results.length, 2);
      assert.deepEqual(results.find(result => result.toolCallId === calls[0].id), {
        role: "tool", content: identicalContent, toolCallId: calls[0].id, isError: false,
      });
      assert.deepEqual(results.find(result => result.toolCallId === calls[1].id), {
        role: "tool", content: identicalContent, toolCallId: calls[1].id, isError: true,
      });
      return "clean checkpoint body";
    },
  ], {}, undefined, {
    auto: false,
    summarizationProvider: "scripted",
    summarizationModel: "summarizer-dedicated",
  });
  try {
    dshClean.ctx.tools.register(probeTool);
    const agent = await dshClean.run("try both tools clean");
    const result = await dshClean.compact(agent);
    assert.equal(result.kind, "success", result.text);
  } finally {
    await dshClean.dispose();
  }
});

test("/compact reattaches the same idle agent after a Spine reload without another user message", { timeout: 10_000 }, async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const dsh = await mountCompact([
    "original-answer-only",
    async request => {
      assert.equal(request.purpose, "compaction");
      assert.match(text(request.messages), /original-answer-only/);
      started.resolve();
      await release.promise;
      return "checkpoint body";
    },
    "continued",
  ]);
  try {
    const agent = await dsh.run("task");
    const original = agent.session.snapshotEvents();
    const enableSpine = await disableSpine(dsh, agent);
    const disabled = await dsh.compact(agent);
    assert.equal(disabled.kind, "error");
    assert.match(disabled.text, /SpineJIT is unavailable/);
    assert.equal(dsh.adapter.requests.length, 1);
    await enableSpine();
    const compact = dsh.compact(agent);
    await Promise.race([started.promise, compact.then(result => assert.fail(result.text))]);
    const concurrent = await dsh.compact(agent);
    assert.equal(concurrent.kind, "error");
    release.resolve();
    const result = await compact;
    assert.equal(result.kind, "success", result.text);
    assert.deepEqual(agent.session.snapshotEvents().slice(0, original.length), original);
    assert.deepEqual(agent.session.snapshotEvents().slice(original.length)
      .filter(event => event.type === "user/message"), checkpoints(agent));
    assert.equal(checkpoints(agent).length, 1);
    await dsh.send(agent, "after reload and compact");
    assert.match(text(dsh.adapter.requests.at(-1).messages), /checkpoint body/);
    assert.doesNotMatch(text(dsh.adapter.requests.at(-1).messages), /original-answer-only/);
  } finally {
    release.resolve();
    await dsh.dispose();
  }
});

test("a checkpoint saved before its surface edits is recoverable", async () => {
  const dsh = await mountCompact(["original-answer-only", "checkpoint body"]);
  let root;
  try {
    const agent = await dsh.run("task");
    const flush = dsh.ctx.sessions.flush;
    let count = 0;
    dsh.ctx.sessions.flush = async function (session) {
      count++;
      // The first flush is the preflight. The second persists the checkpoint.
      const result = await flush.call(this, session);
      if (count === 2) root = await dsh.crashed();
      return result;
    };
    assert.equal((await dsh.compact(agent)).kind, "success");
    assert.ok(root);
    dsh.ctx.sessions.flush = flush;
  } finally {
    await dsh.dispose();
  }
  await resumeAndContinue(root);
});

test("a cancelled or incomplete summary does not change the model context", async () => {
  const dsh = await mountCompact(["original-answer-only", { text: "incomplete", finish: "max-tokens" }]);
  try {
    const agent = await dsh.run("task");
    const original = agent.session.deriveMessages();
    assert.equal((await dsh.compact(agent, "arguments")).kind, "error");
    const cancelled = await dsh.compact(agent, "", AbortSignal.abort());
    assert.equal(cancelled.kind, "error");
    assert.equal(cancelled.text, "Compaction cancelled.");
    assert.equal((await dsh.compact(agent)).kind, "error");
    assert.deepEqual(agent.session.deriveMessages(), original);
    assert.equal(checkpoints(agent).length, 0);
    assert.equal(dsh.adapter.requests.length, 2);
  } finally {
    await dsh.dispose();
  }
});

test("/compact recovers an unanswered turn after warm overflow by pruning oversized tool results in memory", async () => {
  const overflow = () => { throw new LlmError("Context window exceeded", "CONTEXT_WINDOW_EXCEEDED"); };
  const hugeToolText = `TOOL_HEAD_MARKER ${"middle-log-padding ".repeat(600)} TOOL_TAIL_MARKER`;
  assert.ok(hugeToolText.length > 8_192);
  const prunedUsage = { inputTokens: 250, cacheReadTokens: 20, cacheWriteTokens: 10, outputTokens: 28 };
  const dsh = await mountCompact([
    "original-answer-only",
    "first checkpoint",
    [["big_log", {}]],
    // Model request after big_log returns CONTEXT_WINDOW_EXCEEDED (turn left unanswered).
    overflow,
    // Manual /compact warm attempt hits CONTEXT_WINDOW_EXCEEDED.
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.maxTokens, 2048);
      assert.ok(Array.isArray(request.tools) && request.tools.length > 0);
      assert.match(text(request.messages), /unanswered-start/);
      assert.match(text(request.messages), /TOOL_HEAD_MARKER/);
      return overflow();
    },
    // Stage 2: single clean summary with >8,192-char tool result pruned in memory (head + marker + tail).
    request => {
      assert.equal(request.purpose, "compaction");
      assert.equal(request.maxTokens, 2048);
      assert.equal(request.tools, undefined);
      const body = text(request.messages);
      assert.match(body, /unanswered-start/);
      assert.match(body, /TOOL_HEAD_MARKER/);
      assert.match(body, /TOOL_TAIL_MARKER/);
      assert.match(body, /\[\.\.\. tool result middle pruned \.\.\.\]/);
      return { text: "checkpoint body", usage: prunedUsage };
    },
    "continued",
  ], {}, undefined, { auto: false });
  dsh.ctx.tools.register({
    name: "big_log",
    description: "Return an oversized tool log.",
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    execute: async () => ({ text: hugeToolText }),
  });
  const resolveModel = dsh.adapter.resolveModel.bind(dsh.adapter);
  dsh.adapter.resolveModel = async (...args) => ({
    ...await resolveModel(...args),
    context: { contextWindow: 32_768 },
    defaultMaxTokens: 2048,
  });
  const route = { provider: "scripted", model: "scripted" };
  const expectedCalls = [
    route,
    { ...route, usage: prunedUsage },
  ];
  let root;
  try {
    const agent = await dsh.run("task");
    assert.equal((await dsh.compact(agent)).kind, "success");
    await dsh.send(agent, "unanswered-start inspect big log");
    const oldLog = agent.session.snapshotEvents();
    const result = await dsh.compact(agent);
    assert.equal(result.kind, "success", result.text);
    assert.ok(result.sourceEventSeq);
    assert.equal(checkpoints(agent).length, 2);
    assert.deepEqual(checkpoints(agent)[1].data.source.calls, expectedCalls);
    const stats = statistics(checkpoints(agent)[1], oldLog);
    assert.equal(stats.data.metrics.context, 280);
    assert.equal(stats.data.metrics.output, 28);
    assert.equal(stats.data.metrics.cacheRead, 20);
    assert.equal(stats.data.metrics.cacheWrite, 10);
    assert.equal(stats.data.metrics.cacheHit, null);
    assert.equal(stats.data.metrics.provider, route.provider);
    assert.equal(stats.data.metrics.model, route.model);
    assert.equal(
      result.text,
      `Compacted conversation (~${checkpoints(agent)[1].data.source.shadowedTokens.toLocaleString("en-US")} history tokens; summary used ~280 input tokens).\n\ncheckpoint body`,
    );
    assert.deepEqual(agent.session.snapshotEvents().slice(0, oldLog.length), oldLog);
    root = await dsh.crashed();
    await dsh.send(agent, "try again");
    assert.match(text(dsh.adapter.requests.at(-1).messages), /checkpoint body/);
    assert.doesNotMatch(text(dsh.adapter.requests.at(-1).messages), /unanswered-start/);
  } finally {
    await dsh.dispose();
  }
  const resumed = await mountCompact(["continued"], { root });
  try {
    const agent = await resumed.resume("session-1");
    await resumed.send(agent, "continue after restarting");
    assert.match(text(resumed.adapter.requests.at(-1).messages), /checkpoint body/);
    assert.equal(checkpoints(agent).length, 2);
    assert.deepEqual(checkpoints(agent)[1].data.source.calls, expectedCalls);
  } finally {
    await resumed.dispose();
  }
});

test("a missing durable writer rejects before making a checkpoint", async () => {
  const dsh = await mountCompact(["original-answer-only", "checkpoint body", "continued"]);
  try {
    const agent = await dsh.run("task");
    const flush = dsh.ctx.sessions.flush;
    try {
      dsh.ctx.sessions.flush = async () => false;
      const result = await dsh.compact(agent);
      assert.equal(result.kind, "error");
      assert.match(result.text, /No session persistence/);
      assert.equal(checkpoints(agent).length, 0);
    } finally {
      dsh.ctx.sessions.flush = flush;
    }
    await dsh.send(agent, "work can continue");
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === "turn/end").at(-1).data.reason.kind, "completed");
  } finally {
    await dsh.dispose();
  }
});

test("cancellation at the commit boundary cannot interrupt a written checkpoint", async () => {
  const dsh = await mountCompact(["original-answer-only", "checkpoint body", "continued"]);
  try {
    const agent = await dsh.run("task");
    const flush = dsh.ctx.sessions.flush;
    const abort = new AbortController();
    try {
      dsh.ctx.sessions.flush = async function (session) {
        if (checkpoints(agent).length === 1) abort.abort();
        return flush.call(this, session);
      };
      assert.equal((await dsh.compact(agent, "", abort.signal)).kind, "success");
      assert.ok(abort.signal.aborted);
      assert.equal(checkpoints(agent).length, 1);
    } finally {
      dsh.ctx.sessions.flush = flush;
    }
    await dsh.send(agent, "continue after checkpoint");
    assert.match(text(dsh.adapter.requests.at(-1).messages), /checkpoint body/);
    assert.doesNotMatch(text(dsh.adapter.requests.at(-1).messages), /original-answer-only/);
  } finally {
    await dsh.dispose();
  }
});


let commandRuntimeUrl;
let commandBuiltinUrl;
try {
  commandRuntimeUrl = import.meta.resolve("@deepseek-ai/dsh-commands");
  commandBuiltinUrl = import.meta.resolve("@deepseek-ai/dsh-commands/builtin");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND" && error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
}

if (commandRuntimeUrl) test("the Web command registry executes /compact and records its result", async () => {
  const { default: CommandRuntime } = await import(commandRuntimeUrl);
  const dsh = await mountCompact(["original-answer-only", "checkpoint body", "continued"], {}, CommandRuntime);
  try {
    const agent = await dsh.run("task");
    const definition = dsh.ctx.commands.find(agent, "compact");
    assert.equal(definition.definitionId, "@deepseek-ai/dsh-command-compact");
    let commandName = definition.name;
    if (commandBuiltinUrl) {
      const { resolveCommand } = await import(commandBuiltinUrl);
      assert.equal(resolveCommand("compact", [definition]), definition);
      const chinese = resolveCommand("压缩", [definition]);
      assert.equal(chinese, definition);
      // The Web client's command directory resolves aliases before sending the name.
      commandName = chinese.name;
    }
    const enableSpine = await disableSpine(dsh, agent);
    await enableSpine();
    const execution = await dsh.ctx.commands.execute(agent, `/${commandName}`, [], new AbortController().signal);
    assert.equal(execution.result.kind, "success", execution.result.text);
    assert.match(execution.result.text, /\n\ncheckpoint body$/);
    assert.equal(execution.result.sourceEventSeq, checkpoints(agent)[0].seq);
    const receipt = agent.session.snapshotEvents().find(event => event.type === "command/done" && event.data.commandId === execution.commandId);
    assert.equal(receipt?.data.kind, "success");
    assert.equal(receipt.data.text, execution.result.text);
    assert.equal(receipt.data.sourceEventSeq, execution.result.sourceEventSeq);
    await dsh.send(agent, "continue after slash command");
    assert.match(text(dsh.adapter.requests.at(-1).messages), /checkpoint body/);
    assert.doesNotMatch(text(dsh.adapter.requests.at(-1).messages), /original-answer-only/);
    assert.deepEqual(await dsh.restored(agent), agent.session.deriveMessages());
  } finally {
    await dsh.dispose();
  }
});
