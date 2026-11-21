// Mitteilungen (Glocke): Tausch, Dienstplan-Änderungen, Entscheidungen zu Buchungen, Überstunden und Urlaub
import { useEffect, useState } from "react";
import { PushHint } from "../components/PushSettings";
import { Empty, Notice, PageHeader, Row, Section, LeadingIcon, type IconName } from "../components/ui";
import { berlinDate, berlinTime, fmtDay } from "../lib/dates";
import { dbMessage } from "../lib/errors";
import { portalDb } from "../lib/supabase";
import { VacationApprovals } from "../components/VacationApprovals";
import { SwapOfferList } from "./SwapOffers";

type Item = { id: string; kind: string; title: string; body: string | null; created_at: string; read_at: string | null };

const ICON: Record<string, IconName> = { swap: "swap", plan: "calendar", booking: "clock", overtime: "clock", vacation: "sun" };

/** Anzahl ungelesener Mitteilungen (0 bei Fehler oder älterer Datenbank) */
export async function unreadCount(): Promise<number> {
  const { count, error } = await portalDb.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
  return error ? 0 : (count ?? 0);
}

export function Inbox(props: { meId: string; isLead: boolean; onRead: () => void; onOpenPlan: () => void }) {
  const [items, setItems] = useState<Item[]>();
  const [error, setError] = useState<string>();
  const { onRead } = props;

  useEffect(() => {
    void (async () => {
      const { data, error } = await portalDb.from("notifications").select("*").order("created_at", { ascending: false }).limit(50);
      if (error) return setError(`Mitteilungen konnten nicht geladen werden: ${dbMessage(error)}`);
      setItems((data ?? []) as Item[]);
      // beim Öffnen als gelesen merken (die Punkte bleiben bis zum nächsten Öffnen sichtbar)
      if ((data ?? []).some((n) => !n.read_at)) {
        await portalDb.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
        onRead();
      }
    })();
  }, [onRead]);

  return (
    <>
      <PageHeader title="Mitteilungen" />
      <PushHint />
      <SwapOfferList meId={props.meId} />
      {props.isLead && <VacationApprovals db={portalDb} meId={props.meId} />}
      {error && <Notice tone="error">{error}</Notice>}
      {!error && items === undefined && <p className="list-empty">Lädt …</p>}
      {items?.length === 0 && (
        <div className="panel">
          <Empty icon="bell" title="Nichts Neues">Hier erscheint, was dich betrifft: Tausch, Dienstplan, Freigaben.</Empty>
        </div>
      )}
      {!!items?.length && (
        <Section>
          {items.map((n) => (
            <Row
              key={n.id}
              className={`inbox-item${n.read_at ? "" : " is-new"}`}
              leading={<LeadingIcon name={ICON[n.kind] ?? "info"} />}
              title={n.title}
              subtitle={<>{n.body}{n.body && <br />}<span className="muted">{fmtDay(berlinDate(n.created_at))} · {berlinTime(n.created_at)}</span></>}
              chevron={n.kind === "plan" || n.kind === "swap"}
              onClick={n.kind === "plan" || n.kind === "swap" ? props.onOpenPlan : undefined}
            />
          ))}
        </Section>
      )}
    </>
  );
}
