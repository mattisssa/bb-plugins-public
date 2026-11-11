# Thread Load

Thread Load shows how much context each bb thread carries and how many tokens
it burns, so the threads that drain usage limits stand out.

## What it shows

- **Sidebar row glyph.** A gauge marks a loaded thread, a red flame a heavy one.
  The glyph yields to bb's own row indicators (unread, waiting for input,
  running, draft) and is hidden while bb shows row actions on hover.
- **Attention highlight.** A row turns red while its thread waits for your
  answer or ended with an error, and yellow while a finished result is unread.
  It follows bb's own row indicator, so a running background task wins.
- **Context row above the composer.** Context size and 5-hour usage. Click it
  for a breakdown by cache reads, cache writes and model output.
- **Info tab.** Context, and usage over 5 and 24 hours.
- **Heavy section.** Top-level threads without a section move into the
  "Тяжёлые" section while their context is at or above the heavy threshold, and
  move back when it drops, for example after `/compact`.

## How usage is counted

bb records cumulative token counters per thread. The plugin turns them into
increments and weighs them by API price: uncached input 1x, cache write 1.25x,
cache read 0.1x, output 5x. A raw total is dominated by cache reads, which grow
with context size times tool calls, so the weighted number tracks limit drain
much better.

## Settings

| Setting | Default |
|---|---|
| Context warning, thousand tokens | 150 |
| Context heavy, thousand tokens | 300 |
| 5-hour usage warning, million tokens | 1 |
| 5-hour usage heavy, million tokens | 2.5 |
| Move heavy threads to a section | on |
| Heavy section name | Тяжёлые |

Change them in bb settings or with `bb plugin config thread-load set <key> <value>`,
then run `bb plugin reload thread-load`.

## CLI

```sh
bb thread-load top --limit 10
bb thread-load show <thread-id>
bb thread-load rescan
```

## Develop

```sh
npm install
npm run typecheck
bb plugin build
bb plugin install .
```
