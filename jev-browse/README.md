# Jev Browse for bb

Goal-driven browsing inside bb, built on [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT) and [TypeSafe Jev](https://docs.typesafe.ai).

The agent calls `browse` with a URL, a goal, and the literal values the task needs. Each step is one TypeSafe request that returns an operation (CLICK, TYPE_TEXT, SELECT, SCROLL, WAIT, DONE, BLOCKED) plus speculative targets for every operation; only the target matching the chosen operation executes. Execution happens in a `bb browser-automation` session, so the user can watch the live preview and the agent can take over in the same session.

## Install

```sh
npm install
bb plugin install . --yes
bb plugin config jev-browse set typesafeApiKey <key>
```

Optional text helper for values the agent did not supply:

```sh
bb plugin config jev-browse set textModelApiKey <openrouter-key>
```

## Layout

| File | Job |
| --- | --- |
| `server.ts` | Settings, `browse` / `browse_continue` tools, `bb jev` CLI, inspector RPC, approval form |
| `src/loop.ts` | The decision loop and its invariants (ported from `agent.py`) |
| `src/typesafe.ts` | One request with operation, target, value-pair, and sensitive heads |
| `src/action-space.ts` | Indexed elements and operation-specific targets |
| `src/scripts.ts` | DevBrowser scripts: observe, freshness check, batched step |
| `src/driver.ts` | browser-automation transport (HTTP, CLI fallback) and the driver |
| `src/runs.ts` | Run registry, session handling, user approvals |
| `src/snapshot.js` | Vendored DOM snapshot; `npm run gen` embeds it as `src/snapshot.gen.ts` |
| `app.tsx` | Jev inspector tab and the approval form |

## Differences from jev-ultrafast

- Browser: bb browser-automation sessions (headless or desktop) instead of Browser Harness. Each step is one batched script: freshness check, input, settle wait, observation. Freshness data is hashed in the page to keep results under DevBrowser's ~64 KB result limit.
- Text: TYPE_TEXT targets become field + value pairs over the agent's `values`, decided in the same request. A field that needs another value calls the optional text helper or pauses as `needs_text`.
- Safety: an extra speculative head rates each clickable target as irreversible or not. Above the threshold the run asks the user, failing closed when that head is unreadable.

## Checks

```sh
npm run typecheck
npm test
# live driver check without model calls, against an open session of a thread:
JEV_LIVE_SESSION=<session-id> JEV_LIVE_THREAD=<thread-id> npx vitest run test/live-driver.test.ts
```

## Limits

Shadow DOM, iframes, canvas, file uploads, new tabs, nested scrolling, and complex keyboard widgets are not handled by the snapshot; the agent continues manually in the same session. DONE is Jev's claim, not proof: verify outcomes independently. The HTTP transport uses the endpoint the bb CLI itself calls for plugin commands; if a future bb changes it, the driver falls back to the `bb` CLI.
