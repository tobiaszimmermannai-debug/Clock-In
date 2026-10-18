// Stempeln am Handy: QR-Code am Tablet scannen → Kommen / Pause / Gehen.
// Der Server prüft: eigenes registriertes Handy, frischer QR-Code, gleiches WLAN wie das Tablet.
import { useCallback, useEffect, useRef, useState } from "react";
import { ACTIONS, ACTION_ICON, GREETING } from "../components/actions";
import { QrScanner } from "../components/QrScanner";
import { Icon, LeadingIcon, Notice, PageHeader, Pill, Row, Section } from "../components/ui";
import { type Notice as ShiftNote, relevantShift, shiftNotice } from "../lib/shiftInfo";
import { type EarlyReason, type StampCheck, StampError, parseToken, stamp, stampCheck } from "../lib/stamp";
import { currentState, validateAction, type WorkState } from "../lib/status";
import { portalDb } from "../lib/supabase";
import { fmtHM } from "../lib/dates";
import { fmtClock } from "../lib/time";
import { DEFAULT_RULES, EVENT_LABEL, type EventType, type LogEntry, type RuleSettings, type Shift, studioShort } from "../lib/types";
import type { Me } from "./PortalApp";
import { VacationRow } from "./Vacation";


type Context = { shifts: Shift[]; rules: RuleSettings };
type Phase =
  | { kind: "idle" }
  | { kind: "scan" }
  | { kind: "checking" }
  | { kind: "choose"; token: string; check: StampCheck; ctx: Context; busy?: boolean }
  // mehr als 30 Min. vor Schichtende gehen: erst nach dem Grund fragen
  | { kind: "early"; choose: Extract<Phase, { kind: "choose" }>; minutes: number; end: string; busy?: boolean }
  | { kind: "done"; event: EventType; at: string; location: string; note: ShiftNote | null; registered: boolean; pending: boolean; early?: boolean }
  | { kind: "error"; text: string; detail?: string };

function StatusPill(props: { state: WorkState; since?: string | null }) {
  const seit = props.since ? ` seit ${fmtClock(props.since)}` : "";
  if (props.state === "in") return <Pill tone="ok">Eingestempelt{seit}</Pill>;
  if (props.state === "break") return <Pill tone="warn">In der Pause{seit}</Pill>;
  return <Pill>Nicht eingestempelt</Pill>;
}

// Schichten ±1 Tag und Regeln – vor dem Buchen laden (danach gäbe es schon die Aushilfsschicht)
async function loadContext(userId: string): Promise<Context> {
  const now = Date.now();
  const [shifts, rules] = await Promise.all([
    portalDb
      .from("shifts")
      .select("id, user_id, location_id, shift_type, starts_at, ends_at")
      .eq("user_id", userId)
      .gte("starts_at", new Date(now - 86_400_000).toISOString())
      .lte("starts_at", new Date(now + 86_400_000).toISOString()),
    portalDb.from("rule_settings").select("late_tolerance_minutes, overtime_threshold_minutes, min_break_minutes, help_shift_minutes, early_leave_minutes").maybeSingle(),
  ]);
  return { shifts: (shifts.data ?? []) as Shift[], rules: (rules.data as RuleSettings | null) ?? DEFAULT_RULES };
}

function errorPhase(e: unknown): Phase {
  return e instanceof StampError
    ? { kind: "error", text: e.message, detail: e.detail }
    : { kind: "error", text: "Keine Verbindung. Bitte Internet prüfen." };
}

// Nur das eigene Handy stempelt (prüft auch der Server) – nicht Studio-PC oder -Tablet
const IS_PHONE = typeof navigator === "undefined" || !navigator.userAgent || /mobi|iphone|ipod/i.test(navigator.userAgent);

export function Stamp(props: { me: Me; token?: string; onTokenUsed: () => void; onOpenVacation?: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [status, setStatus] = useState<{ state: WorkState; since?: string }>();
  const onTokenUsed = useRef(props.onTokenUsed);
  onTokenUsed.current = props.onTokenUsed;

  const loadStatus = useCallback(async () => {
    const { data } = await portalDb
      .from("time_logs")
      .select("client_event_id, user_id, event_type, recorded_at, approval_status")
      .eq("user_id", props.me.id)
      .gte("recorded_at", new Date(Date.now() - 16 * 3_600_000).toISOString())
      .order("recorded_at");
    setStatus(currentState((data ?? []) as LogEntry[], new Date()));
  }, [props.me.id]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const check = useCallback(async (token: string) => {
    setPhase({ kind: "checking" });
    try {
      const [result, ctx] = await Promise.all([stampCheck(token), loadContext(props.me.id)]);
      setPhase({ kind: "choose", token, check: result, ctx });
    } catch (e) {
      setPhase(errorPhase(e));
    }
  }, [props.me.id]);

  // Direkt aus der Kamera-App geöffnet: …/#/s/<code>
  useEffect(() => {
    if (!props.token) return;
    onTokenUsed.current();
    void check(props.token);
  }, [props.token, check]);

  function scanned(text: string) {
    const token = parseToken(text);
    if (!token) return setPhase({ kind: "error", text: "Das ist kein Clock-In-Code. Bitte den QR-Code am Studio-Tablet scannen." });
    void check(token);
  }

  async function book(p: Extract<Phase, { kind: "choose" }>, event: EventType, earlyReason?: EarlyReason) {
    // Früher gehen? Dann erst fragen: wenig los oder krank (Tobias/Dominik geben frei)
    if (event === "clock_out" && !earlyReason) {
      const shift = relevantShift(p.ctx.shifts, props.me.id, new Date());
      const minutes = shift ? Math.round((Date.parse(shift.ends_at) - Date.now()) / 60_000) : 0;
      if (shift && minutes > (p.ctx.rules.early_leave_minutes ?? 30)) return setPhase({ kind: "early", choose: p, minutes, end: shift.ends_at });
    }
    setPhase((prev) => (prev.kind === "early" ? { ...prev, busy: true } : { ...p, busy: true }));
    try {
      const result = await stamp(p.token, event, earlyReason);
      const at = new Date(result.recorded_at);
      const note = shiftNotice(event, relevantShift(p.ctx.shifts, props.me.id, at), at, {
        since: p.check.since ?? undefined,
        rules: p.ctx.rules,
      });
      setPhase({
        kind: "done", event, at: result.recorded_at, location: result.location, note,
        registered: p.check.registered, pending: !!result.pending, early: !!result.early,
      });
      void loadStatus();
    } catch (e) {
      setPhase(errorPhase(e));
    }
  }

  if (phase.kind === "scan") {
    return (
      <>
        <PageHeader title="QR-Code scannen" />
        <QrScanner onResult={scanned} />
        <button type="button" className="btn btn-outline btn-block" onClick={() => setPhase({ kind: "idle" })}>Abbrechen</button>
      </>
    );
  }

  if (phase.kind === "checking") {
    return (
      <div className="panel stamp-hero">
        <span className="stamp-hero-icon"><Icon name="wifi" size={34} /></span>
        <h2>Prüfe …</h2>
        <p className="muted">Handy, QR-Code und Studio-WLAN</p>
      </div>
    );
  }

  if (phase.kind === "early") {
    const p = phase.choose;
    return (
      <>
        <PageHeader title="Früher gehen?" subtitle={phase.end ? `Schicht bis ${fmtClock(phase.end)} Uhr` : undefined} />
        <div className="panel stamp-hero">
          <span className="stamp-hero-icon"><Icon name="clock" size={34} /></span>
          <h2>{phase.minutes ? `${fmtHM(phase.minutes)} Std. vor Schichtende` : "Warum gehst du früher?"}</h2>
          <p className="muted">Warum gehst du früher? Tobias oder Dominik geben frei – sonst zählen die fehlenden Stunden als Minusstunden.</p>
          <div className="early-actions">
            <button type="button" className="btn btn-outline btn-block btn-lg" disabled={phase.busy} onClick={() => void book(p, "clock_out", "slow")}>
              📉 Wenig los / weniger Trainings
            </button>
            <button type="button" className="btn btn-outline btn-block btn-lg" disabled={phase.busy} onClick={() => void book(p, "clock_out", "sick")}>
              🤒 Ich bin krank
            </button>
          </div>
        </div>
        <button type="button" className="btn btn-plain btn-block" disabled={phase.busy} onClick={() => setPhase(p)}>Zurück</button>
      </>
    );
  }

  if (phase.kind === "choose") {
    const { check: c } = phase;
    return (
      <>
        <PageHeader title={studioShort(c.location)} subtitle={<StatusPill state={c.state} since={c.since} />} />
        {c.registered && (
          <Notice tone="ok">Dieses Handy ist jetzt dein Stempel-Handy. Stempeln geht ab sofort nur noch damit.</Notice>
        )}
        {c.unverified && (
          <Notice tone="warn">
            Dieses Handy bzw. dieser Browser ist für dich noch nicht freigegeben. Du kannst trotzdem stempeln –
            die Buchung zählt, sobald Tobias oder Dominik sie freigeben. Tipp: immer in der Clock-In-App über
            „Stempeln → Scannen“ stempeln.
          </Notice>
        )}
        <div className="stamp-actions">
          {ACTIONS.map((a) => {
            const blocked = validateAction(c.state, c.since ?? undefined, a);
            return (
              <button
                key={a}
                type="button"
                className={`action action-${a}`}
                disabled={!!blocked || phase.busy}
                title={blocked ?? undefined}
                onClick={() => void book(phase, a)}
              >
                <Icon name={ACTION_ICON[a]} stroke={2.2} />
                {EVENT_LABEL[a]}
              </button>
            );
          })}
        </div>
        <button type="button" className="btn btn-outline btn-block" onClick={() => setPhase({ kind: "idle" })}>Abbrechen</button>
      </>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="panel stamp-done">
        <span className={`result-icon action-${phase.event}`} aria-hidden="true"><Icon name="check" stroke={3} /></span>
        <h2>{GREETING[phase.event](props.me.first_name)}</h2>
        <p className="result-line">
          {EVENT_LABEL[phase.event]} · {fmtClock(phase.at)} Uhr · {studioShort(phase.location)}
        </p>
        {phase.note && <Notice tone={phase.note.tone}>{phase.note.text}</Notice>}
        {phase.registered && <Notice tone="ok">Dieses Handy ist jetzt dein Stempel-Handy.</Notice>}
        {phase.pending && (
          <Notice tone="warn">Gespeichert – wartet auf Freigabe durch Tobias oder Dominik (anderes Handy/Browser).</Notice>
        )}
        {phase.early && (
          <Notice tone="warn">Früher gegangen – Tobias oder Dominik entscheiden, wie die restliche Zeit zählt. Gute Besserung, falls du krank bist!</Notice>
        )}
        <button type="button" className="btn btn-primary btn-block" onClick={() => setPhase({ kind: "idle" })}>Fertig</button>
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Stempeln" subtitle={status && <StatusPill state={status.state} since={status.since} />} />
      {phase.kind === "error" && (
        <Notice tone="error">
          {phase.text}
          {phase.detail && <span className="error-detail">Netz: {phase.detail}</span>}
        </Notice>
      )}
      <div className="panel stamp-hero">
        <span className="stamp-hero-icon"><Icon name="qr" size={34} /></span>
        <h2>QR-Code am Tablet oder PC scannen</h2>
        {IS_PHONE ? (
          <>
            <p className="muted">Kommen, Pause und Gehen – im Studio direkt am Tablet oder PC.</p>
            <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => setPhase({ kind: "scan" })}>
              <Icon name="qr" size={20} /> {phase.kind === "error" ? "Erneut scannen" : "Scannen"}
            </button>
          </>
        ) : (
          <Notice tone="warn">Stempeln geht nur mit deinem eigenen Handy – nicht am PC oder Tablet.</Notice>
        )}
      </div>
      <VacationRow meId={props.me.id} onOpen={props.onOpenVacation} />
      <Section title="So geht's" footer="Kein Handy dabei oder Probleme? Bitte Tobias oder Dominik anrufen.">
        <Row leading={<LeadingIcon name="wifi" />} title="Mit dem Studio-WLAN verbinden" subtitle="Mobile Daten am besten ausschalten" />
        <Row leading={<LeadingIcon name="qr" />} title="QR-Code am Tablet oder PC scannen" subtitle="Am besten hier mit „Scannen“ – dann erkennt das System dein Handy sicher" />
        <Row leading={<LeadingIcon name="checkCircle" />} title="Kommen, Pause oder Gehen wählen" />
      </Section>
    </>
  );
}
