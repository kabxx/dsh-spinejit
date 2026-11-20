import { type DeveloperMessage, type Message, type TokenUsage, type UserMessage } from "@deepseek-ai/dsh-llm";
import { type SessionEvent } from "@deepseek-ai/dsh-session";
import type { CompactBarrier, SourceCharacter, SpawnArrival } from "@spinejit/spine-sdk";
declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        /**
         * Context this plugin writes: node descriptors, memory, births and empty
         * slots. `sampling` marks the slot that begins a Spine sampling.
         */
        spine: {
            kind: "spine";
            sampling?: true;
        };
        /** A Spawn child's result, delivered to the session that bore it. */
        "spine-arrival": {
            kind: "spine-arrival";
            arrival: SpawnArrival;
        };
        "spine-compact": {
            kind: "spine-compact";
            barrier: CompactBarrier;
            calls?: CompactCall[];
        };
    }
}
export interface CompactCall {
    provider: string;
    model: string;
    usage?: TokenUsage;
}
export interface CompactSummary {
    text: string;
    calls: CompactCall[];
}
/**
 * How one surface event takes part in Spine context.
 * - host: DSH maintains it each step (system prompt, tool registry changes,
 *   runtime context). It is not a source and stays where it is.
 * - spine: written by this plugin.
 * - source: conversation the Spine core observes.
 */
export type SurfaceRole = "host" | "spine" | "source";
export declare class SpineDshError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** The message a surface event derives, before any later replacement. */
export declare function eventMessage(event: SessionEvent): Message;
export declare function surfaceRole(event: SessionEvent): SurfaceRole;
/** A message the user wrote. The Spine core numbers these as `[U<n>]`. */
export declare function isUserSource(event: SessionEvent): boolean;
/**
 * What the Spine core observes for one source event; the boundary is the event
 * seq. `anchorInText`: a user message logged by 0.1.1 or earlier, whose text
 * starts with its own `[U<n>]`; the core sees it without the number.
 */
export declare function sourceCharacter(event: SessionEvent, anchorInText?: boolean): SourceCharacter;
/** An empty developer message: on the surface, but derives no model message. */
export declare function emptySlot(): DeveloperMessage;
/** The empty slot a sampling appends first, marking in the log where it began. */
export declare function samplingSlot(): DeveloperMessage;
export declare function beginsSampling(event: SessionEvent): boolean;
/** Where an open sampling's stretch of the log ends: the next sampling begins, or its step ends. */
export declare function endsSampling(event: SessionEvent): boolean;
/** A Spawn child's arrival as the message its parent receives. */
export declare function arrivalMessage(arrival: SpawnArrival): UserMessage;
/** The arrival a logged message carries, or null. */
export declare function arrivalOf(event: SessionEvent): SpawnArrival | null;
/** One durable event holds both the epoch barrier and its model-visible replacement. */
export declare function compactMessage(barrier: CompactBarrier, summary: CompactSummary): UserMessage;
export declare function compactBarrierOf(event: SessionEvent): CompactBarrier | undefined;
/** A Spine item (node descriptor, memory, birth) as a model-visible user message. */
export declare function spineMessage(text: string): UserMessage;
/** The visible text of a message this plugin wrote; null for an empty slot. */
export declare function spineText(message: Message): string | null;
//# sourceMappingURL=events.d.ts.map