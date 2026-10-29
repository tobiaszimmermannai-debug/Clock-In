// Eine Seite: Titelbild, Symbol, Titel, Eigenschaften (bei Datenbank-Zeilen), Inhalt oder Datenbank
import { BlockNoteEditor } from "@blocknote/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TYPE_ICONS, ValueCell } from "./database/cells";
import { AddPropertyMenu, DatabaseView, PropertyMenu } from "./database/DatabaseView";
import { PageEditor } from "./editor/Editor";
import { type NotesEditor, schema } from "./editor/blocks";
import { useNotes } from "./state";
import type { DbSchema, PageMeta, PropDef } from "./types";
import { COVER_PRESETS, coverCss, EmojiPicker, randomEmoji } from "./ui/EmojiPicker";
import { Icon } from "./ui/Icon";
import { type Anchor, MenuDivider, MenuItem, MenuLabel, Popover, usePopover } from "./ui/Popover";
import { download, formatTimestamp, safeFileName, untitled } from "./util";

export function PageView(props: { id: string; theme: "light" | "dark"; peek?: boolean }) {
  const notes = useNotes();
  const page = notes.pages.get(props.id);
  const [editor, setEditor] = useState<NotesEditor | null>(null);
  const [commentsEl, setCommentsEl] = useState<HTMLElement | null>(null);

  if (!page) {
    return (
      <div className="nk-empty-page">
        <p>{notes.loaded ? "Diese Seite gibt es nicht oder du hast keinen Zugriff." : "Lädt …"}</p>
        {notes.loaded && (
          <button type="button" className="nk-btn" onClick={() => notes.navigate(null)}>
            Zur Startseite
          </button>
        )}
      </div>
    );
  }
  if (!notes.isLive(page.id)) {
    return (
      <div className="nk-empty-page">
        <p>Diese Seite liegt im Papierkorb.</p>
        <div className="nk-row-gap">
          <button type="button" className="nk-btn is-primary" onClick={() => notes.restore(page.id)}>
            Wiederherstellen
          </button>
          <button type="button" className="nk-btn" onClick={() => notes.navigate(null)}>
            Zur Startseite
          </button>
        </div>
      </div>
    );
  }

  const parent = page.parentId ? notes.pages.get(page.parentId) : undefined;
  const isRow = parent?.kind === "database";
  const o = page.options;
  const cls = [
    "nk-page",
    o.fullWidth || page.kind === "database" ? "is-full" : "",
    o.smallText ? "is-small" : "",
    o.font && o.font !== "default" ? `is-${o.font}` : "",
    props.peek ? "is-peek" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const showComments = notes.commentsOpen && page.kind === "page" && !props.peek;
  const body = (
    <div className={cls}>
      {page.cover && <Cover page={page} />}
      <div className={`nk-page-inner${page.cover ? " has-cover" : ""}`}>
        <PageHeader page={page} editor={editor} />
        {isRow && parent?.schema && <PropertyPanel db={parent} row={page} schema={parent.schema} />}
        {page.kind === "database" ? (
          <DatabaseView dbId={page.id} />
        ) : (
          <PageEditor page={page} theme={props.theme} onEditorReady={setEditor} commentsTarget={showComments ? commentsEl : null} />
        )}
      </div>
    </div>
  );
  if (!showComments) return body;
  return (
    <div className="nk-page-row">
      {body}
      <aside className="nk-comments-col" ref={setCommentsEl} aria-label="Kommentare" />
    </div>
  );
}

function PageHeader(props: { page: PageMeta; editor: NotesEditor | null }) {
  const notes = useNotes();
  const { page } = props;
  const emoji = usePopover();
  const cover = usePopover();
  const locked = Boolean(page.options.locked);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState(page.title);

  // Fremde Änderungen übernehmen, solange man nicht selbst tippt
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(page.title);
  }, [page.title]);

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  // Neue, leere Seite: Titel sofort bearbeiten
  useEffect(() => {
    if (!page.title && Date.now() - new Date(page.createdAt).getTime() < 5000) titleRef.current?.focus();
    // Nur beim Öffnen einer anderen Seite
  }, [page.id]);

  return (
    <div className="nk-page-head">
      {page.icon && (
        <button type="button" className="nk-page-icon" disabled={locked} onClick={(e) => emoji.open(e.currentTarget)}>
          {page.icon}
        </button>
      )}
      {!locked && (
        <div className="nk-page-controls">
          {!page.icon && (
            <button type="button" className="nk-btn is-ghost" onClick={() => notes.updatePage(page.id, { icon: randomEmoji() })}>
              <Icon name="smile" /> Symbol hinzufügen
            </button>
          )}
          {!page.cover && (
            <button type="button" className="nk-btn is-ghost" onClick={() => notes.updatePage(page.id, { cover: COVER_PRESETS[Math.floor(Math.random() * 8)].id })}>
              <Icon name="image" /> Titelbild hinzufügen
            </button>
          )}
          {page.cover && (
            <button type="button" className="nk-btn is-ghost" onClick={(e) => cover.open(e.currentTarget)}>
              <Icon name="image" /> Titelbild ändern
            </button>
          )}
        </div>
      )}
      <textarea
        ref={titleRef}
        className="nk-page-title"
        rows={1}
        value={title}
        placeholder="Ohne Titel"
        readOnly={locked}
        onChange={(e) => {
          const v = e.target.value.replace(/\n/g, " ");
          setTitle(v);
          notes.updatePage(page.id, { title: v });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || (e.key === "ArrowDown" && e.currentTarget.selectionStart === title.length)) {
            e.preventDefault();
            const ed = props.editor;
            if (ed) {
              ed.focus();
              const first = ed.document[0];
              if (first) ed.setTextCursorPosition(first, "start");
            }
          }
        }}
      />
      {emoji.anchor && (
        <EmojiPicker
          anchor={emoji.anchor}
          removable
          onClose={emoji.close}
          onPick={(e) => {
            notes.updatePage(page.id, { icon: e });
            emoji.close();
          }}
        />
      )}
      {cover.anchor && <CoverPicker anchor={cover.anchor} page={page} onClose={cover.close} />}
    </div>
  );
}

function Cover(props: { page: PageMeta }) {
  const notes = useNotes();
  const pop = usePopover();
  const { cover } = props.page;
  const [url, setUrl] = useState<string | null>(null);
  const css = cover ? coverCss(cover) : undefined;

  useEffect(() => {
    if (!cover || css) return;
    let cancelled = false;
    notes.store
      .resolveUrl(cover)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setUrl(null));
    return () => {
      cancelled = true;
    };
  }, [cover, css, notes.store]);

  return (
    <div className="nk-cover" style={css ? { background: css } : url ? { backgroundImage: `url("${url}")` } : undefined}>
      {!props.page.options.locked && (
        <div className="nk-cover-actions">
          <button type="button" className="nk-btn is-overlay" onClick={(e) => pop.open(e.currentTarget)}>
            Titelbild ändern
          </button>
          <button type="button" className="nk-btn is-overlay" onClick={() => notes.updatePage(props.page.id, { cover: null })}>
            Entfernen
          </button>
        </div>
      )}
      {pop.anchor && <CoverPicker anchor={pop.anchor} page={props.page} onClose={pop.close} />}
    </div>
  );
}

function CoverPicker(props: { anchor: Anchor; page: PageMeta; onClose: () => void }) {
  const notes = useNotes();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (cover: string | null) => {
    notes.updatePage(props.page.id, { cover });
    props.onClose();
  };
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} width={360} placement="bottom-end">
      <MenuLabel>Farbverläufe und Farben</MenuLabel>
      <div className="nk-cover-grid">
        {COVER_PRESETS.map((c) => (
          <button key={c.id} type="button" className="nk-cover-swatch" style={{ background: c.css }} onClick={() => set(c.id)} aria-label={c.id} />
        ))}
      </div>
      <MenuDivider />
      <MenuLabel>Bild hochladen oder verlinken</MenuLabel>
      <div className="nk-pad nk-row-gap">
        <input
          className="nk-input"
          placeholder="https://… Bildadresse"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && /^https?:\/\//.test(link) && set(link)}
        />
        <label className={`nk-btn${busy ? " is-busy" : ""}`}>
          <Icon name="upload" /> Hochladen
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setBusy(true);
              try {
                set(await notes.store.upload(file));
              } catch (err) {
                notes.toast(`Hochladen fehlgeschlagen: ${(err as Error).message}`);
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      </div>
    </Popover>
  );
}

/** Eigenschaften einer Datenbank-Zeile oberhalb des Inhalts */
function PropertyPanel(props: { db: PageMeta; row: PageMeta; schema: DbSchema }) {
  const notes = useNotes();
  const head = usePopover();
  const add = usePopover();
  const [menuProp, setMenuProp] = useState<PropDef | null>(null);
  const { updatePage } = notes;
  const updateSchema = useCallback(
    (fn: (s: DbSchema) => DbSchema) => {
      const cur = notes.pages.get(props.db.id)?.schema;
      if (cur) updatePage(props.db.id, { schema: fn(cur) });
    },
    [notes.pages, props.db.id, updatePage],
  );
  const locked = Boolean(props.db.options.locked);
  return (
    <div className="nk-props">
      {props.schema.properties
        .filter((p) => p.type !== "title")
        .map((p) => (
          <div key={p.id} className="nk-prop-row">
            <button
              type="button"
              className="nk-prop-name"
              onClick={(e) => {
                if (locked) return;
                setMenuProp(p);
                head.open(e.currentTarget);
              }}
            >
              <Icon name={TYPE_ICONS[p.type]} className="nk-faint" />
              <span>{p.name}</span>
            </button>
            <ValueCell db={props.db} row={props.row} prop={p} placeholder="Leer" className="is-prop" />
          </div>
        ))}
      {!locked && (
        <button type="button" className="nk-btn is-ghost nk-prop-add" onClick={(e) => add.open(e.currentTarget)}>
          <Icon name="plus" /> Eigenschaft hinzufügen
        </button>
      )}
      {head.anchor && menuProp && <PropertyMenu anchor={head.anchor} onClose={head.close} db={props.db} prop={menuProp} updateSchema={updateSchema} />}
      {add.anchor && (
        <AddPropertyMenu
          anchor={add.anchor}
          onClose={add.close}
          updateSchema={updateSchema}
          onNeedsSetup={(prop) => {
            const anchor = add.anchor;
            setMenuProp(prop);
            if (anchor) setTimeout(() => head.open(anchor));
          }}
        />
      )}
    </div>
  );
}

/** "…"-Menü einer Seite: Darstellung, Favorit, Duplizieren, Verschieben, Export, Papierkorb */
export function PageMenu(props: { anchor: Anchor; page: PageMeta; onClose: () => void; onMove: () => void; onHistory?: () => void }) {
  const notes = useNotes();
  const { page } = props;
  const o = page.options;
  const setOption = (patch: Partial<typeof o>) => notes.updatePage(page.id, { options: { ...o, ...patch } }, { delay: 0 });
  const fav = notes.favorites.includes(page.id);
  const editor = useRef<HTMLInputElement>(null);
  const author = notes.members.find((m) => m.id === page.updatedBy)?.name;

  const exportMarkdown = async () => {
    const blocks = await notes.loadContent(page.id);
    const ed = BlockNoteEditor.create({ schema, initialContent: blocks.length ? (blocks as never) : undefined });
    const md = `# ${untitled(page)}\n\n${await ed.blocksToMarkdownLossy()}`;
    download(`${safeFileName(untitled(page))}.md`, md);
    props.onClose();
  };

  const importMarkdown = async (file: File) => {
    const ed = BlockNoteEditor.create({ schema });
    const blocks = await ed.tryParseMarkdownToBlocks(await file.text());
    const title = file.name.replace(/\.(md|markdown|txt)$/i, "");
    const created = await notes.createPage({ parentId: page.kind === "page" ? page.id : page.parentId, space: page.space, title, content: blocks as never, linkInParent: page.kind === "page" });
    notes.navigate(created.id);
    props.onClose();
  };

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} placement="bottom-end" width={270}>
      <div className="nk-font-row">
        {(["default", "serif", "mono"] as const).map((f) => (
          <button key={f} type="button" className={`nk-font-btn is-${f}${(o.font ?? "default") === f ? " is-active" : ""}`} onClick={() => setOption({ font: f })}>
            <span>Ag</span>
            <small>{{ default: "Standard", serif: "Serif", mono: "Mono" }[f]}</small>
          </button>
        ))}
      </div>
      <MenuDivider />
      <MenuItem icon="font" label="Kleine Schrift" active={Boolean(o.smallText)} onClick={() => setOption({ smallText: !o.smallText })} />
      {page.kind === "page" && <MenuItem icon="width" label="Volle Breite" active={Boolean(o.fullWidth)} onClick={() => setOption({ fullWidth: !o.fullWidth })} />}
      <MenuItem icon={o.locked ? "unlock" : "lock"} label={o.locked ? "Seite entsperren" : "Seite sperren"} onClick={() => setOption({ locked: !o.locked })} />
      <MenuDivider />
      <MenuItem icon={fav ? "starFilled" : "star"} label={fav ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"} onClick={() => (notes.toggleFavorite(page.id), props.onClose())} />
      <MenuItem
        icon="link"
        label="Link kopieren"
        onClick={() => {
          const url = `${location.origin}${location.pathname}#/p/${page.id}`;
          void navigator.clipboard?.writeText(url).then(() => notes.toast("Link kopiert"));
          props.onClose();
        }}
      />
      <MenuItem icon="duplicate" label="Duplizieren" onClick={() => (void notes.duplicate(page.id).then((c) => c && notes.navigate(c.id)), props.onClose())} />
      <MenuItem icon="move" label="Verschieben nach …" onClick={() => (props.onClose(), props.onMove())} />
      {page.kind === "page" && props.onHistory && <MenuItem icon="history" label="Versionsverlauf" onClick={() => (props.onClose(), props.onHistory!())} />}
      <MenuDivider />
      {page.kind === "page" && <MenuItem icon="download" label="Als Markdown exportieren" onClick={() => void exportMarkdown()} />}
      <MenuItem icon="upload" label="Markdown importieren" onClick={() => editor.current?.click()} />
      <input ref={editor} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => e.target.files?.[0] && void importMarkdown(e.target.files[0])} />
      <MenuDivider />
      <MenuItem icon="trash" label="In den Papierkorb" danger onClick={() => (notes.archive(page.id), props.onClose())} />
      <div className="nk-menu-foot">
        Zuletzt bearbeitet{author ? ` von ${author}` : ""}
        <br />
        {formatTimestamp(page.updatedAt)}
      </div>
    </Popover>
  );
}

/** Ziel für "Verschieben nach …" wählen */
export function MovePicker(props: { pageId: string; onClose: () => void }) {
  const notes = useNotes();
  const [query, setQuery] = useState("");
  const page = notes.pages.get(props.pageId);
  if (!page) return null;
  const q = query.toLowerCase();
  const blocked = new Set([page.id]);
  for (const p of notes.pages.values()) {
    let cur: PageMeta | undefined = p;
    while (cur?.parentId) {
      if (cur.parentId === page.id) blocked.add(p.id);
      cur = notes.pages.get(cur.parentId);
    }
  }
  const targets = [...notes.pages.values()]
    .filter((p) => !blocked.has(p.id) && notes.isLive(p.id) && notes.pages.get(p.parentId ?? "")?.kind !== "database" && untitled(p).toLowerCase().includes(q))
    .slice(0, 30);
  const go = (parentId: string | null, space?: "private" | "team") => {
    notes.move(page.id, { parentId, space });
    notes.toast(`Verschoben nach ${parentId ? untitled(notes.pages.get(parentId)) : space === "team" ? "Team" : "Privat"}`);
    props.onClose();
  };
  return (
    <Popover anchor={{ x: window.innerWidth / 2 - 160, y: 120 }} onClose={props.onClose} width={320}>
      <div className="nk-pad">
        <input autoFocus className="nk-input" placeholder="Seite suchen …" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <MenuLabel>Bereich</MenuLabel>
      <MenuItem icon="users" label="Team" onClick={() => go(null, "team")} />
      <MenuItem icon="lock" label="Privat" onClick={() => go(null, "private")} />
      <MenuLabel>Seiten</MenuLabel>
      <div className="nk-menu-scroll">
        {targets.map((t) => (
          <MenuItem
            key={t.id}
            icon={<span>{t.icon ?? <Icon name={t.kind === "database" ? "database" : "page"} />}</span>}
            label={untitled(t)}
            hint={t.space === "team" ? "Team" : "Privat"}
            onClick={() => go(t.id)}
          />
        ))}
      </div>
    </Popover>
  );
}
