// DevBrowser scripts for one observation, one freshness check, or one batched
// step (freshness check + execution + short wait + observation). Each script
// runs inside a `bb browser-automation` session, which gives a real Puppeteer
// Page with a CDP session. Execution logic is ported from
// browser-use/jev-ultrafast jev_ultrafast/browser.py (MIT).
//
// Model output never becomes code here: payloads are JSON data, node ids are
// code-owned identities from snapshot.js, and geometry is re-read before input.
import { READ_STATE } from "./snapshot.gen";
import type { Action, Page } from "./types";

const MARKER = `(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`;

function wrap(pageName: string, body: string): string {
  return `await (async () => {
  const READ_STATE = ${JSON.stringify(READ_STATE)};
  const MARKER = ${JSON.stringify(MARKER)};
  const p = await browser.getPage(${JSON.stringify(pageName)});
  const c = await p.createCDPSession();
  // Emulation is per CDP session: keep rAF and timers running in an unfocused tab for this script.
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const call = (method, params = {}) => c.send(method, params);
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error("Document changed during evaluation");
    return r.result ? r.result.value : undefined;
  };
  // Freshness data (marker, page key, guards) is large; compare 53-bit digests instead.
  const digest = (value) => {
    const str = JSON.stringify(value) ?? "null";
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  const compact = (state) => {
    const guards = {};
    for (const [node, guard] of Object.entries(state.guards)) guards[node] = digest(guard);
    return {
      url: state.url, title: state.title, w: state.w, h: state.h, text: state.text, scroll: state.scroll,
      actions: state.actions.map(({ rect, ...action }) => ({ ...action, label: String(action.label).slice(0, 300) })),
      marker: digest(state.marker), page_key: digest(state.page_key), guards, omitted_actions: state.omitted_actions,
    };
  };
  const observe = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const state = await evaluate(READ_STATE);
        if (state) return compact(state);
      } catch {}
      await sleep(20);
    }
    return null;
  };
  try {
    // The run result is returned as one compact JSON string (DevBrowser caps result text near 64 KB).
    const result = await (async () => {
${body}
    })();
    let out = JSON.stringify(result);
    if (out.length > 60000 && result && result.observation) {
      const o = result.observation;
      o.text = o.text.slice(0, 3000);
      o.actions = o.actions.map((a) => ({ ...a, label: String(a.label).slice(0, 80), value: a.value == null ? a.value : String(a.value).slice(0, 80), current_value: a.current_value == null ? a.current_value : String(a.current_value).slice(0, 80) }));
      out = JSON.stringify(result);
    }
    return out;
  } finally {
    await c.detach().catch(() => {});
  }
})()`;
}

export interface Viewport {
  width: number;
  height: number;
}

export function openScript(pageName: string, url: string, viewport: Viewport | null = null): string {
  return wrap(
    pageName,
    `    ${viewport ? `await p.setViewport(${JSON.stringify({ width: viewport.width, height: viewport.height })}).catch(() => {});` : ""}
    await p.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: 20000 });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const ready = await evaluate("document.readyState").catch(() => null);
      if (ready === "complete") break;
      await sleep(20);
    }
    // Let post-load rendering settle: two equal markers 100 ms apart, at most ~1.5 s.
    let previous = null;
    for (let i = 0; i < 15; i++) {
      const marker = await evaluate(MARKER).catch(() => null);
      const current = marker === null ? null : digest(marker);
      if (current !== null && current === previous) break;
      previous = current;
      await sleep(100);
    }
    return { observation: await observe() };`,
  );
}

export function observeScript(pageName: string): string {
  return wrap(pageName, "    return { observation: await observe() };");
}

export function freshScript(pageName: string, page: Page): string {
  return wrap(
    pageName,
    `    const marker = await evaluate(MARKER).catch(() => null);
    return { fresh: marker !== null && digest(marker) === ${JSON.stringify(page.marker)} };`,
  );
}

/** Element checks run in the page immediately before input. Returns {x,y} or null. */
const TARGET = `(action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x,y))) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})`;

/** After input: up to two animation frames or 50 ms; comboboxes wait up to 200 ms for visible options. */
const SETTLE = `(action => new Promise(resolve => {
  const field=window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))`;

export function stepScript(pageName: string, action: Action, page: Page, text: string | null): string {
  const kind = action.kind;
  if ((kind === "click" || kind === "fill" || kind === "select") && typeof action.node !== "number") {
    throw new Error("Invalid observed node");
  }
  if (kind === "fill" && (typeof text !== "string" || text === "")) {
    throw new Error("TYPE_TEXT needs a value; nothing typed.");
  }
  const node = typeof action.node === "number" ? action.node : null;
  const minimal = { id: action.id, kind, node, value: action.value ?? null, delta: action.delta ?? 0 };
  const scoped = kind === "click" || kind === "select";
  const expected = scoped ? [page.page_key, page.guards[String(node)] ?? null] : page.marker;
  const payload = { action: minimal, expected, text, w: page.w, h: page.h };
  return wrap(
    pageName,
    `    const P = ${JSON.stringify(payload)};
    const kind = P.action.kind;
    let fresh = false;
    try {
      ${
        scoped
          ? `const current = await evaluate("(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(" + P.action.node + "))] : null; })()");
      fresh = current !== null && digest(current[0]) === P.expected[0] && digest(current[1]) === P.expected[1];`
          : `const current = await evaluate(MARKER);
      fresh = current !== null && digest(current) === P.expected;`
      }
    } catch {}
    if (!fresh) return { stale: true, reason: "page changed", observation: await observe() };
    let started = false;
    try {
      if (kind === "wait") {
        await sleep(100);
      } else if (kind === "scroll") {
        started = true;
        await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(P.w / 2), y: Math.round(P.h * 0.8), deltaX: 0, deltaY: P.action.delta });
      } else {
        // A native select mutates inside this evaluation, so it counts as started.
        if (kind === "select") started = true;
        const target = await evaluate(${JSON.stringify(TARGET)} + "(" + JSON.stringify(P.action) + ")");
        if (target == null) {
          if (kind === "select") return { uncertain: "Dropdown execution was not confirmed; inspect before retrying." };
          return { stale: true, reason: "target changed, hidden, or covered", observation: await observe() };
        }
        if (kind !== "select") {
          started = true;
          for (const type of ["mousePressed", "mouseReleased"]) {
            await call("Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 });
          }
          if (kind === "fill") {
            const mac = /Mac/.test(String(await evaluate("navigator.platform").catch(() => "")));
            const modifiers = mac ? 4 : 2;
            await call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers, commands: ["selectAll"] });
            await call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers });
            await call("Input.insertText", { text: P.text });
          }
        }
      }
    } catch (error) {
      if (started) return { uncertain: String(error && error.message || error) };
      return { stale: true, reason: String(error && error.message || error), observation: await observe() };
    }
    if (kind !== "wait") {
      try { await evaluate(${JSON.stringify(SETTLE)} + "(" + JSON.stringify(P.action) + ")", true); } catch {}
    }
    let observation = null, observeError = null;
    try {
      observation = await observe();
      if (!observation) observeError = "Page did not settle";
    } catch (error) {
      observeError = String(error && error.message || error);
    }
    return { executed: true, observation, observeError };`,
  );
}
