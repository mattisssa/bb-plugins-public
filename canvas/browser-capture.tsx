import { useEffect } from "react";
import {
  useBbNavigate,
  useRpc,
  type ExperimentalPluginBrowserToolbarActionProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { PANEL_ID, contentBounds } from "./model";
import { imagePng, loadImage } from "./images";
import { useStateRef } from "./use-state-ref";
import { Icon } from "./icons";
import type { rpcContract } from "./server";
import { revealElement } from "./reveal";

export const PICKER_KEY = "__bbCanvasPicker";
export function pickerScript(token: string): string {
  return `(() => {
    const key = ${JSON.stringify(PICKER_KEY)}, token = ${JSON.stringify(token)};
    window[key]?.cleanup();
    // Frame events never bubble to this document. Keep input here and hit-test underneath.
    const previousFocus = document.activeElement;
    const shield = document.createElement('div');
    shield.tabIndex = -1;
    shield.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;display:block;pointer-events:auto;touch-action:none;cursor:crosshair;outline:none;user-select:none';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #007aff;background:#007aff22;border-radius:3px;box-sizing:border-box;display:none';
    shield.appendChild(overlay);
    document.documentElement.appendChild(shield);
    shield.focus({preventScroll:true});
    let selected = null, point = null, timer;
    const rectOf = (element) => { const r = element.getBoundingClientRect(); const x = Math.max(0, r.left), y = Math.max(0, r.top); return { x, y, width: Math.max(0, Math.min(innerWidth, r.right) - x), height: Math.max(0, Math.min(innerHeight, r.bottom) - y) }; };
    const highlight = () => { if (!selected) { overlay.style.display='none'; return; } const r = rectOf(selected); Object.assign(overlay.style, {display:'block',left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'}); };
    const selectAt = (event, preserveParent = false) => {
      const x = event.clientX, y = event.clientY;
      // Click coordinates can round fractional pointer coordinates in browser engines.
      if (selected?.isConnected && point && (point.x===x && point.y===y || preserveParent && Math.abs(point.x-x)<1 && Math.abs(point.y-y)<1)) return;
      point = {x,y};
      shield.style.pointerEvents='none';
      try {
        selected = document.elementFromPoint(x,y);
        while (selected?.shadowRoot?.elementFromPoint) {
          const child = selected.shadowRoot.elementFromPoint(x,y);
          if (!child || child===selected) break;
          selected = child;
        }
      } finally { shield.style.pointerEvents='auto'; }
      highlight();
    };
    const swallow = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const move = (event) => { swallow(event); selectAt(event); };
    const down = (event) => { swallow(event); selectAt(event,true); };
    const cleanup = () => { clearTimeout(timer); const restoreFocus = document.activeElement===shield; shield.remove(); document.removeEventListener('pointermove',move,true); document.removeEventListener('pointerdown',down,true); document.removeEventListener('pointerup',swallow,true); document.removeEventListener('click',click,true); document.removeEventListener('keydown',keyDown,true); document.removeEventListener('wheel',swallow,true); document.removeEventListener('contextmenu',swallow,true); window.removeEventListener('pagehide',cleanup); if(window[key]?.token===token) delete window[key]; if(restoreFocus && previousFocus?.isConnected) previousFocus.focus?.({preventScroll:true}); };
    const cancel = () => { cleanup(); bb.postMessage({kind:'canvas-cancel',token}); };
    const keyDown = (event) => { swallow(event); if(event.key==='Escape') cancel(); else if(event.key==='ArrowUp' && selected) { selected=selected.parentElement || selected.getRootNode().host || selected; highlight(); } };
    const click = (event) => { swallow(event); selectAt(event,true); if(!selected) return; const rect=rectOf(selected); const label=(selected.getAttribute('aria-label') || selected.tagName.toLowerCase()).slice(0,120); const viewport={width:innerWidth,height:innerHeight}; cleanup(); if(rect.width<1 || rect.height<1) return; requestAnimationFrame(()=>requestAnimationFrame(()=>bb.postMessage({kind:'canvas-pick',token,rect,viewport,label}))); };
    document.addEventListener('pointermove',move,true); document.addEventListener('pointerdown',down,true); document.addEventListener('pointerup',swallow,true); document.addEventListener('click',click,true); document.addEventListener('keydown',keyDown,true); document.addEventListener('wheel',swallow,{capture:true,passive:false}); document.addEventListener('contextmenu',swallow,true); window.addEventListener('pagehide',cleanup);
    timer=setTimeout(cancel,90000); window[key]={token,cleanup}; return true;
  })()`;
}
function stopScript(token: string): string {
  return `(() => {const p=window[${JSON.stringify(PICKER_KEY)}];if(p?.token===${JSON.stringify(token)})p.cleanup();})()`;
}
export function BrowserCapture({
  threadId,
  tabId,
  url,
  isCompactViewport,
  experimental_page: page,
}: ExperimentalPluginBrowserToolbarActionProps) {
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const [capture, setCapture, captureRef] = useStateRef<{
    token: string;
    phase: "picking" | "capturing";
  } | null>(null);
  const picking = capture?.phase === "picking";
  const busy = capture?.phase === "capturing";
  useEffect(() => {
    if (!page) return;
    const unsubscribe = page.onMessage((data) => {
      const current = captureRef.current;
      if (
        !current ||
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        data.token !== current.token
      )
        return;
      const currentToken = current.token;
      if (data.kind === "canvas-cancel") {
        setCapture(null);
        return;
      }
      if (data.kind !== "canvas-pick" || current.phase === "capturing") return;
      const { rect, viewport } = data as unknown as {
        rect: { x: number; y: number; width: number; height: number };
        viewport: { width: number; height: number };
      };
      if (
        !rect ||
        !viewport ||
        ![
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          viewport.width,
          viewport.height,
        ].every(Number.isFinite) ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        viewport.width <= 0 ||
        viewport.height <= 0 ||
        rect.x + rect.width > viewport.width + 1 ||
        rect.y + rect.height > viewport.height + 1
      )
        return;
      setCapture({ token: currentToken, phase: "capturing" });
      const isCurrent = () => captureRef.current?.token === currentToken;
      void (async () => {
        const captured = await rpc.call("captureCanvasTab", {
          threadId,
          tabId,
        });
        if (!isCurrent()) return;
        const source = await loadImage(
          `data:${captured.mimeType};base64,${captured.base64}`,
        );
        if (!isCurrent()) return;
        const sx = captured.width / viewport.width,
          sy = captured.height / viewport.height;
        const asset = await rpc.call("uploadCanvasImage", {
          threadId,
          base64: imagePng(source, {
            x: rect.x * sx,
            y: rect.y * sy,
            width: rect.width * sx,
            height: rect.height * sy,
          }),
        });
        if (!isCurrent()) return;
        const board = await rpc.call("getCanvas", { threadId });
        if (!isCurrent()) return;
        const box = contentBounds(board.elements);
        const fit = Math.min(1, 600 / asset.width, 600 / asset.height);
        const id = crypto.randomUUID();
        await rpc.call("updateCanvas", {
          threadId,
          patch: {
            upserts: [
              {
                id,
                type: "image",
                assetId: asset.id,
                name: `Capture: ${typeof data.label === "string" ? data.label.slice(0, 120) : "Browser"}`,
                x: board.elements.length ? box.x + box.width + 32 : 0,
                y: board.elements.length ? box.y : 0,
                width: asset.width * fit,
                height: asset.height * fit,
              },
            ],
            removeIds: [],
          },
        });
        if (!isCurrent()) return;
        const open = () => {
          revealElement(threadId, id);
          navigate.openThreadPanel({ actionId: PANEL_ID });
        };
        toast.success("Added to Canvas", {
          action: { label: "Open", onClick: open },
        });
        open();
      })()
        .catch((cause: unknown) => {
          if (isCurrent())
            toast.error(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (isCurrent()) setCapture(null);
        });
    });
    return () => {
      unsubscribe();
      const previous = captureRef.current;
      setCapture(null);
      if (previous)
        void page.evaluate(stopScript(previous.token)).catch(() => undefined);
    };
  }, [page, url, threadId, tabId, rpc, navigate]);
  if (!page) return null;
  async function toggle() {
    if (!page) return;
    const previous = captureRef.current;
    if (previous) {
      setCapture(null);
      await page.evaluate(stopScript(previous.token)).catch(() => undefined);
      return;
    }
    const next = crypto.randomUUID();
    setCapture({ token: next, phase: "picking" });
    try {
      await page.evaluate(pickerScript(next));
      if (captureRef.current?.token !== next) return;
      toast(
        "Click a block to add it to Canvas. ↑ selects its parent; Esc cancels.",
      );
    } catch (cause) {
      if (captureRef.current?.token !== next) return;
      setCapture(null);
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <button
      className="cv-browser-button"
      aria-label={picking ? "Cancel Canvas capture" : "Capture to Canvas"}
      title="Capture a block to Canvas"
      aria-pressed={picking}
      disabled={busy}
      onClick={() => void toggle()}
    >
      <Icon name="capture" />
      {!isCompactViewport && (
        <span>{busy ? "Capturing…" : picking ? "Cancel" : "Canvas"}</span>
      )}
    </button>
  );
}
