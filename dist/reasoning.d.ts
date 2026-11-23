import { type Message } from "@deepseek-ai/dsh-llm";
import { type Session, type SessionSeq } from "@deepseek-ai/dsh-session";
import type { SessionMessageProjection } from "@deepseek-ai/dsh-session/surface";
export declare const WITHOUT_REASONING = "plugin:spinejit/without-reasoning";
declare module "@deepseek-ai/dsh-session/types" {
    interface PluginRecordMap {
        /**
         * Drop the reasoning of the named assistant/message nodes from later
         * model requests: their reasoning blocks and their provider replay state
         * (thinking signatures and the like). Text and tool calls stay.
         */
        "plugin:spinejit/without-reasoning": {
            seqs: SessionSeq[];
        };
    }
}
/** The message without its reasoning blocks and provider replay state. */
export declare function withoutReasoning(message: Message): Message;
/** Whether the message carries pi-ai replay metadata from the Anthropic Messages API. */
export declare function isAnthropicMessagesReplay(message: Message): boolean;
/**
 * Whether the message still carries reasoning the label asks to drop.
 *
 * Gemini's reasoning is not tied to the prefix: Gemini accepts its thought
 * signatures after the prefix changed, and requires them on the function
 * calls of its current turn, where the sampling after a close sits once the
 * node folds. A Gemini output keeps its reasoning. Only the pi-ai adapter's
 * replay state names the API that produced a message.
 */
export declare function hasReasoning(message: Message): boolean;
export declare const withoutReasoningProjection: SessionMessageProjection;
/** Log one decision for the plan's labelled sources that still show reasoning. */
export declare function dropReasoning(session: Session, seqs: readonly SessionSeq[]): void;
//# sourceMappingURL=reasoning.d.ts.map