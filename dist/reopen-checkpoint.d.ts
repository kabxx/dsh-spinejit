import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent, SessionSeq } from "@deepseek-ai/dsh-session";
import type { PlanItem } from "./projection.js";
import type { SpineProjection } from "@spinejit/spine-sdk";
export interface HostCheckpoint {
    sourceSeqs: [string, SessionSeq][];
    userNumbers: [SessionSeq, number][];
    anchored: SessionSeq[];
    anchorInText: SessionSeq[];
    entered: string[];
    plan: PlanItem[] | null;
    projection: SpineProjection | null;
}
interface Capture {
    sdk: string;
    host: HostCheckpoint;
}
export declare class LatestCheckpoint {
    #private;
    readonly agent: Agent;
    private readonly host;
    constructor(agent: Agent, host: Pick<Agent["ctx"], "sessionPersistence" | "sessions">, build: string, configToml: string);
    flush(): Promise<boolean>;
    read(events: readonly SessionEvent[], signal: AbortSignal): Promise<(Capture & {
        through: number;
    }) | undefined>;
    markRestored(through: number): void;
    needsUpdate(through: number): boolean;
    write(events: readonly SessionEvent[], payload: Capture, signal: AbortSignal): Promise<void>;
}
export {};
//# sourceMappingURL=reopen-checkpoint.d.ts.map