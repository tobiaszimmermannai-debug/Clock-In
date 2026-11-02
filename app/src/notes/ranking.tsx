// Siegerehrung für Clock-In: montags nach „Kommen“ einmal pro Woche und Person.
// Lädt ohne den Editor (klein). Standard-Export für lazy().
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "react";
import { stageOf } from "./gamification/evolution";
import { lastWeek, Podium } from "./gamification/Podium";
import { leaderboard, myStats, type LeaderRow } from "./gamification/stats";
import { SupabaseStore } from "./store/supabase";
import type { Completion, Member } from "./types";
import { storageGet, storageSet, today } from "./util";

/** Ist heute Montag (Berliner Zeit) und wurde die Siegerehrung dieser Woche noch nicht gezeigt? */
export function podiumDue(userKey: string): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short" }).format(new Date());
  return weekday === "Mon" && !storageGet<boolean>(`aun-podium-${lastWeek(today()).label}-${userKey}`, false);
}

export default function WeeklyRanking(props: { db: SupabaseClient; userKey: string; onClose: () => void }) {
  const store = useMemo(() => new SupabaseStore(props.db), [props.db]);
  const [data, setData] = useState<{ rows: LeaderRow[]; events: Completion[]; me: string } | null>(null);
  const info = lastWeek(today());
  const already = storageGet<boolean>(`aun-podium-${info.label}-${props.userKey}`, false);
  useEffect(() => {
    if (already) return;
    let cancelled = false;
    (async () => {
      const since = new Date(Date.now() - 60 * 864e5).toISOString();
      const [me, members, events] = await Promise.all([store.me(), store.members(), store.completions(since)]);
      if (!cancelled) setData({ rows: leaderboard(events, members, info.from, info.to), events, me: me.id });
    })().catch(() => props.onClose());
    return () => {
      cancelled = true;
    };
  }, [store, info.from, info.to, props, already]);
  if (already || !data) return null;
  const close = () => {
    storageSet(`aun-podium-${info.label}-${props.userKey}`, true);
    props.onClose();
  };
  return (
    <Podium
      rows={data.rows}
      info={info}
      me={data.me}
      stageOf={(m: Member) => stageOf(myStats(m.id, data.events, { today: today(), workDays: null }).streak)}
      onClose={close}
    />
  );
}
