import type { Message, UserMessage } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-compaction";
import { isAppendSurfaceEvent, pluginRecordOf, SessionSeq, type EpochHeader, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import type { CompactBarrier, EpochOrdinalId, FeatureFlag, SpineProjection, Terminal } from "@spinejit/spine-sdk";
import {
  createHostAdapter,
  isSpineToolName,
  operationFromSpineToolCall,
  spineToolRefusal,
  spineToolResult,
  unarrivedBirths,
  type SpawnBirth,
  type SpineHostAdapter,
  type SpineToolName,
} from "@spinejit/spine-sdk/host";
import { createNodeSpineRuntime } from "@spinejit/spine-sdk/node";

import { anchorPrefix, firstText, hasRepairedInlineAnchor, logAnchors, USER_ANCHORS, type UserAnchor } from "./anchors.js";
import {
  estimateEffectiveTokens,
  hasNewConversation,
  selectCompactPlan,
  type CompactSelection,
  type MessagePricingContext,
} from "./compact-range.js";
import {
  arrivalOf,
  beginsSampling,
  compactBarrierOf,
  compactDroppedReasoningSeqsOf,
  compactMessage,
  compactRetainedSeqsOf,
  emptySlot,
  endsSampling,
  eventMessage,
  isUserSource,
  samplingSlot,
  sourceCharacter,
  SpineDshError,
  spineText,
  surfaceRole,
  type CompactSummary,
  type CompactTrigger,
} from "./events.js";
import { applySurfaceEdits, planItems, surfaceEdits, type PlanItem, type SurfaceNode } from "./projection.js";
import { dropReasoning, hasReasoning, isAnthropicMessagesReplay } from "./reasoning.js";
import { sessionBirth } from "./spawn.js";

export const SPINE_FEATURES: FeatureFlag[] = ["jit", "spawn"];

/**
 * Hands over the births a live commit made and where their sampling began in
 * the log. Resolves once the children are started, or receive non-waking abort
 * arrivals if the user stopped the turn while the Spawn was still queued.
 */
export type BirthHandler = (births: readonly SpawnBirth[], prefixEnd: number, stopped: boolean) => Promise<void>;

/** Hears each projection the agent publishes or commits live; the recovered one is `projection` once `create` returns. */
export type ProjectionHandler = (projection: SpineProjection) => void;

/**
 * One model response carries at most one Spine operation (the core admits one
 * per sampling). A second call is refused before it runs; the model sees a tool error.
 */
export class SpineToolLimitError extends Error {
  constructor(staged: SpineToolName) {
    super(`only one Spine tool call is allowed per model response; ${staged} already ran in this one`);
    this.name = "SpineToolLimitError";
  }
}

export class SpineCompactCommitError extends SpineDshError {}

interface Sampling {
  /** Log seq of the slot that began the sampling. */
  from: number;
  /** The Spine call its response made, admitted live. */
  called: SpineToolName | null;
}

/** A Spine tool call as logged. */
interface SpineCall {
  name: SpineToolName;
  callId: string;
  args: string;
}

export const SPINE_ATTACHMENT = "spinejitAttachment";

export interface SpineAttachment {
  ensure(agent: Agent): Promise<SpineAgent>;
  readonly signal: AbortSignal;
}

export interface SpineCompactOptions {
  readonly mode: "manual" | "auto";
  readonly trigger: CompactTrigger;
  readonly retainTokens?: number | undefined;
  readonly tokenMeter?: TokenMeter | undefined;
  readonly header?: EpochHeader | undefined;
  readonly summarize: (selection: CompactSelection) => Promise<CompactSummary>;
  readonly flush: () => Promise<void>;
  readonly signal: AbortSignal;
}

export interface SpineCompactResult {
  readonly seq: SessionSeq;
  readonly summary: string;
  readonly shadowedSeqs: readonly SessionSeq[];
  readonly shadowedRange: { readonly start: SessionSeq; readonly end: SessionSeq };
  readonly shadowedTokenCount: number;
  readonly retainedSeqs: readonly SessionSeq[];
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
  readonly agent: Agent;
  readonly #nodePrompt: string;
  readonly #born: BirthHandler;
  readonly #changed: ProjectionHandler;
  #adapter!: SpineHostAdapter;
  /** Every session event seen, by seq. */
  readonly #events = new Map<number, SessionEvent>();
  /** Logged sources the core has not observed yet, in log order. */
  #unobserved: SessionEvent[] = [];
  readonly #sourceSeqs = new Map<string, SessionSeq>();
  /** Maps every Spine logical boundary to its underlying DSH session seq. */
  readonly #boundarySeqs = new Map<number, SessionSeq>();
  /** Cumulative logical-boundary shift caused by retained trailing sources across compactions. */
  #boundaryOffset = 0;
  /** Each user message's number, by seq: the n-th the user wrote in the log. */
  readonly #userNumbers = new Map<SessionSeq, number>();
  /** User messages numbered for the model: in a user-anchors record, or (0.1.1 and earlier) in their text. */
  readonly #anchored = new Set<SessionSeq>();
  readonly #anchorInText = new Set<SessionSeq>();
  #plan: PlanItem[] | null = null;
  #projection: SpineProjection | null = null;
  /** Births whose arrival is in the log, by producer. */
  readonly #entered = new Set<string>();
  /** Retained assistant seqs whose reasoning must be stripped before any subsequent request. */
  readonly #compactDroppedReasoning = new Set<SessionSeq>();
  #recovering = false;
  #compacting = false;
  #compactCheckpoint: { boundary: number; flush: () => Promise<void> } | null = null;
  #sampling: Sampling | null = null;
  #turn = 0;
  #step = 0;
  #fault: unknown = null;

  private constructor(agent: Agent, nodePrompt: string, born: BirthHandler, changed: ProjectionHandler) {
    this.agent = agent;
    this.#nodePrompt = nodePrompt;
    this.#born = born;
    this.#changed = changed;
  }

  static async create(
    agent: Agent,
    configToml: string,
    born: BirthHandler,
    changed: ProjectionHandler,
  ): Promise<SpineAgent> {
    const events = agent.session.snapshotEvents();
    const { thread, continuations } = forkNamespaces(events, agent.id, agent.session.header.parentSession);
    const runtime = createNodeSpineRuntime({ thread, features: SPINE_FEATURES, configToml });
    const spine = new SpineAgent(agent, runtime.nodePrompt(), born, changed);
    spine.#adapter = await createHostAdapter<PlanItem>({
      runtime: runtime.client,
      host: {
        // DSH has no ownership registry. Another writer that rewrites conversation
        // context moves a plan source off the surface, and the projection faults.
        claimOwnership: async () => {},
        // Every fact a commit derives from is already in the session log.
        persistArchive: async () => {},
        persistCompact: (barrier) => spine.#persistCompact(barrier),
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
    // A resumed session brings its log as seed events, which are never published.
    try {
      await spine.#recover(events, thread, continuations);
    } catch (error) {
      spine.dispose();
      throw error;
    }
    return spine;
  }

  get projection(): SpineProjection | null {
    return this.#projection;
  }

  get fault(): unknown {
    return this.#fault ?? this.#adapter.fault;
  }

  /** Index one event of this agent's session; a new source waits for observation. */
  accept(event: SessionEvent): void {
    if (this.#events.has(event.seq)) return;
    this.#events.set(event.seq, event);
    if (isAppendSurfaceEvent(event) && surfaceRole(event) === "source" && compactBarrierOf(event) === undefined) {
      this.#unobserved.push(event);
    }
    if (isUserSource(event)) this.#userNumbers.set(event.seq, this.#userNumbers.size + 1);
    const record = pluginRecordOf(event);
    if (record?.type === USER_ANCHORS) {
      for (const { seq } of (record.data as { anchors: UserAnchor[] }).anchors) this.#anchored.add(seq);
    }
    const arrival = arrivalOf(event);
    if (arrival !== null) this.#entered.add(arrival.producer.join("."));
  }

  /** Births still pending whose arrival is not in the log yet. */
  openBirths(): SpawnBirth[] {
    if (this.#projection === null) return [];
    return unarrivedBirths(this.#projection).filter((birth) => !this.#entered.has(birth.producer.join(".")));
  }

  /** Whether any Spawn child branch has not yet arrived back into this session. */
  hasUnarrivedBirths(): boolean {
    return this.openBirths().length > 0;
  }

  /**
   * Admit claimed messages up through the final `spine-arrival` when the batch
   * satisfies every remaining open Spawn birth, preserving the batch's exact
   * chronological order so preceding user messages are never reordered behind
   * an arrival while still satisfying Spine's arrival-before-compact invariant.
   */
  async admitPendingArrivals(messages: readonly UserMessage[]): Promise<Set<string>> {
    const admitted = new Set<string>();
    const open = this.openBirths();
    if (open.length === 0 || messages.length === 0) return admitted;
    const openProducers = new Set(open.map((birth) => birth.producer.join(".")));
    let lastArrivalIdx = -1;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      if (message.source.kind !== "spine-arrival") continue;
      const producer = message.source.arrival.producer.join(".");
      if (!openProducers.has(producer)) continue;
      openProducers.delete(producer);
      lastArrivalIdx = index;
    }
    if (lastArrivalIdx < 0 || openProducers.size > 0) return admitted;
    const toAppend = messages.slice(0, lastArrivalIdx + 1);
    await this.#guard(async () => {
      for (const message of toAppend) {
        const event = this.agent.session.append("user/message", message, { surfaceOp: "append" });
        this.accept(event);
        admitted.add(message.id);
      }
      await this.#prepare();
    });
    return admitted;
  }

  /**
   * Estimate current effective model-context tokens, taking any pending Spine
   * fold in `#plan` into account so automatic pressure checks do not misfire
   * right after `spine_close` or `spine_next`.
   */
  effectiveTokenCount(
    tokenMeter?: TokenMeter,
    header?: EpochHeader,
    extraMessages?: readonly Message[],
    pricing?: MessagePricingContext,
    targetSystemTokens?: number,
    clearLaterSystemMessages = false,
  ): number {
    return estimateEffectiveTokens(
      this.agent.session,
      this.#surface(),
      this.#plan,
      tokenMeter,
      header,
      extraMessages,
      pricing,
      targetSystemTokens,
      clearLaterSystemMessages,
    );
  }

  /** A step opened: bring the surface to the published plan. */
  async enterStep(turn: number, step: number): Promise<void> {
    this.#turn = turn;
    this.#step = step;
    await this.#guard(async () => {
      if (this.#plan !== null) {
        applySurfaceEdits(this.agent.session, surfaceEdits(this.#surface(), this.#plan), turn, step);
        dropReasoning(this.agent.session, this.#plan.flatMap((item) =>
          item.type === "source" && item.withoutReasoning ? [item.seq] : []));
      }
      this.#dropPendingCompactReasoning();
    });
  }

  #dropPendingCompactReasoning(): void {
    if (this.#compactDroppedReasoning.size === 0) return;
    const live = new Set(this.agent.session.surface.nodes);
    const pending: SessionSeq[] = [];
    for (const seq of this.#compactDroppedReasoning) {
      if (live.has(seq)) pending.push(seq);
      else this.#compactDroppedReasoning.delete(seq);
    }
    if (pending.length > 0) dropReasoning(this.agent.session, pending);
  }

  /** A main-loop request is about to stream. Its messages must be the plan; it begins a sampling. */
  async beginSampling(): Promise<void> {
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
      this.#logPendingAnchors();
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

  #logPendingAnchors(): void {
    const anchors = [...this.#userNumbers]
      .filter(([seq]) => !this.#anchored.has(seq))
      .map(([seq, anchor]) => ({ seq, anchor }));
    logAnchors(this.agent.session, anchors);
    for (const { seq } of anchors) this.#anchored.add(seq);
  }

  /**
   * Admit one Spine tool call of the current sampling and return its result
   * text, or throw the tool error the model sees. The sampling stages it when
   * it settles, if its logged result is not an error.
   */
  admit(name: SpineToolName, args: Record<string, unknown>): string {
    if (this.fault !== null) throw new SpineDshError("Spine context is faulted", { cause: this.fault });
    const sampling = this.#sampling;
    if (sampling === null) throw new SpineDshError(`${name} ran outside a Spine sampling`);
    if (sampling.called !== null) throw new SpineToolLimitError(sampling.called);
    // What the core would refuse at commit is a tool error now, not a fault later.
    const refusal = spineToolRefusal(this.#projection!, name, this.#entered, sessionBirth(this.agent.id), this.#responseCalls(sampling.from));
    if (refusal !== null) throw new SpineDshError(refusal);
    const result = spineToolResult(this.#projection!, name, args, this.#nodePrompt);
    sampling.called = name;
    return result;
  }

  /** Settle the open sampling, if any, over its stretch of the log so far. */
  async settle(): Promise<void> {
    if (this.#sampling !== null) await this.#settle(this.#end(this.#sampling.from));
  }

  /**
   * Compact the live Spine context into a durable checkpoint and advance the
   * Spine epoch. Manual compaction runs under DSH's idle maintenance lock;
   * automatic compaction runs at step boundaries, model switches, or overflow
   * retries and safely skips whenever parallel Spawn children are still open.
   */
  async compact(options: SpineCompactOptions): Promise<SpineCompactResult | null> {
    const { mode, trigger, retainTokens = 0, tokenMeter, header, summarize, flush, signal } = options;
    signal.throwIfAborted();
    if (this.#compacting) {
      if (mode === "manual") throw new SpineDshError("A Spine compaction is already in progress.");
      return null;
    }
    this.#compacting = true;
    try {
      await this.settle();
      if (this.fault !== null) throw new SpineDshError("Spine context is faulted", { cause: this.fault });
      if (this.hasUnarrivedBirths()) {
        if (mode === "manual") {
          throw new SpineDshError("Wait for the parallel branches to return before using /compact.");
        }
        return null;
      }
      const session = this.agent.session;
      if (mode === "manual" && !hasNewConversation(session)) return null;
      // Ensure every logged source has been observed and the latest folded plan
      // is published before selecting the live context to summarize.
      await this.#guard(async () => {
        await this.#prepare();
        this.#dropPendingCompactReasoning();
      });
      signal.throwIfAborted();
      const selection = selectCompactPlan(session, {
        mode,
        retainTokens,
        plan: this.#plan,
        surface: this.#surface(),
        tokenMeter,
        header,
        anchoredSeqs: this.#anchored,
      });
      if (selection === null) return null;

      const beforeReplaceGen = session.surface.replaceGeneration;
      const beforeSurfaceNodes = [...session.surface.nodes];
      const summary = await summarize(selection);
      signal.throwIfAborted();

      // Verify the selected span stayed stable while summarization ran asynchronously.
      if (
        session.surface.replaceGeneration !== beforeReplaceGen
        || session.surface.nodes.length < selection.shadowedSeqs.length
        || selection.shadowedSeqs.some((seq, index) => {
          const baseIdx = beforeSurfaceNodes.indexOf(selection.startSeq);
          return session.surface.nodes[baseIdx + index] !== seq;
        })
      ) {
        throw new SpineDshError("Conversation surface changed during compaction.");
      }

      // Check that a durable writer is available before appending the checkpoint.
      await flush();
      signal.throwIfAborted();
      const source = await this.#guard(async () => {
        await this.#observe(Infinity);
        return this.#adapter.sourceSnapshot();
      });
      signal.throwIfAborted();

      return await this.#guard(async () => {
        // Record any pending [U#] anchors before replacing user messages.
        this.#logPendingAnchors();
        // Strip reasoning from retained assistant outputs BEFORE appending the
        // checkpoint so both records share the same durability flush and no
        // crash can leave a persisted checkpoint whose retained tail still
        // exposes stale reasoning/replayState. Also record the seqs on the
        // checkpoint so recovery can enforce the strip even on truncated logs.
        //
        // Exception: for Anthropic Messages (`anthropic-messages`), manual
        // (budget-based) thinking requires the final assistant turn of an open
        // tool round to retain its thinking block and signature. Leave that
        // single message intact so `dsh-llm-pi-ai`'s `bindThinkingToPrefix`
        // keeps it for manual thinking and strips it for adaptive thinking.
        const openToolAssistant = openToolRoundAssistantSeq(session, selection.retainedSeqs);
        const droppedReasoningSeqs = selection.retainedAssistantSeqs.filter((assistantSeq) => {
          const event = session.eventAt(assistantSeq);
          const message = event === undefined ? null : session.deriveEventMessage(event);
          if (message === null || !hasReasoning(message)) return false;
          if (assistantSeq === openToolAssistant && isAnthropicMessagesReplay(message)) return false;
          return true;
        });
        if (droppedReasoningSeqs.length > 0) {
          dropReasoning(session, droppedReasoningSeqs);
          for (const assistantSeq of droppedReasoningSeqs) {
            this.#compactDroppedReasoning.add(assistantSeq);
          }
        }
        const shadowedRange = { start: selection.startSeq, end: selection.endSeq };
        session.append("compaction/prune", {
          shadowedRange,
          shadowedSeqs: [...selection.shadowedSeqs],
          shadowedTokenCount: selection.shadowedTokenCount,
        });
        const seq = SessionSeq(session.seq);
        const offset = this.#boundaryOffset;
        const checkpointBoundary = seq + offset;
        const replacementBoundaries = [
          checkpointBoundary,
          ...selection.retainedSeqs.map((_, index) => checkpointBoundary + index + 1),
        ];
        const barrier: CompactBarrier = {
          schema: "spine.compact.barrier.v1",
          thread: source.thread,
          previous_epoch: source.epoch,
          next_epoch: source.epoch + 1,
          boundary: checkpointBoundary - 1,
          replacement_boundaries: replacementBoundaries,
        };
        session.append(
          "user/message",
          compactMessage(barrier, summary, {
            retainedSeqs: selection.retainedSeqs,
            droppedReasoningSeqs,
            trigger,
            ...(selection.openTurn === null ? {} : { turn: selection.openTurn.turn }),
            shadowedTokens: selection.shadowedTokenCount,
          }),
          {
            surfaceOp: { op: "replace", startSeq: selection.startSeq, endSeq: selection.endSeq },
            sourceEventSeqs: [...selection.shadowedSeqs],
          },
        );
        this.#compactCheckpoint = { boundary: checkpointBoundary, flush };
        try {
          await this.#applyCompact(barrier, seq, selection.retainedSeqs);
        } catch (cause) {
          throw new SpineCompactCommitError(
            "The checkpoint was appended, but compaction could not finish. Check the session after reopening it before retrying.",
            { cause },
          );
        } finally {
          this.#compactCheckpoint = null;
        }
        return {
          seq,
          summary: summary.text,
          shadowedSeqs: selection.shadowedSeqs,
          shadowedRange,
          shadowedTokenCount: selection.shadowedTokenCount,
          retainedSeqs: selection.retainedSeqs,
        };
      });
    } finally {
      this.#compacting = false;
    }
  }

  async #persistCompact(barrier: CompactBarrier): Promise<void> {
    if (this.#recovering) return;
    const checkpoint = this.#compactCheckpoint;
    if (checkpoint === null || barrier.replacement_boundaries[0] !== checkpoint.boundary) {
      throw new SpineDshError("Spine checkpoint does not match the persisted replacement.");
    }
    // The SDK waits for durability before it changes epochs.
    await checkpoint.flush();
  }

  async #applyCompact(
    barrier: CompactBarrier,
    checkpointSeq: SessionSeq,
    retainedSeqs: readonly SessionSeq[],
  ): Promise<void> {
    await this.#adapter.compact(barrier, { publish: false });
    const source = await this.#adapter.sourceSnapshot();
    const replacementSeqs = [checkpointSeq, ...retainedSeqs];
    if (source.cells.length !== replacementSeqs.length) {
      throw new SpineDshError(
        `Spine compact produced ${source.cells.length} cells for ${replacementSeqs.length} replacements`,
      );
    }
    for (let index = 0; index < source.cells.length; index += 1) {
      const cell = source.cells[index]!;
      const seq = replacementSeqs[index]!;
      this.#sourceSeqs.set(sourceKey(cell.source_id), seq);
      this.#boundarySeqs.set(cell.boundary, seq);
    }
    this.#boundaryOffset += retainedSeqs.length;
    await this.#adapter.previewAndPublish();
  }

  dispose(): void {
    this.#adapter.dispose();
  }

  /**
   * Run the sampling lifecycle over a logged session, in log order: each
   * sampling begins at its marked slot and settles where its stretch ends,
   * or at the end of the log. A forked session continues in its own
   * namespace where its inherited prefix ends.
   */
  async #recover(
    events: readonly SessionEvent[],
    initialThread: string,
    continuations: ReadonlyMap<number, string>,
  ): Promise<void> {
    const possibleLegacyAnchors: SessionSeq[] = [];
    let currentThread = initialThread;
    this.#recovering = true;
    for (const event of events) {
      const sampling = beginsSampling(event);
      if (sampling) {
        // Older versions logged the anchor in the user text before sampling.
        // Only recognize that format on replay, with a logged Spine sampling
        // and no separate anchor record for that message.
        for (const seq of possibleLegacyAnchors) {
          if (this.#anchored.has(seq)) continue;
          this.#anchored.add(seq);
          this.#anchorInText.add(seq);
        }
        possibleLegacyAnchors.length = 0;
      }
      const barrier = compactBarrierOf(event);
      const nextThread = continuations.get(event.seq);
      if (endsSampling(event) || nextThread !== undefined || barrier !== undefined) await this.#settle(event.seq);
      if (nextThread !== undefined) {
        possibleLegacyAnchors.length = 0;
        await this.#guard(() => this.#continueNamespace(event.seq, nextThread));
        currentThread = nextThread;
      }
      this.accept(event);
      if (barrier !== undefined) {
        const recordedDrops = compactDroppedReasoningSeqsOf(event);
        if (recordedDrops !== undefined) {
          for (const droppedSeq of recordedDrops) this.#compactDroppedReasoning.add(droppedSeq);
        } else {
          for (const retainedSeq of compactRetainedSeqsOf(event)) {
            if (this.#events.get(retainedSeq)?.type === "assistant/message") {
              this.#compactDroppedReasoning.add(retainedSeq);
            }
          }
        }
        // Copied compact barriers inside a forked session's inherited prefix
        // carry the ancestor session's thread name, while replay uses the
        // synthetic segment namespace assigned by forkNamespaces().
        const replayBarrier = currentThread === this.agent.id ? barrier : { ...barrier, thread: currentThread };
        await this.#guard(async () => {
          await this.#observe(event.seq);
          await this.#applyCompact(replayBarrier, event.seq, compactRetainedSeqsOf(event));
        });
      }
      if (isUserSource(event)) {
        const prefix = anchorPrefix(this.#userNumbers.get(event.seq)!);
        if (firstText(eventMessage(event))?.startsWith(prefix)) possibleLegacyAnchors.push(event.seq);
      }
      // Restored logs can contain an inline number even if Spine did not run
      // for that reply. Require an earlier Spine anchor and a queued copy that
      // proves the number was added to the message after the user sent it.
      if (event.type === "assistant/message" && this.#anchored.size > 0) {
        for (const seq of possibleLegacyAnchors) {
          if (this.#anchored.has(seq)) continue;
          const user = this.#events.get(seq);
          if (user?.type === "user/message" && hasRepairedInlineAnchor(this.#events, seq, user.data, this.#userNumbers.get(seq)!)) {
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
    await this.settle();
    // Observe the entire recovery tail, including pending user sources, repaired
    // inline anchors and DSH's synthetic Fork results, before applying the plan.
    await this.#guard(() => this.#prepare());
    this.#recovering = false;
  }

  #project(projection: SpineProjection): void {
    this.#projection = projection;
    if (!this.#recovering) this.#changed(projection);
  }

  /**
   * Observe the inherited sources and continue in this session's namespace.
   * Births the parent made stay its own to join.
   */
  async #continueNamespace(cut: number, thread: string): Promise<void> {
    await this.#observe(cut);
    const source = await this.#adapter.continueNamespace(thread);
    for (const cell of source.cells) {
      const seq = this.#boundarySeqs.get(cell.boundary) ?? SessionSeq(cell.boundary);
      this.#sourceSeqs.set(sourceKey(cell.source_id), seq);
      this.#boundarySeqs.set(cell.boundary, seq);
    }
    await this.#adapter.previewAndPublish();
  }

  /** Observe every logged source and make sure a plan is published for it. */
  async #prepare(): Promise<void> {
    if ((await this.#observe(Infinity)) > 0 || this.#plan === null) await this.#adapter.previewAndPublish();
  }

  async #begin(from: number): Promise<void> {
    await this.#adapter.beginSampling();
    this.#sampling = { from, called: null };
  }

  /** Where the stretch of the sampling that began at `from` ends, as logged so far. */
  #end(from: number): number {
    const next = this.agent.session.seq;
    for (let seq = from + 1; seq < next; seq += 1) {
      if (endsSampling(this.#event(seq))) return seq;
    }
    return next;
  }

  /** Settle the open sampling with its stretch of the log, which ends before `to`. */
  async #settle(to: number): Promise<void> {
    const sampling = this.#sampling;
    if (sampling === null) return;
    await this.#guard(async () => {
      const call = this.#spineCall(sampling.from, to);
      if (call !== null) {
        const operation = operationFromSpineToolCall(call.name, JSON.parse(call.args) as Record<string, unknown>);
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
      if (result.type !== "committed") return;
      this.#project(result.projection);
      if (!this.#recovering && call?.name === "spine_spawn") {
        const births = this.openBirths().filter(({ producer }) => !olderBirths?.has(producer.join(".")));
        await this.#born(births, sampling.from, stoppedSpawn);
      }
    });
  }

  /** Stop is logged at turn/end, after the sampling's step/end. */
  #userStopped(from: number, to: number): boolean {
    const start = this.#event(from);
    if (start.type !== "developer/message") return false;
    const turn = start.data.turn;
    for (let seq = to; seq < this.agent.session.seq; seq += 1) {
      const event = this.#event(seq);
      if (event.type === "turn/start") return false;
      if (event.type === "turn/end" && event.data.turn === turn) {
        return event.data.reason.kind === "aborted" && event.data.reason.reason.kind === "user";
      }
    }
    return false;
  }

  /** Observe the unobserved sources logged before `to`. */
  async #observe(to: number): Promise<number> {
    const count = this.#unobserved.findIndex((event) => event.seq >= to);
    const events = this.#unobserved.splice(0, count < 0 ? this.#unobserved.length : count);
    if (events.length === 0) return 0;
    const boundaries = events.map((event) => event.seq + this.#boundaryOffset);
    const ids = await this.#adapter.observeSources(
      events.map((event, index) => sourceCharacter(event, this.#anchorInText.has(event.seq), boundaries[index]!)),
    );
    if (ids.length !== events.length) {
      throw new SpineDshError(`Spine admitted ${ids.length} sources for ${events.length} events`);
    }
    ids.forEach((id, index) => {
      const seq = events[index]!.seq;
      this.#sourceSeqs.set(sourceKey(id), seq);
      this.#boundarySeqs.set(boundaries[index]!, seq);
    });
    return events.length;
  }

  /** Tool calls in the model response logged since `from`, the sampling's start. */
  #responseCalls(from: number): number {
    for (let seq = this.agent.session.seq - 1; seq >= from; seq -= 1) {
      const event = this.#events.get(seq);
      if (event?.type === "assistant/message") {
        return event.data.message.content.filter((block) => block.type === "tool-call").length;
      }
    }
    return 1;
  }

  #seqOf(id: EpochOrdinalId): SessionSeq {
    const seq = this.#sourceSeqs.get(sourceKey(id));
    if (seq === undefined) throw new SpineDshError(`Spine plan names unknown source ${sourceKey(id)}`);
    return seq;
  }

  #surface(): SurfaceNode[] {
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
  #assertSurfaceShowsPlan(): void {
    const plan = this.#plan!;
    const edits = surfaceEdits(this.#surface(), plan);
    if (edits.length > 0) {
      throw new SpineDshError(`the model request differs from the Spine plan by ${edits.length} surface edits`);
    }
    for (const item of plan) {
      if (item.type !== "source") continue;
      if (item.withoutReasoning) {
        const shown = this.agent.session.deriveEventMessage(this.#event(item.seq));
        if (shown !== null && hasReasoning(shown)) {
          throw new SpineDshError(`source ${item.seq} still shows its reasoning, which the Spine plan leaves out`);
        }
      }
      if (item.anchor === null || !this.#anchored.has(item.seq)) continue;
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

  #event(seq: number): SessionEvent {
    const event = this.#events.get(seq);
    if (event === undefined) throw new SpineDshError(`session event ${seq} was never seen`);
    return event;
  }

  /** The Spine call in the stretch [from, to) whose logged result is not an error, if any. */
  #spineCall(from: number, to: number): SpineCall | null {
    const calls = new Map<string, SpineCall>();
    for (let seq = from; seq < to; seq += 1) {
      const event = this.#event(seq);
      if (event.type === "tool/call" && isSpineToolName(event.data.name)) {
        calls.set(event.data.callId, { name: event.data.name, callId: event.data.callId, args: event.data.arguments });
      } else if (event.type === "tool/result" && event.data.message.isError !== true) {
        const call = calls.get(event.data.message.toolCallId);
        if (call !== undefined) return call;
      }
    }
    return null;
  }

  /**
   * A sampling ends as its response did: completed when it was logged whole,
   * cancelled when it was interrupted, failed when none was logged.
   */
  #outcome(from: number, to: number): { terminal: Terminal; inputTokens?: number } {
    for (let seq = from; seq < to; seq += 1) {
      const event = this.#event(seq);
      if (event.type !== "assistant/message") continue;
      const terminal: Terminal = event.data.interrupted === true ? "cancelled" : "completed";
      const usage = event.data.usage;
      if (usage === undefined) return { terminal };
      // DSH reports uncached, cache-read, and cache-write input separately.
      const inputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      return { terminal, inputTokens };
    }
    return { terminal: "failed" };
  }

  async #guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.fault !== null) throw new SpineDshError("Spine context is faulted", { cause: this.fault });
    try {
      return await operation();
    } catch (cause) {
      this.#fault ??= cause;
      throw new SpineDshError("Spine context fault", { cause });
    }
  }
}

/** Replay each inherited prefix before continuing in the namespace after its cut. */
function forkNamespaces(events: readonly SessionEvent[], sessionId: string, parentSession?: string) {
  const continuations = new Map<number, string>();
  let thread = sessionId;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "session/end-seed" || event.data.inherited !== true) continue;
    const parent = continuations.size === 0 ? parentSession : undefined;
    continuations.set(event.seq, thread);
    // Ordinary Fork does not record the source session ID. A stable namespace
    // per copied segment keeps its pending Spawn work owned by that segment.
    thread = parent ?? `dsh-inherited:${event.seq}`;
  }
  return { thread, continuations };
}

function sourceKey(id: EpochOrdinalId): string {
  return `${id.thread}\u0000${id.epoch}\u0000${id.ordinal}`;
}

/**
 * Return the seq of the assistant message whose open tool round the retained
 * tail continues (trailing `tool/result` events directly after an assistant
 * message), matching `dsh-llm-pi-ai`'s `openToolRoundAssistant`.
 */
function openToolRoundAssistantSeq(
  session: Session,
  retainedSeqs: readonly SessionSeq[],
): SessionSeq | undefined {
  let toolResults = 0;
  for (let index = retainedSeqs.length - 1; index >= 0; index -= 1) {
    const seq = retainedSeqs[index]!;
    const event = session.eventAt(seq);
    if (event?.type === "assistant/message") {
      return toolResults > 0 ? seq : undefined;
    }
    if (event?.type !== "tool/result") return undefined;
    toolResults += 1;
  }
  return undefined;
}
