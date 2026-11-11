# Changelog

Newest version first. [Releases](../README.md#releases) explains when a change
gets a new version. Each version is tagged `canvas/v<version>`.

## 0.1.15 (2026-11-11)

- Show the image of a sent feedback message in the chat. It reached the agent
  but appeared as a broken thumbnail.

## 0.1.14 (2026-11-11)

- Add the **Feedback** tool: outline an area, type a comment for it, and
  repeat. **Send** posts the numbered comments, an image of the board, and each
  outline's position to the thread.

## 0.1.13 (2026-10-11)

- Fix the browser toolbar's **Canvas** button, which added nothing in BB 0.46
  because Canvas rejected BB's new Browser tab ids.
- Follow the BB theme on the board: it takes BB's background in light and dark
  mode, Graphite ink shows in the theme's text color, and the dot grid and
  empty state use theme colors. Saved colors and PNG exports stay unchanged.

## 0.1.12 (2026-10-01)

- Simplify gesture, draft, and import lifecycles with shared state updates and
  one tool definition for toolbar buttons and keyboard shortcuts.
- Share stroke rendering, image viewports, and resize handles across editing,
  cropping, and export.
- Use one capture operation and shared PNG preparation for browser captures
  and uploaded images, keeping stale requests from affecting newer captures.

## 0.1.11 (2026-10-01)

- Save image crops and deselect on an outside click without an extra toolbar.
  Keep Enter to apply, Escape to cancel, and expansion to the original image.
- Preserve crop changes when switching tools or inserting new elements.

## 0.1.10 (2026-10-01)

- Keep native text input responsive without replacing the editor's DOM text on
  each keystroke or restyling the surrounding thread.
- Reuse unchanged artwork and sticky layouts while typing, moving, and zooming.
  Fit long sticky text without repeatedly allocating and measuring wrapped lines.

## 0.1.9 (2026-10-01)

- Create square sticky notes with wrapped text that automatically fits inside.
  Resizing a note scales its text and padding together. Convert existing notes
  to squares while preserving their text, colors, and positions.
- Double-click an image with Select to crop it with eight handles and a movable
  frame. Apply, cancel, or reset the crop without modifying the source image;
  preserve crops in copies, Undo, agent reads, and PNG exports.
- Cut selected elements with Command/Ctrl+X and paste them through the existing
  clipboard workflow. Failed clipboard writes keep the original elements.

## 0.1.8 (2026-10-01)

- Order toolbar tools as Select, Sticky note, Text, Arrow, and Draw.

## 0.1.7 (2026-10-01)

- Start text and sticky notes with a compact single line that grows while
  typing. Only Enter starts a new line; deleting text shrinks its bounds.
- Use the same frame for selection and editing, with the sticky background
  following the draft. Preserve saved bounds when reopening an unchanged note.
- Keep the caret visible as an unwrapped line grows beyond the panel.

## 0.1.6 (2026-09-30)

- Add Arrow with color, stroke presets, Shift-constrained direction, and
  support for moving, copying, Undo, agent reads, and PNG export.
- Add editable yellow sticky notes with text formatting and matching exports.
- Fix double-click editing when pointer capture targets the canvas surface.
- Discard pencil and arrow clicks or jitter under three screen pixels while
  preserving short strokes, loops, and the final pointer-release position.

## 0.1.5 (2026-09-30)

- Draw and write directly on images without a modifier key; moving or resizing
  images requires Select. Text and strokes remain draggable in every tool.
- Keep images stationary when moving mixed selections with Draw or Text, and
  match their cursors and resize handles to the active tool.

## 0.1.4 (2026-09-30)

- Copy selected images, text, and drawings with Command/Ctrl+C and paste
  separate copies with Command/Ctrl+V, preserving styles and relative layout.
- Offset successive pasted groups, select the new copies, and undo each paste
  in one step. Support pasting between thread canvases with independent images.
- Keep native text editing and screenshot paste; let the Paste toolbar button
  insert copied elements too.

## 0.1.3 (2026-09-30)

- Show colors and three size presets directly in the first toolbar row, with
  dots for stroke widths and letters for text sizes.
- Drag existing elements with a mouse or pen in every tool. Hold Alt or Option
  to draw or write over them; touch keeps the selected tool's direct action.
- Keep the active tool after moving elements, show their selection handles,
  and avoid saving clicks that do not move anything.
- Apply text formatting to the current draft and keep focus while choosing
  colors and sizes.

## 0.1.2 (2026-09-30)

- Keep deleted images available for Undo for 24 hours after their last canvas
  element is removed, regardless of when the image was uploaded.
- Isolate recovery drafts between browser tabs while preserving reload recovery.
- Cancel active gestures before Delete, Undo, Redo, and tool changes so that
  releasing the pointer cannot restore an earlier preview.
- Capture embedded browser frames as whole blocks without passing clicks to
  their contents.

## 0.1.1 (2026-09-30)

- Keep the visible position when a drag loses pointer capture, and prevent
  native image dragging from interrupting canvas gestures.
- Save the final pointer position when releasing a moved or resized element.
- Put color and size controls at the end of the first toolbar row, with a
  popover for the color palette.

## 0.1.0 (2026-09-30)

- Add a canvas to each thread's right panel, with images, editable text,
  freehand drawing, Shift-constrained lines, selection, resize, undo, and zoom.
- Paste screenshots, drop or upload images, and capture a highlighted block
  from desktop BB's built-in browser.
- Save JSON documents and images per thread, with recovery for failed saves.
- Let agents read elements and view a PNG of the entire canvas; export PNGs
  from the panel or the CLI.
- Follow the active theme with compact San Francisco-style controls.
