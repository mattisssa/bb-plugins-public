# Pool Usage

Pool Usage shows how much of each provider's capacity is in use, at the right
end of the BB sidebar footer: Claude and Codex, including every account in
Account Pooler, and any other provider that reports usage to BB, such as
Cursor.

```text
[ ] [ ] [ ]                                   [Claude] 60%  [Codex] 12%
```

## Use

Click a number to open that provider's card, in the same menu surface as the
footer's `…` menu:

```text
[Claude] Claude 2x     60%
1h 25m                 48%
1d 6h                   0%
Reset to 12% (1 available)
```

- `2x` is the number of accounts that count, shown when there are several.
- Up to four lines show when the total drops next, as quota windows reset or
  holds end, and what it drops to, assuming no new usage.
- **Reset to** shows up when Account Pooler's accounts hold resets, which
  Claude and Codex grant to clear an account's usage limits early. It gives the
  total right after the reset worth spending first, and how many the accounts
  hold. When none can lower the total right now, a gray line only counts them.
- Clicking **Reset to** asks first, in bb's dialog or, on a phone, its bottom
  sheet. It names the account, when the reset expires, and the total before
  and after. **Use reset** spends it, a toast confirms it, and the card reads
  usage again. Closing it any other way spends nothing.
- If a try fails, **Try again** repeats the same request, which never uses a
  second reset. When the provider keeps the reset, or the account's login
  can't be used, the dialog says why.
- Escape or a click elsewhere closes the card.

**Red at, %** in the plugin's settings (80 by default) turns the numbers red at
or above that value.

The built-in **Provider usage** plugin may be disabled if its footer item is
redundant:

```sh
bb plugin disable provider-usage
```

## How it works

- Each account counts in proportion to its plan, by the vendors' stated
  multipliers. Claude: Pro 1x, Max 5x or 20x, a standard Team seat 1.25x and a
  premium seat 6.25x. Codex: Plus and standard Business 1x, Pro $100 and
  Business Pro Lite ($100) 5x, Pro $200 20x. Other plans count as 1x; disabled
  accounts and API keys don't count.
- An account's free capacity is what its tightest quota window leaves. A window
  past its reset is empty until the next reading replaces it. A weekly window
  limits an account that also has a five-hour window only once it runs low.
- For providers Account Pooler serves, accounts come from its redacted
  `status.get` RPC, and a window at or past its `switchThreshold` (from
  `config.get`) is spent. A held account counts as fully used until its hold
  ends, and so does one with an expired login, an error, no reading from the
  last 30 minutes, or none since the plugin reset its limits. A held or
  exhausted account keeps its last reading however old, since Account Pooler
  sends it nothing that could change it. Codex plans missing there come from
  BB's official Codex usage when the account emails match.
- Other providers, or every provider without Account Pooler, are read from BB's
  provider usage sources; a window there is spent at 100%.
- The numbers refresh every 30 seconds.
- Resets come from the endpoints Claude Code and Codex use, every 10 minutes:
  `api.anthropic.com/api/oauth/usage` for Claude, and
  `chatgpt.com/backend-api/wham/usage` and its `rate-limit-reset-credits` for
  Codex. The plugin's server calls them with the access tokens Account Pooler
  stores for its enabled accounts, under `plugins/account-pool/secrets` in BB's
  data directory. Claude reports resets only to Claude Code, so the Claude
  request identifies itself as the installed Claude Code version.
- The reset worth spending first frees the most capacity over the next week.
  The plugin plays out a busy account with and without the reset: it serves
  all its windows allow as soon as they allow it, and each window starts again
  once it resets. The reset is worth the account's plan weight times how much
  more it serves with the reset, summed over time until every window the reset
  would empty resets on its own. So a reset counts the weekly quota it frees as
  well as the five-hour quota, and quota that would come back soon counts for
  little. Of resets worth about the same, the one that expires first goes
  first. Only a reset that lowers the total as the card rounds it counts.
- **Use reset** spends it as Claude Code and Codex do: Claude's
  `organizations/<id>/reset_rate_limits` with the grant Claude Code would
  claim, or Codex's `rate-limit-reset-credits/consume` with the credit that
  expires first. Every try from one dialog sends the same request id and the
  same grant or credit, which the plugin keeps in its storage for a day, so the
  provider applies it once, even after a restart. An account spends one reset
  at a time. Unless the provider keeps the reset, the plugin then asks Account
  Pooler to read the account's usage again.
- The plugin spends a reset only on **Use reset**. It never refreshes a token
  or passes one to the frontend; an expired token waits for Account Pooler to
  refresh it. A read that fails shows no resets until the next one. Neither the
  token files nor these endpoints are public APIs: if one changes, the reset
  line goes away and the rest of the card stays.
- The confirmation uses the Radix dialog, the vaul drawer, and the toasts bb
  provides to plugins, with the classes of bb's own dialog and bottom sheet. If
  a bb update restyles those, the confirmation keeps working with its old look.
- The footer summary stands in for the plugin's own **Account usage** footer
  icon. bb's footer markup isn't a versioned plugin API, so if a bb update
  changes it, the summary steps aside and the icon comes back; clicking it
  opens the same cards in bb's footer panel.

## Install

Needs bb 0.43.4 or later. Account Pooler is optional.

```sh
bb marketplace add git:https://github.com/rebryk/bb-plugins.git@main
bb plugin install pool-usage@sf-plugins
```

Use `bb plugin install .` from this directory instead when working on it
locally.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
bb plugin reload pool-usage
```
