# Thread Load

Shows how much context each thread carries and how many tokens it burns.

- `server.ts` folds `thread/tokenUsage/updated` and `thread/contextWindowUsage/updated` events into per-thread state (bb.storage.kv), computes levels, moves heavy threads into a section, and serves `loads_list` over RPC plus the `bb thread-load` CLI.
- `model.ts` holds the pure usage math shared by server and app.
- `app.tsx` draws sidebar row glyphs (content script setter driven by an always-mounted overlay), a thread context-row segment, and Info-tab rows.
