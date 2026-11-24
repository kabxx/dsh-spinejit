import type { ContentBlock, LlmImageRequestPricing, Message } from "@deepseek-ai/dsh-llm";
import { SessionSeq, type EpochHeader, type Session } from "@deepseek-ai/dsh-session";
import type { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import { type PlanItem, type SurfaceNode } from "./projection.js";
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
export declare function openTurnInfo(session: Session): OpenTurnInfo | null;
/**
 * Whether any meaningful conversation source exists on the surface after the
 * most recent Spine checkpoint (or after all retained sources if none).
 */
export declare function hasNewConversation(session: Session): boolean;
/**
 * Tool-pairing balance for every cut position `0..nodes.length` along the
 * current surface. Entry `i` is true iff no unanswered tool call crosses the
 * cut immediately before `nodes[i]`.
 */
export declare function balancedCuts(session: Session, nodes: readonly SessionSeq[]): boolean[];
type FileAttachmentRef = Extract<ContentBlock, {
    type: "file";
}>["attachment"];
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
export declare function estimateRouteMessage(message: Message, pricing?: MessagePricingContext): number;
/**
 * Estimate current effective context tokens, accounting for any pending Spine
 * fold in `plan` that `enterStep` has not yet materialized onto `session.surface`,
 * plus route-priced newly claimed messages and any target system-prompt delta.
 */
export declare function estimateEffectiveTokens(session: Session, surface: readonly SurfaceNode[], plan: readonly PlanItem[] | null, tokenMeter: TokenMeter | undefined, header: EpochHeader | undefined, extraMessages?: readonly Message[], pricing?: MessagePricingContext, targetSystemTokens?: number, clearLaterSystemMessages?: boolean): number;
/**
 * Lower bound on tokens that cannot be removed by compacting prior history:
 * target tool schemas + system prompt + newly claimed messages priced under
 * the target route. If this floor already reaches the target threshold,
 * compacting prior history cannot make the switch succeed and would only
 * destroy live history before failing.
 */
export declare function estimateIrreducibleTokens(session: Session, tokenMeter: TokenMeter | undefined, header: EpochHeader | undefined, extraMessages?: readonly Message[], pricing?: MessagePricingContext, targetSystemTokens?: number): number;
/**
 * Choose the surface span to replace with a Spine checkpoint, any safe trailing
 * sources from an unfinished turn to carry into the new epoch, and the live
 * Spine messages to feed to the summarizer (never reviving folded nodes).
 */
export declare function selectCompactPlan(session: Session, options: SelectCompactOptions): CompactSelection | null;
export {};
//# sourceMappingURL=compact-range.d.ts.map