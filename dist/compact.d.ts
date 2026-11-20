declare module "@deepseek-ai/dsh-llm/types" {
    interface LlmRequestPurposeMap {
        compaction: true;
    }
}
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
export declare const name = "spinejit-compact";
export declare const inject: string[];
interface Invocation {
    agent: Agent;
    rawInput: string;
    signal: AbortSignal;
}
type CommandResult = {
    kind: "success";
    text: string;
    sourceEventSeq?: number;
} | {
    kind: "error";
    text: string;
};
type CompactContext = Context & {
    commands: {
        register(definition: {
            definitionId: string;
            name: string;
            description: string;
            handler(invocation: Invocation): Promise<CommandResult>;
        }): () => void;
    };
};
export declare function apply(ctx: CompactContext): void;
export {};
//# sourceMappingURL=compact.d.ts.map