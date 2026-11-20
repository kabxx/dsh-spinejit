import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { compactStatsDefinition } from "./compact-stats.js";
import { TREE_PROJECTION, type SpineTree } from "./tree.js";
/** The dock seat's props the entry reads. */
export interface SpineDockProps {
    useProjection(key: typeof TREE_PROJECTION): SpineTree | null | undefined;
}
/** The part of the client's slot service the entry uses. */
interface Slots {
    inject(name: "conversation.input.dock", register: () => unknown): unknown;
    register(entry: {
        name: "conversation.input.dock";
        id: string;
        order: number;
        registrant: string;
    }, component: (props: SpineDockProps) => unknown): unknown;
}
/** Hide only Spine's empty replay markers and reserved slots, not other events. */
declare const emptySpineContextDefinition: {
    kind: string;
    target: string;
    match: {
        "developer/message"(event: SessionEvent<"developer/message">): {
            id: string;
            role: "start";
            exclusive: true;
        } | null;
    };
    start: () => null;
    update: () => null;
    buildViewNode: () => null;
};
export declare const inject: string[];
export declare function apply(ctx: {
    slots: Slots;
    uiConversation: {
        events: {
            register(definition: typeof emptySpineContextDefinition | typeof compactStatsDefinition): () => void;
        };
    };
    effect(execute: () => () => void, label?: string): unknown;
}): void;
/** Hook-free but for `useProjection`, so the dock can also call it as a plain function. */
export declare function SpineDock({ useProjection }: SpineDockProps): unknown;
export {};
//# sourceMappingURL=client.d.ts.map