import {
  applyPatch,
  emptyBoard,
  patchSchema,
  type Board,
  type Patch,
} from "./model";

export type CanvasTransport = {
  read(): Promise<Board>;
  update(patch: Patch): Promise<Board>;
};
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export class CanvasSession {
  private saved: Board = emptyBoard();
  private pending: Patch[] = [];
  private listeners = new Set<() => void>();
  private running = false;
  private loaded = false;
  private error: string | null = null;
  private undoStack: { forward: Patch; backward: Patch }[] = [];
  private redoStack: { forward: Patch; backward: Patch }[] = [];
  private draftStorage: DraftStorage | null = null;
  private state = {
    board: emptyBoard(),
    loaded: false,
    saving: false,
    error: null as string | null,
    canUndo: false,
    canRedo: false,
  };
  constructor(
    private transport: CanvasTransport,
    private draftKey?: string,
    draftStorage?: DraftStorage,
  ) {
    if (draftKey)
      try {
        // Session storage survives reloads but is isolated between tabs, even
        // when a browser duplicates a tab with its initial storage contents.
        this.draftStorage = draftStorage ?? sessionStorage;
        const stored = this.draftStorage.getItem(draftKey);
        const legacy = stored === null ? localStorage.getItem(draftKey) : null;
        const draft: unknown = JSON.parse(stored ?? legacy ?? "[]");
        if (Array.isArray(draft)) {
          this.pending = draft.map((patch) => patchSchema.parse(patch));
          if (legacy !== null) {
            // Preserve an existing recovery draft before retiring its shared
            // key. Normal saves never touch another tab's recovery storage.
            this.draftStorage.setItem(draftKey, JSON.stringify(this.pending));
            if (localStorage.getItem(draftKey) === legacy)
              localStorage.removeItem(draftKey);
          }
        }
      } catch {
        /* A blocked browser store must not prevent server saves. */
      }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  private publish() {
    this.state = {
      board: {
        ...this.saved,
        elements: this.pending.reduce(
          (elements, patch) => applyPatch(elements, patch),
          this.saved.elements,
        ),
      },
      loaded: this.loaded,
      saving: this.pending.length > 0 && !this.error,
      error: this.error,
      canUndo: !!this.undoStack.length,
      canRedo: !!this.redoStack.length,
    };
    if (this.draftKey && this.draftStorage)
      try {
        if (this.pending.length)
          this.draftStorage.setItem(
            this.draftKey,
            JSON.stringify(this.pending),
          );
        else this.draftStorage.removeItem(this.draftKey);
      } catch {
        /* Server persistence remains the source of truth. */
      }
    this.listeners.forEach((listener) => listener());
  }
  refresh = async () => {
    try {
      const board = await this.transport.read();
      if (board.revision >= this.saved.revision) this.saved = board;
      this.loaded = true;
      if (!this.pending.length) this.error = null;
      this.publish();
      if (this.pending.length && !this.error) void this.flush();
    } catch (cause) {
      this.error = String(cause instanceof Error ? cause.message : cause);
      this.publish();
    }
  };
  commit(patch: Patch) {
    patchSchema.parse(patch);
    const touched = new Set([
      ...patch.removeIds,
      ...patch.upserts.map((element) => element.id),
    ]);
    const before = this.state.board.elements.filter((element) =>
      touched.has(element.id),
    );
    this.undoStack.push({
      forward: patch,
      backward: {
        upserts: before,
        removeIds: patch.upserts
          .filter((element) => !before.some((old) => old.id === element.id))
          .map((element) => element.id),
        order: this.state.board.elements.map((element) => element.id),
      },
    });
    this.undoStack = this.undoStack.slice(-100);
    this.redoStack = [];
    this.enqueue(patch);
  }
  private enqueue(patch: Patch) {
    this.pending.push(patch);
    if (this.error && !this.running && this.pending.length > 1) {
      // A corrective edit (including undo) must be able to replace a rejected
      // edit, rather than waiting behind a patch that can never be saved.
      const upserts = new Map<string, Patch["upserts"][number]>();
      const removed = new Set<string>();
      let order: string[] | undefined;
      for (const queued of this.pending) {
        for (const id of queued.removeIds) {
          upserts.delete(id);
          removed.add(id);
        }
        for (const element of queued.upserts) {
          upserts.set(element.id, element);
          removed.delete(element.id);
        }
        if (queued.order) order = queued.order;
      }
      this.pending = [
        {
          upserts: [...upserts.values()],
          removeIds: [...removed],
          ...(order ? { order } : {}),
        },
      ];
    }
    this.error = null;
    this.publish();
    void this.flush();
  }
  undo() {
    const change = this.undoStack.pop();
    if (change) {
      this.redoStack.push(change);
      this.enqueue(change.backward);
    }
  }
  redo() {
    const change = this.redoStack.pop();
    if (change) {
      this.undoStack.push(change);
      this.enqueue(change.forward);
    }
  }
  retry = () => {
    this.error = null;
    this.publish();
    if (this.loaded) void this.flush();
    else void this.refresh();
  };
  private async flush() {
    if (this.running || !this.loaded) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const board = await this.transport.update(this.pending[0]!);
        this.pending.shift();
        if (board.revision >= this.saved.revision) this.saved = board;
        this.error = null;
        this.publish();
      }
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
      this.publish();
    } finally {
      this.running = false;
    }
  }
}
