// Eigene Editor-Blöcke: Hinweis (Callout), Unterseite, Inline-Datenbank, Erwähnung (@)
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, defaultProps } from "@blocknote/core";
import { createReactBlockSpec, createReactInlineContentSpec } from "@blocknote/react";
import { useState } from "react";
import { DatabaseView } from "../database/DatabaseView";
import { useNotesOptional } from "../state";
import { EmojiPicker } from "../ui/EmojiPicker";
import { Icon } from "../ui/Icon";
import { formatDate, untitled } from "../util";

const Callout = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      backgroundColor: { ...defaultProps.backgroundColor, default: "gray" as const },
      textColor: defaultProps.textColor,
      emoji: { default: "💡" },
    },
    content: "inline",
  },
  {
    render: function CalloutRender(props) {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      const editable = props.editor.isEditable;
      return (
        <div className="nk-callout">
          <button
            type="button"
            className="nk-callout-emoji"
            contentEditable={false}
            onClick={(e) => editable && setAnchor(e.currentTarget)}
          >
            {props.block.props.emoji}
          </button>
          <div className="nk-callout-text" ref={props.contentRef} />
          {anchor && (
            <EmojiPicker
              anchor={anchor}
              onClose={() => setAnchor(null)}
              onPick={(emoji) => {
                props.editor.updateBlock(props.block, { props: { emoji: emoji ?? "💡" } });
                setAnchor(null);
              }}
            />
          )}
        </div>
      );
    },
  },
);

const PageLink = createReactBlockSpec(
  { type: "pageLink", propSchema: { pageId: { default: "" } }, content: "none" },
  {
    render: function PageLinkRender(props) {
      const notes = useNotesOptional();
      const page = notes?.pages.get(props.block.props.pageId);
      const gone = !page;
      const archived = page && notes && !notes.isLive(page.id);
      return (
        <button
          type="button"
          className={`nk-pagelink${gone || archived ? " is-muted" : ""}`}
          contentEditable={false}
          onClick={() => page && !archived && notes?.navigate(page.id)}
        >
          <span className="nk-pagelink-icon">
            {page?.icon ?? <Icon name={page?.kind === "database" ? "database" : "page"} size={18} />}
          </span>
          <span className="nk-pagelink-title">{gone ? "Seite nicht verfügbar" : untitled(page)}</span>
          {archived && <span className="nk-muted"> · im Papierkorb</span>}
        </button>
      );
    },
    toExternalHTML: function PageLinkHtml(props) {
      return <a href={`#/p/${props.block.props.pageId}`}>Unterseite</a>;
    },
  },
);

const InlineDatabase = createReactBlockSpec(
  { type: "database", propSchema: { dbId: { default: "" } }, content: "none" },
  {
    render: function InlineDatabaseRender(props) {
      const notes = useNotesOptional();
      const db = notes?.pages.get(props.block.props.dbId);
      if (!notes || !db || !notes.isLive(db.id)) {
        return (
          <div className="nk-pagelink is-muted" contentEditable={false}>
            <Icon name="database" size={18} /> Datenbank nicht verfügbar
          </div>
        );
      }
      return (
        <div
          className="nk-inline-db"
          contentEditable={false}
          // Eingaben in der Tabelle dürfen den Editor nicht steuern
          onKeyDown={(e) => e.stopPropagation()}
          onPaste={(e) => e.stopPropagation()}
          onDragStart={(e) => e.stopPropagation()}
        >
          <DatabaseView dbId={db.id} inline />
        </div>
      );
    },
  },
);

const Mention = createReactInlineContentSpec(
  {
    type: "mention",
    propSchema: { kind: { default: "page" }, refId: { default: "" }, label: { default: "" } },
    content: "none",
  },
  {
    render: function MentionRender(props) {
      const notes = useNotesOptional();
      const { kind, refId, label } = props.inlineContent.props;
      if (kind === "date") return <span className="nk-mention is-date">@{formatDate(refId)}</span>;
      if (kind === "user") {
        const m = notes?.members.find((x) => x.id === refId);
        return <span className="nk-mention is-user">@{m?.name ?? label}</span>;
      }
      const page = notes?.pages.get(refId);
      return (
        <span
          className="nk-mention is-page"
          onClick={() => page && notes?.isLive(page.id) && notes.navigate(page.id)}
          role="link"
        >
          <span className="nk-mention-icon">{page?.icon ?? "📄"}</span>
          <span className="nk-mention-title">{page ? untitled(page) : label || "Seite"}</span>
        </span>
      );
    },
  },
);

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: Callout(),
    pageLink: PageLink(),
    database: InlineDatabase(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: Mention },
});

export type NotesEditor = typeof schema.BlockNoteEditor;
