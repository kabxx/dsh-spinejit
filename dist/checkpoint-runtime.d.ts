import type { NodeSpineRuntime, NodeSpineRuntimeOptions, SpineToolInput } from "@spinejit/spine-sdk/node";
export declare function checkpointBuild(): string;
export interface CheckpointNodeRuntime extends NodeSpineRuntime {
    exportCheckpoint(): Promise<string>;
    exportPreSamplingCheckpoint(): Promise<string>;
    importCheckpoint(state: string): Promise<void>;
}
export declare function validateSpineToolInput<T extends SpineToolInput["type"]>(tool: T, input: Record<string, unknown>): Extract<SpineToolInput, {
    type: T;
}>;
/** Use the stock JS SDK protocol client with the checkpoint-capable native binding. */
export declare function createCheckpointNodeRuntime(options: NodeSpineRuntimeOptions): CheckpointNodeRuntime;
//# sourceMappingURL=checkpoint-runtime.d.ts.map