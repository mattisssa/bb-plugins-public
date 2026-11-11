Give the agent a link and a goal; Jev drives the browser there in seconds.

## What you get

- A `browse` tool for agents. It opens a bb browser session, lets TypeSafe's
  Jev choose one operation and one element per step (about 0.2 s each), and
  returns the action trace, the visible page text, and a final screenshot.
- A live preview of the browser in the chat, and a **Jev** tab in the thread
  panel with the action trace, decision probabilities, and a Stop button.
- An Approve / Decline form before any click Jev rates as irreversible:
  purchases, sending, deleting, publishing.
- A `bb jev` command for running, continuing, inspecting, and stopping runs.

## How it works

The page is read by one in-browser snapshot of visible controls. Jev answers
a single request that names the operation and, speculatively, a target for
every operation; only the matching target can execute. The plugin re-checks
that the page has not changed and that the target is visible and uncovered
immediately before input. Model output never becomes selectors, coordinates,
or code, and a browser mutation is never retried.

Text that goes into fields comes from the agent (the `values` list), not from
a guess. An optional OpenAI-compatible text model can fill fields the agent
did not anticipate; without it such a field pauses the run and asks.

## Requirements

A TypeSafe API key. The browser runs through bb's built-in Browser
Automation plugin, which installs its runtime on first use.

Based on browser-use/jev-ultrafast (MIT).
