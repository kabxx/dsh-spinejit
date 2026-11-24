import { COMPACT_CHECKPOINT_PREFIX } from "./compact-format.js";
function checkpoint(event) {
    if (event.type !== "user/message" || event.data.source.kind !== "spine-compact")
        return null;
    return { source: event.data.source, content: event.data.content };
}
// The registration uses DSH's Conversation API. This row's payload follows
// the experimental Statistics view contract for the supported DSH version.
export const compactStatsDefinition = {
    kind: "spinejit.compact-stats",
    target: "stats",
    match(event) {
        return checkpoint(event)?.source.calls?.length ? { id: `spine-compact:${event.seq}`, role: "start" } : null;
    },
    start(_context, { event }, reader) {
        const message = checkpoint(event);
        if (message === null)
            return null;
        // Automatic compactions record their enclosing open turn directly; idle
        // manual checkpoints sit outside a turn and attach after the last turn end.
        let turn = message.source.turn;
        if (turn === undefined) {
            const end = reader.previous("stats-turn-end")?.matches[0]?.event;
            if (end?.type !== "turn/end")
                return null;
            turn = end.data.turn;
        }
        const text = message.content.reduce((text, block) => block.type === "text" ? text + block.text : text, "");
        return {
            turn,
            calls: message.source.calls ?? [],
            summaryChars: text.startsWith(COMPACT_CHECKPOINT_PREFIX)
                ? text.length - COMPACT_CHECKPOINT_PREFIX.length
                : text.length,
            shadowedTokens: typeof message.source.shadowedTokens === "number" ? message.source.shadowedTokens : null,
        };
    },
    update(context) { return context.state ?? null; },
    buildViewNode({ key, kind, id, start, state }) {
        if (start === undefined || state == null)
            return null;
        const route = state.calls[0];
        if (route === undefined)
            return null;
        let context = 0;
        let output = 0;
        let cacheRead = 0;
        let cacheWrite = 0;
        let reported = 0;
        let reportedRead = false;
        let reportedWrite = false;
        for (const { usage } of state.calls) {
            if (usage === undefined)
                continue;
            reported++;
            const read = usage.cacheReadTokens ?? 0;
            const write = usage.cacheWriteTokens ?? 0;
            context += usage.inputTokens + read + write;
            output += usage.outputTokens;
            cacheRead += read;
            cacheWrite += write;
            reportedRead ||= usage.cacheReadTokens !== undefined;
            reportedWrite ||= usage.cacheWriteTokens !== undefined;
        }
        const complete = reported === state.calls.length;
        return {
            key, kind, id, target: "stats", anchorSeq: start.event.seq, location: start.location,
            data: { kind: "compaction", metrics: {
                    compactionId: id,
                    turn: state.turn,
                    startTime: start.event.time,
                    endTime: null,
                    wall: null,
                    running: false,
                    context: reported > 0 ? context : null,
                    output: reported > 0 ? output : null,
                    cacheHit: complete && reportedRead && context > 0 ? Math.min(1, cacheRead / context) : null,
                    cacheRead: reportedRead ? cacheRead : null,
                    cacheWrite: reportedWrite ? cacheWrite : null,
                    provider: route.provider,
                    model: route.model,
                    shadowedTokens: state.shadowedTokens,
                    summaryChars: state.summaryChars,
                    error: null,
                } },
        };
    },
};
//# sourceMappingURL=compact-stats.js.map