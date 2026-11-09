// Schwebende Menüs und Dialoge: an einem Element verankert, schließen per Klick daneben oder Esc
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export type Anchor = HTMLElement | DOMRect | { x: number; y: number };

function rectOf(anchor: Anchor): DOMRect {
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  if ("width" in anchor) return anchor;
  return new DOMRect(anchor.x, anchor.y, 0, 0);
}

/** Handy: Menüs als Blatt von unten (volle Breite, große Tippflächen) statt winzig am Element */
export const SHEET_QUERY = "(max-width: 640px)";
export const isPhone = () => typeof window !== "undefined" && window.matchMedia?.(SHEET_QUERY).matches === true;

/** Portal-Ziel: innerhalb des Arbeitsbereichs, damit Farben/Variablen gelten */
function portalRoot(): HTMLElement {
  return (document.querySelector(".nk") as HTMLElement | null) ?? document.body;
}

export function Popover(props: {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  placement?: "bottom-start" | "bottom-end" | "right-start";
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Bis zur Positionierung nur durchsichtig (nicht "hidden"), damit Eingabefelder mit autoFocus den Fokus bekommen
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0, left: 0, top: 0, width: props.width });
  const { onClose } = props;
  const [sheet] = useState(isPhone);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (sheet) return setStyle({});
    const r = rectOf(props.anchor);
    const vw = window.innerWidth;
    // Feste Breite gleich mitrechnen (sonst ragt das Menü am Handy über den Rand)
    const w = props.width ? Math.min(props.width, vw - 16) : el.offsetWidth;
    const h = el.offsetHeight;
    const vh = window.innerHeight;
    let left = props.placement === "bottom-end" ? r.right - w : props.placement === "right-start" ? r.right + 4 : r.left;
    let top = props.placement === "right-start" ? r.top : r.bottom + 4;
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
    if (left < 8) left = 8;
    if (top + h > vh - 8) top = Math.max(8, (props.placement === "right-start" ? vh : r.top) - h - 4);
    setStyle({ left, top, width: props.width });
  }, [props.anchor, props.placement, props.width, sheet]);

  // Öffnet sich danach ein Dialog (z. B. Fotonachweis nach „Erledigt“), schließt das Menü – sonst liegt es darüber
  useEffect(() => {
    const root = portalRoot();
    const obs = new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) {
        if (n instanceof HTMLElement && n.classList.contains("nk-modal-backdrop") && !n.contains(ref.current)) return onClose();
      }
    });
    obs.observe(root, { childList: true });
    return () => obs.disconnect();
  }, [onClose]);

  useEffect(() => {
    // Ein Dialog, der aus dem Menü geöffnet wurde, liegt darüber – Klicks dort zählen nicht als "daneben"
    const modalAbove = () => !ref.current?.closest(".nk-modal-backdrop") && document.querySelector(".nk-modal-backdrop");
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.(".nk-sheet-backdrop") && (t as HTMLElement).closest(".nk-sheet-backdrop") !== ref.current?.previousElementSibling) return;
      if ((t as HTMLElement).closest?.(".nk-modal-backdrop") && modalAbove()) return;
      // Verschachtelte Popover (z. B. Untermenü) zählen als innen
      if ((t as HTMLElement).closest?.(".nk-popover")) {
        const all = [...document.querySelectorAll(".nk-popover")];
        if (all.indexOf((t as HTMLElement).closest(".nk-popover")!) > all.indexOf(ref.current!)) return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !modalAbove()) {
        e.stopPropagation();
        onClose();
      }
    };
    const t = setTimeout(() => document.addEventListener("pointerdown", onDown, true));
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <>
      {sheet && <div className="nk-sheet-backdrop" aria-hidden onClick={(e) => e.stopPropagation()} />}
      {/* Klicks im Menü nicht an das auslösende Element weiterreichen (React leitet Portal-Klicks nach oben weiter –
          sonst öffnet z. B. eine Tabellenzelle das gerade geschlossene Menü sofort wieder) */}
      <div ref={ref} className={`nk-popover ${sheet ? "is-sheet " : ""}${props.className ?? ""}`} style={style} role="dialog"
        onClick={(e) => e.stopPropagation()}>
        {sheet && <div className="nk-sheet-grip" aria-hidden />}
        {props.children}
      </div>
    </>,
    portalRoot(),
  );
}

export function MenuItem(props: {
  icon?: IconName | ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  active?: boolean;
  chevron?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`nk-menu-item${props.danger ? " is-danger" : ""}${props.active ? " is-active" : ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.icon !== undefined && (
        <span className="nk-menu-icon">{typeof props.icon === "string" ? <Icon name={props.icon as IconName} /> : props.icon}</span>
      )}
      <span className="nk-menu-label">{props.label}</span>
      {props.hint !== undefined && <span className="nk-menu-hint">{props.hint}</span>}
      {props.active && <Icon name="check" className="nk-menu-check" />}
      {props.chevron && <Icon name="chevronRight" className="nk-menu-hint" />}
    </button>
  );
}

export const MenuDivider = () => <div className="nk-menu-divider" />;
export const MenuLabel = (props: { children: ReactNode }) => <div className="nk-menu-section">{props.children}</div>;

export function Modal(props: { onClose: () => void; children: ReactNode; className?: string; label: string }) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="nk-modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* Handy: Blatt von unten mit Griff, Kopf/Fuß bleiben stehen, Inhalt scrollt */}
      <div className={`nk-modal ${props.className ?? ""}`} role="dialog" aria-label={props.label}>
        {props.children}
      </div>
    </div>,
    portalRoot(),
  );
}

/** Popover-Zustand: Anker merken, schließen */
export function usePopover() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  return {
    anchor,
    open: (a: Anchor) => setAnchor(a),
    toggle: (a: Anchor) => setAnchor((cur) => (cur ? null : a)),
    close: () => setAnchor(null),
  };
}
