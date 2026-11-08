// Siegerehrung für Clock-In: montags nach „Kommen“ einmal pro Woche und Person – Team-Wertung der Studios
// (Punkteschnitt je Person). Lädt ohne den Editor (klein). Standard-Export für lazy().
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "react";
import { blitziInfo } from "./gamification/blitzi";
import { lastWeek, TeamPodium } from "./gamification/Podium";
import { leaderboard, teamLeaderboard, type TeamRow } from "./gamification/stats";
import { SupabaseStore } from "./store/supabase";
import type { BlitziProfile, Completion, Member } from "./types";
import { storageGet, storageSet, today } from "./util";

/** Ist heute Montag (Berliner Zeit) und wurde die Siegerehrung dieser Woche noch nicht gezeigt? */
export function podiumDue(userKey: string): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short" }).format(new Date());
  return weekday === "Mon" && !storageGet<boolean>(`aun-podium-${lastWeek(today()).label}-${userKey}`, false);
}

type Data = {
  teams: TeamRow[];
  events: Completion[];
  members: Member[];
  profiles: BlitziProfile[];
  workDays: Record<string, string[]> | null;
  me: Member;
};

export default function WeeklyRanking(props: { db: SupabaseClient; userKey: string; onClose: () => void }) {
  const store = useMemo(() => new SupabaseStore(props.db), [props.db]);
  const [data, setData] = useState<Data | null>(null);
  const info = lastWeek(today());
  const already = storageGet<boolean>(`aun-podium-${info.label}-${props.userKey}`, false);
  useEffect(() => {
    if (already) return;
    let cancelled = false;
    (async () => {
      const since = new Date(Date.now() - 60 * 864e5).toISOString();
      const [me, members, events, studios, profiles, workDays] = await Promise.all([
        store.me(),
        store.members(),
        store.completions(since),
        store.locations(),
        store.blitziProfiles().catch(() => []),
        store.workDays(since).catch(() => null),
      ]);
      if (!cancelled) setData({ teams: teamLeaderboard(events, members, studios, info.from, info.to), events, members, profiles, workDays, me });
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
  const blitzi = (id: string) => blitziInfo(id, data.events, data.workDays?.[id] ?? null, today(), data.profiles.find((p) => p.userId === id) ?? null);
  const board = leaderboard(data.events, data.members, info.from, info.to);
  const myStudio = data.members.find((m) => m.id === data.me.id)?.studioId ?? null;
  return (
    <TeamPodium
      teams={data.teams}
      info={info}
      myStudio={myStudio}
      myPoints={board.find((r) => r.member.id === data.me.id)?.points ?? 0}
      heroes={(sid) =>
        board
          .filter((r) => r.member.studioId === sid && r.member.role !== "admin")
          .map((r) => ({ member: r.member, stage: blitzi(r.member.id).stage, items: blitzi(r.member.id).items }))
      }
      onClose={close}
    />
  );
}
