// Ziehen & Ablegen per Touch (Handy, Tablet)
//
// Browser lösen HTML5-Drag&Drop per Finger meist nicht aus. Hier startet langes Drücken auf ein
// Element mit draggable="true" das Ziehen; danach werden echte DragEvents (dragstart, dragover, drop,
// dragend) an die Elemente unter dem Finger geschickt. So funktionieren die vorhandenen Handler in
// Seitenleiste, Board, Tabelle und Kalender ohne eigene Touch-Logik.

const LONG_PRESS = 350;
const MOVE_TOLERANCE = 8;
const EDGE = 56;
const SCROLL_STEP = 14;

type Drag = {
  source: HTMLElement;
  x: number;
  y: number;
  startX: number;
  startY: number;
  timer: ReturnType<typeof setTimeout>;
  dragging: boolean;
  dt: DataTransfer;
  ghost?: HTMLElement;
  offsetX: number;
  offsetY: number;
  over: Element | null;
  accepted: boolean;
  scroller?: ReturnType<typeof setInterval>;
};

const supported = () => {
  try {
    return typeof DragEvent !== "undefined" && Boolean(new DataTransfer());
  } catch {
    return false;
  }
};

function scrollParent(el: Element | null): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let cur = el as HTMLElement | null; cur; cur = cur.parentElement) {
    const s = getComputedStyle(cur);
    const y = /(auto|scroll)/.test(s.overflowY) && cur.scrollHeight > cur.clientHeight;
    const x = /(auto|scroll)/.test(s.overflowX) && cur.scrollWidth > cur.clientWidth;
    if (x || y) out.push(cur);
  }
  return out;
}

export function installTouchDrag(root: HTMLElement): () => void {
  if (!supported()) return () => undefined;
  let drag: Drag | null = null;
  let suppressUntil = 0;

  const fire = (type: string, target: EventTarget, d: Drag) => {
    const ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: d.x, clientY: d.y, dataTransfer: d.dt });
    target.dispatchEvent(ev);
    return ev;
  };

  const cleanup = () => {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.scroller) clearInterval(drag.scroller);
    drag.ghost?.remove();
    root.classList.remove("nk-touch-dragging");
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", onCancel);
    drag = null;
  };

  // Am Rand des sichtbaren Bereichs weiterscrollen (lange Listen, breites Board)
  const autoScroll = () => {
    if (!drag?.dragging) return;
    for (const el of scrollParent(drag.over)) {
      const r = el.getBoundingClientRect();
      if (drag.y < r.top + EDGE) el.scrollTop -= SCROLL_STEP;
      else if (drag.y > r.bottom - EDGE) el.scrollTop += SCROLL_STEP;
      if (drag.x < r.left + EDGE) el.scrollLeft -= SCROLL_STEP;
      else if (drag.x > r.right - EDGE) el.scrollLeft += SCROLL_STEP;
    }
  };

  const begin = () => {
    const d = drag;
    if (!d) return;
    d.dragging = true;
    const start = fire("dragstart", d.source, d);
    if (start.defaultPrevented) return cleanup();
    navigator.vibrate?.(12);
    const rect = d.source.getBoundingClientRect();
    d.offsetX = d.x - rect.left;
    d.offsetY = d.y - rect.top;
    const ghost = d.source.cloneNode(true) as HTMLElement;
    ghost.classList.add("nk-touch-ghost");
    Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    root.appendChild(ghost);
    d.ghost = ghost;
    root.classList.add("nk-touch-dragging");
    d.scroller = setInterval(autoScroll, 30);
  };

  const onStart = (e: TouchEvent) => {
    if (drag || e.touches.length !== 1) return cleanup();
    const target = e.target as Element;
    const source = target.closest?.<HTMLElement>('[draggable="true"]');
    if (!source || !root.contains(source) || target.closest("input, textarea, select, [contenteditable='true']")) return;
    const t = e.touches[0];
    drag = {
      source,
      x: t.clientX,
      y: t.clientY,
      startX: t.clientX,
      startY: t.clientY,
      timer: setTimeout(begin, LONG_PRESS),
      dragging: false,
      dt: new DataTransfer(),
      offsetX: 0,
      offsetY: 0,
      over: null,
      accepted: false,
    };
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onCancel);
  };

  const onMove = (e: TouchEvent) => {
    const d = drag;
    if (!d) return;
    const t = e.touches[0];
    d.x = t.clientX;
    d.y = t.clientY;
    if (!d.dragging) {
      // Bewegung vor dem langen Drücken = Scrollen
      if (Math.hypot(d.x - d.startX, d.y - d.startY) > MOVE_TOLERANCE) cleanup();
      return;
    }
    e.preventDefault();
    if (d.ghost) Object.assign(d.ghost.style, { left: `${d.x - d.offsetX}px`, top: `${d.y - d.offsetY}px` });
    const under = document.elementFromPoint(d.x, d.y);
    if (!under) return;
    if (under !== d.over) {
      if (d.over) fire("dragleave", d.over, d);
      fire("dragenter", under, d);
      d.over = under;
    }
    d.accepted = fire("dragover", under, d).defaultPrevented;
  };

  const onEnd = (e: TouchEvent) => {
    const d = drag;
    if (!d) return;
    if (d.dragging) {
      e.preventDefault();
      if (d.over && d.accepted) fire("drop", d.over, d);
      fire("dragend", d.source, d);
      // Klick/Kontextmenü, die der Browser nach dem Loslassen noch auslöst, nicht ausführen
      suppressUntil = Date.now() + 600;
    }
    cleanup();
  };

  const onCancel = () => {
    if (drag?.dragging) fire("dragend", drag.source, drag);
    cleanup();
  };

  const onCapture = (e: Event) => {
    const active = drag?.dragging || Date.now() < suppressUntil;
    // Startet der Browser selbst ein Ziehen, übernimmt er – außer wir ziehen schon
    if (e.type === "dragstart" && e.isTrusted && drag) {
      if (drag.dragging) e.preventDefault();
      else cleanup();
      return;
    }
    if ((e.type === "contextmenu" && (drag || active)) || (e.type === "click" && active) || (e.type === "selectstart" && drag?.dragging)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  root.addEventListener("touchstart", onStart, { passive: true });
  for (const type of ["contextmenu", "click", "dragstart", "selectstart"]) document.addEventListener(type, onCapture, true);
  return () => {
    cleanup();
    root.removeEventListener("touchstart", onStart);
    for (const type of ["contextmenu", "click", "dragstart", "selectstart"]) document.removeEventListener(type, onCapture, true);
  };
}
