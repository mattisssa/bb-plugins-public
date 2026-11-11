import { FONT_ADVANCES, FONT_UNITS, MISSING_ADVANCE } from "./font-metrics";
import { STICKY_PADDING, STICKY_SIZE, type StickyElement } from "./model";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function textAdvance(text: string, fontSize: number): number {
  let advance = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    // A tab gets a stable four-space advance in the SVG and editor alike.
    advance +=
      code === 9
        ? (FONT_ADVANCES.get(32) ?? MISSING_ADVANCE) * 4
        : (FONT_ADVANCES.get(code) ??
          (/\p{Mark}|\p{Format}/u.test(character) ? 0 : FONT_UNITS * 2));
  }
  return (advance * fontSize) / FONT_UNITS;
}

export function stickyPadding(sticky: Pick<StickyElement, "width" | "height">) {
  return (STICKY_PADDING * Math.min(sticky.width, sticky.height)) / STICKY_SIZE;
}

type Part = {
  text: string;
  advance: number;
  trimmedAdvance: number;
  content: boolean;
};
type Token = Part & {
  space: boolean;
  graphemes?: Part[];
};
function measure(text: string): Part {
  const trimmed = text.trimEnd();
  const advance = textAdvance(text, 1);
  return {
    text,
    advance,
    trimmedAdvance: trimmed === text ? advance : textAdvance(trimmed, 1),
    content: trimmed.length > 0,
  };
}
function prepare(text: string): Token[][] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n")
    .map((line) =>
      (line.match(/ +|[^ ]+/gu) ?? []).map((text) => ({
        ...measure(text),
        space: text[0] === " ",
      })),
    );
}

// Fit candidates only count lines and advances. Build strings once, at the
// chosen font size, so typing does not allocate and measure 28 sets of lines.
function wrap(
  paragraphs: Token[][],
  fontSize: number,
  width: number,
  height: number,
  result?: string[],
): boolean {
  const available = width / fontSize;
  let lineCount = 0;
  for (const paragraph of paragraphs) {
    let line = "";
    let advance = 0;
    let visibleAdvance = 0;
    let content = false;
    let occupied = false;
    const emit = (trimmed: boolean) => {
      if (
        ++lineCount * fontSize * 1.3 > height ||
        (trimmed ? visibleAdvance : advance) * fontSize > width
      )
        return false;
      result?.push(trimmed ? line.trimEnd() : line);
      return true;
    };
    for (const token of paragraph) {
      // CSS pre-wrap hangs breaking spaces at the end of the preceding line.
      // They must not become indentation on the next automatically wrapped line.
      if (token.space || advance + token.advance <= available) {
        if (result) line += token.text;
        if (token.content) {
          visibleAdvance = advance + token.trimmedAdvance;
          content = true;
        }
        advance += token.advance;
        occupied = true;
        continue;
      }
      if (content && !emit(true)) return false;
      line = "";
      advance = 0;
      visibleAdvance = 0;
      content = false;
      occupied = false;
      if (token.advance <= available) {
        if (result) line = token.text;
        advance = token.advance;
        visibleAdvance = token.trimmedAdvance;
        content = token.content;
        occupied = true;
        continue;
      }
      token.graphemes ??= /^[\x00-\x7f]*$/.test(token.text)
        ? Array.from(token.text, measure)
        : Array.from(segments.segment(token.text), ({ segment }) =>
            measure(segment),
          );
      for (const part of token.graphemes) {
        if (occupied && advance + part.advance > available) {
          if (!emit(false)) return false;
          line = "";
          advance = 0;
          visibleAdvance = 0;
          content = false;
          occupied = false;
        }
        if (result) line += part.text;
        if (part.content) {
          visibleAdvance = advance + part.trimmedAdvance;
          content = true;
        }
        advance += part.advance;
        occupied = true;
      }
    }
    if (!emit(true)) return false;
  }
  return true;
}

export type StickyLayout = {
  lines: string[];
  fontSize: number;
  padding: number;
  lineHeight: number;
  contentWidth: number;
  contentHeight: number;
};

type CachedLayout = Pick<
  StickyElement,
  "text" | "width" | "height" | "fontSize"
> & { layout: StickyLayout };
// Canvas reuses layouts when only selection, position, color, or viewport change.
// Bound both entries and retained text because server exports share this module.
const layouts = new Map<string, CachedLayout>();
let cachedCharacters = 0;
const MAX_CACHED_LAYOUTS = 128;
const MAX_CACHED_CHARACTERS = 512_000;

export function layoutSticky(sticky: StickyElement): StickyLayout {
  const cached = layouts.get(sticky.id);
  if (
    cached?.text === sticky.text &&
    cached.width === sticky.width &&
    cached.height === sticky.height &&
    cached.fontSize === sticky.fontSize
  ) {
    layouts.delete(sticky.id);
    layouts.set(sticky.id, cached);
    return cached.layout;
  }
  const padding = stickyPadding(sticky);
  // Leave room for fractional CSS pixel rounding at small zoom levels.
  const safety = (2 * Math.min(sticky.width, sticky.height)) / STICKY_SIZE;
  const width = Math.max(Number.EPSILON, sticky.width - padding * 2 - safety);
  const height = Math.max(Number.EPSILON, sticky.height - padding * 2 - safety);
  const paragraphs = prepare(sticky.text);
  let fontSize = sticky.fontSize;
  if (!wrap(paragraphs, fontSize, width, height)) {
    let low = 0,
      high = fontSize;
    for (let i = 0; i < 28; i++) {
      const candidate = (low + high) / 2;
      if (wrap(paragraphs, candidate, width, height)) low = candidate;
      else high = candidate;
    }
    fontSize = Math.max(Number.EPSILON, low);
  }
  const lines: string[] = [];
  wrap(paragraphs, fontSize, width, height, lines);
  const layout = {
    lines,
    fontSize,
    padding,
    lineHeight: fontSize * 1.3,
    contentWidth: width,
    contentHeight: height,
  };
  if (cached) {
    cachedCharacters -= cached.text.length;
    layouts.delete(sticky.id);
  }
  // Avoid retaining an oversized caller input even outside schema validation.
  if (sticky.text.length <= MAX_CACHED_CHARACTERS) {
    layouts.set(sticky.id, {
      text: sticky.text,
      width: sticky.width,
      height: sticky.height,
      fontSize: sticky.fontSize,
      layout,
    });
    cachedCharacters += sticky.text.length;
    while (
      layouts.size > MAX_CACHED_LAYOUTS ||
      cachedCharacters > MAX_CACHED_CHARACTERS
    ) {
      const oldest = layouts.entries().next().value!;
      layouts.delete(oldest[0]);
      cachedCharacters -= oldest[1].text.length;
    }
  }
  return layout;
}
