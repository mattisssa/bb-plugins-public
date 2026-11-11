# bb-plugins

Plugins for [bb](https://getbb.app) that I use every day. Each plugin lives in
its own directory and is indexed in `.bb/plugins.json`, so you can install any
one of them straight from this repository.

## Plugins

| Plugin | What it does | Needs bb |
|---|---|---|
| [`canvas`](canvas) | A canvas in each thread for images, text and drawing, with screenshots your agent can read. Adds a Feedback tool: outline areas on the board and send them to the thread. | 0.44+ |
| [`image-feedback`](image-feedback) | An **Annotate** button on any image bb shows. Outline areas, comment on each, and send the marked-up image back to the thread's agent. | 0.46+ |
| [`claude-account-switcher`](claude-account-switcher) | Moves one open Claude Code thread to another Claude subscription login without losing the thread or its history. | 0.39+ |
| [`jev-browse`](jev-browse) | Experimental. A `browse` tool that drives a real browser toward a goal with TypeSafe Jev, with a live preview and your approval for irreversible clicks. Needs a TypeSafe API key. | 0.48+ |
| [`pool-usage`](pool-usage) | One number per provider in the sidebar footer: how much of its capacity is used and when it frees up. Also shows Claude extra-usage spending. | 0.43.4+ |
| [`thread-load`](thread-load) | Marks threads that carry a large context or burn many tokens: a glyph on the sidebar row, a context row above the composer, and an automatic section for heavy threads. | 0.47+ |
| [`project-icons`](project-icons) | An icon (image or emoji) next to each project in the sidebar, editable from a menu and auto-detected for new projects. | 0.46+ |

Each directory has its own README with usage and settings.

## Install

Install a plugin by name. bb clones the repository, installs dependencies and
builds the plugin:

```sh
bb plugin install git:https://github.com/mattisssa/bb-plugins-public.git@main --plugin canvas
```

Replace `canvas` with any name from the table. bb shows what it is about to
install and asks for confirmation; add `--yes` to skip the prompt.

To install all of them:

```sh
for p in canvas image-feedback claude-account-switcher jev-browse pool-usage thread-load project-icons; do
  bb plugin install git:https://github.com/mattisssa/bb-plugins-public.git@main --plugin "$p" --yes
done
```

Check the result with `bb plugin list`.

### After installing

- **jev-browse** needs a [TypeSafe](https://docs.typesafe.ai) API key:
  `bb plugin config jev-browse set typesafeApiKey <key>`
- **canvas**, **pool-usage** and **claude-account-switcher** replace plugins of
  the same name from other sources. Remove the other copy first:
  `bb plugin remove <name>`.

## Update and remove

```sh
bb plugin outdated            # what has a newer version
bb plugin update <name>       # update one plugin
bb plugin update --all        # update everything
bb plugin remove <name>       # uninstall and delete its settings
```

## Hack on a plugin

Install from a local clone when you want to change the code:

```sh
git clone https://github.com/mattisssa/bb-plugins-public.git
cd bb-plugins-public/canvas
npm install
bb plugin install path:. --yes
bb plugin dev                 # rebuild and reload on every change
```

## Credits

- `canvas` and `pool-usage` are modified versions of the plugins in
  [rebryk/bb-plugins](https://github.com/rebryk/bb-plugins) by Yurii Rebryk.
- `claude-account-switcher` is a copy of
  [benegessarit/bb-plugin-claude-account-switcher](https://github.com/benegessarit/bb-plugin-claude-account-switcher)
  v0.1.2 by David Beyer, MIT license (see its `LICENSE`).
- `jev-browse` builds on
  [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast),
  MIT license (see `jev-browse/THIRD_PARTY_LICENSE_jev-ultrafast`).
