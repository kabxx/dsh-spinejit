const SPAWN_SUFFIX = /:spawn:(\d+(?:\.\d+)*)$/;
/** A durable Spawn identity, shared by the Host and the browser. */
export function spawnIdentity(id) {
    const match = SPAWN_SUFFIX.exec(id);
    if (match === null)
        return null;
    return { parent: id.slice(0, match.index), producer: match[1].split(".").map(Number) };
}
//# sourceMappingURL=spawn-id.js.map