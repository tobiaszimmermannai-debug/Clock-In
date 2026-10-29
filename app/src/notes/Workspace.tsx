// Arbeitsbereich: Seitenleiste + Seite + Seitenvorschau (Peek), Tastenkürzel, Design, Meldungen
import "@blocknote/mantine/style.css";
import "./notes.css";
import { useCallback, useEffect, useState } from "react";
import { VersionHistory } from "./History";
import { Home } from "./Home";
import { MovePicker, PageMenu, PageView } from "./PageView";
import { Search } from "./Search";
import { Sidebar, TemplatePicker } from "./Sidebar";
import { NotesProvider, useNotes } from "./state";
import type { NotesStore, PageMeta, Space } from "./types";
import { Icon } from "./ui/Icon";
import { MenuItem, MenuLabel, Popover, usePopover } from "./ui/Popover";
import { ancestors, relativeTime, storageGet, storageSet, untitled } from "./util";

type Theme = "light" | "dark" | "system";

export type NotesWorkspaceProps = {
  store: NotesStore;
  /** Name in der Seitenleiste */
  title?: string;
  /** "hash": Adresse #/p/<id> (eigenständige Web-App); "memory": eingebettet (z. B. in Clock-In) */
  routing?: "hash" | "memory";
  /** Füllt den Container statt des ganzen Fensters */
  embedded?: boolean;
  onLogout?: () => void;
};

export function NotesWorkspace(props: NotesWorkspaceProps) {
  return (
    <NotesProvider store={props.store} routing={props.routing ?? "hash"}>
      <Layout {...props} />
    </NotesProvider>
  );
}

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

function Layout(props: NotesWorkspaceProps) {
  const notes = useNotes();
  const title = props.title ?? "Aufgaben und Notizen";
  const mobile = useMedia("(max-width: 760px)");
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const [theme, setTheme] = useState<Theme>(() => storageGet<Theme>("aun-theme", "system"));
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  const [sidebar, setSidebar] = useState(() => storageGet<boolean>("aun-sidebar", true));
  const [drawer, setDrawer] = useState(false);
  const [width, setWidth] = useState(() => storageGet<number>("aun-sidebar-width", 260));
  const [searching, setSearching] = useState(false);
  const [templates, setTemplates] = useState(false);
  const showSidebar = mobile ? drawer : sidebar;

  const toggleSidebar = useCallback(() => {
    if (mobile) return setDrawer((d) => !d);
    setSidebar((s) => {
      storageSet("aun-sidebar", !s);
      return !s;
    });
  }, [mobile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching((s) => !s);
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "Escape" && notes.peek && !document.querySelector(".nk-popover, .nk-modal")) {
        notes.openPeek(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notes, toggleSidebar]);

  // Mobil: Seitenleiste nach dem Navigieren schließen
  useEffect(() => setDrawer(false), [notes.current]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = width;
    let w = start;
    const move = (ev: PointerEvent) => {
      w = Math.min(420, Math.max(200, start + ev.clientX - startX));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      storageSet("aun-sidebar-width", w);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const cls = ["nk", resolved === "dark" ? "nk-dark" : "nk-light", props.embedded ? "is-embedded" : "is-standalone", mobile ? "is-mobile" : ""]
    .filter(Boolean)
    .join(" ");

  if (notes.error) {
    return (
      <div className={cls}>
        <div className="nk-empty-page">
          <p>
            <b>Aufgaben konnten nicht geladen werden.</b>
            <br />
            {notes.error}
          </p>
          <button type="button" className="nk-btn" onClick={() => location.reload()}>
            Neu laden
          </button>
        </div>
      </div>
    );
  }

  const page = notes.current ? notes.pages.get(notes.current) : undefined;

  return (
    <div className={cls} style={{ ["--nk-sidebar" as string]: `${width}px` }}>
      {showSidebar && (
        <>
          {mobile && <div className="nk-scrim" onClick={() => setDrawer(false)} />}
          <div className="nk-sidebar-wrap">
            <Sidebar
              title={title}
              onSearch={() => setSearching(true)}
              onClose={mobile ? () => setDrawer(false) : undefined}
              onCollapse={toggleSidebar}
              onLogout={props.onLogout}
              theme={theme}
              onTheme={(t) => {
                setTheme(t);
                storageSet("aun-theme", t);
              }}
            />
            {!mobile && <div className="nk-sidebar-resize" onPointerDown={startResize} onDoubleClick={() => setWidth(260)} />}
          </div>
        </>
      )}
      <div className="nk-main">
        <Topbar page={page} sidebarOpen={showSidebar} onToggleSidebar={toggleSidebar} theme={resolved} />
        <div className="nk-scroll">
          {!notes.loaded ? (
            <div className="nk-page">
              <div className="nk-page-inner">
                <div className="nk-skeleton is-title" />
                <div className="nk-skeleton" />
              </div>
            </div>
          ) : notes.current ? (
            <PageView key={notes.current} id={notes.current} theme={resolved} />
          ) : (
            <Home title={title} onTemplates={() => setTemplates(true)} />
          )}
        </div>
      </div>
      {notes.peek && <Peek id={notes.peek} theme={resolved} mobile={mobile} />}
      {searching && <Search onClose={() => setSearching(false)} />}
      {templates && <TemplatePicker space="private" onClose={() => setTemplates(false)} onCreated={(id) => notes.navigate(id)} />}
      <Toasts />
    </div>
  );
}

function Topbar(props: { page?: PageMeta; sidebarOpen: boolean; onToggleSidebar: () => void; theme: "light" | "dark" }) {
  const notes = useNotes();
  const menu = usePopover();
  const share = usePopover();
  const [moving, setMoving] = useState(false);
  const [history, setHistory] = useState(false);
  const { page } = props;
  const trail = page ? [...ancestors(page.id, notes.pages), page] : [];
  const fav = page && notes.favorites.includes(page.id);

  return (
    <header className="nk-topbar">
      {!props.sidebarOpen && (
        <button type="button" className="nk-icon-btn" aria-label="Seitenleiste öffnen" onClick={props.onToggleSidebar}>
          <Icon name="menu" />
        </button>
      )}
      <nav className="nk-crumbs" aria-label="Pfad">
        {!page && <span className="nk-crumb is-current">Startseite</span>}
        {trail.map((p, i) => (
          <span key={p.id} className="nk-crumb-wrap">
            {i > 0 && <span className="nk-crumb-sep">/</span>}
            <button type="button" className={`nk-crumb${i === trail.length - 1 ? " is-current" : ""}`} onClick={() => notes.navigate(p.id)}>
              {p.icon && <span>{p.icon}</span>}
              <span>{untitled(p)}</span>
            </button>
          </span>
        ))}
      </nav>
      <span className="nk-spacer" />
      {page && (
        <>
          <Facepile peers={notes.presence[page.id] ?? []} />
          <span className="nk-muted nk-hide-sm nk-edited">Bearbeitet {relativeTime(page.updatedAt)}</span>
          <button type="button" className="nk-btn is-ghost" onClick={(e) => share.open(e.currentTarget)}>
            <Icon name={page.space === "team" ? "users" : "lock"} /> <span className="nk-hide-sm">{page.space === "team" ? "Team" : "Privat"}</span>
          </button>
          {page.kind === "page" && (
            <button
              type="button"
              className={`nk-icon-btn${notes.commentsOpen ? " is-on" : ""}`}
              aria-label="Kommentare"
              aria-pressed={notes.commentsOpen}
              title="Kommentare"
              onClick={() => notes.setCommentsOpen(!notes.commentsOpen)}
            >
              <Icon name="comment" />
            </button>
          )}
          <button type="button" className="nk-icon-btn" aria-label={fav ? "Aus Favoriten entfernen" : "Zu Favoriten"} onClick={() => notes.toggleFavorite(page.id)}>
            <Icon name={fav ? "starFilled" : "star"} className={fav ? "nk-star-on" : ""} />
          </button>
          <button type="button" className="nk-icon-btn" aria-label="Seitenmenü" onClick={(e) => menu.open(e.currentTarget)}>
            <Icon name="more" />
          </button>
          {menu.anchor && <PageMenu anchor={menu.anchor} page={page} onClose={menu.close} onMove={() => setMoving(true)} onHistory={() => setHistory(true)} />}
          {share.anchor && <SharePanel anchor={share.anchor} page={page} onClose={share.close} />}
          {history && <VersionHistory page={page} theme={props.theme} onClose={() => setHistory(false)} />}
          {moving && <MovePicker pageId={page.id} onClose={() => setMoving(false)} />}
        </>
      )}
    </header>
  );
}

/** Wer gerade auf der Seite ist (Live-Cursor anderer Personen) */
function Facepile(props: { peers: { clientId: number; name: string; color: string }[] }) {
  // Dieselbe Person in mehreren Tabs nur einmal zeigen
  const people = [...new Map(props.peers.map((p) => [p.name, p])).values()];
  if (!people.length) return null;
  return (
    <div className="nk-facepile" title={`Gerade hier: ${people.map((p) => p.name).join(", ")}`}>
      {people.slice(0, 4).map((p) => (
        <span key={p.clientId} className="nk-avatar" style={{ background: p.color }}>
          {p.name[0]}
        </span>
      ))}
      {people.length > 4 && <span className="nk-avatar is-more">+{people.length - 4}</span>}
    </div>
  );
}

function SharePanel(props: { anchor: HTMLElement | DOMRect | { x: number; y: number }; page: PageMeta; onClose: () => void }) {
  const notes = useNotes();
  const { page } = props;
  const root = [...ancestors(page.id, notes.pages), page][0];
  const nested = root.id !== page.id;
  const set = (space: Space) => {
    if (space === page.space) return props.onClose();
    notes.move(nested ? page.id : root.id, { parentId: null, space });
    notes.toast(space === "team" ? "Für das Team freigegeben" : "Jetzt nur für dich sichtbar");
    props.onClose();
  };
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} placement="bottom-end" width={320}>
      <MenuLabel>Wer hat Zugriff?</MenuLabel>
      <MenuItem icon="lock" label="Privat – nur ich" active={page.space === "private"} onClick={() => set("private")} />
      <MenuItem icon="users" label="Team – alle Kolleginnen und Kollegen" active={page.space === "team"} onClick={() => set("team")} />
      {nested && (
        <div className="nk-menu-foot">
          Unterseiten erben den Zugriff von „{untitled(root)}“. Beim Wechsel wird diese Seite als eigene Seite in den anderen Bereich verschoben.
        </div>
      )}
    </Popover>
  );
}

function Peek(props: { id: string; theme: "light" | "dark"; mobile: boolean }) {
  const notes = useNotes();
  const menu = usePopover();
  const [moving, setMoving] = useState(false);
  const [history, setHistory] = useState(false);
  const page = notes.pages.get(props.id);
  return (
    <>
      <div className="nk-peek-scrim" onClick={() => notes.openPeek(null)} />
      <aside className={`nk-peek${props.mobile ? " is-mobile" : ""}`} aria-label="Vorschau">
        <div className="nk-peek-bar">
          <button type="button" className="nk-icon-btn" aria-label="Schließen" onClick={() => notes.openPeek(null)}>
            <Icon name="doubleLeft" className="nk-flip" />
          </button>
          <button type="button" className="nk-icon-btn" aria-label="Als ganze Seite öffnen" title="Als ganze Seite öffnen" onClick={() => notes.navigate(props.id)}>
            <Icon name="expand" />
          </button>
          <span className="nk-spacer" />
          {page && (
            <>
              <span className="nk-muted nk-edited">Bearbeitet {relativeTime(page.updatedAt)}</span>
              <button type="button" className="nk-icon-btn" aria-label="Seitenmenü" onClick={(e) => menu.open(e.currentTarget)}>
                <Icon name="more" />
              </button>
            </>
          )}
        </div>
        <div className="nk-peek-scroll">
          <PageView key={props.id} id={props.id} theme={props.theme} peek />
        </div>
        {menu.anchor && page && <PageMenu anchor={menu.anchor} page={page} onClose={menu.close} onMove={() => setMoving(true)} onHistory={() => setHistory(true)} />}
        {history && page && <VersionHistory page={page} theme={props.theme} onClose={() => setHistory(false)} />}
        {moving && <MovePicker pageId={props.id} onClose={() => setMoving(false)} />}
      </aside>
    </>
  );
}

function Toasts() {
  const notes = useNotes();
  if (!notes.toasts.length) return null;
  return (
    <div className="nk-toasts" role="status">
      {notes.toasts.map((t) => (
        <div key={t.id} className="nk-toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="nk-toast-action"
              onClick={() => {
                t.action!.run();
                notes.dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
