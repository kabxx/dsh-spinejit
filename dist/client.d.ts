import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { compactStatsDefinition } from "./compact-stats.js";
import { worktreeText, type SpineDockProps } from "./worktree.js";
export { SpineDock, type SpineDockProps } from "./worktree.js";
interface ComposerBlock {
    readonly reason: string;
}
interface ComposerBlocks {
    set(sessionId: string, block?: ComposerBlock): void;
    storeFor(sessionId: string): {
        getSnapshot(): ComposerBlock | undefined;
        subscribe(notify: () => void): () => void;
    };
}
type ChildAddress = {
    mode: string;
    childSessionId: string;
    parentSessionId: string;
};
interface SpawnSendProps {
    sessionId: string;
    useSession(select: (session: {
        running?: boolean;
        removed?: boolean;
        subagent?: {
            address: ChildAddress;
        } | null;
    }) => boolean): boolean;
    t(key: "placeholder"): string;
}
declare const SPAWN_LOCALE = "spinejit-spawn";
declare const SPAWN_COPY: {
    en: {
        placeholder: string;
    };
    zh: {
        placeholder: string;
    };
};
/** The part of the client's slot service the entries use. */
interface Slots {
    inject(name: "conversation.input.dock" | "conversation.composer.dock", register: () => unknown): unknown;
    register(entry: {
        name: "conversation.input.dock";
        id: string;
        order: number;
        locale: string;
        registrant: string;
    }, component: (props: SpineDockProps) => unknown): unknown;
    register(entry: {
        name: "conversation.composer.dock";
        id: string;
        locale: typeof SPAWN_LOCALE;
    }, component: (props: SpawnSendProps) => unknown): unknown;
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
interface SessionStatus {
    sessionStatus: {
        getSnapshot(): ReadonlyMap<string, {
            pendingInteraction: unknown;
        }>;
    };
}
export declare const inject: string[];
export declare function apply(ctx: {
    slots: Slots;
    uiConversation: {
        events: {
            register(definition: typeof emptySpineContextDefinition | typeof compactStatsDefinition): () => void;
        };
    };
    conversation: {
        blocks: ComposerBlocks;
    };
    uiSession: SessionStatus;
    locale: {
        bind(namespace: "conversation"): (key: "input.stop") => string;
        register(namespace: string, dictionaries: typeof worktreeText | typeof SPAWN_COPY): () => void;
    };
    effect(execute: () => () => void, label?: string): unknown;
}): void;
//# sourceMappingURL=client.d.ts.map