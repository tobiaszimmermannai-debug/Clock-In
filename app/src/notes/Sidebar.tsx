// Seitenleiste: Suche, Startseite, Favoriten, Team, Privat, Vorlagen, Papierkorb – mit Ziehen & Ablegen
import { type DragEvent, useState } from "react";
import { MovePicker } from "./PageView";
import { useNotes } from "./state";
import { TEMPLATES } from "./templates";
import type { PageMeta, Space } from "./types";
import { Icon } from "./ui/Icon";
import { MenuDivider, MenuItem, Modal, Popover, usePopover } from "./ui/Popover";
import { between, initials, relativeTime, storageGet, storageSet, untitled } from "./util";

type DropZone = { id: string; zone: "before" | "inside" | "after" } | null;

export function Sidebar(props: {
  title: string;
  onSearch: () => void;
  onClose?: () => void;
  onCollapse: () => void;
  onLogout?: () => void;
  theme: "light" | "dark" | "system";
  onTheme: (t: "light" | "dark" | "system") => void;
}) {
  const notes = useNotes();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(storageGet<string[]>("aun-expanded", [])));
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropZone>(null);
  const [collapsedSections, setCollapsedSections] = useState<string[]>(() => storageGet<string[]>("aun-sections", []));
  const [templatesFor, setTemplatesFor] = useState<Space | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const trash = usePopover();
  const account = usePopover();

  const toggle = (id: string, open?: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      storageSet("aun-expanded", [...next]);
      return next;
    });

  const toggleSection = (key: string) =>
    setCollapsedSections((s) => {
      const next = s.includes(key) ? s.filter((x) => x !== key) : [...s, key];
      storageSet("aun-sections", next);
      return next;
    });

  const open = (id: string) => {
    notes.navigate(id);
    props.onClose?.();
  };

  const newPage = async (space: Space, parentId: string | null = null) => {
    const page = await notes.createPage({ space, parentId, linkInParent: Boolean(parentId) });
    if (parentId) toggle(parentId, true);
    open(page.id);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const target = drop;
    const id = drag;
    setDrag(null);
    setDrop(null);
    if (!target || !id || target.id === id) return;
    const t = notes.pages.get(target.id);
    if (!t) return;
    if (target.zone === "inside") {
      notes.move(id, { parentId: t.id });
      toggle(t.id, true);
      return;
    }
    const siblings = notes.childrenOf(t.parentId, t.space).filter((s) => s.id !== id && notes.pages.get(s.parentId ?? "")?.kind !== "database");
    const i = siblings.findIndex((s) => s.id === t.id);
    const position =
      target.zone === "before" ? between(siblings[i - 1]?.position, t.position) : between(t.position, siblings[i + 1]?.position);
    notes.move(id, { parentId: t.parentId, space: t.space, position });
  };

  const sectionDrop = (space: Space) => (e: DragEvent) => {
    e.preventDefault();
    if (drag) notes.move(drag, { parentId: null, space });
    setDrag(null);
    setDrop(null);
  };

  const item = (page: PageMeta, depth: number) => (
    <TreeItem
      key={page.id}
      page={page}
      depth={depth}
      expanded={expanded}
      toggle={toggle}
      open={open}
      onNewChild={(p) => void newPage(p.space, p.id)}
      onMove={setMoving}
      drag={drag}
      setDrag={setDrag}
      drop={drop}
      setDrop={setDrop}
      onDrop={onDrop}
    />
  );

  const favs = notes.favorites.map((id) => notes.pages.get(id)).filter((p): p is PageMeta => Boolean(p && notes.isLive(p.id)));
  const team = notes.childrenOf(null, "team");
  const mine = notes.childrenOf(null, "private").filter((p) => p.ownerId === notes.me.id);

  const section = (key: string, label: string, pages: PageMeta[], space?: Space) => (
    <div className="nk-side-section" onDragOver={(e) => space && drag && e.preventDefault()} onDrop={space ? sectionDrop(space) : undefined}>
      <div className="nk-side-heading">
        <button type="button" className="nk-side-heading-btn" onClick={() => toggleSection(key)}>
          {label}
          <Icon name={collapsedSections.includes(key) ? "chevronRight" : "chevronDown"} size={12} />
        </button>
        {space && (
          <span className="nk-side-heading-actions">
            <button type="button" className="nk-icon-btn" aria-label="Vorlage" title="Aus Vorlage" onClick={() => setTemplatesFor(space)}>
              <Icon name="template" size={14} />
            </button>
            <button type="button" className="nk-icon-btn" aria-label={`Neue Seite in ${label}`} title="Neue Seite" onClick={() => void newPage(space)}>
              <Icon name="plus" size={14} />
            </button>
          </span>
        )}
      </div>
      {!collapsedSections.includes(key) && (
        <div role="tree">
          {pages.map((p) => item(p, 0))}
          {!pages.length && space && (
            <button type="button" className="nk-side-item is-hint" onClick={() => void newPage(space)}>
              <Icon name="plus" size={14} /> {space === "team" ? "Erste Team-Seite anlegen" : "Seite hinzufügen"}
            </button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <aside className="nk-sidebar">
      <div className="nk-side-top">
        <button type="button" className="nk-workspace" onClick={(e) => account.open(e.currentTarget)}>
          <span className={`nk-avatar is-square is-${notes.me.color}`}>{props.title[0]}</span>
          <span className="nk-workspace-name">{props.title}</span>
          <Icon name="chevronDown" size={12} className="nk-faint" />
        </button>
        <button type="button" className="nk-icon-btn" aria-label="Seitenleiste einklappen" title="Einklappen (Strg+\)" onClick={props.onCollapse}>
          <Icon name="doubleLeft" />
        </button>
      </div>

      <nav className="nk-side-nav">
        <button type="button" className="nk-side-item" onClick={props.onSearch}>
          <Icon name="search" /> Suchen <kbd className="nk-kbd">Strg K</kbd>
        </button>
        <button
          type="button"
          className={`nk-side-item${notes.current === null ? " is-active" : ""}`}
          onClick={() => {
            notes.navigate(null);
            props.onClose?.();
          }}
        >
          <Icon name="home" /> Startseite
        </button>
        <button type="button" className="nk-side-item" onClick={() => void newPage("private")}>
          <Icon name="edit" /> Neue Seite
        </button>
      </nav>

      <div className="nk-side-scroll">
        {favs.length > 0 && section("favorites", "Favoriten", favs)}
        {section("team", "Team", team, "team")}
        {section("private", "Privat", mine, "private")}
      </div>

      <div className="nk-side-foot">
        <button type="button" className="nk-side-item" onClick={() => setTemplatesFor("private")}>
          <Icon name="template" /> Vorlagen
        </button>
        <button type="button" className="nk-side-item" onClick={(e) => trash.open(e.currentTarget)}>
          <Icon name="trash" /> Papierkorb
        </button>
      </div>

      {account.anchor && (
        <Popover anchor={account.anchor} onClose={account.close} width={260}>
          <div className="nk-account">
            <span className={`nk-avatar is-${notes.me.color}`}>{initials(notes.me.name)}</span>
            <div>
              <b>{notes.me.name}</b>
              <div className="nk-muted">{notes.store.kind === "local" ? "Lokal auf diesem Gerät" : "Mit Clock-In verbunden"}</div>
            </div>
          </div>
          <MenuDivider />
          {(["system", "light", "dark"] as const).map((t) => (
            <MenuItem
              key={t}
              icon={t === "dark" ? "moon" : "sun"}
              label={{ system: "Design wie System", light: "Hell", dark: "Dunkel" }[t]}
              active={props.theme === t}
              onClick={() => props.onTheme(t)}
            />
          ))}
          {props.onLogout && (
            <>
              <MenuDivider />
              <MenuItem icon="logout" label="Abmelden" onClick={props.onLogout} />
            </>
          )}
        </Popover>
      )}

      {trash.anchor && <TrashPanel anchor={trash.anchor} onClose={trash.close} />}
      {templatesFor && <TemplatePicker space={templatesFor} onClose={() => setTemplatesFor(null)} onCreated={open} />}
      {moving && <MovePicker pageId={moving} onClose={() => setMoving(null)} />}
    </aside>
  );
}

function TreeItem(props: {
  page: PageMeta;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string, open?: boolean) => void;
  open: (id: string) => void;
  onNewChild: (p: PageMeta) => void;
  onMove: (id: string) => void;
  drag: string | null;
  setDrag: (id: string | null) => void;
  drop: DropZone;
  setDrop: (z: DropZone) => void;
  onDrop: (e: DragEvent) => void;
}) {
  const notes = useNotes();
  const menu = usePopover();
  const [renaming, setRenaming] = useState(false);
  const { page, depth } = props;
  // Datenbank-Zeilen erscheinen nicht im Baum (wie im Original: nur in der Datenbank)
  const kids = page.kind === "database" ? [] : notes.childrenOf(page.id);
  const isOpen = props.expanded.has(page.id);
  const active = notes.current === page.id;
  const zone = props.drop?.id === page.id ? props.drop.zone : null;

  return (
    <div role="treeitem" aria-expanded={kids.length ? isOpen : undefined}>
      <div
        className={`nk-side-item is-page${active ? " is-active" : ""}${zone ? ` is-drop-${zone}` : ""}${props.drag === page.id ? " is-dragging" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", page.id);
          props.setDrag(page.id);
        }}
        onDragEnd={() => (props.setDrag(null), props.setDrop(null))}
        onDragOver={(e) => {
          if (!props.drag || props.drag === page.id) return;
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          const y = e.clientY - r.top;
          const z = y < r.height * 0.25 ? "before" : y > r.height * 0.75 ? "after" : page.kind === "database" ? "after" : "inside";
          if (props.drop?.id !== page.id || props.drop.zone !== z) props.setDrop({ id: page.id, zone: z });
        }}
        onDrop={(e) => {
          e.stopPropagation();
          props.onDrop(e);
        }}
        onClick={() => props.open(page.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          menu.open({ x: e.clientX, y: e.clientY });
        }}
      >
        <button
          type="button"
          className="nk-tree-toggle"
          aria-label={isOpen ? "Zuklappen" : "Aufklappen"}
          onClick={(e) => {
            e.stopPropagation();
            props.toggle(page.id);
          }}
        >
          <span className="nk-tree-icon">{page.icon ?? <Icon name={page.kind === "database" ? "database" : "page"} />}</span>
          <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={12} className="nk-tree-chevron" />
        </button>
        {renaming ? (
          <input
            autoFocus
            className="nk-inline-input"
            defaultValue={page.title}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => (notes.updatePage(page.id, { title: e.target.value }), setRenaming(false))}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="nk-side-label">{untitled(page)}</span>
        )}
        <span className="nk-side-actions">
          <button
            type="button"
            className="nk-icon-btn"
            aria-label="Seitenmenü"
            onClick={(e) => {
              e.stopPropagation();
              menu.open(e.currentTarget);
            }}
          >
            <Icon name="more" size={14} />
          </button>
          {page.kind === "page" && (
            <button
              type="button"
              className="nk-icon-btn"
              aria-label="Unterseite hinzufügen"
              onClick={(e) => {
                e.stopPropagation();
                props.onNewChild(page);
              }}
            >
              <Icon name="plus" size={14} />
            </button>
          )}
        </span>
      </div>
      {isOpen && (
        <div role="group">
          {kids.map((k) => (
            <TreeItem key={k.id} {...props} page={k} depth={depth + 1} />
          ))}
          {!kids.length && (
            <div className="nk-side-empty" style={{ paddingLeft: 30 + depth * 14 }}>
              {page.kind === "database" ? "Einträge siehst du in der Datenbank" : "Keine Unterseiten"}
            </div>
          )}
        </div>
      )}
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} width={240}>
          <MenuItem
            icon={notes.favorites.includes(page.id) ? "starFilled" : "star"}
            label={notes.favorites.includes(page.id) ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}
            onClick={() => (notes.toggleFavorite(page.id), menu.close())}
          />
          <MenuItem icon="edit" label="Umbenennen" onClick={() => (setRenaming(true), menu.close())} />
          <MenuItem icon="duplicate" label="Duplizieren" onClick={() => (void notes.duplicate(page.id), menu.close())} />
          <MenuItem icon="move" label="Verschieben nach …" onClick={() => (props.onMove(page.id), menu.close())} />
          <MenuItem
            icon="link"
            label="Link kopieren"
            onClick={() => {
              void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#/p/${page.id}`).then(() => notes.toast("Link kopiert"));
              menu.close();
            }}
          />
          <MenuDivider />
          <MenuItem icon="trash" label="In den Papierkorb" danger onClick={() => (notes.archive(page.id), menu.close())} />
          <div className="nk-menu-foot">Zuletzt bearbeitet {relativeTime(page.updatedAt)}</div>
        </Popover>
      )}
    </div>
  );
}

function TrashPanel(props: { anchor: HTMLElement | DOMRect | { x: number; y: number }; onClose: () => void }) {
  const notes = useNotes();
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const items = [...notes.pages.values()]
    .filter((p) => p.archivedAt && (p.space === "team" || p.ownerId === notes.me.id) && untitled(p).toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={380} placement="right-start">
      <div className="nk-pad">
        <input autoFocus className="nk-input" placeholder="Im Papierkorb suchen …" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="nk-menu-scroll is-tall">
        {items.map((p) => {
          const parent = p.parentId ? notes.pages.get(p.parentId) : undefined;
          return (
            <div key={p.id} className="nk-trash-row">
              <button type="button" className="nk-trash-main" onClick={() => (notes.navigate(p.id), props.onClose())}>
                <span>{p.icon ?? <Icon name={p.kind === "database" ? "database" : "page"} />}</span>
                <span className="nk-trash-text">
                  <span>{untitled(p)}</span>
                  <small className="nk-muted">
                    {parent ? `in ${untitled(parent)} · ` : ""}
                    {p.space === "team" ? "Team" : "Privat"} · gelöscht {relativeTime(p.archivedAt!)}
                  </small>
                </span>
              </button>
              <button type="button" className="nk-icon-btn" aria-label="Wiederherstellen" title="Wiederherstellen" onClick={() => notes.restore(p.id)}>
                <Icon name="restore" />
              </button>
              {confirm === p.id ? (
                <button type="button" className="nk-btn is-danger" onClick={() => (void notes.destroy(p.id), setConfirm(null))}>
                  Endgültig löschen
                </button>
              ) : (
                <button type="button" className="nk-icon-btn" aria-label="Endgültig löschen" title="Endgültig löschen" onClick={() => setConfirm(p.id)}>
                  <Icon name="trash" />
                </button>
              )}
            </div>
          );
        })}
        {!items.length && <div className="nk-empty-hint">Der Papierkorb ist leer.</div>}
      </div>
    </Popover>
  );
}

export function TemplatePicker(props: { space: Space; onClose: () => void; onCreated: (id: string) => void; parentId?: string }) {
  const notes = useNotes();
  const [space, setSpace] = useState<Space>(props.space);
  const create = async (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    const page = await notes.createPage({
      space,
      parentId: props.parentId,
      kind: t.kind,
      title: t.name,
      icon: t.icon,
      content: t.content(),
      schema: t.schema?.() ?? null,
      linkInParent: Boolean(props.parentId),
    });
    props.onClose();
    props.onCreated(page.id);
  };
  return (
    <Modal onClose={props.onClose} label="Vorlagen" className="nk-templates">
      <div className="nk-modal-head">
        <b>Vorlagen</b>
        <span className="nk-spacer" />
        {!props.parentId && (
          <div className="nk-segmented">
            {(["team", "private"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={space === s} onClick={() => setSpace(s)}>
                {s === "team" ? "Team" : "Privat"}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="nk-icon-btn" aria-label="Schließen" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="nk-template-grid">
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" className="nk-template" onClick={() => void create(t.id)}>
            <span className="nk-template-icon">{t.icon}</span>
            <b>{t.name}</b>
            <span className="nk-muted">{t.description}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
