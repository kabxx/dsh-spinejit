import { type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { SpineProjection } from "@spinejit/spine-sdk";
import { z } from "zod";
import { type SpineTree } from "./tree.js";
declare module "@deepseek-ai/dsh-session" {
    interface PluginRecordMap {
        "plugin:spinejit/tree": SpineTree;
    }
}
/**
 * The session projection clients read the tree from: the tree of the latest
 * record, null before the first. A record this build cannot read leaves the
 * tree as it was.
 */
export declare const treeProjection: {
    key: string;
    stateVersion: number;
    stateSchema: z.ZodNullable<z.ZodType<SpineTree, unknown, z.core.$ZodTypeInternals<SpineTree, unknown>>>;
    init: () => SpineTree | null;
    apply(state: SpineTree | null, event: SessionEvent): SpineTree | null;
    wire: {
        summary: boolean;
        viewSchema: z.ZodNullable<z.ZodType<SpineTree, unknown, z.core.$ZodTypeInternals<SpineTree, unknown>>>;
        view: (state: SpineTree | null) => SpineTree | null;
    };
};
/**
 * Each agent's tree, and the one the terminal shows: the top-level session
 * opened or changed last. dsh-tui tells plugins which session it shows only
 * through its gated decision events, and only the session it shows runs turns,
 * so the newest top-level activity stands for it; subagent sessions never do.
 */
export declare class TreeDisplay {
    #private;
    /** Follow an agent's session from the last tree its log recorded. */
    open(session: Session): void;
    /** The agent published or committed a projection: when what its tree shows changed, show it and record it. */
    update(session: Session, projection: SpineProjection): void;
    close(id: string): void;
    readonly subscribe: (listener: () => void) => (() => void);
    /** The shown session's tree: the same object until it changes, as useSyncExternalStore needs. */
    readonly shown: () => SpineTree | null;
}
//# sourceMappingURL=display.d.ts.map