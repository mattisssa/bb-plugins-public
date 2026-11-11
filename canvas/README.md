# Canvas

A canvas in each thread's right panel for screenshots, notes, and sketches
that you and your agent can read together.

## Use

Open **Canvas** from the right panel's new-tab menu, or run
**Canvas: Open this thread's canvas** from the command palette.

- **Images.** Drop an image, choose **Add image**, or click the canvas and
  press **⌘V** / **Ctrl+V** to paste a screenshot. Use **Select** to move images
  or drag a corner to resize with the original proportions. Double-click an
  image with **Select** to crop it: drag an edge or corner, or move the crop
  frame. Click outside the frame to save and deselect, or press **Enter** to
  save. **Escape** discards changes. Reopen the crop and expand its edges to
  reveal the original image again.
- **Text.** Choose **Text**, click the canvas, and write. The box grows with
  your text; only **Enter** starts a new line. Click outside or press
  **⌘Enter** / **Ctrl+Enter** to finish. Double-click text to edit it within
  the same selection frame.
  Select a text element to change its color or size using the controls at the
  end of the toolbar. Color circles and three letter sizes are always visible.
- **Draw.** Choose **Draw**, pick a color and stroke width, and draw. Hold
  **Shift** for a horizontal or vertical line. Three dots choose thin, medium,
  or thick strokes. Clicks and movements shorter than three screen pixels do
  not leave a mark. **Escape** cancels a gesture.
- **Feedback.** Choose **Feedback** (**F**) and outline an area, such as part
  of a screenshot. A field opens under the outline: type your comment and
  press **Enter** (**Shift+Enter** starts a new line, **Escape** discards a
  new outline). The tool stays active, so outline and comment as many areas
  as you need; each gets a numbered pin showing its comment. Click a pin or
  an outline to edit its comment. **Send** in the footer posts all of them to
  the thread and clears them from the board; Undo brings them back.
- **Arrow.** Choose **Arrow** and drag from the tail to the tip. Use the same
  colors and thickness dots; hold **Shift** for horizontal or vertical arrows.
- **Sticky note.** Choose **Sticky note**, click, and type on a yellow square.
  Notes start at 180×180 canvas units. Text wraps and automatically shrinks to
  fit; resizing a note scales its text and padding. Colors change the text's
  ink. Double-click a note to edit it; click outside or press **⌘Enter** /
  **Ctrl+Enter** to save.
- **Select.** Click an element, Shift-click to select more, or drag a selection
  box. **⌘C** / **Ctrl+C** copies the selection; **⌘X** / **Ctrl+X** cuts it.
  **⌘V** / **Ctrl+V** pastes a new copy with a small offset.
  Images, text, and drawings keep their styles
  and relative positions. Repeated pastes create separate copies; you can also
  paste into another thread's canvas. Delete removes the selection.
  **⌘Z** / **Ctrl+Z** undoes an edit, including an entire pasted group;
  add Shift to redo. **V**, **S**, **T**, **A**, and **D** switch to Select,
  Sticky note, Text, Arrow, and Draw while the canvas has focus.
- **Navigate.** Scroll to pan; hold Space and drag to pan with a mouse.
  Pinch a trackpad or use the zoom buttons to zoom. **Fit canvas** shows all
  elements. On a touch screen, drag empty canvas to pan.
- **Export.** Wait for **Saved**, then choose **Export PNG**. The image includes
  the entire board on white, without editing controls or the dot grid.

With a mouse or pen, dragging existing annotations moves them in any tool.
Images move and resize only with **Select**, so the other tools work directly
on top of screenshots. Hold **Alt** / **Option** to annotate over existing
text, notes, strokes, or arrows instead of moving them.
On touch screens, annotation tools act directly on touched content;
**Select** moves elements. The toolbar scrolls horizontally in narrow panels.

### Capture from the desktop browser

In desktop BB's built-in browser, click **Canvas** in the browser toolbar.
Hover to highlight a block, then click to capture its visible portion and
add it to the thread's canvas. Press **↑** to select the parent block or
**Escape** to cancel. The new image is selected and brought into view.

The picker works in the top document; an embedded frame is captured as a
single block. Browser capture requires the desktop BB app. On the web, use
paste, drag and drop, or **Add image**. Clipboard buttons depend on browser
permissions; ordinary image paste does not require clipboard-read access.
The **Paste** button also accepts copied Canvas elements. Shortcuts apply while
Canvas has focus; copying, cutting, or pasting inside the text editor edits its
text.

### Work with an agent

Ask your agent to look at the canvas. **canvas_screenshot** returns a PNG of
all saved elements; **canvas_read** returns their text, coordinates, image
references, and drawing points, in back-to-front order. Reads are paginated.
Newly installed tools become available when an agent session next starts.

**Send** posts the board's feedback to the thread as your message: the
numbered comments, an image of the board with every outline and its number,
and, for the agent only, each outline's position in that image, on the image
under it, and in canvas units. The agent starts working on it at once, or
receives it in its running turn.

Agents can also run:

```sh
bb canvas read --json
bb canvas read --offset 20 --json
bb canvas export --json
```

`--thread <id>` chooses a thread explicitly. Export writes a PNG into that
thread's storage on its owning machine and returns its path and host ID.

## How it works

Each thread has one versioned JSON document containing ordered images, text,
sticky notes, strokes, and arrow endpoints. Image crops store a normalized
source rectangle while keeping the original PNG available for later changes.
PNG images are stored separately in the plugin's SQLite database on the BB
server, keyed to that thread.
Closing the panel, changing threads, and restarting BB preserve the board.
Deleting a thread removes its canvas and images. Canvas does not send images
to an external service.

Completed edits save immediately. **Saved**, **Saving…**, and **Not saved**
show the state; failed writes offer **Retry** and keep a recovery draft in
the current browser tab when storage is available. Drafts survive reloads
within that tab's session and stay isolated from other tabs. Independent
element changes merge across windows; the latest saved change wins when two
windows edit the same element.
The viewport is remembered on this browser; undo history lasts for the
current browser session.

Canvas uses BB's thread-panel, RPC, realtime, and experimental browser-toolbar
APIs. Browser capture may need an update when those experimental APIs change.
The board and its controls follow the active theme, including San Francisco's
accent: the board takes BB's background, and Graphite ink shows in the theme's
text color so it stays readable in dark mode. Elements keep their saved colors,
and PNG exports draw them on white. Exports render on the server, so agents can
see the board with the panel closed.

Limits are 500 elements, a 2 MB JSON document, 100 MB of images per thread,
10,000 characters per text element, and 6,000 points per stroke. Imports are
scaled to at most 2,400 pixels per side and must fit in 8 MB after conversion
to PNG. Animated images use their decoded frame. Exports fit within 2,400
pixels. Images are kept for 24 hours after their last element is deleted;
unused uploads are kept for 24 hours after upload. Expired images are reclaimed
on the next upload. Undoing an older deletion after that may require importing
the image again.

## Install

Requires BB 0.44 or newer and Plugin SDK 0.5.29 or newer.

```sh
bb marketplace add git:https://github.com/rebryk/bb-plugins.git@main
bb plugin install canvas@sf-plugins
```

Use `bb plugin install .` from this directory instead when working on it
locally.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
bb plugin reload canvas
```

Use `bb plugin dev` to rebuild and reload on each save. Verify paste, dragging,
resizing, text editing, sticky notes, drawing, arrows, capture, and persistence
in web BB, including a narrow touch viewport. The unit tests cover thread
isolation, persistence, undo ordering, image validation, rendering, pointer
behavior, and bounded agent output.

## More San Francisco Plugins

Canvas is one of the
[San Francisco Plugins](https://github.com/rebryk/bb-plugins), a family of BB
plugins. The others:

- [Superhuman](../superhuman): Superhuman-style speed for BB, with shortcuts and
  search in any keyboard layout, snoozed threads, and a phone layout.
- [Bookmarks](../bookmarks): save any chat message and jump back to it from the
  thread's right panel.
- [To-do](../todo): a Notes-style to-do list on the New thread screen and in
  the right panel; snooze a to-do or start a thread from it.
- [Annotate](../annotate): notes on the elements of a page in BB's Browser,
  sent to your agent with a screenshot.
- [Auto Update](../auto-update): updates for the plugins you pick, installed
  every hour, day, or week.
- [Storage Cleaner](../storage-cleaner): what fills your Mac's disk, and
  cleanup of archived threads, worktrees, and caches.
- [Resource Monitor](../resource-monitor): live CPU, RAM, and GPU bars for the
  BB server in the sidebar, with the numbers on hover.
- [San Francisco](../san-francisco): a quiet macOS-style theme after the Aside
  browser, with your pick of the eight macOS accent colors.
- [Pool Usage](../pool-usage): how much of each provider's capacity is in use
  and when it frees up, in the sidebar footer.
