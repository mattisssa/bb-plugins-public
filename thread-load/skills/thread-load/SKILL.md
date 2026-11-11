---
name: thread-load
description: Use when asked which threads burn the most tokens, why usage limits drain fast, or how heavy a thread's context is. Lists threads by context size and weighted 5-hour token usage with `bb thread-load`.
---

# Thread Load

The Thread Load plugin reads the token events bb records for every thread and
reports two numbers per thread:

- **Context**: tokens in the thread's current context window.
- **Usage**: tokens spent in the last 5 hours and 24 hours, weighted by API
  price (uncached input 1x, cache write 1.25x, cache read 0.1x, output 5x).

## Commands

1. List the heaviest threads:
   ```sh
   bb thread-load top --limit 10
   ```
   Output: one line per thread, `!!` heavy, `!` loaded, then thread id, context, 5h and 24h usage.
2. Inspect one thread (rescans it first):
   ```sh
   bb thread-load show <thread-id> --json
   ```
3. Re-read token events of recently active threads:
   ```sh
   bb thread-load rescan
   ```

All commands accept `--json`.

## Behavior

- A sidebar row shows an amber gauge for a loaded thread and a red flame for a heavy one, only while bb shows no indicator of its own on that row.
- A sidebar row gets a red background while its thread waits for the user or failed, and yellow while a finished result is unread.
- The context row above the composer shows context and 5-hour usage; click it for a breakdown.
- Top-level threads without a section move into the heavy section (default "Тяжёлые") while
  their context is at or above the heavy threshold, and move back when it drops. A thread the
  user moved elsewhere is left alone.
- Thresholds and the section behavior are plugin settings: `bb plugin config thread-load`.
  Settings apply after `bb plugin reload thread-load`.
