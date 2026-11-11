// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPatch,
  emptyBoard,
  type Board,
  type CanvasElement,
  type Patch,
} from "./model";
import { CanvasSession } from "./session";

const note = (id: string, x = 0): CanvasElement => ({
  id,
  type: "text",
  x,
  y: 0,
  width: 100,
  height: 30,
  text: id,
  color: "#242424",
  fontSize: 24,
});
const patch = (element: CanvasElement): Patch => ({
  upserts: [element],
  removeIds: [],
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}
beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe("thread canvas persistence", () => {
  it("can undo a rejected edit and save again", async () => {
    let board = emptyBoard();
    const session = new CanvasSession({
      read: async () => board,
      update: async (change) => {
        if (change.upserts.some((element) => element.id === "rejected"))
          throw new Error("Canvas is full");
        board = {
          ...board,
          revision: board.revision + 1,
          elements: applyPatch(board.elements, change),
        };
        return board;
      },
    });
    await session.refresh();
    session.commit(patch(note("rejected")));
    await tick();
    expect(session.snapshot().error).toBe("Canvas is full");
    session.undo();
    await tick();
    session.commit(patch(note("valid")));
    await tick();
    expect(session.snapshot().board.elements).toEqual([note("valid")]);
    expect(session.snapshot()).toMatchObject({ error: null, saving: false });
  });
  it("keeps a later drag visible while earlier saves are in flight", async () => {
    const first = deferred<Board>(),
      second = deferred<Board>();
    const update = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const session = new CanvasSession({
      read: async () => emptyBoard(),
      update,
    });
    await session.refresh();
    session.commit(patch(note("a", 10)));
    session.commit(patch(note("a", 90)));
    expect(update).toHaveBeenCalledTimes(1);
    expect(session.snapshot().board.elements).toEqual([note("a", 90)]);
    first.resolve({ version: 1, revision: 1, elements: [note("a", 10)] });
    await tick();
    expect(update).toHaveBeenCalledTimes(2);
    expect(session.snapshot().board.elements).toEqual([note("a", 90)]);
    second.resolve({ version: 1, revision: 2, elements: [note("a", 90)] });
    await tick();
    expect(session.snapshot()).toMatchObject({ saving: false, error: null });
  });

  it("recovers an unsaved change after reload without removing newer remote content", async () => {
    const key = "canvas:draft:recovery";
    const original = new CanvasSession(
      {
        read: async () => emptyBoard(),
        update: async () => {
          throw new Error("Offline");
        },
      },
      key,
    );
    await original.refresh();
    original.commit(patch(note("local")));
    await tick();
    expect(original.snapshot().error).toBe("Offline");
    expect(sessionStorage.getItem(key)).not.toBeNull();
    let board: Board = { version: 1, revision: 8, elements: [note("remote")] };
    const recovered = new CanvasSession(
      {
        read: async () => board,
        update: async (change) => {
          board = {
            ...board,
            revision: board.revision + 1,
            elements: applyPatch(board.elements, change),
          };
          return board;
        },
      },
      key,
    );
    await recovered.refresh();
    await tick();
    expect(recovered.snapshot().board.elements).toEqual([
      note("remote"),
      note("local"),
    ]);
    expect(recovered.snapshot()).toMatchObject({
      loaded: true,
      saving: false,
      error: null,
    });
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("keeps two tabs' failed saves recoverable after either tab refreshes or saves", async () => {
    const key = "canvas:draft:multiple-tabs";
    const firstStore = memoryStorage(),
      secondStore = memoryStorage();
    const offline = {
      read: async () => emptyBoard(),
      update: async () => {
        throw new Error("Offline");
      },
    };
    const first = new CanvasSession(offline, key, firstStore);
    const second = new CanvasSession(offline, key, secondStore);
    await first.refresh();
    await second.refresh();
    first.commit(patch(note("first")));
    await tick();
    await second.refresh();
    expect(firstStore.getItem(key)).not.toBeNull();
    second.commit(patch(note("second")));
    await tick();
    await first.refresh();
    let board = emptyBoard();
    const online = {
      read: async () => board,
      update: async (change: Patch) => {
        board = {
          ...board,
          revision: board.revision + 1,
          elements: applyPatch(board.elements, change),
        };
        return board;
      },
    };
    const reopenedFirst = new CanvasSession(online, key, firstStore);
    await reopenedFirst.refresh();
    await tick();
    expect(board.elements).toEqual([note("first")]);
    expect(firstStore.getItem(key)).toBeNull();
    expect(secondStore.getItem(key)).not.toBeNull();
    const reopenedSecond = new CanvasSession(online, key, secondStore);
    await reopenedSecond.refresh();
    await tick();
    expect(board.elements).toEqual([note("first"), note("second")]);
    expect(secondStore.getItem(key)).toBeNull();
  });

  it("recovers an existing shared draft into the current tab before retiring it", async () => {
    const key = "canvas:draft:legacy";
    localStorage.setItem(key, JSON.stringify([patch(note("legacy"))]));
    const transport = {
      read: async () => emptyBoard(),
      update: async () => {
        throw new Error("Offline");
      },
    };
    const session = new CanvasSession(transport, key);
    await session.refresh();
    await tick();
    expect(session.snapshot().board.elements).toEqual([note("legacy")]);
    expect(sessionStorage.getItem(key)).not.toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
    const reloaded = new CanvasSession(transport, key);
    await reloaded.refresh();
    expect(reloaded.snapshot().board.elements).toEqual([note("legacy")]);
  });

  it("keeps a shared draft when copying it to tab storage fails", async () => {
    const key = "canvas:draft:full-storage";
    const serialized = JSON.stringify([patch(note("recoverable"))]);
    localStorage.setItem(key, serialized);
    const store = memoryStorage();
    store.setItem = () => {
      throw new Error("Storage full");
    };
    const session = new CanvasSession(
      {
        read: async () => emptyBoard(),
        update: async () => {
          throw new Error("Offline");
        },
      },
      key,
      store,
    );
    await session.refresh();
    await tick();
    expect(localStorage.getItem(key)).toBe(serialized);
    expect(session.snapshot().board.elements).toEqual([note("recoverable")]);
  });

  it("ignores a stale refresh after a newer saved edit", async () => {
    const stale = deferred<Board>();
    let reads = 0;
    const session = new CanvasSession({
      read: async () => (++reads === 1 ? emptyBoard() : stale.promise),
      update: async () => ({
        version: 1,
        revision: 4,
        elements: [note("new")],
      }),
    });
    await session.refresh();
    const refresh = session.refresh();
    session.commit(patch(note("new")));
    await tick();
    stale.resolve({ version: 1, revision: 2, elements: [note("old")] });
    await refresh;
    expect(session.snapshot().board.elements).toEqual([note("new")]);
  });

  it("keeps a local move visible through realtime refreshes until its save is acknowledged", async () => {
    const saving = deferred<Board>();
    let remote: Board = { version: 1, revision: 1, elements: [note("moving")] };
    const session = new CanvasSession({
      read: async () => remote,
      update: () => saving.promise,
    });
    await session.refresh();
    session.commit(patch(note("moving", 100)));
    remote = {
      version: 1,
      revision: 2,
      elements: [note("moving"), note("remote")],
    };
    await session.refresh();
    expect(session.snapshot().board.elements).toEqual([
      note("moving", 100),
      note("remote"),
    ]);
    expect(session.snapshot().saving).toBe(true);
    saving.resolve({
      version: 1,
      revision: 3,
      elements: [note("moving", 100), note("remote")],
    });
    await tick();
    await session.refresh();
    expect(session.snapshot().board.elements).toEqual([
      note("moving", 100),
      note("remote"),
    ]);
    expect(session.snapshot().saving).toBe(false);
  });

  it("restores a deleted background image behind its annotations when undoing", async () => {
    const image: CanvasElement = {
      id: "image",
      type: "image",
      x: 0,
      y: 0,
      width: 500,
      height: 300,
      assetId: "asset",
      name: "Screenshot",
    };
    let board: Board = {
      version: 1,
      revision: 1,
      elements: [image, note("annotation")],
    };
    const session = new CanvasSession({
      read: async () => board,
      update: async (change) => {
        board = {
          ...board,
          revision: board.revision + 1,
          elements: applyPatch(board.elements, change),
        };
        return board;
      },
    });
    await session.refresh();
    session.commit({ upserts: [], removeIds: ["image"] });
    await tick();
    session.undo();
    await tick();
    expect(session.snapshot().board.elements).toEqual([
      image,
      note("annotation"),
    ]);
  });
});
