# Changelog

Newest version first. [Releases](../README.md#releases) explains when a change
gets a new version. Each version is tagged `pool-usage/v<version>`.

## 0.2.6 (2026-10-02)

- **Reset to** now picks the reset that frees the most quota across all the
  windows it clears, the weekly one included. It weighs how much more the
  account can serve with the reset, by plan weight, for as long as it would
  stay limited on its own. Before, weekly usage counted only once the weekly
  window ran almost out, so a reset could go to an account whose five-hour
  window was about to reset anyway instead of one with most of its week spent.
  A reset that frees nothing a busy account wouldn't get back soon is no longer
  offered.
- A held or exhausted account keeps its last reading however old, since
  Account Pooler sends it nothing that would renew it. Its usage now drops on
  the card when its window resets, and its reset can be offered, where before
  it counted as fully used with no data after 30 minutes.
- After **Use reset**, the account counts as having no data until Account
  Pooler reads it again, instead of showing the limits the reset cleared.

## 0.2.5 (2026-09-28)

- When Account Pooler's Claude or Codex accounts hold resets, which clear an
  account's usage limits early, a provider's card ends with a line such as
  "Reset to 27% (3 available)". It gives the total right after the reset that
  frees the most capacity over the next week, by plan weight and how long the
  account would stay limited; of resets worth about the same, the one that
  expires first. When none can lower the total, a gray line only counts them,
  such as "3 resets available".
- Clicking that line asks first, in bb's dialog or its bottom sheet on a
  phone, naming the account, when the reset expires, and the total before and
  after. **Use reset** spends it, a toast confirms it, and the card reads
  usage again. A failed try offers **Try again**, which never uses a second
  reset, even after the plugin restarts, and an account spends one reset at a
  time.
- The plugin's server reads the resets every 10 minutes with the access tokens
  Account Pooler stores and spends one only on **Use reset**. It never
  refreshes a token.

## 0.2.4 (2026-09-27)

- Codex Business Pro Lite accounts count as 5x Plus, matching Pro Lite, so
  unused capacity on those accounts no longer inflates the pool's usage
  percentage. Standard Business accounts still count as 1x.

## 0.2.3 (2026-09-26)

- A provider's card opens below its button when the sidebar footer sits at the
  top of the window, as another plugin can place it on a phone, and grows
  leftward from a button near the window's right edge, so it stays on screen.

## 0.2.2 (2026-09-26)

- The sidebar footer shows each provider's logo with the share of its capacity
  in use, at the right end of the footer row. Besides Account Pooler's Claude
  and Codex accounts, it covers every provider that reports usage to BB, such
  as Cursor, and works without Account Pooler.
- Accounts count by the vendors' stated plan multipliers: Claude Pro 1x, Max
  5x or 20x, Team 1.25x (premium 6.25x); Codex Plus 1x, Pro $100 5x, Pro $200
  20x; other plans 1x. An account Account Pooler can't use right now (held,
  out of quota, logged out, failing, or without a reading for 30 minutes)
  counts as used until it frees up.
- Clicking a number opens that provider's card, styled like the footer's `…`
  menu: the total, the number of accounts when there are several, and up to
  four upcoming resets with the total after each. Claude Code is shown as
  Claude. Escape or a click elsewhere closes it.
- A new setting, **Red at, %** (80 by default), sets the percentage at which
  the numbers turn red.
- The per-account rows with usage bars are gone. If the footer summary can't
  find its place in bb's footer, the **Account usage** icon stays and opens the
  same cards.
- Needs bb 0.43.4 or later.

## 0.2.1 (2026-09-22)

- When Account Pooler's switch threshold can't be read, the plugin logs why at
  debug level before it falls back to 98%.

## 0.2.0 (2026-09-22)

- Each row shows the quota window that decides whether the account can take a
  request: the spent window that clears last, or else the window closest to
  its limit. Before, a row showed the shortest window.
- A window counts as spent at Account Pooler's own switch threshold, a window
  past its reset is dropped as stale, and a row the pool won't route to turns
  red whatever its percentage reads.
- The plugin moved to this repository from rebryk/bb-plugin-pool-usage.

## 0.1.0 (2026-09-11)

- First release: a sidebar footer list with one row per Account Pooler
  account, showing the provider, plan, usage, and the shortest active quota
  window with its reset time.
