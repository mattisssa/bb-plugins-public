# bb-plugin-project-icons

Shows an icon (image or emoji) next to each project title in bb's sidebar and
lets you change it from a menu on the icon itself.

bb's project model has no icon field and the sidebar renders the project name
as plain text, so the plugin's app overlay inserts a slot before every project
title and portals an icon button into it.

## Editing

Click the icon next to a project name:

- **Upload image…** — pick a file; it is downscaled to 128px in the browser and
  stored in the plugin database. Works from a remote browser too.
- **Emoji ▸** — grid of common emoji, or **Custom…** to type one.
- **Find in project folder** — re-run auto-detection for that project.
- **Remove icon** — clears it; the sweep will not put it back until you pick
  "Find in project folder" or set one.

Projects without an icon show a faint dashed circle on hover so there is always
something to click.

## Auto-detection

Every minute (and whenever the sidebar loads) the server looks for projects it
has not seen and resolves them:

1. If the project name already starts with an emoji (`🧪 playground`), nothing
   is added — the name is its own marker.
2. Otherwise the project folder is searched for icon-like files
   (`AppIcon.appiconset/*.png`, `icon-512.png`, `apple-touch-icon.png`,
   `resources/icon.png`, `favicon*`, …), ranked in `lib/detect.ts`. Build
   output, docs, fixtures and non-square PNGs are skipped.
3. If nothing qualifies, a deterministic emoji derived from the project id is
   used.

## Storage

`<dataDir>/plugins/project-icons/data.db`, table `project_icons`
(`project_id, kind image|emoji|none, data, source manual|auto`).

## Development

```sh
npm install
node --test lib/detect.test.ts
npx tsc -p tsconfig.json
bb plugin build . && bb plugin reload project-icons
```
