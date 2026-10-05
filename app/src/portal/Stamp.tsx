// Stempeln am Handy: QR-Code am Tablet scannen → Kommen / Pause / Gehen.
// Der Server prüft: eigenes registriertes Handy, frischer QR-Code, gleiches WLAN wie das Tablet.
import { useCallback, useEffect, useRef, useState } from "react";
import { ACTIONS, ACTION_ICON, GREETING } from "../components/actions";
import { QrScanner } from "../components/QrScanner";
import { Icon, LeadingIcon, Notice, PageHeader, Pill, Row, Section } from "../components/ui";
import { type Notice as ShiftNote, relevantShift, shiftNotice } from "../lib/shiftInfo";
import { type StampCheck, StampError, parseToken, stamp, stampCheck } from "../lib/stamp";
import { currentState, validateAction, type WorkState } from "../lib/status";
import { portalDb } from "../lib/supabase";
import { fmtClock } from "../lib/time";
import { DEFAULT_RULES, EVENT_LABEL, type EventType, type LogEntry, type RuleSettings, type Shift, studioShort } from "../lib/types";
import type { Me } from "./PortalApp";


type Context = { shifts: Shift[]; rules: RuleSettings };
type Phase =
  | { kind: "idle" }
  | { kind: "scan" }
  | { kind: "checking" }
  | { kind: "choose"; token: string; check: StampCheck; ctx: Context; busy?: boolean }
  | { kind: "done"; event: EventType; at: string; location: string; note: ShiftNote | null; registered: boolean }
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
    portalDb.from("rule_settings").select("late_tolerance_minutes, overtime_threshold_minutes, min_break_minutes, help_shift_minutes").maybeSingle(),
  ]);
  return { shifts: (shifts.data ?? []) as Shift[], rules: (rules.data as RuleSettings | null) ?? DEFAULT_RULES };
}

function errorPhase(e: unknown): Phase {
  return e instanceof StampError
    ? { kind: "error", text: e.message, detail: e.detail }
    : { kind: "error", text: "Keine Verbindung. Bitte Internet prüfen." };
}

export function Stamp(props: { me: Me; token?: string; onTokenUsed: () => void }) {
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

  async function book(p: Extract<Phase, { kind: "choose" }>, event: EventType) {
    setPhase({ ...p, busy: true });
    try {
      const result = await stamp(p.token, event);
      const at = new Date(result.recorded_at);
      const note = shiftNotice(event, relevantShift(p.ctx.shifts, props.me.id, at), at, {
        since: p.check.since ?? undefined,
        rules: p.ctx.rules,
      });
      setPhase({ kind: "done", event, at: result.recorded_at, location: result.location, note, registered: p.check.registered });
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

  if (phase.kind === "choose") {
    const { check: c } = phase;
    return (
      <>
        <PageHeader title={studioShort(c.location)} subtitle={<StatusPill state={c.state} since={c.since} />} />
        {c.registered && (
          <Notice tone="ok">Dieses Handy ist jetzt dein Stempel-Handy. Stempeln geht ab sofort nur noch damit.</Notice>
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
        <h2>QR-Code am Tablet scannen</h2>
        <p className="muted">Kommen, Pause und Gehen – im Studio direkt am Tablet.</p>
        <button type="button" className="btn btn-primary btn-block btn-lg" onClick={() => setPhase({ kind: "scan" })}>
          <Icon name="qr" size={20} /> {phase.kind === "error" ? "Erneut scannen" : "Scannen"}
        </button>
      </div>
      <Section title="So geht's" footer="Kein Handy dabei oder Probleme? Bitte Tobias oder Dominik anrufen.">
        <Row leading={<LeadingIcon name="wifi" />} title="Mit dem Studio-WLAN verbinden" subtitle="Mobile Daten am besten ausschalten" />
        <Row leading={<LeadingIcon name="qr" />} title="QR-Code am Tablet scannen" subtitle="Hier mit „Scannen“ oder mit der Kamera-App" />
        <Row leading={<LeadingIcon name="checkCircle" />} title="Kommen, Pause oder Gehen wählen" />
      </Section>
    </>
  );
}
