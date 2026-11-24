import { createHash, randomUUID, type Hash } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import * as zlib from "node:zlib";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionEvent, SessionSeq } from "@deepseek-ai/dsh-session";
import { z } from "zod";

import type { PlanItem } from "./projection.js";
import type { SpineProjection } from "@spinejit/spine-sdk";

export interface HostCheckpoint {
  sourceSeqs: [string, SessionSeq][];
  boundarySeqs?: [number, SessionSeq][];
  boundaryOffset?: number;
  userNumbers: [SessionSeq, number][];
  anchored: SessionSeq[];
  anchorInText: SessionSeq[];
  entered: string[];
  compactDroppedReasoning?: SessionSeq[];
  plan: PlanItem[] | null;
  projection: SpineProjection | null;
}

const manifest = createRequire(import.meta.url)("../package.json") as { name: string; version: string };
const safeSegment = /^[a-z0-9][a-z0-9._~-]*$/i;
const version = /^\d+\.\d+\.\d+(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const packageParts = manifest.name.split("/");
const validPackage = (packageParts.length === 1 && safeSegment.test(packageParts[0]!))
  || (packageParts.length === 2 && packageParts[0]!.startsWith("@")
    && safeSegment.test(packageParts[0]!.slice(1)) && safeSegment.test(packageParts[1]!));

const schema = "spine-dsh-reopen/v1";
let hostBuild: string | undefined;
function hostBuildId(): string {
  if (hostBuild !== undefined) return hostBuild;
  const hash = createHash("sha256");
  for (const name of ["index", "agent", "anchors", "compact-range", "events", "projection", "reasoning", "spawn", "reopen-checkpoint"]) {
    hash.update(name).update(readFileSync(new URL(`./${name}.js`, import.meta.url)));
  }
  for (const specifier of ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-llm", "@spinejit/spine-sdk/host"]) {
    hash.update(specifier).update(readFileSync(new URL(import.meta.resolve(specifier))));
  }
  return hostBuild = hash.digest("hex");
}
const nonnegative = z.number().int().nonnegative();
const seqs = z.array(nonnegative);
const textSeq = z.array(z.tuple([z.string(), nonnegative]));
const planItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("source"), seq: nonnegative, anchor: nonnegative.nullable(), withoutReasoning: z.boolean() }),
  z.object({ type: z.literal("spine"), text: z.string() }),
]);
const envelope = z.object({
  schema: z.literal(schema), identity: z.string(), through: nonnegative,
  prefix: z.string(), checksum: z.string(), contents: z.string(),
});
const payloadSchema = z.object({
  sdk: z.string(), host: z.object({
    sourceSeqs: textSeq,
    boundarySeqs: z.array(z.tuple([nonnegative, nonnegative])).optional(),
    boundaryOffset: nonnegative.optional(),
    userNumbers: z.array(z.tuple([nonnegative, nonnegative])),
    anchored: seqs, anchorInText: seqs, entered: z.array(z.string()),
    compactDroppedReasoning: seqs.optional(),
    plan: z.array(planItem).nullable(), projection: z.record(z.string(), z.unknown()).nullable(),
  }),
});

// The SDK bounds the size of an individual decoded state. This is a parser
// safety limit on a single file, independent of retention or disk quotas.
const maxDecodedBytes = 256 * 1024 * 1024;
const codec = zlib as typeof zlib & {
  zstdCompress?: (input: Buffer, callback: (error: Error | null, buffer: Buffer) => void) => void;
  zstdDecompress?: (input: Buffer, opts: { maxOutputLength: number }, callback: (error: Error | null, buffer: Buffer) => void) => void;
};
function compress(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => codec.zstdCompress!(input, (error, buffer) => error ? reject(error) : resolve(buffer)));
}
function decompress(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => codec.zstdDecompress!(input, { maxOutputLength: maxDecodedBytes },
    (error, buffer) => error ? reject(error) : resolve(buffer)));
}

interface Storage { log: string; directory: string; file: string }
interface Capture { sdk: string; host: HostCheckpoint }

function missingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function hasLog(storage: Storage): Promise<boolean> {
  try {
    return (await stat(storage.log)).isFile();
  } catch (error) {
    if (missingPath(error)) return false;
    throw error;
  }
}

export class LatestCheckpoint {
  readonly #identity?: string;
  #saved = -1;
  #prefix = new SessionPrefixHash();
  #location: Storage | undefined;

  constructor(readonly agent: Agent, private readonly host: Pick<Agent["ctx"], "sessionPersistence" | "sessions">, build: string, configToml: string) {
    try {
      this.#identity = digest(JSON.stringify([schema, manifest.name, manifest.version,
        build, hostBuildId(), agent.id, agent.session.header.parentSession ?? null, configToml]));
    } catch {
      // Without a trustworthy build identity, use ordinary log recovery.
    }
  }

  flush(): Promise<boolean> {
    return this.host.sessions.flush(this.agent.session);
  }

  async #storage(signal: AbortSignal): Promise<Storage | undefined> {
    if (this.#identity === undefined || !validPackage || !version.test(manifest.version)
      || !codec.zstdCompress || !codec.zstdDecompress) return;
    signal.throwIfAborted();
    const cached = this.#location;
    if (cached !== undefined) {
      const exists = await hasLog(cached);
      signal.throwIfAborted();
      if (exists) return cached;
      this.#forget(cached);
    }
    const snapshot = await this.host.sessionPersistence.stat(this.agent.id, { signal });
    signal.throwIfAborted();
    const location = (snapshot as { location?: { kind: string; path?: string } } | undefined)?.location;
    if (location?.kind !== "jsonl" || !location.path || !isAbsolute(location.path)) return;
    const directory = dirname(location.path);
    const storage = { log: location.path, directory,
      file: join(directory, "plugins", ...packageParts, `v${manifest.version}`, "checkpoints", "latest.json.zst") };
    const exists = await hasLog(storage);
    signal.throwIfAborted();
    if (exists) return this.#location = storage;
  }

  #forget(storage: Storage): void {
    if (this.#location === storage) this.#location = undefined;
  }

  async read(events: readonly SessionEvent[], signal: AbortSignal): Promise<(Capture & { through: number }) | undefined> {
    try {
      signal.throwIfAborted();
      const storage = await this.#storage(signal);
      signal.throwIfAborted();
      if (!storage) return;
      const { size } = await stat(storage.file);
      signal.throwIfAborted();
      if (size > maxDecodedBytes) return;
      const bytes = await readFile(storage.file, { signal });
      const decoded = await decompress(bytes);
      signal.throwIfAborted();
      const header = envelope.parse(JSON.parse(decoded.toString("utf8")));
      if (header.identity !== this.#identity || digest(header.contents) !== header.checksum) return;
      const prefix = new SessionPrefixHash();
      const length = header.through + 1;
      if (events[header.through]?.seq !== header.through
        || await prefix.readDigest(events, length, signal) !== header.prefix) return;
      const payload = payloadSchema.parse(JSON.parse(header.contents));
      signal.throwIfAborted();
      this.#prefix = prefix;
      return { through: header.through, sdk: payload.sdk, host: payload.host as HostCheckpoint };
    } catch {
      signal.throwIfAborted();
      return;
    }
  }

  markRestored(through: number): void {
    this.#saved = through;
  }

  needsUpdate(through: number): boolean {
    return through > this.#saved;
  }

  async write(events: readonly SessionEvent[], payload: Capture, signal: AbortSignal): Promise<void> {
    const through = events.at(-1)?.seq;
    if (through === undefined || !this.needsUpdate(through)) return;
    let storage = await this.#storage(signal);
    if (!storage) return;
    signal.throwIfAborted();
    const contents = JSON.stringify(payload);
    const raw = Buffer.from(JSON.stringify({
      schema, identity: this.#identity, through, prefix: this.#prefix.digest(events), checksum: digest(contents), contents,
    }));
    if (raw.length > maxDecodedBytes) return;
    const bytes = await compress(raw);
    signal.throwIfAborted();
    if (!this.needsUpdate(through)) return;
    if (!await hasLog(storage)) {
      this.#forget(storage);
      storage = await this.#storage(signal);
      if (!storage) return;
    }
    signal.throwIfAborted();
    const temporary = `${storage.file}.${randomUUID()}.tmp`;
    try {
      // Do not recursively recreate an absent session directory.
      let directory = storage.directory;
      for (const part of relative(directory, dirname(storage.file)).split(sep)) {
        signal.throwIfAborted();
        directory = join(directory, part);
        await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      }
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, signal });
      if (!await hasLog(storage)) {
        this.#forget(storage);
        return;
      }
      signal.throwIfAborted();
      if (!this.needsUpdate(through)) return;
      renameSync(temporary, storage.file);
      this.#saved = through;
    } catch (error) {
      signal.throwIfAborted();
      if (!missingPath(error)) throw error;
      this.#forget(storage);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}

function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }

class SessionPrefixHash {
  #hash: Hash = createHash("sha256");
  #length = 0;
  #last?: SessionEvent;

  digest(events: readonly SessionEvent[]): string {
    // A checkpoint store belongs to one live session. Its snapshots share
    // the same frozen events across appends, so the hashed prefix is stable.
    if (events.length < this.#length || (this.#length > 0 && events[this.#length - 1] !== this.#last)) {
      this.#hash = createHash("sha256");
      this.#length = 0;
    }
    this.#append(events, events.length);
    return this.#hash.copy().digest("hex");
  }

  async readDigest(events: readonly SessionEvent[], length: number, signal: AbortSignal): Promise<string> {
    // A restore validates the entire saved prefix. Yield between batches so an
    // unload can interrupt validation before this state becomes the live hash.
    while (this.#length < length) {
      signal.throwIfAborted();
      this.#append(events, Math.min(this.#length + 128, length));
      if (this.#length < length) await yieldToLoop();
    }
    signal.throwIfAborted();
    return this.#hash.copy().digest("hex");
  }

  #append(events: readonly SessionEvent[], length: number): void {
    for (; this.#length < length; this.#length += 1) {
      const event = events[this.#length]!;
      // DSH may timestamp the same ordinary end marker differently on reopen.
      const value = event.type === "session/end-seed" && event.data.inherited !== true
        ? [event.type, event.seq, event.data] : event;
      this.#hash.update(JSON.stringify(value)).update("\n");
      this.#last = event;
    }
  }
}
