// Feierabend nach der Ausstempel-Statistik (Clock-In): eine von 10 Nachrichten mit dem persönlichen Blitzi
// (Stufe, Items, Spitzname) – die Abgabe bringt +1 Punkt. Lädt ohne den Editor. Standard-Export für lazy().
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "react";
import { blitziInfo, type BlitziInfo } from "./gamification/blitzi";
import { blitziName } from "./gamification/items";
import { RewardOverlay, type RewardKind } from "./gamification/Reward";
import { SupabaseStore } from "./store/supabase";
import { FEIERABEND_LINES } from "./studio/report";
import { today } from "./util";

const FEIERABEND_KINDS: RewardKind[] = ["trophy", "highfive", "confetti", "smoothie", "balloons", "polaroid", "micdrop", "fireworks"];

export default function Feierabend(props: { db: SupabaseClient; onDone: () => void }) {
  const store = useMemo(() => new SupabaseStore(props.db), [props.db]);
  const [data, setData] = useState<{ name: string; first: string; blitzi: BlitziInfo } | null>(null);
  const [line] = useState(() => FEIERABEND_LINES[Math.floor(Math.random() * FEIERABEND_LINES.length)]);
  const [kind] = useState(() => FEIERABEND_KINDS[Math.floor(Math.random() * FEIERABEND_KINDS.length)]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const since = new Date(Date.now() - 90 * 864e5).toISOString();
      const [me, events, days, profiles] = await Promise.all([
        store.me(),
        store.completions(since),
        store.workDays(since).catch(() => null),
        store.blitziProfiles().catch(() => []),
      ]);
      const profile = profiles.find((p) => p.userId === me.id) ?? null;
      const blitzi = blitziInfo(me.id, events, days?.[me.id] ?? null, today(), profile);
      if (!cancelled) setData({ name: me.name, first: blitzi.nickname ?? me.name.split(" ")[0], blitzi });
    })().catch(() => !cancelled && setData({ name: "", first: "", blitzi: { stage: 1, streak: 0, prestige: 0, items: [], nickname: null, stats: { today: 0, todayPoints: 0, week: 0, weekPoints: 0, streak: 0, goal: 3, goalReached: false } } }));
    return () => {
      cancelled = true;
    };
  }, [store]);
  if (!data) return null;
  const text = line.replaceAll("{name}", data.first || "du");
  return (
    <RewardOverlay
      kind={kind}
      stage={data.blitzi.stage}
      items={data.blitzi.items}
      mood="proud"
      name={data.name ? blitziName(data.name, data.blitzi.nickname) : "Blitzi"}
      headline="Feierabend! +1 ⚡"
      line={text}
      duration={6000}
      onClose={props.onDone}
    />
  );
}
