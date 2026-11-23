import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { type LlmCallConfig, type Message } from "@deepseek-ai/dsh-llm";
import type { EpochHeader } from "@deepseek-ai/dsh-session";
import type { CompactCall, CompactSummary } from "./events.js";
export declare const DEFAULT_THRESHOLD_RATIO = 0.8;
export declare const DEFAULT_HEADROOM_TOKENS = 65536;
export declare const DEFAULT_RETAIN_RATIO = 0.16;
export declare const DEFAULT_MAX_TOKENS = 8192;
export declare const DEFAULT_MAX_OVERFLOW_RETRIES = 1;
/** Matches @deepseek-ai/dsh-compaction-tool-result-pruner defaults (code points). */
export declare const TOOL_RESULT_PRUNE_THRESHOLD_CHARS = 8192;
export declare const TOOL_RESULT_PRUNE_HEAD_CHARS = 4096;
export declare const TOOL_RESULT_PRUNE_TAIL_CHARS = 1024;
export declare const TOOL_RESULT_PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
export interface SpineCompactConfig {
    /** Enable automatic pressure, model-switch, and overflow compaction. Defaults to true. */
    readonly auto?: boolean;
    /** Fraction of contextWindow at which step-boundary pressure triggers compaction. Defaults to 0.8. */
    readonly thresholdRatio?: number;
    /** Minimum input headroom tokens kept below the window after output reservation. */
    readonly headroomTokens?: number;
    /** Fraction of contextWindow retained verbatim from the current unfinished turn. Defaults to 0.16. */
    readonly retainRatio?: number;
    /** Explicit token cap retained verbatim from the current unfinished turn (overrides retainRatio). */
    readonly retainTokens?: number;
    /** Optional dedicated summarization provider (must be paired with summarizationModel). */
    readonly summarizationProvider?: string;
    /** Optional dedicated summarization model (must be paired with summarizationProvider). */
    readonly summarizationModel?: string;
    /** Upper bound on summary output tokens. Defaults to 8192 (also capped by contextWindow/4 and defaultMaxTokens). */
    readonly maxTokens?: number;
    /** Maximum consecutive context-overflow compaction retries before letting the error surface. Defaults to 1. */
    readonly maxOverflowRetries?: number;
}
export interface ResolvedCompactConfig {
    readonly auto: boolean;
    readonly thresholdRatio: number;
    readonly headroomTokens: number | undefined;
    readonly retainRatio: number;
    readonly retainTokens: number | undefined;
    readonly summarizationProvider: string | undefined;
    readonly summarizationModel: string | undefined;
    readonly maxTokens: number;
    readonly maxOverflowRetries: number;
}
export interface PressureSpec {
    readonly contextWindow: number;
    readonly thresholdTokens: number;
    readonly retainTokens: number;
}
export declare class PressureConfigError extends Error {
    readonly targetKey: string;
    constructor(targetKey: string, message: string);
}
export declare function resolveCompactConfig(raw?: SpineCompactConfig): ResolvedCompactConfig;
export declare function resolvePressureSpec(config: ResolvedCompactConfig, targetKey: string, contextWindow: number, reservedOutputTokens: number): PressureSpec;
export type SummaryRoute = Pick<LlmCallConfig, "provider" | "model" | "reasoningEffort">;
export interface SummarizeRequestOptions {
    readonly agent: Agent;
    readonly config: ResolvedCompactConfig;
    readonly route: SummaryRoute;
    readonly systemHead: Message | null;
    readonly messages: readonly Message[];
    readonly prefixCacheEligible: boolean;
    readonly header: EpochHeader | undefined;
    readonly forceClean?: boolean | undefined;
    readonly calls: CompactCall[];
    readonly signal: AbortSignal;
    readonly recoverError?: ((error: unknown) => Promise<boolean>) | undefined;
    readonly refreshMessages?: (() => {
        systemHead: Message | null;
        messages: readonly Message[];
    }) | undefined;
}
export interface PrunedToolResults {
    readonly messages: readonly Message[];
    readonly prunedCount: number;
}
/**
 * In-memory equivalent of `@deepseek-ai/dsh-compaction-tool-result-pruner` for
 * SpineJIT's overflow/oversized compaction path: truncates oversized `tool`
 * text content (keeping head 4096 + marker + tail 1024 across text blocks by
 * Unicode code point) without mutating `session.surface`, `<spine_memory>`, or
 * user/assistant messages.
 */
export declare function pruneOversizedToolResults(messages: readonly Message[]): PrunedToolResults;
/**
 * Summarize a Spine-live conversation span in two DSH-aligned stages:
 * 1. Cache-warm single call (same model, synced prefix, within safe input budget):
 *    reuses the conversation's exact system prompt, tools, toolHistory, sessionId,
 *    and messages, appending only the compaction instruction (cooperating with
 *    `compaction/summary-error` such as `image-offload`).
 * 2. Overflow / oversized / dedicated-model single clean call:
 *    runs without conversation tools and, when overflowing or over budget, prunes
 *    oversized tool results in memory (head 4096 + tail 1024) without modifying
 *    `session.surface`, chunking, or dropping earlier turns.
 */
export declare function summarizeConversation(ctx: Context, options: SummarizeRequestOptions): Promise<CompactSummary>;
//# sourceMappingURL=compact-summarizer.d.ts.map