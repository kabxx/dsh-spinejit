import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadSpineConfigToml } from "@spinejit/spine-sdk/host";
import { SpineAgent } from "../dist/agent.js";
import { checkpointBuild } from "../dist/checkpoint-runtime.js";
import { LatestCheckpoint } from "../dist/reopen-checkpoint.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("the latest checkpoint is version-scoped and validates its committed prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine-reopen-cache-"));
  const log = join(directory, "session.v4.jsonl.zstd");
  const cache = join(directory, "plugins", ...manifest.name.split("/"), `v${manifest.version}`, "checkpoints", "latest.json.zst");
  const signal = new AbortController();
  const agent = { id: "session-checkpoint-test", session: { header: {} } };
  const host = {
    sessionPersistence: { async stat() { return { location: { kind: "jsonl", path: log } }; } },
    sessions: { async flush() { return true; } },
  };
  const cacheFor = (build = "original-build", config = "") => new LatestCheckpoint(agent, host, build, config);
  const store = cacheFor();
  await writeFile(log, "fixture log");
  const first = { seq: 0, type: "session/end-seed", ts: 100, data: { inherited: false } };
  const second = { seq: 1, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } };
  const payload = {
    sdk: "opaque SDK state",
    host: { sourceSeqs: [], userNumbers: [], anchored: [], anchorInText: [], entered: [], plan: [], projection: null },
  };
  await store.write([first], payload, signal.signal);
  assert.deepEqual(await store.read([{ ...first, ts: 200 }, second], signal.signal), { ...payload, through: 0 });
  await store.write([first, second], payload, signal.signal);
  assert.deepEqual(await readdir(dirname(cache)), ["latest.json.zst"]);
  assert.deepEqual(await cacheFor().read([first, second], signal.signal), { ...payload, through: 1 });
  assert.equal(await cacheFor("updated-build").read([first, second], signal.signal), undefined);
  assert.equal(await cacheFor("original-build", "changed-config").read([first, second], signal.signal), undefined);
  assert.equal(await cacheFor().read([first, { ...second, data: { ...second.data, turn: 5 } }], signal.signal), undefined);
  await writeFile(cache, "interrupted write");
  assert.equal(await cacheFor().read([first, second], signal.signal), undefined);
  signal.abort();
  await assert.rejects(cacheFor().read([first, second], signal.signal), { name: "AbortError" });
  await assert.rejects(cacheFor().write([first, second], payload, signal.signal), { name: "AbortError" });
  assert.equal(await readFile(cache, "utf8"), "interrupted write");
});

test("successive saves only hash the new suffix, including after a validated restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine-reopen-incremental-"));
  const log = join(directory, "session.v4.jsonl.zstd");
  await writeFile(log, "fixture log");
  const agent = { id: "session-checkpoint-incremental", session: { header: {} } };
  const host = {
    sessionPersistence: { async stat() { return { location: { kind: "jsonl", path: log } }; } },
    sessions: { async flush() { return true; } },
  };
  const makeStore = () => new LatestCheckpoint(agent, host, "build", "");
  const encodings = [0, 0, 0];
  const events = encodings.map((_, seq) => {
    const value = Object.freeze({ seq, type: "test", data: `event ${seq}` });
    return Object.freeze({ ...value, toJSON() { encodings[seq]++; return value; } });
  });
  const payload = {
    sdk: "opaque SDK state",
    host: { sourceSeqs: [], userNumbers: [], anchored: [], anchorInText: [], entered: [], plan: [], projection: null },
  };
  const signal = new AbortController().signal;
  const store = makeStore();
  await store.write(events.slice(0, 1), payload, signal);
  await store.write(events.slice(0, 2), payload, signal);
  assert.deepEqual(encodings, [1, 1, 0]);

  const reopened = makeStore();
  assert.deepEqual(await reopened.read(events, signal), { ...payload, through: 1 });
  assert.deepEqual(encodings, [2, 2, 0]);
  reopened.markRestored(1);
  await reopened.write(events, payload, signal);
  assert.deepEqual(encodings, [2, 2, 1]);
  assert.deepEqual(await makeStore().read(events, signal), { ...payload, through: 2 });
  const edited = [{ seq: 0, type: "test", data: "edited" }, ...events.slice(1)];
  assert.equal(await makeStore().read(edited, signal), undefined);
});

test("a live store reuses its log location until the log is moved or removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine-reopen-location-"));
  const original = join(directory, "original");
  const moved = join(directory, "moved");
  const removed = join(directory, "removed");
  const log = (parent) => join(parent, "session.v4.jsonl.zstd");
  const checkpoint = (parent) => join(parent, "plugins", ...manifest.name.split("/"), `v${manifest.version}`, "checkpoints", "latest.json.zst");
  await mkdir(original);
  await writeFile(log(original), "fixture log");
  let location = original;
  let lookups = 0;
  const host = {
    sessionPersistence: { async stat() {
      lookups++;
      return location && { location: { kind: "jsonl", path: log(location) } };
    } },
    sessions: { async flush() { return true; } },
  };
  const agent = { id: "session-checkpoint-location", session: { header: {} } };
  const store = new LatestCheckpoint(agent, host, "build", "");
  const signal = new AbortController().signal;
  const events = Array.from({ length: 5 }, (_, seq) => ({ seq, type: "turn/end", data: { turn: seq } }));
  const payload = {
    sdk: "opaque SDK state",
    host: { sourceSeqs: [], userNumbers: [], anchored: [], anchorInText: [], entered: [], plan: [], projection: null },
  };
  await store.write(events.slice(0, 1), payload, signal);
  await store.write(events.slice(0, 2), payload, signal);
  assert.deepEqual(await store.read(events, signal), { ...payload, through: 1 });
  assert.equal(lookups, 1);

  await rename(original, moved);
  location = moved;
  await store.write(events.slice(0, 3), payload, signal);
  assert.deepEqual(await store.read(events, signal), { ...payload, through: 2 });
  assert.equal(lookups, 2);
  await assert.rejects(readdir(original), { code: "ENOENT" });

  // A remaining session directory without its log is not a write target.
  const saved = await readFile(checkpoint(moved));
  await rename(log(moved), join(moved, "detached-log"));
  await store.write(events.slice(0, 4), payload, signal);
  assert.deepEqual(await readFile(checkpoint(moved)), saved);
  assert.equal(lookups, 3);

  await rename(moved, removed);
  location = undefined;
  await store.write(events, payload, signal);
  assert.equal(lookups, 4);
  await assert.rejects(readdir(moved), { code: "ENOENT" });
});

test("a cache hit can be cancelled during prefix validation before importing or replaying history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spine-reopen-validate-cancel-"));
  const log = join(directory, "session.v4.jsonl.zstd");
  await writeFile(log, "fixture log");
  const owner = new AbortController();
  const reason = new Error("plugin unloaded during checkpoint validation");
  const config = loadSpineConfigToml();
  const host = {
    sessionPersistence: { async stat() { return { location: { kind: "jsonl", path: log } }; } },
    sessions: { async flush() { return true; } },
  };
  const prefix = Array.from({ length: 512 }, (_, seq) => ({ seq, type: "turn/end", data: { turn: seq } }));
  let eventReads = 0;
  let encoded = 0;
  const events = prefix.map((event) => ({
    ...event,
    get type() { eventReads++; return event.type; },
    toJSON() {
      if (++encoded === 1) setImmediate(() => owner.abort(reason));
      return event;
    },
  }));
  const agent = { id: "session-checkpoint-validate-cancel", session: { header: {}, snapshotEvents: () => events } };
  const payload = {
    sdk: "opaque SDK state",
    host: { sourceSeqs: [], userNumbers: [], anchored: [], anchorInText: [], entered: [], plan: [], projection: null },
  };
  const store = new LatestCheckpoint(agent, host, checkpointBuild(), config);
  await store.write(prefix, payload, owner.signal);
  await assert.rejects(SpineAgent.create(agent, config, () => {}, () => {}, host, owner.signal), (error) => error === reason);
  assert.ok(encoded > 0 && encoded < events.length, `unexpected validation count ${encoded}`);
  assert.equal(eventReads, events.length + encoded, "only the Fork boundary scan and validation should read events");
});

test("cancellation during storage lookup rejects without reading history for a fallback", async () => {
  const owner = new AbortController();
  const reason = new Error("plugin unloaded during cache lookup");
  let typeReads = 0;
  const event = { seq: 0, get type() { typeReads++; return "turn/end"; } };
  const agent = { id: "session-checkpoint-cancel", session: { header: {}, snapshotEvents: () => [event] } };
  const host = {
    sessionPersistence: { async stat() { owner.abort(reason); throw reason; } },
    sessions: { async flush() { return true; } },
  };
  await assert.rejects(SpineAgent.create(agent, loadSpineConfigToml(), () => {}, () => {}, host, owner.signal), (error) => error === reason);
  assert.equal(typeReads, 1, "only the initial Fork boundary scan should read the event");
});

test("an in-progress replay yields to a reload and stops reading the log", async () => {
  const owner = new AbortController();
  const reason = new Error("plugin unloaded during replay");
  let replayed = 0;
  const events = Array.from({ length: 512 }, (_, seq) => {
    let reads = 0;
    return { seq, get type() {
      // Each event is read once by the initial Fork boundary scan.
      if (++reads === 2) {
        replayed++;
        if (seq === 0) setImmediate(() => owner.abort(reason));
      }
      return "turn/end";
    } };
  });
  const agent = { id: "session-replay-cancel", session: { header: {}, snapshotEvents: () => events } };
  const host = {
    sessionPersistence: { async stat() { return undefined; } },
    sessions: { async flush() { return true; } },
  };
  await assert.rejects(SpineAgent.create(agent, loadSpineConfigToml(), () => {}, () => {}, host, owner.signal), (error) => error === reason);
  assert.ok(replayed > 0 && replayed < events.length, `unexpected replay count ${replayed}`);
});
