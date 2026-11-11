# Image feedback

Mark up any image bb shows and send it back to the thread's agent.

## Use

1. Hover an image in a thread (or tap it on a phone): an **Annotate** button
   appears in its top-right corner. It also appears on the enlarged image.
2. Outline an area with the pointer. A field opens under the outline: type the
   comment and press **Enter** (**Shift+Enter** starts a new line, **Escape**
   discards a new outline).
3. Repeat for as many areas as you need. Each gets a numbered pin with its
   comment; click a pin to edit the comment or **Remove** the outline.
   **Undo** or **⌘Z** / **Ctrl+Z** removes the last outline.
4. **Send** (or **⌘Enter** / **Ctrl+Enter**) posts a message to the thread
   you have open: the numbered comments, a copy of the image with the outlines
   and numbers drawn on it, and, for the agent only, each outline's position in
   pixels and percentages of the original image.

**Cancel** closes the annotator without sending; **Escape** does too while
nothing is outlined. Images smaller than 100 pixels on a side, or shown smaller than 64 pixels, get
no button.
The marked-up copy is at most 2,000 pixels on its longer side and is stored as
an attachment of the thread's project.

## Limits

- An image served by another site that forbids reading it cannot be opened.
- The annotator shows the image fitted to the window, without zoom.
- The message goes to the thread in view, also for an image shown elsewhere.

## Development

```sh
npm install
npm test && npm run typecheck
bb plugin build
```
