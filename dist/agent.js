import { setImmediate as yieldToLoop } from "node:timers/promises";
import { isAppendSurfaceEvent, pluginRecordOf } from "@deepseek-ai/dsh-session";
import { createHostAdapter, isSpineToolName, operationFromSpineToolCall, spineToolRefusal, spineToolResult, unarrivedBirths, } from "@spinejit/spine-sdk/host";
import { anchorPrefix, firstText, hasRepairedInlineAnchor, logAnchors, USER_ANCHORS } from "./anchors.js";
import { arrivalOf, beginsSampling, emptySlot, endsSampling, eventMessage, isUserSource, samplingSlot, sourceCharacter, SpineDshError, spineText, surfaceRole, } from "./events.js";
import { checkpointBuild, createCheckpointNodeRuntime } from "./checkpoint-runtime.js";
import { LatestCheckpoint } from "./reopen-checkpoint.js";
import { applySurfaceEdits, planItems, surfaceEdits } from "./projection.js";
import { dropReasoning, hasReasoning } from "./reasoning.js";
import { sessionBirth } from "./spawn.js";
export const SPINE_FEATURES = ["jit", "spawn"];
/**
 * One model response carries at most one Spine operation (the core admits one
 * per sampling). A second call is refused before it runs; the model sees a tool error.
 */
export class SpineToolLimitError extends Error {
    constructor(staged) {
        super(`only one Spine tool call is allowed per model response; ${staged} already ran in this one`);
        this.name = "SpineToolLimitError";
    }
}
/**
 * The Spine state of one DSH agent. One main-loop model request is one Spine
 * sampling: it begins with a marked empty slot in front of the response, and
 * its stretch of the log runs to the next sampling's slot or to the end of its
 * step. The surface follows the plan the core last published, edited when the
 * next step opens.
 *
 * The session log is the only record of this state. A sampling settles from
 * its stretch alone: the sources in it, the Spine call whose logged result is
 * not an error, and its response. Live and resumed agents settle it with the
 * same code, and when it settles does not change the result.
 */
export class SpineAgent {
    agent;
    #nodePrompt;
    #born;
    #changed;
    #adapter;
    #runtime;
    #checkpoint;
    #checkpointLifetime = new AbortController();
    /** Every session event seen, by seq. */
    #events = new Map();
    /** Logged sources the core has not observed yet, in log order. */
    #unobserved = [];
    #sourceSeqs = new Map();
    /** Each user message's number, by seq: the n-th the user wrote in the log. */
    #userNumbers = new Map();
    /** User messages numbered for the model: in a user-anchors record, or (0.1.1 and earlier) in their text. */
    #anchored = new Set();
    #anchorInText = new Set();
    #plan = null;
    #projection = null;
    /** Births whose arrival is in the log, by producer. */
    #entered = new Set();
    #recovering = false;
    // A preview at the end of recovery can expose pending input before its
    // next recorded sampling. That preview is not a reusable replay boundary.
    #recoveryPreview = false;
    #sampling = null;
    #turn = 0;
    #step = 0;
    #fault = null;
    constructor(agent, nodePrompt, born, changed) {
        this.agent = agent;
        this.#nodePrompt = nodePrompt;
        this.#born = born;
        this.#changed = changed;
    }
    static async create(agent, configToml, born, changed, storage, signal) {
        signal.throwIfAborted();
        const events = agent.session.snapshotEvents();
        const { thread, continuations } = forkNamespaces(events, agent.id, agent.session.header.parentSession);
        const checkpoint = new LatestCheckpoint(agent, storage, checkpointBuild(), configToml);
        const cached = await checkpoint.read(events, signal);
        signal.throwIfAborted();
        if (cached !== undefined) {
            const spine = await SpineAgent.#initialize(agent, agent.id, configToml, born, changed);
            try {
                signal.throwIfAborted();
                await spine.#runtime.importCheckpoint(cached.sdk);
                signal.throwIfAborted();
                spine.#installCheckpoint(events.slice(0, cached.through + 1), cached.host);
                await spine.#recover(events.slice(cached.through + 1), continuations, signal);
                signal.throwIfAborted();
                checkpoint.markRestored(cached.through);
                spine.#checkpoint = checkpoint;
                return spine;
            }
            catch {
                spine.dispose();
                signal.throwIfAborted();
            }
        }
        signal.throwIfAborted();
        const spine = await SpineAgent.#initialize(agent, thread, configToml, born, changed);
        spine.#checkpoint = checkpoint;
        try {
            await spine.#recover(events, continuations, signal);
            signal.throwIfAborted();
        }
        catch (error) {
            spine.dispose();
            throw error;
        }
        return spine;
    }
    static async #initialize(agent, thread, configToml, born, changed) {
        const runtime = createCheckpointNodeRuntime({ thread, features: SPINE_FEATURES, configToml });
        const spine = new SpineAgent(agent, runtime.nodePrompt(), born, changed);
        spine.#runtime = runtime;
        try {
            spine.#adapter = await createHostAdapter({
                runtime: runtime.client,
                host: {
                    // DSH has no ownership registry. Another writer that rewrites conversation
                    // context moves a plan source off the surface, and the projection faults.
                    claimOwnership: async () => { },
                    // Every fact a commit derives from is already in the session log.
                    persistArchive: async () => { },
                    context: {
                        materialize: async (context) => planItems(context, (id) => spine.#seqOf(id)),
                        publishAtomic: async (context) => {
                            spine.#plan = [...context.messages];
                            spine.#project(context.projection);
                        },
                    },
                },
                dispose: () => runtime.dispose(),
            });
        }
        catch (error) {
            runtime.dispose();
            throw error;
        }
        return spine;
    }
    #exportHostCheckpoint() {
        return {
            sourceSeqs: [...this.#sourceSeqs], userNumbers: [...this.#userNumbers],
            anchored: [...this.#anchored], anchorInText: [...this.#anchorInText], entered: [...this.#entered],
            plan: this.#plan, projection: this.#projection,
        };
    }
    #installCheckpoint(events, host) {
        for (const event of events)
            this.#events.set(event.seq, event);
        for (const [id, seq] of host.sourceSeqs) {
            this.#event(seq);
            this.#sourceSeqs.set(id, seq);
        }
        for (const [seq, number] of host.userNumbers) {
            if (!isUserSource(this.#event(seq)) || number !== this.#userNumbers.size + 1) {
                throw new SpineDshError("Checkpoint user numbers do not match the log.");
            }
            this.#userNumbers.set(seq, number);
        }
        for (const seq of host.anchored)
            this.#anchored.add(seq);
        for (const seq of host.anchorInText)
            this.#anchorInText.add(seq);
        for (const producer of host.entered)
            this.#entered.add(producer);
        for (const item of host.plan ?? [])
            if (item.type === "source")
                this.#event(item.seq);
        this.#plan = host.plan;
        this.#projection = host.projection;
    }
    /** Export a detached snapshot of a durable idle prefix without reserving the Agent. */
    async saveCheckpoint(configToml, pluginSignal) {
        const { agent } = this;
        const owner = AbortSignal.any([this.#checkpointLifetime.signal, pluginSignal]);
        if (owner.aborted || agent.status !== "idle" || this.fault !== null || this.#recovering
            || this.#recoveryPreview || this.#plan === null)
            return;
        const events = agent.session.snapshotEvents();
        const through = events.at(-1)?.seq;
        if (through === undefined || !this.#checkpoint.needsUpdate(through))
            return;
        if ([...this.#userNumbers.keys()].some((seq) => !this.#anchored.has(seq)))
            return;
        const sampling = this.#sampling;
        const host = this.#exportHostCheckpoint();
        let payload;
        if (sampling === null) {
            if (this.#unobserved.length !== 0)
                return;
            payload = { host, sdk: await this.#runtime.exportCheckpoint() };
        }
        else {
            // Capture the pre-sampling SDK state before yielding to another step.
            // Settle the final sampling on a separate runtime with the frozen tail,
            // no tool execution, message writes or tree publication.
            const end = events.findIndex((event) => event.seq === sampling.from);
            if (end < 0 || !beginsSampling(events[end]) || this.#unobserved.some((event) => event.seq < sampling.from))
                return;
            const tail = events.slice(end);
            if (!tail.some((event) => event.type === "step/end") || tail.slice(1).some((event) => beginsSampling(event) || isUserSource(event) || arrivalOf(event) !== null
                || pluginRecordOf(event)?.type === USER_ANCHORS
                || (event.type === "session/end-seed" && event.data.inherited)))
                return;
            const state = await this.#runtime.exportPreSamplingCheckpoint();
            const shadow = await SpineAgent.#initialize(agent, agent.id, configToml, async () => { }, () => { });
            try {
                await shadow.#runtime.importCheckpoint(state);
                shadow.#installCheckpoint(events.slice(0, end), host);
                await shadow.#recover(tail, new Map(), owner);
                if (shadow.#recoveryPreview)
                    return;
                payload = { host: shadow.#exportHostCheckpoint(), sdk: await shadow.#runtime.exportCheckpoint() };
            }
            finally {
                shadow.dispose();
            }
        }
        owner.throwIfAborted();
        if (await this.#checkpoint.flush() === false)
            return;
        await this.#checkpoint.write(events, payload, owner);
    }
    get projection() {
        return this.#projection;
    }
    get fault() {
        return this.#fault ?? this.#adapter.fault;
    }
    /** Index one event of this agent's session; a new source waits for observation. */
    accept(event) {
        if (this.#events.has(event.seq))
            return;
        this.#events.set(event.seq, event);
        if (isAppendSurfaceEvent(event) && surfaceRole(event) === "source")
            this.#unobserved.push(event);
        if (isUserSource(event))
            this.#userNumbers.set(event.seq, this.#userNumbers.size + 1);
        const record = pluginRecordOf(event);
        if (record?.type === USER_ANCHORS) {
            for (const { seq } of record.data.anchors)
                this.#anchored.add(seq);
        }
        const arrival = arrivalOf(event);
        if (arrival !== null)
            this.#entered.add(arrival.producer.join("."));
    }
    /** Births still pending whose arrival is not in the log yet. */
    openBirths() {
        if (this.#projection === null)
            return [];
        return unarrivedBirths(this.#projection).filter((birth) => !this.#entered.has(birth.producer.join(".")));
    }
    /** A step opened: bring the surface to the published plan. */
    async enterStep(turn, step) {
        this.#turn = turn;
        this.#step = step;
        await this.#guard(async () => {
            if (this.#plan === null)
                return;
            applySurfaceEdits(this.agent.session, surfaceEdits(this.#surface(), this.#plan), turn, step);
            dropReasoning(this.agent.session, this.#plan.flatMap((item) => item.type === "source" && item.withoutReasoning ? [item.seq] : []));
        });
    }
    /** A main-loop request is about to stream. Its messages must be the plan; it begins a sampling. */
    async beginSampling() {
        // A request retried in the same step ends the failed one's stretch.
        await this.settle();
        await this.#guard(async () => {
            await this.#prepare();
            this.#assertSurfaceShowsPlan();
            const session = this.agent.session;
            // The user messages this request is the first to carry, numbered for
            // every later request. DSH built this one from the log right after
            // logging them, with no point between, so it carries them as the user
            // wrote them; the logged messages, which clients show, stay so.
            const anchors = [...this.#userNumbers]
                .filter(([seq]) => !this.#anchored.has(seq))
                .map(([seq, anchor]) => ({ seq, anchor }));
            logAnchors(session, anchors);
            for (const { seq } of anchors)
                this.#anchored.add(seq);
            await this.#begin(session.seq);
            // Two empty slots before the response: room for what this sampling
            // puts in front of it (a Next: the closed node's memory). Nothing
            // follows it: a node it opens is described in the call's result.
            // The first marks in the log where the sampling began.
            for (const message of [samplingSlot(), emptySlot()]) {
                session.append("developer/message", { turn: this.#turn, step: this.#step, message }, { surfaceOp: "append" });
            }
        });
    }
    /**
     * Admit one Spine tool call of the current sampling and return its result
     * text, or throw the tool error the model sees. The sampling stages it when
     * it settles, if its logged result is not an error.
     */
    admit(name, args) {
        if (this.fault !== null)
            throw new SpineDshError("Spine context is faulted", { cause: this.fault });
        const sampling = this.#sampling;
        if (sampling === null)
            throw new SpineDshError(`${name} ran outside a Spine sampling`);
        if (sampling.called !== null)
            throw new SpineToolLimitError(sampling.called);
        // What the core would refuse at commit is a tool error now, not a fault later.
        const refusal = spineToolRefusal(this.#projection, name, this.#entered, sessionBirth(this.agent.id), this.#responseCalls(sampling.from));
        if (refusal !== null)
            throw new SpineDshError(refusal);
        const result = spineToolResult(this.#projection, name, args, this.#nodePrompt);
        sampling.called = name;
        return result;
    }
    /** Settle the open sampling, if any, over its stretch of the log so far. */
    async settle() {
        if (this.#sampling !== null)
            await this.#settle(this.#end(this.#sampling.from));
    }
    dispose() {
        this.#checkpointLifetime.abort();
        this.#adapter.dispose();
    }
    /**
     * Run the sampling lifecycle over a logged session, in log order: each
     * sampling begins at its marked slot and settles where its stretch ends,
     * or at the end of the log. A forked session continues in its own
     * namespace where its inherited prefix ends.
     */
    async #recover(events, continuations, signal) {
        signal.throwIfAborted();
        const possibleLegacyAnchors = [];
        this.#recovering = true;
        for (const [index, event] of events.entries()) {
            // SDK calls can resolve without yielding to the host. Give a reload
            // or shutdown a chance to cancel a long historical replay.
            if (index > 0 && index % 128 === 0)
                await yieldToLoop();
            signal.throwIfAborted();
            const sampling = beginsSampling(event);
            if (sampling) {
                // Older versions logged the anchor in the user text before sampling.
                // Only recognize that format on replay, with a logged Spine sampling
                // and no separate anchor record for that message.
                for (const seq of possibleLegacyAnchors) {
                    if (this.#anchored.has(seq))
                        continue;
                    this.#anchored.add(seq);
                    this.#anchorInText.add(seq);
                }
                possibleLegacyAnchors.length = 0;
            }
            const nextThread = continuations.get(event.seq);
            if (endsSampling(event) || nextThread !== undefined)
                await this.#settle(event.seq);
            if (nextThread !== undefined) {
                possibleLegacyAnchors.length = 0;
                await this.#guard(() => this.#continueNamespace(event.seq, nextThread));
            }
            this.accept(event);
            if (isUserSource(event)) {
                const prefix = anchorPrefix(this.#userNumbers.get(event.seq));
                if (firstText(eventMessage(event))?.startsWith(prefix))
                    possibleLegacyAnchors.push(event.seq);
            }
            // Restored logs can contain an inline number even if Spine did not run
            // for that reply. Require an earlier Spine anchor and a queued copy that
            // proves the number was added to the message after the user sent it.
            if (event.type === "assistant/message" && this.#anchored.size > 0) {
                for (const seq of possibleLegacyAnchors) {
                    if (this.#anchored.has(seq))
                        continue;
                    const user = this.#events.get(seq);
                    if (user?.type === "user/message" && hasRepairedInlineAnchor(this.#events, seq, user.data, this.#userNumbers.get(seq))) {
                        this.#anchored.add(seq);
                        this.#anchorInText.add(seq);
                    }
                }
            }
            // With Spine, a user message is numbered before the model answers it.
            if (event.type === "assistant/message" && [...this.#userNumbers.keys()].some((seq) => !this.#anchored.has(seq))) {
                throw new SpineDshError(`session ${this.agent.id} started without Spine: its user messages carry no [U#]`);
            }
            if (sampling) {
                await this.#guard(async () => {
                    await this.#prepare();
                    await this.#begin(event.seq);
                });
            }
        }
        signal.throwIfAborted();
        await this.settle();
        signal.throwIfAborted();
        // Observe the entire recovery tail, including pending user sources, repaired
        // inline anchors and DSH's synthetic Fork results, before applying the plan.
        this.#recoveryPreview = this.#unobserved.length > 0;
        if (this.#recoveryPreview)
            await this.#guard(() => this.#prepare());
        this.#recovering = false;
    }
    #project(projection) {
        this.#projection = projection;
        if (!this.#recovering)
            this.#changed(projection);
    }
    /**
     * Observe the inherited sources and continue in this session's namespace.
     * Births the parent made stay its own to join.
     */
    async #continueNamespace(cut, thread) {
        await this.#observe(cut);
        const source = await this.#adapter.continueNamespace(thread);
        for (const cell of source.cells)
            this.#sourceSeqs.set(sourceKey(cell.source_id), cell.boundary);
        await this.#adapter.previewAndPublish();
    }
    /** Observe every logged source and make sure a plan is published for it. */
    async #prepare() {
        if ((await this.#observe(Infinity)) > 0 || this.#plan === null)
            await this.#adapter.previewAndPublish();
    }
    async #begin(from) {
        await this.#adapter.beginSampling();
        this.#sampling = { from, called: null };
        this.#recoveryPreview = false;
    }
    /** Where the stretch of the sampling that began at `from` ends, as logged so far. */
    #end(from) {
        const next = this.agent.session.seq;
        for (let seq = from + 1; seq < next; seq += 1) {
            if (endsSampling(this.#event(seq)))
                return seq;
        }
        return next;
    }
    /** Settle the open sampling with its stretch of the log, which ends before `to`. */
    async #settle(to) {
        const sampling = this.#sampling;
        if (sampling === null)
            return;
        await this.#guard(async () => {
            const call = this.#spineCall(sampling.from, to);
            if (call !== null) {
                const operation = operationFromSpineToolCall(call.name, JSON.parse(call.args));
                await this.#adapter.registerExecution(call.callId);
                await this.#adapter.stageExecution(call.callId, call.callId, operation);
                await this.#adapter.finishExecution(call.callId, true);
            }
            const stoppedSpawn = !this.#recovering && call?.name === "spine_spawn" && this.#userStopped(sampling.from, to);
            const olderBirths = stoppedSpawn ? new Set(this.openBirths().map(({ producer }) => producer.join("."))) : null;
            await this.#observe(to);
            const outcome = this.#outcome(sampling.from, to);
            const result = await this.#adapter.finishSampling(outcome.terminal, outcome.inputTokens);
            this.#sampling = null;
            if (result.type !== "committed")
                return;
            this.#project(result.projection);
            if (!this.#recovering && call?.name === "spine_spawn") {
                const births = this.openBirths().filter(({ producer }) => !olderBirths?.has(producer.join(".")));
                await this.#born(births, sampling.from, stoppedSpawn);
            }
        });
    }
    /** Stop is logged at turn/end, after the sampling's step/end. */
    #userStopped(from, to) {
        const start = this.#event(from);
        if (start.type !== "developer/message")
            return false;
        const turn = start.data.turn;
        for (let seq = to; seq < this.agent.session.seq; seq += 1) {
            const event = this.#event(seq);
            if (event.type === "turn/start")
                return false;
            if (event.type === "turn/end" && event.data.turn === turn) {
                return event.data.reason.kind === "aborted" && event.data.reason.reason.kind === "user";
            }
        }
        return false;
    }
    /** Observe the unobserved sources logged before `to`. */
    async #observe(to) {
        const count = this.#unobserved.findIndex((event) => event.seq >= to);
        const events = this.#unobserved.splice(0, count < 0 ? this.#unobserved.length : count);
        if (events.length === 0)
            return 0;
        const ids = await this.#adapter.observeSources(events.map((event) => sourceCharacter(event, this.#anchorInText.has(event.seq))));
        if (ids.length !== events.length) {
            throw new SpineDshError(`Spine admitted ${ids.length} sources for ${events.length} events`);
        }
        ids.forEach((id, index) => this.#sourceSeqs.set(sourceKey(id), events[index].seq));
        return events.length;
    }
    /** Tool calls in the model response logged since `from`, the sampling's start. */
    #responseCalls(from) {
        for (let seq = this.agent.session.seq - 1; seq >= from; seq -= 1) {
            const event = this.#events.get(seq);
            if (event?.type === "assistant/message") {
                return event.data.message.content.filter((block) => block.type === "tool-call").length;
            }
        }
        return 1;
    }
    #seqOf(id) {
        const seq = this.#sourceSeqs.get(sourceKey(id));
        if (seq === undefined)
            throw new SpineDshError(`Spine plan names unknown source ${sourceKey(id)}`);
        return seq;
    }
    #surface() {
        return this.agent.session.surface.nodes.map((seq) => {
            const event = this.#event(seq);
            const role = surfaceRole(event);
            return { seq, role, text: role === "spine" ? spineText(eventMessage(event)) : null };
        });
    }
    /**
     * The request DSH just built is the published plan: no edit pending, and
     * every user message numbered as the plan numbers it, but those it is the
     * first to carry, which it shows as the user wrote them.
     */
    #assertSurfaceShowsPlan() {
        const plan = this.#plan;
        const edits = surfaceEdits(this.#surface(), plan);
        if (edits.length > 0) {
            throw new SpineDshError(`the model request differs from the Spine plan by ${edits.length} surface edits`);
        }
        for (const item of plan) {
            if (item.type !== "source")
                continue;
            if (item.withoutReasoning) {
                const shown = this.agent.session.deriveEventMessage(this.#event(item.seq));
                if (shown !== null && hasReasoning(shown)) {
                    throw new SpineDshError(`source ${item.seq} still shows its reasoning, which the Spine plan leaves out`);
                }
            }
            if (item.anchor === null || !this.#anchored.has(item.seq))
                continue;
            const event = this.#event(item.seq);
            const shown = this.agent.session.deriveEventMessage(event);
            const rawText = firstText(eventMessage(event)) ?? "";
            const prefix = anchorPrefix(item.anchor);
            const legacy = this.#anchorInText.has(item.seq);
            const expected = legacy ? rawText : prefix + rawText;
            if ((legacy && !rawText.startsWith(prefix)) || shown === null || firstText(shown) !== expected) {
                throw new SpineDshError(`source ${item.seq} does not show the expected user text for U${item.anchor}`);
            }
        }
    }
    #event(seq) {
        const event = this.#events.get(seq);
        if (event === undefined)
            throw new SpineDshError(`session event ${seq} was never seen`);
        return event;
    }
    /** The Spine call in the stretch [from, to) whose logged result is not an error, if any. */
    #spineCall(from, to) {
        const calls = new Map();
        for (let seq = from; seq < to; seq += 1) {
            const event = this.#event(seq);
            if (event.type === "tool/call" && isSpineToolName(event.data.name)) {
                calls.set(event.data.callId, { name: event.data.name, callId: event.data.callId, args: event.data.arguments });
            }
            else if (event.type === "tool/result" && event.data.message.isError !== true) {
                const call = calls.get(event.data.message.toolCallId);
                if (call !== undefined)
                    return call;
            }
        }
        return null;
    }
    /**
     * A sampling ends as its response did: completed when it was logged whole,
     * cancelled when it was interrupted, failed when none was logged.
     */
    #outcome(from, to) {
        for (let seq = from; seq < to; seq += 1) {
            const event = this.#event(seq);
            if (event.type !== "assistant/message")
                continue;
            const terminal = event.data.interrupted === true ? "cancelled" : "completed";
            const usage = event.data.usage;
            if (usage === undefined)
                return { terminal };
            // DSH reports uncached, cache-read, and cache-write input separately.
            const inputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
            return { terminal, inputTokens };
        }
        return { terminal: "failed" };
    }
    async #guard(operation) {
        if (this.fault !== null)
            throw new SpineDshError("Spine context is faulted", { cause: this.fault });
        try {
            return await operation();
        }
        catch (cause) {
            this.#fault ??= cause;
            throw new SpineDshError("Spine context fault", { cause });
        }
    }
}
/** Replay each inherited prefix before continuing in the namespace after its cut. */
function forkNamespaces(events, sessionId, parentSession) {
    const continuations = new Map();
    let thread = sessionId;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type !== "session/end-seed" || event.data.inherited !== true)
            continue;
        const parent = continuations.size === 0 ? parentSession : undefined;
        continuations.set(event.seq, thread);
        // Ordinary Fork does not record the source session ID. A stable namespace
        // per copied segment keeps its pending Spawn work owned by that segment.
        thread = parent ?? `dsh-inherited:${event.seq}`;
    }
    return { thread, continuations };
}
function sourceKey(id) {
    return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}
//# sourceMappingURL=agent.js.map