import type { Message } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { FeatureFlag, SpineProjection } from "@spinejit/spine-sdk";
import { type SpawnBirth, type SpineToolName } from "@spinejit/spine-sdk/host";
import { SpineDshError, type CompactSummary } from "./events.js";
export declare const SPINE_FEATURES: FeatureFlag[];
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
export declare class SpineToolLimitError extends Error {
    constructor(staged: SpineToolName);
}
export declare class SpineCompactCommitError extends SpineDshError {
}
export declare const SPINE_ATTACHMENT = "spinejitAttachment";
export interface SpineAttachment {
    ensure(agent: Agent): Promise<SpineAgent>;
    readonly signal: AbortSignal;
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
export declare class SpineAgent {
    #private;
    readonly agent: Agent;
    private constructor();
    static create(agent: Agent, configToml: string, born: BirthHandler, changed: ProjectionHandler): Promise<SpineAgent>;
    get projection(): SpineProjection | null;
    get fault(): unknown;
    /** Index one event of this agent's session; a new source waits for observation. */
    accept(event: SessionEvent): void;
    /** Births still pending whose arrival is not in the log yet. */
    openBirths(): SpawnBirth[];
    /** A step opened: bring the surface to the published plan. */
    enterStep(turn: number, step: number): Promise<void>;
    /** A main-loop request is about to stream. Its messages must be the plan; it begins a sampling. */
    beginSampling(): Promise<void>;
    /**
     * Admit one Spine tool call of the current sampling and return its result
     * text, or throw the tool error the model sees. The sampling stages it when
     * it settles, if its logged result is not an error.
     */
    admit(name: SpineToolName, args: Record<string, unknown>): string;
    /** Settle the open sampling, if any, over its stretch of the log so far. */
    settle(): Promise<void>;
    /** Run under DSH's idle maintenance lock so input cannot start a turn mid-checkpoint. */
    compact(summarize: (messages: readonly Message[]) => Promise<CompactSummary>, flush: () => Promise<void>, signal: AbortSignal): Promise<{
        seq: SessionSeq;
        summary: string;
    } | null>;
    dispose(): void;
}
//# sourceMappingURL=agent.d.ts.map