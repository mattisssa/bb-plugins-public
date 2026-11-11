---
name: jev-browse
description: Use when the user gives a link and wants something found, filled in, navigated, or checked on a website, or asks to drive a browser toward a goal. Runs TypeSafe Jev in a bb browser session with the `browse` tool (or `bb jev run`), then verifies the result.
---

# Browse with Jev

Jev picks one operation (CLICK, TYPE_TEXT, SELECT, SCROLL, WAIT, DONE, BLOCKED) and one observed element per TypeSafe request, about 0.2 s per decision. The plugin executes each choice in a `bb browser-automation` session. Model output never becomes selectors, coordinates, or code.

## Workflow

1. Write one complete goal: every requirement plus the stopping condition. Example: "Find one-way flights from Zurich to London on 20 September 2026 for one adult in economy. Stop when matching flight options are visible."
2. Put every literal the task will type into `values`, for example `["Zurich", "London", "20 September 2026"]`. Jev decides which value goes into which field. Never pass passwords, card numbers, or other secrets.
3. Call the `browse` tool with `url`, `goal`, and `values`. Without `sessionId` it opens a local headless session on this thread's host. To reuse a page that is already open (logged in, mid-task), pass its `sessionId`.
4. When the result contains a live view directive (`::browser-preview{...}`), post it once as its own line so the user can watch.
5. Read the result: status, action trace, visible text, final screenshot.
   - `done`: Jev claims success. Check every requirement against the visible text or screenshot before telling the user it worked.
   - `needs_text`: Jev needs a value for the named field that was not in `values`. Call `browse_continue` with `runId` and `text`. Ask the user when the conversation does not contain the value; never invent personal data.
   - `blocked`, `budget`, `error`: continue manually in the same session with `bb browser-automation run <sessionId> --script ...` (see the browser-automation skill). Iframes, shadow DOM, file uploads, new tabs, canvas, and complex keyboard widgets are outside Jev's reach.
6. Close the session with `bb browser-automation close <sessionId>` when you are finished checking.

## Sensitive actions

Before a click or select that Jev rates as irreversible (purchase, send, delete, publish, submit to a third party, account settings), the run pauses and the user sees an Approve / Decline form in the composer. You cannot approve it. If the user declines, the run stops as `blocked`.

## CLI

The same runs are available from a shell inside the thread:

```sh
bb jev run --url https://en.wikipedia.org --goal "Open the article about Gödel's incompleteness theorems" --value "Gödel's incompleteness theorems"
bb jev status              # this thread's runs
bb jev status <run-id> --json
bb jev continue <run-id> --text "value"
bb jev stop <run-id>
```

## Inspector

The thread's side panel shows a "Jev" tab while the thread has runs: status, the action trace, the last decision's operation and target probabilities, and the observed element table. The user can stop a run there.

## Settings

`bb plugin config jev-browse set <key> <value>`:

- `typesafeApiKey` (secret, required) and `typesafeModel` (default `jev-latest`). Falls back to `TYPESAFE_API_KEY` in the server environment.
- `textModelApiKey` (secret, optional), `textModelBaseUrl`, `textModel`, `textModelReasoning`: an OpenAI-compatible helper that writes TYPE_TEXT values when none of the provided values fits. Without it, such fields pause as `needs_text`.
- `confirmSensitive` (default true) and `sensitiveThreshold` (default 0.35).
- `maxActions` (default 60).
