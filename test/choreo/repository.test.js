import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Der lokale Speicher (IndexedDB) wird durch ein Protokoll ersetzt.
const localCalls = [];
vi.mock("../../public/js/choreo/data/local.js", () => {
  const log = (name) => (...args) => { localCalls.push([name, ...args]); return Promise.resolve(); };
  return {
    local: {
      put: log("put"),
      remove: log("remove"),
      enqueue: log("enqueue"),
      replaceProjectRows: log("replaceProjectRows"),
      replaceProjects: log("replaceProjects"),
      replaceMemberships: log("replaceMemberships"),
      listByProject: async () => [{ id: "aus-dem-cache" }],
      listProjects: async () => [{ id: "cache-projekt" }],
      listMemberships: async () => [],
      queued: async () => globalThis.__queue ?? [],
      dequeue: async (id) => { localCalls.push(["dequeue", id]); },
    },
  };
});

const { createRepository } = await import("../../public/js/choreo/data/repository.js");

function fakeRemote(overrides = {}) {
  const calls = [];
  const remote = {
    calls,
    listByProject: async () => [{ id: "vom-server" }],
    listProjects: async () => [{ id: "p" }],
    insert: async (...a) => { calls.push(["insert", ...a]); },
    upsert: async (...a) => { calls.push(["upsert", ...a]); },
    update: async (...a) => { calls.push(["update", ...a]); },
    remove: async (...a) => { calls.push(["remove", ...a]); },
    updateKeepalive: async (...a) => { calls.push(["keepalive", ...a]); return { ok: true }; },
    ...overrides,
  };
  return remote;
}
const failing = async () => { throw new Error("offline"); };

beforeEach(() => {
  localCalls.length = 0;
  globalThis.__queue = [];
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Lesen", () => {
  it("spiegelt Serverdaten lokal", async () => {
    const repo = createRepository(fakeRemote());
    expect(await repo.loadRows("steps", "p1")).toEqual([{ id: "vom-server" }]);
    expect(localCalls[0]).toEqual(["replaceProjectRows", "steps", "p1", [{ id: "vom-server" }]]);
  });

  it("fällt ohne Netz auf den lokalen Spiegel zurück", async () => {
    const repo = createRepository(fakeRemote({ listByProject: failing, listProjects: failing }));
    expect(await repo.loadRows("steps", "p1")).toEqual([{ id: "aus-dem-cache" }]);
    expect(await repo.loadProjects()).toEqual({ rows: [{ id: "cache-projekt" }], fromCache: true });
  });
});

describe("Schreiben", () => {
  it("fasst schnelle Änderungen zu einem Speichern zusammen", async () => {
    const remote = fakeRemote();
    const repo = createRepository(remote);
    const row = { id: "s1", label: "a" };
    repo.patch("persons", row, { name: "A" });
    repo.patch("persons", row, { name: "An" });
    repo.patch("persons", row, { number: 2 });
    expect(remote.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(remote.calls).toEqual([["update", "persons", "s1", { name: "An", number: 2 }]]);
  });

  it("stempelt updated_at nur bei Tabellen, die die Spalte haben", async () => {
    const remote = fakeRemote();
    const repo = createRepository(remote);
    repo.patch("choreo_segments", { id: "m1" }, { label: "Kreis" }, { delay: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const [, , , patch] = remote.calls[0];
    expect(patch.label).toBe("Kreis");
    expect(typeof patch.updated_at).toBe("string");
  });

  it("legt fehlgeschlagene Änderungen in die Warteschlange und meldet das", async () => {
    const repo = createRepository(fakeRemote({ insert: failing, update: failing }));
    const notices = [];
    repo.onNotice((m) => notices.push(m));

    await repo.insert("steps", { id: "x1" }, { offlineMessage: "offline!" });
    repo.patch("steps", { id: "x2" }, { foot: "L" });
    await vi.advanceTimersByTimeAsync(500);

    const queued = localCalls.filter((c) => c[0] === "enqueue").map((c) => [c[1], c[2], c[3]]);
    expect(queued).toEqual([["steps", "insert", "x1"], ["steps", "update", "x2"]]);
    expect(notices[0]).toBe("offline!");
  });

  it("sendet beim Verlassen alles Offene sofort (keepalive)", async () => {
    const remote = fakeRemote();
    const repo = createRepository(remote);
    repo.patch("parts", { id: "a" }, { label: "x" });
    repo.patch("choreo_segments", { id: "b" }, { notes: "y" }, { delay: 1000 });
    repo.flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(remote.calls.map((c) => c.slice(0, 3))).toEqual([
      ["keepalive", "parts", "a"],
      ["keepalive", "choreo_segments", "b"],
    ]); // und nichts doppelt nach Ablauf der Timer
  });

  it("verwirft offene Änderungen einer gelöschten Zeile", async () => {
    const remote = fakeRemote();
    const repo = createRepository(remote);
    repo.patch("steps", { id: "z" }, { foot: "R" });
    await repo.remove("steps", { id: "z" });
    await vi.advanceTimersByTimeAsync(500);
    expect(remote.calls).toEqual([["remove", "steps", "z"]]);
  });
});

describe("Warteschlange", () => {
  it("reicht in Reihenfolge nach und bricht beim ersten Fehler ab", async () => {
    let n = 0;
    const remote = fakeRemote({
      update: async () => { if (++n === 2) throw new Error("weg"); },
    });
    globalThis.__queue = [
      { id: 1, op: "insert", table: "steps", key: "a", payload: { id: "a" } },
      { id: 2, op: "update", table: "steps", key: "a", payload: { foot: "L" } },
      { id: 3, op: "update", table: "steps", key: "a", payload: { foot: "R" } },
      { id: 4, op: "delete", table: "steps", key: "a" },
    ];
    await createRepository(remote).processQueue();
    expect(remote.calls).toEqual([["upsert", "steps", { id: "a" }]]);
    expect(localCalls.filter((c) => c[0] === "dequeue")).toEqual([["dequeue", 1], ["dequeue", 2]]);
  });
});
