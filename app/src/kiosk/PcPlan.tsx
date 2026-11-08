// Dienstplan am Studio-PC: alle Studios sichtbar (nur lesen). Planen erst, wenn die Studioleitung den QR-Code
// hier mit ihrem registrierten Stempel-Handy bestätigt – dann nur für ihr Heimatstudio. Nach 5 Min. ohne Maus,
// Tastatur oder Touch ist die Planung wieder gesperrt (die Aufgaben-Ansicht bleibt davon unberührt).
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Profile } from "../admin/AdminApp";
import { Plan } from "../admin/Plan";
import { QrCode } from "../components/QrCode";
import { StudioCalendar } from "../components/StudioCalendar";
import { useWeekShifts } from "../components/WeekPlan";
import { Notice, WeekNav } from "../components/ui";
import { publicAppUrl } from "../lib/config";
import { berlinDate, weekStart } from "../lib/dates";
import { registerStudios } from "../lib/studios";
import { kioskDb, planClient } from "../lib/supabase";
import type { Location } from "../lib/types";
import { useWishes } from "../lib/wishes";

const IDLE_MS = 5 * 60_000;
const POLL_MS = 2_000;
const QR_MS = 2 * 60_000;
const LOCKED_TEXT = "Schichtplanung gesperrt – Studioleitung per QR erneut bestätigen.";

/** Link im QR-Code: öffnet im Portal der Studioleitung die Bestätigung */
export const pcUnlockUrl = (token: string, origin = publicAppUrl()) => `${origin}/#/pc/${token}`;

type Unlocked = { db: SupabaseClient; profile: Profile; home: string };

export function PcPlan() {
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [lockedNote, setLockedNote] = useState(false);

  const lock = useCallback((timeout: boolean) => {
    setUnlocked((u) => {
      if (u) void u.db.auth.signOut({ scope: "local" }).catch(() => undefined);
      return null;
    });
    setLockedNote(timeout);
  }, []);

  // 5 Minuten ohne Bedienung → Planung wieder sperren
  useEffect(() => {
    if (!unlocked) return;
    let timer = setTimeout(() => lock(true), IDLE_MS);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => lock(true), IDLE_MS);
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;
    for (const e of events) window.addEventListener(e, bump, { passive: true, capture: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, bump, { capture: true });
    };
  }, [unlocked, lock]);

  if (unlocked) {
    return (
      <div className="pc-plan">
        <div className="pc-plan-bar">
          <span>✏️ Planung freigeschaltet: <b>{unlocked.profile.first_name} {unlocked.profile.last_name}</b> · nur das eigene Studio · sperrt nach 5 Min. ohne Bedienung</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => lock(false)}>Planung sperren</button>
        </div>
        <Plan profile={unlocked.profile} db={unlocked.db} onlyStudio={unlocked.home} />
      </div>
    );
  }
  return <ReadOnlyPlan lockedNote={lockedNote} onUnlocked={(u) => (setLockedNote(false), setUnlocked(u))} />;
}

function ReadOnlyPlan(props: { lockedNote: boolean; onUnlocked: (u: Unlocked) => void }) {
  const [start, setStart] = useState(weekStart(berlinDate()));
  const [locations, setLocations] = useState<Location[]>([]);
  const { shifts, error, blockOf } = useWeekShifts(kioskDb, start);
  const wishes = useWishes(kioskDb, start);
  const [qr, setQr] = useState(false);

  useEffect(() => {
    void kioskDb.from("locations").select("id, code, name").eq("is_active", true).order("name").then(({ data }) => {
      const all = (data ?? []) as Location[];
      registerStudios(all);
      setLocations(all);
    });
  }, []);

  return (
    <div className="pc-plan">
      <div className="pc-plan-bar">
        <span>👀 Dienstplan aller Studios · nur lesen</span>
        {!qr && <button type="button" className="btn btn-primary btn-sm" onClick={() => setQr(true)}>Schichtplanung freischalten</button>}
      </div>
      {props.lockedNote && <Notice tone="warn">{LOCKED_TEXT}</Notice>}
      {qr && <UnlockQr onCancel={() => setQr(false)} onUnlocked={props.onUnlocked} />}
      <WeekNav start={start} onChange={setStart} />
      {error && <Notice tone="error">{error}</Notice>}
      <StudioCalendar start={start} shifts={shifts} locations={locations} blockOf={blockOf}
        wishes={wishes.wishes.filter((w) => w.status === "open")} slots={wishes.slots} />
    </div>
  );
}

/** QR-Code zeigen und warten, bis die Studioleitung ihn mit ihrem Stempel-Handy bestätigt */
function UnlockQr(props: { onCancel: () => void; onUnlocked: (u: Unlocked) => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [who, setWho] = useState<string | null>(null);
  const done = useRef(props.onUnlocked);
  done.current = props.onUnlocked;

  const fresh = useCallback(async () => {
    setError(undefined);
    const { data, error } = await kioskDb.rpc("pc_plan_challenge");
    if (error) return setError(error.message);
    setToken(String(data));
  }, []);

  useEffect(() => {
    void fresh();
  }, [fresh]);

  // Bestätigung abfragen (nur solange der Code zu sehen ist), nach 2 Min. neuer Code
  useEffect(() => {
    if (!token) return;
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      if (stop) return;
      if (Date.now() - started > QR_MS) return void fresh();
      const { data } = await kioskDb.rpc("pc_plan_status", { p_token: token });
      const st = data as { unlocked?: boolean; name?: string | null } | null;
      if (stop) return;
      if (!st?.unlocked) return void setTimeout(tick, POLL_MS);
      setWho(st.name ?? "Studioleitung");
      try {
        const res = await kioskDb.functions.invoke("pc-plan", { body: { token } });
        const body = res.data as { token_hash?: string; home_location_id?: string; error?: string } | null;
        if (res.error || !body?.token_hash) throw new Error(body?.error ?? "Anmeldung für die Planung fehlgeschlagen.");
        const db = planClient();
        const { data: auth, error: otpError } = await db.auth.verifyOtp({ token_hash: body.token_hash, type: "magiclink" });
        if (otpError || !auth.user) throw new Error(otpError?.message ?? "Anmeldung fehlgeschlagen.");
        const { data: profile } = await db.from("users").select("id, first_name, last_name, role, home_location_id")
          .eq("auth_user_id", auth.user.id).maybeSingle();
        if (!profile || profile.role !== "manager" || !profile.home_location_id) {
          await db.auth.signOut({ scope: "local" });
          throw new Error("Nur eine Studioleitung mit Heimatstudio kann hier planen.");
        }
        done.current({ db, profile: profile as Profile, home: profile.home_location_id as string });
      } catch (e) {
        setWho(null);
        setError(e instanceof Error ? e.message : String(e));
        void fresh();
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [token, fresh]);

  return (
    <div className="panel pc-unlock">
      <div className="pc-unlock-qr">{token ? <QrCode text={pcUnlockUrl(token)} label="QR-Code zum Freischalten der Planung" /> : <span>Lädt …</span>}</div>
      <div className="stack">
        <h2>Schichtplanung freischalten</h2>
        <ol>
          <li>Studioleitung öffnet Clock-In auf <b>ihrem Stempel-Handy</b></li>
          <li><b>Stempeln → Scannen</b> und diesen Code scannen</li>
          <li>„Planung freigeben“ tippen – danach plant ihr hier fürs eigene Studio</li>
        </ol>
        {who && <Notice tone="ok">{who} hat bestätigt – Planung wird geöffnet …</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <button type="button" className="btn btn-outline" onClick={props.onCancel}>Abbrechen</button>
      </div>
    </div>
  );
}
