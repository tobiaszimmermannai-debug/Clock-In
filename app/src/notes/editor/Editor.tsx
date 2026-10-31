// Block-Editor einer Seite (BlockNote): Live-Bearbeitung mit Cursorn (Yjs), Kommentare, Slash-Menü, @-Erwähnungen
import { BlockNoteEditor, filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { CommentsExtension, DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { de } from "@blocknote/core/locales";
import { blocksToYXmlFragment, withCollaboration, yXmlFragmentToBlocks, YjsThreadStore } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import {
  type DefaultReactSuggestionItem,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  ThreadsSidebar,
  useCreateBlockNote,
} from "@blocknote/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { newDatabaseSchema } from "../database/logic";
import { useNotes } from "../state";
import { TEMPLATES } from "../templates";
import type { Blocks, PageMeta } from "../types";
import { Icon } from "../ui/Icon";
import { addDays, COLOR_HEX, formatDate, today, uid, untitled } from "../util";
import { type NotesEditor, schema } from "./blocks";
import { CollabSession } from "./collab";

const dictionary = {
  ...de,
  placeholders: { ...de.placeholders, default: "Tippe „/“ für Befehle, „@“ für Erwähnungen", emptyDocument: "Tippe „/“ für Befehle" },
};

type EditorProps = {
  page: PageMeta;
  theme: "light" | "dark";
  onEditorReady?: (e: NotesEditor | null) => void;
  /** Ziel für die Kommentar-Leiste (rechts neben der Seite) */
  commentsTarget?: HTMLElement | null;
};

export function PageEditor(props: EditorProps) {
  const notes = useNotes();
  const [session, setSession] = useState<CollabSession | null>(null);
  const [error, setError] = useState<string>();
  const { loadDoc, store, onDocSaved, toast } = notes;
  const id = props.page.id;

  useEffect(() => {
    let cancelled = false;
    let s: CollabSession | null = null;
    setSession(null);
    setError(undefined);
    (async () => {
      const doc = await loadDoc(id);
      if (cancelled) return;
      // Ohne sichtbaren Editor: Inhalt für Suche/Export direkt aus dem Yjs-Dokument lesen
      const headless = BlockNoteEditor.create({ schema });
      s = new CollabSession(store, id, {
        toContent: (fragment) => yXmlFragmentToBlocks(headless, fragment as never) as Blocks,
        onSaved: (content) => onDocSaved(id, content),
        onError: (message) => toast(`Speichern fehlgeschlagen: ${message}`),
      });
      s.start(doc);
      // Ohne Live-Stand (neue oder ältere Seite): kurz auf andere offene Editoren warten, dann aus dem Inhalt aufbauen
      if (!doc.ydoc) {
        await s.waitForPeer(600);
        if (cancelled) return;
        if (s.fragment.length === 0 && doc.content.length) {
          blocksToYXmlFragment(headless, doc.content as never, s.fragment);
        }
      }
      if (!cancelled) setSession(s);
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      // Speichert noch offene Änderungen und baut danach ab
      void s?.close();
    };
  }, [id, loadDoc, onDocSaved, store, toast]);

  if (error) return <div className="nk-error">Inhalt konnte nicht geladen werden: {error}</div>;
  if (!session) return <div className="nk-skeleton" aria-label="Lädt" />;
  return <EditorInner key={id} {...props} session={session} />;
}

function linkedIds(blocks: Blocks, out = new Set<string>()): Set<string> {
  for (const b of blocks as { type?: string; props?: Record<string, unknown>; children?: Blocks }[]) {
    if (b.type === "pageLink" && typeof b.props?.pageId === "string") out.add(b.props.pageId);
    if (b.type === "database" && typeof b.props?.dbId === "string") out.add(b.props.dbId);
    if (b.children?.length) linkedIds(b.children, out);
  }
  return out;
}

function EditorInner(props: EditorProps & { session: CollabSession }) {
  const notes = useNotes();
  const { page, session } = props;
  const { me, store, registerEditor, setPresence } = notes;
  const membersRef = useRef(notes.members);
  membersRef.current = notes.members;
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [commentFilter, setCommentFilter] = useState<"open" | "resolved">("open");

  const threadStore = useMemo(
    () => new YjsThreadStore(me.id, session.threads as never, new DefaultThreadStoreAuth(me.id, "editor")),
    [me.id, session],
  );

  const editor = useCreateBlockNote(
    withCollaboration({
      schema,
      dictionary,
      uploadFile: (file: File) => store.upload(file, page.id),
      resolveFileUrl: (url: string) => store.resolveUrl(url),
      tables: { splitCells: true, cellBackgroundColor: true, cellTextColor: true, headers: true },
      extensions: [
        CommentsExtension({
          threadStore,
          resolveUsers: async (ids: string[]) =>
            ids.map((id) => ({ id, username: membersRef.current.find((m) => m.id === id)?.name ?? "Unbekannt", avatarUrl: "" })),
        }),
      ],
      collaboration: {
        fragment: session.fragment,
        user: { name: me.name || "Unbekannt", color: COLOR_HEX[me.color] },
        provider: { awareness: session.awareness },
        showCursorLabels: "activity",
      },
    }),
    [session],
  ) as NotesEditor;

  const { onEditorReady } = props;
  useEffect(() => {
    registerEditor(page.id, {
      appendPageLink: (pageId) => {
        const last = editor.document[editor.document.length - 1];
        editor.insertBlocks([{ type: "pageLink", props: { pageId } }], last, "after");
      },
      replaceContent: (blocks) => editor.replaceBlocks(editor.document, (blocks.length ? blocks : [{ type: "paragraph" }]) as never),
      applyRemote: (ydoc) => session.merge(ydoc),
      content: () => editor.document as Blocks,
    });
    onEditorReady?.(editor);
    setLinked(linkedIds(editor.document as Blocks));
    const off = session.onPeers((peers) => setPresence(page.id, peers));
    return () => {
      off();
      setPresence(page.id, []);
      registerEditor(page.id, null);
      onEditorReady?.(null);
    };
  }, [editor, onEditorReady, page.id, registerEditor, session, setPresence]);

  const slashItems = (query: string): DefaultReactSuggestionItem[] => {
    const own: DefaultReactSuggestionItem[] = [
      {
        title: "Seite",
        subtext: "Unterseite in dieser Seite anlegen",
        aliases: ["page", "unterseite", "seite"],
        group: "Grundlegende Blöcke",
        icon: <Icon name="page" size={18} />,
        onItemClick: () => {
          const id = uid();
          insertOrUpdateBlockForSlashMenu(editor, { type: "pageLink", props: { pageId: id } });
          void notes.createPage({ id, parentId: page.id }).then(() => notes.navigate(id));
        },
      },
      {
        title: "Hinweis",
        subtext: "Hervorgehobener Kasten mit Symbol",
        aliases: ["callout", "hinweis", "info", "box"],
        group: "Grundlegende Blöcke",
        icon: <span className="nk-slash-emoji">💡</span>,
        onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: "callout" }),
      },
      {
        title: "Datenbank – inline",
        subtext: "Tabelle mit Eigenschaften direkt in dieser Seite",
        aliases: ["database", "datenbank", "tabelle inline", "db"],
        group: "Datenbanken",
        icon: <Icon name="table" size={18} />,
        onItemClick: () => {
          const id = uid();
          insertOrUpdateBlockForSlashMenu(editor, { type: "database", props: { dbId: id } });
          void notes.createPage({ id, parentId: page.id, kind: "database", schema: newDatabaseSchema() });
        },
      },
      {
        title: "Datenbank – ganze Seite",
        subtext: "Neue Datenbank als Unterseite",
        aliases: ["database", "datenbank", "full page"],
        group: "Datenbanken",
        icon: <Icon name="database" size={18} />,
        onItemClick: () => {
          const id = uid();
          insertOrUpdateBlockForSlashMenu(editor, { type: "pageLink", props: { pageId: id } });
          void notes.createPage({ id, parentId: page.id, kind: "database", schema: newDatabaseSchema() }).then(() => notes.navigate(id));
        },
      },
      ...TEMPLATES.filter((t) => t.kind === "database").map(
        (t): DefaultReactSuggestionItem => ({
          title: `${t.name}-Datenbank`,
          subtext: t.description,
          aliases: [t.name.toLowerCase(), "vorlage", "template"],
          group: "Datenbanken",
          icon: <span className="nk-slash-emoji">{t.icon}</span>,
          onItemClick: () => {
            const id = uid();
            insertOrUpdateBlockForSlashMenu(editor, { type: "database", props: { dbId: id } });
            void notes.createPage({ id, parentId: page.id, kind: "database", title: t.name, icon: t.icon, schema: t.schema!() });
          },
        }),
      ),
      {
        title: "Erwähnung",
        subtext: "Person, Seite oder Datum erwähnen",
        aliases: ["mention", "erwähnen", "@", "link zu seite"],
        group: "Grundlegende Blöcke",
        icon: <span className="nk-slash-emoji">@</span>,
        onItemClick: () => {
          insertOrUpdateBlockForSlashMenu(editor, { type: "paragraph" });
          editor.insertInlineContent("@");
        },
      },
    ];
    // BlockNote fasst nur direkt aufeinanderfolgende Einträge einer Gruppe zusammen
    const all = [...getDefaultReactSlashMenuItems(editor), ...own];
    const groups = [...new Set(all.map((i) => i.group))];
    const sorted = groups.flatMap((g) => all.filter((i) => i.group === g));
    return filterSuggestionItems(sorted, query);
  };

  const mentionItems = (query: string): DefaultReactSuggestionItem[] => {
    const q = query.toLowerCase();
    const insert = (kind: string, refId: string, label: string) => () =>
      editor.insertInlineContent([{ type: "mention", props: { kind, refId, label } }, " "]);
    const people = notes.members
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map(
        (m): DefaultReactSuggestionItem => ({
          title: m.name,
          group: "Personen",
          icon: <span className={`nk-avatar is-${m.color}`}>{m.name[0]}</span>,
          onItemClick: insert("user", m.id, m.name),
        }),
      );
    const pages = [...notes.pages.values()]
      .filter((p) => notes.isLive(p.id) && p.id !== page.id && p.title.trim() && p.title.toLowerCase().includes(q))
      .slice(0, 6)
      .map(
        (p): DefaultReactSuggestionItem => ({
          title: untitled(p),
          group: "Seiten",
          icon: <span className="nk-slash-emoji">{p.icon ?? "📄"}</span>,
          onItemClick: insert("page", p.id, untitled(p)),
        }),
      );
    const days = [
      { label: "Heute", day: today() },
      { label: "Morgen", day: addDays(today(), 1) },
      { label: "Nächste Woche", day: addDays(today(), 7) },
    ];
    const typed = query.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})?$/);
    if (typed) {
      const y = typed[3] ?? String(new Date().getFullYear());
      days.unshift({ label: query, day: `${y}-${typed[2].padStart(2, "0")}-${typed[1].padStart(2, "0")}` });
    }
    const dates = days
      .filter((d) => !q || d.label.toLowerCase().includes(q) || d === days[0])
      .map(
        (d): DefaultReactSuggestionItem => ({
          title: d.label,
          subtext: formatDate(d.day, { relative: false }),
          group: "Datum",
          icon: <Icon name="calendar" size={18} />,
          onItemClick: insert("date", d.day, d.label),
        }),
      );
    return [...people, ...pages, ...dates];
  };

  const locked = Boolean(page.options.locked);

  // Unterseiten, die im Inhalt nicht verlinkt sind, erscheinen unter dem Text
  const unlinked = notes.childrenOf(page.id).filter((c) => !linked.has(c.id));

  return (
    <>
      <BlockNoteView
        editor={editor}
        theme={props.theme}
        editable={!locked}
        slashMenu={false}
        onChange={() => setLinked(linkedIds(editor.document as Blocks))}
        className="nk-editor"
      >
        <SuggestionMenuController triggerCharacter="/" getItems={async (q) => slashItems(q)} />
        <SuggestionMenuController triggerCharacter="@" getItems={async (q) => mentionItems(q)} />
        {props.commentsTarget &&
          createPortal(
            // BlockNote/Mantine-Stile gelten nur innerhalb dieser Hülle
            <div className="nk-comments bn-container bn-mantine" data-color-scheme={props.theme} data-mantine-color-scheme={props.theme}>
              <div className="nk-comments-head">
                <b>Kommentare</b>
                <span className="nk-spacer" />
                <div className="nk-segmented">
                  {(["open", "resolved"] as const).map((f) => (
                    <button key={f} type="button" aria-pressed={commentFilter === f} onClick={() => setCommentFilter(f)}>
                      {f === "open" ? "Offen" : "Erledigt"}
                    </button>
                  ))}
                </div>
                <button type="button" className="nk-icon-btn" aria-label="Kommentare schließen" onClick={() => notes.setCommentsOpen(false)}>
                  <Icon name="close" />
                </button>
              </div>
              <p className="nk-comments-hint nk-muted">Text markieren und „Kommentieren“ wählen, um einen Kommentar anzulegen.</p>
              <ThreadsSidebar filter={commentFilter} sort="position" />
            </div>,
            props.commentsTarget,
          )}
      </BlockNoteView>
      {unlinked.length > 0 && (
        <div className="nk-subpages">
          {unlinked.map((c) => (
            <button key={c.id} type="button" className="nk-pagelink" onClick={() => notes.navigate(c.id)}>
              <span className="nk-pagelink-icon">{c.icon ?? <Icon name={c.kind === "database" ? "database" : "page"} size={18} />}</span>
              <span className="nk-pagelink-title">{untitled(c)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
