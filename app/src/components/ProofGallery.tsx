// Fotonachweise der Aufgaben ansehen (Studioleitung: eigene Leute, Admin: alle) – mit Prüfstand aus Telegram
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "react";
import { berlinDate, berlinTime, fmtDay } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { Notice, Pill, Section } from "./ui";

type Person = { auth_user_id: string | null; first_name: string; last_name: string };
type Row = { id: string; title: string | null; props: Record<string, unknown> };
type Item = { id: string; title: string; at: string; by: string; path: string; status: string | null; url?: string };

const PREFIX = "sb-notes://";

function toItem(r: Row): Item | null {
  const p = r.props.__proof as { url?: string; at?: string; by?: string } | undefined;
  if (!p?.url || !p.at || !p.url.startsWith(PREFIX)) return null;
  const check = r.props.__proofCheck as { status?: string } | undefined;
  return { id: r.id, title: r.title || "Ohne Titel", at: p.at, by: p.by ?? "", path: p.url.slice(PREFIX.length), status: check?.status ?? null };
}

/** people: wessen Fotos gezeigt werden (Studioleitung: nur die eigenen Leute) */
export function ProofGallery(props: { db: SupabaseClient; people: Person[]; days?: number; title?: string; limit?: number }) {
  const days = props.days ?? 14;
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string>();
  const names = useMemo(
    () => new Map(props.people.filter((p) => p.auth_user_id).map((p) => [p.auth_user_id!, `${p.first_name} ${p.last_name}`])),
    [props.people],
  );
  const key = [...names.keys()].sort().join(",");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const { data, error } = await props.db
        .from("note_pages")
        .select("id, title, props")
        .not("props->__proof", "is", null)
        .gte("updated_at", since)
        .order("updated_at", { ascending: false })
        .limit(300);
      if (!alive) return;
      if (error) return setError(`Fotonachweise konnten nicht geladen werden: ${dbMessage(error)}`);
      const ids = new Set(key.split(",").filter(Boolean));
      const list = ((data ?? []) as Row[]).map(toItem).filter((x): x is Item => !!x && ids.has(x.by) && x.at >= since)
        .sort((a, b) => b.at.localeCompare(a.at)).slice(0, props.limit ?? 60);
      if (list.length) {
        const signed = await props.db.storage.from("notes").createSignedUrls(list.map((x) => x.path), 3600);
        const urls = new Map((signed.data ?? []).map((s) => [s.path, s.signedUrl]));
        list.forEach((x) => (x.url = urls.get(x.path) ?? undefined));
      }
      if (alive) setItems(list);
    })();
    return () => {
      alive = false;
    };
  }, [props.db, key, days, props.limit]);

  return (
    <Section title={props.title ?? `📷 Fotonachweise (${days} Tage)`} aside={items ? <span>{items.length}</span> : undefined}
      footer="Foto antippen = groß ansehen. ✅ freigegeben · ❌ abgelehnt (kommt am nächsten Tag wieder) · ⏳ noch nicht geprüft.">
      {error && <Notice tone="error">{error}</Notice>}
      {!error && items === null && <p className="list-empty">Lädt …</p>}
      {items?.length === 0 && <p className="list-empty">Keine Fotonachweise in diesem Zeitraum.</p>}
      {!!items?.length && (
        <div className="proof-grid">
          {items.map((x) => (
            <a key={`${x.id}-${x.at}`} className="proof-card" href={x.url} target="_blank" rel="noopener noreferrer">
              {x.url ? <img src={x.url} alt={x.title} loading="lazy" /> : <span className="proof-missing">Foto nicht verfügbar</span>}
              <span className="proof-meta">
                <b>{x.title}</b>
                <small>{names.get(x.by) ?? "?"} · {fmtDay(berlinDate(x.at))} {berlinTime(x.at)}</small>
                <Pill tone={x.status === "approved" ? "ok" : x.status === "rejected" ? "bad" : "warn"}>
                  {x.status === "approved" ? "✅ freigegeben" : x.status === "rejected" ? "❌ abgelehnt" : "⏳ offen"}
                </Pill>
              </span>
            </a>
          ))}
        </div>
      )}
    </Section>
  );
}
