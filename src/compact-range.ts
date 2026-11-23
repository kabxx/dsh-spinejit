import type { ContentBlock, ImageBlock, LlmImageRequestPricing, Message } from "@deepseek-ai/dsh-llm";
import {
  deriveEventMessage,
  isAppendSurfaceEvent,
  SessionSeq,
  type EpochHeader,
  type Session,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import type { TokenMeasurement, TokenMeter } from "@deepseek-ai/dsh-token-meter";
import {
  estimateContent,
  estimateMessage,
  estimateStructuralBlock,
  estimateToolsTokens,
} from "@deepseek-ai/dsh-token-meter/estimate";
import { isSpineToolName } from "@spinejit/spine-sdk/host";

import { anchorPrefix, anchored, firstText } from "./anchors.js";
import { compactBarrierOf, compactRetainedSeqsOf, spineMessage, surfaceRole } from "./events.js";
import { surfaceEdits, type PlanItem, type SurfaceNode } from "./projection.js";
import { hasReasoning, withoutReasoning } from "./reasoning.js";

export interface OpenTurnInfo {
  readonly turn: number;
  readonly startSeq: SessionSeq;
}

export interface CompactSelection {
  readonly startSeq: SessionSeq;
  readonly endSeq: SessionSeq;
  readonly shadowedSeqs: readonly SessionSeq[];
  readonly shadowedTokenCount: number;
  readonly retainedSeqs: readonly SessionSeq[];
  readonly retainedAssistantSeqs: readonly SessionSeq[];
  readonly systemHead: Message | null;
  readonly messages: readonly Message[];
  readonly prefixCacheEligible: boolean;
  readonly openTurn: OpenTurnInfo | null;
}

export interface SelectCompactOptions {
  readonly mode: "manual" | "auto";
  readonly retainTokens: number;
  readonly plan: readonly PlanItem[] | null;
  readonly surface: readonly SurfaceNode[];
  readonly tokenMeter?: TokenMeter | undefined;
  readonly header?: EpochHeader | undefined;
  readonly anchoredSeqs?: ReadonlySet<SessionSeq> | undefined;
}

/** Return the currently open turn (last `turn/start` without a following `turn/end`), or `null`. */
export function openTurnInfo(session: Session): OpenTurnInfo | null {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    if (event.type === "turn/start") return { turn: event.data.turn, startSeq: event.seq };
    if (event.type === "turn/end") return null;
  }
  return null;
}

/**
 * Whether any meaningful conversation source exists on the surface after the
 * most recent Spine checkpoint (or after all retained sources if none).
 */
export function hasNewConversation(session: Session): boolean {
  let checkpoint = -1;
  let retained = new Set<SessionSeq>();
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event !== undefined && compactBarrierOf(event) !== undefined) {
      checkpoint = event.seq;
      retained = new Set(compactRetainedSeqsOf(event));
      break;
    }
  }
  return session.surface.nodes.some((seq) => {
    if (seq <= checkpoint && !retained.has(seq)) return false;
    const event = session.eventAt(seq);
    if (event === undefined || !isAppendSurfaceEvent(event) || surfaceRole(event) !== "source") return false;
    const message = session.deriveEventMessage(event);
    return hasMeaningfulContent(message);
  });
}

function hasMeaningfulContent(message: Message | null): boolean {
  return message?.content.some((block) =>
    block.type !== "reasoning" && (block.type !== "text" || block.text.trim().length > 0),
  ) ?? false;
}

/**
 * Tool-pairing balance for every cut position `0..nodes.length` along the
 * current surface. Entry `i` is true iff no unanswered tool call crosses the
 * cut immediately before `nodes[i]`.
 */
export function balancedCuts(session: Session, nodes: readonly SessionSeq[]): boolean[] {
  const cuts: boolean[] = [true];
  let openCalls = 0;
  let corrupted = false;
  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (event?.type === "assistant/message") {
      openCalls += event.data.message.content.filter((block) => block.type === "tool-call").length;
    } else if (event?.type === "tool/result") {
      openCalls -= 1;
      if (openCalls < 0) corrupted = true;
    }
    cuts.push(!corrupted && openCalls === 0);
  }
  return cuts;
}

function isSystemHead(session: Session, seq: SessionSeq): boolean {
  return session.eventAt(seq)?.type === "system/message";
}

function hasSpineToolCall(event: SessionEvent | undefined): boolean {
  if (event?.type !== "assistant/message") return false;
  return event.data.message.content.some(
    (block) => block.type === "tool-call" && isSpineToolName(block.name),
  );
}

function isNonEmptySpineNode(session: Session, event: SessionEvent | undefined): boolean {
  if (event === undefined || surfaceRole(event) !== "spine") return false;
  return hasMeaningfulContent(session.deriveEventMessage(event));
}

function nodeHeuristicTokens(
  session: Session,
  seq: SessionSeq,
  measurementBySeq: ReadonlyMap<SessionSeq, number> | undefined,
): number {
  const measured = measurementBySeq?.get(seq);
  if (measured !== undefined) return measured;
  const event = session.eventAt(seq);
  if (event === undefined) return 0;
  // Match dsh-token-meter's O(1) surface-projection heuristic baseline.
  const derived = deriveEventMessage(event);
  return derived === null ? 0 : estimateMessage(derived);
}

function nodeRouteTokens(
  session: Session,
  seq: SessionSeq,
  measurementBySeq: ReadonlyMap<SessionSeq, number> | undefined,
): number {
  const measured = measurementBySeq?.get(seq);
  if (measured !== undefined) return measured;
  const event = session.eventAt(seq);
  if (event === undefined) return 0;
  const derived = session.deriveEventMessage(event);
  return derived === null ? 0 : estimateMessage(derived);
}

function measureSafely(
  tokenMeter: TokenMeter | undefined,
  session: Session,
  header: EpochHeader | undefined,
): TokenMeasurement | undefined {
  if (tokenMeter === undefined || typeof tokenMeter.measure !== "function") return undefined;
  try {
    return tokenMeter.measure(session, header);
  } catch {
    return undefined;
  }
}

type FileAttachmentRef = Extract<ContentBlock, { type: "file" }>["attachment"];

/** Route-owned attachment pricing mirrored from `@deepseek-ai/dsh-token-meter`. */
export interface MessagePricingContext {
  readonly imagePricing?: LlmImageRequestPricing | undefined;
  readonly fileText?: ((ref: FileAttachmentRef) => string) | undefined;
}

/**
 * Price one model-visible message under the target route's image and file
 * projections, matching `dsh-token-meter`'s `priceSurface` calculation so
 * newly claimed images and files are never under-counted to raw JSON length.
 */
export function estimateRouteMessage(
  message: Message,
  pricing?: MessagePricingContext,
): number {
  let tokens = estimateMessage(message);
  if (pricing === undefined || (pricing.imagePricing === undefined && pricing.fileText === undefined)) {
    return tokens;
  }

  const images: ImageBlock[] = [];
  const files: FileAttachmentRef[] = [];
  let imageStructuralTokens = 0;
  let fileStructuralTokens = 0;
  for (const block of message.content) {
    if (block.type === "image") {
      images.push(block);
      imageStructuralTokens += estimateStructuralBlock(block);
    } else if (block.type === "file") {
      files.push(block.attachment);
      fileStructuralTokens += estimateStructuralBlock(block);
    }
  }

  if (pricing.fileText !== undefined && files.length > 0) {
    tokens -= fileStructuralTokens;
    for (const file of files) {
      tokens += estimateContent([{ type: "text", text: pricing.fileText(file) }]);
    }
  }

  if (pricing.imagePricing !== undefined && images.length > 0) {
    const prices = pricing.imagePricing.priceImages(images);
    if (prices.length === images.length) {
      tokens -= imageStructuralTokens;
      for (const price of prices) {
        tokens += price.visualTokens + estimateContent([{ type: "text", text: price.text }]);
      }
    }
  }

  return Math.max(0, tokens);
}

/**
 * Estimate current effective context tokens, accounting for any pending Spine
 * fold in `plan` that `enterStep` has not yet materialized onto `session.surface`,
 * plus route-priced newly claimed messages and any target system-prompt delta.
 */
export function estimateEffectiveTokens(
  session: Session,
  surface: readonly SurfaceNode[],
  plan: readonly PlanItem[] | null,
  tokenMeter: TokenMeter | undefined,
  header: EpochHeader | undefined,
  extraMessages?: readonly Message[],
  pricing?: MessagePricingContext,
  targetSystemTokens?: number,
  clearLaterSystemMessages = false,
): number {
  const measurement = measureSafely(tokenMeter, session, header);
  const routeBySeq = measurement === undefined
    ? undefined
    : new Map(measurement.nodes.map((node) => [node.seq, node.tokens] as const));

  let total: number;
  if (measurement !== undefined) {
    total = measurement.totalTokens;
  } else {
    total = estimateToolsTokens(header);
    for (const seq of session.surface.nodes) {
      total += nodeRouteTokens(session, seq, undefined);
    }
  }

  // Account for target system prompt changes (e.g. PTC mode, model-specific sections,
  // and mid-history system messages that DSH clears when switching to a route without
  // `systemPromptUpdate: "in-history"`).
  if (targetSystemTokens !== undefined) {
    const nodes = session.surface.nodes;
    let currentSystemTokens = 0;
    if (nodes.length > 0 && isSystemHead(session, nodes[0]!)) {
      currentSystemTokens += nodeRouteTokens(session, nodes[0]!, routeBySeq);
    }
    if (clearLaterSystemMessages) {
      for (let index = 1; index < nodes.length; index += 1) {
        const seq = nodes[index]!;
        if (isSystemHead(session, seq)) {
          currentSystemTokens += nodeRouteTokens(session, seq, routeBySeq);
        }
      }
    }
    total = Math.max(0, total + (targetSystemTokens - currentSystemTokens));
  }

  // If the previous step just folded a Spine branch (e.g. spine_close), its
  // surface replacement will run at enterStep. Subtract the pending reduction so
  // automatic pressure compaction does not fire falsely right after a fold.
  if (plan !== null) {
    try {
      const pendingEdits = surfaceEdits(surface, plan);
      if (pendingEdits.length > 0) {
        let delta = 0;
        for (const edit of pendingEdits) {
          if (edit.type === "append") {
            delta += estimateMessage(spineMessage(edit.text));
          } else {
            for (const seq of edit.shadowed) {
              delta -= nodeRouteTokens(session, seq, routeBySeq);
            }
            if (edit.text !== null) {
              delta += estimateMessage(spineMessage(edit.text));
            }
          }
        }
        total = Math.max(0, total + delta);
      }
    } catch {
      // Fall back to the measured surface total if edits cannot be previewed yet.
    }
  }

  if (extraMessages !== undefined) {
    for (const message of extraMessages) {
      total += estimateRouteMessage(message, pricing);
    }
  }

  return total;
}

/**
 * Lower bound on tokens that cannot be removed by compacting prior history:
 * target tool schemas + system prompt + newly claimed messages priced under
 * the target route. If this floor already reaches the target threshold,
 * compacting prior history cannot make the switch succeed and would only
 * destroy live history before failing.
 */
export function estimateIrreducibleTokens(
  session: Session,
  tokenMeter: TokenMeter | undefined,
  header: EpochHeader | undefined,
  extraMessages?: readonly Message[],
  pricing?: MessagePricingContext,
  targetSystemTokens?: number,
): number {
  let floor = estimateToolsTokens(header);
  if (targetSystemTokens !== undefined) {
    floor += targetSystemTokens;
  } else {
    const firstSeq = session.surface.nodes[0];
    if (firstSeq !== undefined && isSystemHead(session, firstSeq)) {
      const measurement = measureSafely(tokenMeter, session, header);
      const routeBySeq = measurement === undefined
        ? undefined
        : new Map(measurement.nodes.map((node) => [node.seq, node.tokens] as const));
      floor += nodeRouteTokens(session, firstSeq, routeBySeq);
    }
  }
  if (extraMessages !== undefined) {
    for (const message of extraMessages) {
      floor += estimateRouteMessage(message, pricing);
    }
  }
  return floor;
}

/**
 * Choose the surface span to replace with a Spine checkpoint, any safe trailing
 * sources from an unfinished turn to carry into the new epoch, and the live
 * Spine messages to feed to the summarizer (never reviving folded nodes).
 */
export function selectCompactPlan(
  session: Session,
  options: SelectCompactOptions,
): CompactSelection | null {
  const nodes = session.surface.nodes;
  if (nodes.length === 0) return null;

  const hasSystem = isSystemHead(session, nodes[0]!);
  const firstIdx = hasSystem ? 1 : 0;
  if (firstIdx >= nodes.length) return null;

  const cuts = balancedCuts(session, nodes);
  // Find the furthest tool-pairing-balanced end of the surface.
  let maxEndIdx = nodes.length;
  while (maxEndIdx > firstIdx && !cuts[maxEndIdx]) {
    maxEndIdx -= 1;
  }
  if (maxEndIdx <= firstIdx) return null;

  const measurement = measureSafely(options.tokenMeter, session, options.header);
  const heuristicBySeq = measurement === undefined
    ? undefined
    : new Map(measurement.nodes.map((node) => [node.seq, node.heuristicTokens] as const));
  const routeBySeq = measurement === undefined
    ? undefined
    : new Map(measurement.nodes.map((node) => [node.seq, node.tokens] as const));

  const openTurn = openTurnInfo(session);
  let keepFromIdx = maxEndIdx;

  // Automatic compaction during an unfinished turn preserves a safe suffix of
  // ONLY the current unfinished turn, never reaching back into prior turns
  // (which would revive folded history or leak old-epoch Spine tree state).
  if (options.mode === "auto" && openTurn !== null && options.retainTokens > 0) {
    let minTurnIdx = nodes.length;
    for (let i = firstIdx; i < maxEndIdx; i += 1) {
      if (nodes[i]! > openTurn.startSeq) {
        minTurnIdx = i;
        break;
      }
    }

    // Never retain steps containing old-epoch Spine tool calls or non-empty
    // Spine nodes (e.g. folded `<spine_memory>` summaries): the new epoch starts
    // cleanly at Root and discards old Spine slots, so any non-empty Spine
    // summary MUST land inside the compacted span to be absorbed into the summary.
    let safeTurnStartIdx = minTurnIdx;
    for (let i = minTurnIdx; i < maxEndIdx; i += 1) {
      const event = session.eventAt(nodes[i]!);
      if (hasSpineToolCall(event) || isNonEmptySpineNode(session, event)) {
        let after = i + 1;
        while (after < maxEndIdx && !cuts[after]) after += 1;
        safeTurnStartIdx = Math.max(safeTurnStartIdx, after);
      }
    }

    // Also inspect an unmaterialized `plan` (e.g. a `spine_close` memory not yet
    // written onto `session.surface`): ensure `safeTurnStartIdx` never starts
    // before the last non-empty Spine item in `plan`, so every folded branch
    // memory is fed to the summarizer rather than skipped at the tail boundary.
    if (options.plan !== null) {
      let lastSpineIdx = -1;
      for (let p = 0; p < options.plan.length; p += 1) {
        const item = options.plan[p]!;
        if (item.type === "spine" && item.text.trim().length > 0) {
          lastSpineIdx = p;
        }
      }
      if (lastSpineIdx >= 0) {
        let nextSourceAfterSpine: SessionSeq | undefined;
        for (let p = lastSpineIdx + 1; p < options.plan.length; p += 1) {
          const item = options.plan[p]!;
          if (item.type === "source") {
            nextSourceAfterSpine = item.seq;
            break;
          }
        }
        if (nextSourceAfterSpine === undefined) {
          // The folded Spine memory sits at the very end of the plan with no
          // subsequent source; compact through the end so it enters the summary.
          safeTurnStartIdx = maxEndIdx;
        } else {
          const surfaceIdx = nodes.indexOf(nextSourceAfterSpine);
          if (surfaceIdx >= 0) {
            let aligned = surfaceIdx;
            while (aligned < maxEndIdx && !cuts[aligned]) aligned += 1;
            safeTurnStartIdx = Math.max(safeTurnStartIdx, aligned);
          }
        }
      }
    }

    // Walk backward from the balanced end within [safeTurnStartIdx, maxEndIdx)
    // to pick the longest balanced suffix of the unfinished turn that fits the
    // retention budget while still leaving something before it to compact.
    if (safeTurnStartIdx < maxEndIdx) {
      let accumulated = 0;
      let candidate = maxEndIdx;
      for (let i = maxEndIdx - 1; i >= safeTurnStartIdx; i -= 1) {
        const tokens = nodeRouteTokens(session, nodes[i]!, routeBySeq);
        if (accumulated + tokens > options.retainTokens) break;
        accumulated += tokens;
        if (i > firstIdx && cuts[i]) {
          candidate = i;
        }
      }
      if (candidate > firstIdx && candidate < maxEndIdx) {
        // Only keep the tail if it actually contains at least one Spine source.
        const hasSource = nodes.slice(candidate, maxEndIdx).some((seq) => {
          const event = session.eventAt(seq);
          return event !== undefined && surfaceRole(event) === "source";
        });
        if (hasSource) keepFromIdx = candidate;
      }
    }
  }

  if (keepFromIdx <= firstIdx) return null;

  const shadowedSeqs = nodes.slice(firstIdx, keepFromIdx);
  if (shadowedSeqs.length === 0) return null;

  // Ensure the compacted span actually has non-empty conversation content to summarize.
  const hasCompactableSource = shadowedSeqs.some((seq) => {
    const event = session.eventAt(seq);
    if (event === undefined || surfaceRole(event) !== "source") return false;
    return hasMeaningfulContent(session.deriveEventMessage(event));
  });
  if (!hasCompactableSource) return null;

  let shadowedTokenCount = 0;
  for (const seq of shadowedSeqs) {
    shadowedTokenCount += nodeHeuristicTokens(session, seq, heuristicBySeq);
  }

  const tailNodes = nodes.slice(keepFromIdx);
  const retainedSeqs: SessionSeq[] = [];
  const retainedAssistantSeqs: SessionSeq[] = [];
  for (const seq of tailNodes) {
    const event = session.eventAt(seq);
    if (event === undefined || surfaceRole(event) !== "source") continue;
    retainedSeqs.push(seq);
    if (event.type === "assistant/message") retainedAssistantSeqs.push(seq);
  }

  const systemHead = hasSystem
    ? session.deriveEventMessage(session.eventAt(nodes[0]!)!)
    : null;

  // Build the summarizer input exclusively from Spine's live context for the
  // compacted span. When the surface matches the latest published plan, the
  // derived messages are an exact prefix of the last routed request and are
  // eligible for cache-warm summarization. When a recent Spine fold has not
  // yet materialized onto the surface, project from `plan` directly so folded
  // branches are never fed back to the summarizer.
  let prefixCacheEligible = true;
  let pendingEditsCount = 0;
  if (options.plan !== null) {
    try {
      pendingEditsCount = surfaceEdits(options.surface, options.plan).length;
    } catch {
      pendingEditsCount = 1;
    }
  }

  let messages: Message[];
  if (options.plan === null || pendingEditsCount === 0) {
    messages = [];
    for (const seq of shadowedSeqs) {
      const event = session.eventAt(seq);
      if (event === undefined) continue;
      const derived = session.deriveEventMessage(event);
      if (derived !== null) messages.push(derived);
    }
  } else {
    prefixCacheEligible = false;
    messages = materializePlanPrefix(session, options.plan, new Set(shadowedSeqs), new Set(tailNodes), options.anchoredSeqs);
  }

  if (messages.length === 0) return null;

  return {
    startSeq: shadowedSeqs[0]!,
    endSeq: shadowedSeqs[shadowedSeqs.length - 1]!,
    shadowedSeqs,
    shadowedTokenCount,
    retainedSeqs,
    retainedAssistantSeqs,
    systemHead,
    messages,
    prefixCacheEligible,
    openTurn,
  };
}

function materializePlanPrefix(
  session: Session,
  plan: readonly PlanItem[],
  shadowedSet: ReadonlySet<SessionSeq>,
  retainedSet: ReadonlySet<SessionSeq>,
  anchoredSeqs?: ReadonlySet<SessionSeq>,
): Message[] {
  const result: Message[] = [];
  for (const item of plan) {
    if (item.type === "spine") {
      result.push(spineMessage(item.text));
      continue;
    }
    if (retainedSet.has(item.seq)) break;
    if (!shadowedSet.has(item.seq)) continue;
    const event = session.eventAt(item.seq);
    if (event === undefined) continue;
    let derived = session.deriveEventMessage(event);
    if (derived === null) continue;
    if (item.withoutReasoning && hasReasoning(derived)) {
      derived = withoutReasoning(derived);
    }
    const alreadyAnchored = anchoredSeqs !== undefined
      ? anchoredSeqs.has(item.seq)
      : (item.anchor !== null && (firstText(derived)?.startsWith(anchorPrefix(item.anchor)) ?? false));
    if (item.anchor !== null && !alreadyAnchored) {
      derived = anchored(derived, item.anchor);
    }
    result.push(derived);
  }
  return result;
}
