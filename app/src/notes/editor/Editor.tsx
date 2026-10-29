// Block-Editor einer Seite (BlockNote): Slash-Menü mit eigenen Blöcken, @-Erwähnungen, Live-Updates
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { de } from "@blocknote/core/locales";
import { BlockNoteView } from "@blocknote/mantine";
import { type DefaultReactSuggestionItem, getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";
import { newDatabaseSchema } from "../database/logic";
import { useNotes } from "../state";
import { TEMPLATES } from "../templates";
import type { Blocks, PageMeta } from "../types";
import { Icon } from "../ui/Icon";
import { addDays, formatDate, today, uid, untitled } from "../util";
import { type NotesEditor, schema } from "./blocks";

const dictionary = {
  ...de,
  placeholders: { ...de.placeholders, default: "Tippe „/“ für Befehle, „@“ für Erwähnungen", emptyDocument: "Tippe „/“ für Befehle" },
};

export function PageEditor(props: { page: PageMeta; theme: "light" | "dark"; onEditorReady?: (e: NotesEditor | null) => void }) {
  const notes = useNotes();
  const [initial, setInitial] = useState<Blocks | null>(null);
  const [error, setError] = useState<string>();
  const { loadContent } = notes;
  const id = props.page.id;

  useEffect(() => {
    let cancelled = false;
    setInitial(null);
    loadContent(id)
      .then((b) => !cancelled && setInitial(b))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, loadContent]);

  if (error) return <div className="nk-error">Inhalt konnte nicht geladen werden: {error}</div>;
  if (!initial) return <div className="nk-skeleton" aria-label="Lädt" />;
  return <EditorInner key={id} page={props.page} initial={initial} theme={props.theme} onEditorReady={props.onEditorReady} />;
}

function EditorInner(props: { page: PageMeta; initial: Blocks; theme: "light" | "dark"; onEditorReady?: (e: NotesEditor | null) => void }) {
  const notes = useNotes();
  const { page } = props;
  const applyingRemote = useRef(false);

  const editor = useCreateBlockNote(
    {
      schema,
      initialContent: props.initial.length ? (props.initial as never) : undefined,
      dictionary,
      uploadFile: (file: File) => notes.store.upload(file),
      resolveFileUrl: (url: string) => notes.store.resolveUrl(url),
      tables: { splitCells: true, cellBackgroundColor: true, cellTextColor: true, headers: true },
    },
    [page.id],
  ) as NotesEditor;

  const { registerEditor, saveContent } = notes;
  const { onEditorReady } = props;
  useEffect(() => {
    registerEditor(page.id, {
      appendPageLink: (pageId) => {
        const last = editor.document[editor.document.length - 1];
        editor.insertBlocks([{ type: "pageLink", props: { pageId } }], last, "after");
      },
      replaceContent: (blocks) => {
        applyingRemote.current = true;
        try {
          editor.replaceBlocks(editor.document, (blocks.length ? blocks : [{ type: "paragraph" }]) as never);
        } finally {
          applyingRemote.current = false;
        }
      },
      isBusy: () => editor.isFocused(),
    });
    onEditorReady?.(editor);
    return () => {
      registerEditor(page.id, null);
      onEditorReady?.(null);
    };
  }, [editor, onEditorReady, page.id, registerEditor]);

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

  return (
    <BlockNoteView
      editor={editor}
      theme={props.theme}
      editable={!locked}
      slashMenu={false}
      onChange={() => {
        if (!applyingRemote.current) saveContent(page.id, editor.document as Blocks);
      }}
      className="nk-editor"
    >
      <SuggestionMenuController triggerCharacter="/" getItems={async (q) => slashItems(q)} />
      <SuggestionMenuController triggerCharacter="@" getItems={async (q) => mentionItems(q)} />
    </BlockNoteView>
  );
}
