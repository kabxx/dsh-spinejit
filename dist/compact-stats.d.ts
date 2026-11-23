import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { CompactCall } from "./events.js";
interface Match {
    readonly event: SessionEvent;
    readonly location: unknown;
}
interface CheckpointStats {
    readonly turn: number;
    readonly calls: readonly CompactCall[];
    readonly summaryChars: number;
    readonly shadowedTokens: number | null;
}
interface StatsContext {
    readonly key: string;
    readonly kind: string;
    readonly id: string;
    readonly start: Match | undefined;
    readonly state: CheckpointStats | null | undefined;
}
interface PreviousContexts {
    previous(kind: string): {
        readonly matches: readonly Match[];
    } | undefined;
}
export declare const compactStatsDefinition: {
    kind: string;
    target: string;
    match(event: SessionEvent): {
        id: string;
        role: "start";
    } | null;
    start(_context: unknown, { event }: Match, reader: PreviousContexts): CheckpointStats | null;
    update(context: StatsContext): CheckpointStats | null;
    buildViewNode({ key, kind, id, start, state }: StatsContext): {
        key: string;
        kind: string;
        id: string;
        target: string;
        anchorSeq: import("@deepseek-ai/dsh-session").SessionSeq;
        location: unknown;
        data: {
            kind: string;
            metrics: {
                compactionId: string;
                turn: number;
                startTime: number;
                endTime: null;
                wall: null;
                running: boolean;
                context: number | null;
                output: number | null;
                cacheHit: number | null;
                cacheRead: number | null;
                cacheWrite: number | null;
                provider: string;
                model: string;
                shadowedTokens: number | null;
                summaryChars: number;
                error: null;
            };
        };
    } | null;
};
export {};
//# sourceMappingURL=compact-stats.d.ts.map