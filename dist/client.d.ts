import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { worktreeText, type SpineDockProps } from "./worktree.js";
export { SpineDock, type SpineDockProps } from "./worktree.js";
/** The part of the client's slot service the entry uses. */
interface Slots {
    inject(name: "conversation.input.dock", register: () => unknown): unknown;
    register(entry: {
        name: "conversation.input.dock";
        id: string;
        order: number;
        locale: string;
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
            register(definition: typeof emptySpineContextDefinition): () => void;
        };
    };
    locale: {
        register(namespace: string, dictionaries: typeof worktreeText): () => void;
    };
    effect(execute: () => () => void, label?: string): unknown;
}): void;
//# sourceMappingURL=client.d.ts.map