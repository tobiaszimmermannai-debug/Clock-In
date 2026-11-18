// Reiter „Wissen“ im Duolingo-Stil: Lernpfad (Lektionen mit Multiple Choice), Blitzi-Karteikarten, Blitzrunde (60 s),
// Wiederholung nach Leitner. Inhalte unverändert aus src/content/wissen; gespeichert wird nur der Fortschritt.
import "./wissen.css";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "../../components/ui";
import { isMuted, setMuted, sounds } from "../../lib/sounds";
import { portalDb } from "../../lib/supabase";
import {
  BLITZ_SECONDS, CARD_XP, CARDS, composeLesson, currentUnit, DAILY_GOAL_XP, type DayXp, DECK_KIND, type Deck, DECKS, DEFAULT_TOPIC, dueCards,
  dueQuestions, earnsXp, type Flashcard, isCorrect, type ItemType, LESSON_SIZE, levelOf, nextProgress, PERFECT_BONUS, type Progress, type ProgressMap,
  type Question, QUESTIONS, questionsOf, shuffle, streakOf, todayXp, topicMastery, TOPICS, type Unit, unitRing, unitsOf, unlockedUnits, weekXp, XP_BY_DIFFICULTY,
} from "../../lib/wissen";
import { Blitzi } from "../../notes/gamification/Blitzi";

type Mode = "lesson" | "review" | "blitzi" | "blitzrunde";
/** xp: was die App anzeigt (0, wenn es keine Punkte gibt); base: Punktwert der Frage/Karte für die Datenbank */
type Save = (input: { id: string; type: ItemType; correct: boolean; mode: Mode; xp: number; base: number; answer?: string[]; leitner: boolean; retry?: boolean }) => void;

// ---------------- Daten ----------------
function useWissen() {
  const [uid, setUid] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressMap>(new Map());
  const [days, setDays] = useState<DayXp[]>([]);
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [xpTotal, setXpTotal] = useState(0);
  const progressRef = useRef(progress);
  progressRef.current = progress;

  const load = useCallback(async () => {
    const { data } = await portalDb.auth.getSession();
    const me = data.session?.user.id ?? null;
    setUid(me);
    if (!me) return setReady(true);
    const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const [p, d, profile] = await Promise.all([
      portalDb.from("wissen_item_progress").select("*").eq("user_id", me),
      portalDb.from("wissen_daily_xp").select("day, xp, answers").eq("user_id", me).gte("day", since),
      portalDb.from("wissen_profile").select("xp_total").eq("user_id", me).maybeSingle(),
    ]);
    setXpTotal(Number((profile.data as { xp_total?: number } | null)?.xp_total ?? 0));
    if (p.error || d.error) setError("Lernstand konnte nicht geladen werden – ist das Wissen-Update in der Datenbank eingespielt?");
    setProgress(new Map(((p.data ?? []) as Progress[]).map((r) => [r.item_id, r])));
    setDays(((d.data ?? []) as { day: string; xp: number; answers: number }[]).map((r) => ({ day: r.day, xp: r.xp, active: r.answers > 0 })));
    setReady(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save: Save = useCallback(
    (input) => {
      if (!uid) return;
      const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
      setDays((list) => {
        const hit = list.find((x) => x.day === day);
        return hit ? list.map((x) => (x.day === day ? { ...x, xp: x.xp + input.xp, active: true } : x)) : [...list, { day, xp: input.xp, active: true }];
      });
      setXpTotal((x) => x + input.xp);
      const bonus = input.id.startsWith("bonus:");
      // Wiederholung derselben Frage in einer Lektion: nur speichern, wenn sie jetzt richtig ist (gilt dann als gelernt)
      const retry = !input.leitner && !bonus && input.correct;
      if (!input.leitner && !bonus && !retry) return;
      const next = bonus ? undefined : nextProgress(progressRef.current.get(input.id), input.id, input.type, input.correct, new Date(), retry);
      if (next) setProgress((m) => new Map(m).set(input.id, next));
      // Punkte und Lernstufe setzt die Datenbank (wissen_answer) – die App zeigt nur an
      void (async () => {
        const args = { p_item: input.id, p_type: input.type, p_correct: input.correct, p_mode: input.mode, p_answer: input.answer ?? null, p_xp: input.base };
        let res = await portalDb.rpc("wissen_answer", retry ? { ...args, p_retry: true } : args);
        // Datenbank-Update (Wiederholung) noch nicht eingespielt → ohne Wiederholungs-Kennzeichen
        if (res.error && retry) res = await portalDb.rpc("wissen_answer", args);
        if (!res.error) {
          const r = res.data as { xp: number; xp_total: number } | null;
          if (r && typeof r.xp_total === "number") setXpTotal(r.xp_total);
          return;
        }
        // Ältere Datenbank ohne wissen_answer: wie früher direkt speichern, damit kein Lernstand verloren geht
        if (/wissen_answer|schema cache|PGRST202/i.test(`${res.error.message} ${res.error.code}`)) {
          const writes = [
            portalDb.from("wissen_attempts").insert({ user_id: uid, item_id: input.id, item_type: input.type, correct: input.correct,
              answer: input.answer ?? null, mode: input.mode, xp_earned: input.xp }),
          ];
          if (next) {
            const { best_box: _b, ...row } = next;
            writes.push(portalDb.from("wissen_item_progress").upsert({ user_id: uid, ...row, last_seen_at: new Date().toISOString() }));
          }
          const failed = (await Promise.all(writes)).find((w) => w.error);
          if (!failed) return;
          return setError(`Speichern fehlgeschlagen: ${failed.error!.message}`);
        }
        setError(`Speichern fehlgeschlagen: ${res.error.message}`);
      })();
    },
    [uid],
  );

  return { ready, error, progress, days, xpTotal, save };
}

// Fällige Wiederholungen nur aus dem gewählten Thema (Einarbeitung und Strahlenschutz getrennt)
const dueOfTopic = (progress: ProgressMap, topicId: string) => {
  const units = new Set(unitsOf(topicId).map((u) => u.id));
  return dueQuestions(progress).filter((q) => units.has(q.unitId));
};

// ---------------- Startseite ----------------
type Screen =
  | { kind: "home" }
  | { kind: "lesson"; mode: "lesson" | "review"; title: string; questions: Question[] }
  | { kind: "deck"; deck: Deck }
  | { kind: "blitz" };

export default function WissenApp() {
  const w = useWissen();
  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const home = () => setScreen({ kind: "home" });

  if (!w.ready) return <p className="muted wi-loading">Lädt …</p>;
  if (screen.kind === "lesson") return <Lesson {...screen} progress={w.progress} save={w.save} onClose={home} />;
  if (screen.kind === "deck") return <DeckRun deck={screen.deck} progress={w.progress} save={w.save} onClose={home} />;
  if (screen.kind === "blitz") return <BlitzRound progress={w.progress} save={w.save} onClose={home} />;
  return (
    <Home
      {...w}
      onLesson={(u) => setScreen({ kind: "lesson", mode: "lesson", title: u.title, questions: composeLesson(u.id, w.progress) })}
      onReview={(topicId) => setScreen({ kind: "lesson", mode: "review", title: "Wiederholen", questions: dueOfTopic(w.progress, topicId).slice(0, LESSON_SIZE) })}
      onDeck={(deck) => setScreen({ kind: "deck", deck })}
      onBlitz={() => setScreen({ kind: "blitz" })}
    />
  );
}

function Home(props: {
  progress: ProgressMap;
  days: DayXp[];
  xpTotal: number;
  error?: string;
  onLesson: (u: Unit) => void;
  onReview: (topicId: string) => void;
  onDeck: (d: Deck) => void;
  onBlitz: () => void;
}) {
  const { progress, days } = props;
  const open = unlockedUnits(progress);
  // Thema (Kapitel): Auswahl wird am Gerät gemerkt
  const [topicId, setTopicId] = useState(() => {
    try {
      const saved = localStorage.getItem("clockin-wissen-topic");
      return saved && TOPICS.some((t) => t.id === saved) ? saved : DEFAULT_TOPIC;
    } catch {
      return DEFAULT_TOPIC;
    }
  });
  const pickTopic = (id: string) => {
    setTopicId(id);
    try {
      localStorage.setItem("clockin-wissen-topic", id);
    } catch {
      // egal
    }
  };
  const topic = TOPICS.find((t) => t.id === topicId) ?? TOPICS[0];
  const units = unitsOf(topic.id);
  const current = currentUnit(progress, topic.id);
  const level = levelOf(props.xpTotal);
  // Level-Aufstieg feiern (nur wenn das Level während der Sitzung steigt)
  const lastLevel = useRef(level.level);
  const [levelUp, setLevelUp] = useState<number>();
  useEffect(() => {
    if (level.level > lastLevel.current && lastLevel.current > 0 && props.xpTotal > 0) {
      setLevelUp(level.level);
      sounds.finish();
    }
    lastLevel.current = level.level;
  }, [level.level, props.xpTotal]);
  const due = dueOfTopic(progress, topicId).length;
  const dueC = dueCards(progress).length;
  const streak = streakOf(days);
  const today = todayXp(days);
  const goalPct = Math.min(100, Math.round((today / DAILY_GOAL_XP) * 100));
  const [week, setWeek] = useState<number | null>(null);
  const [muted, setMute] = useState(isMuted);

  return (
    <div className="wi">
      <header className="wi-hero">
        <Blitzi mood={today >= DAILY_GOAL_XP ? "party" : today > 0 ? "happy" : "neutral"} size={78} stage={Math.min(30, 1 + streak)} still />
        <div className="wi-hero-text">
          <h1>Wissen</h1>
          <p>Lernen wie bei Duolingo – kurz, jeden Tag, mit Blitzi.</p>
        </div>
        <button type="button" className="wi-sound" aria-pressed={!muted} aria-label={muted ? "Ton einschalten" : "Ton ausschalten"}
          title={muted ? "Ton einschalten" : "Ton ausschalten"}
          onClick={() => { setMuted(!muted); setMute(!muted); if (muted) setTimeout(sounds.correct, 0); }}>
          {muted ? "🔇" : "🔊"}
        </button>
      </header>
      {props.error && <Notice tone="warn">{props.error}</Notice>}

      <div className={`wi-level${levelUp ? " is-up" : ""}`} onAnimationEnd={() => setLevelUp(undefined)}>
        <span className="wi-level-badge" aria-hidden>{level.level}</span>
        <div className="wi-level-main">
          <b>Level {level.level} · {level.title}{levelUp ? " – aufgestiegen! 🎉" : ""}</b>
          <span className="wi-goal"><span style={{ width: `${level.pct}%` }} /></span>
          <span className="muted small">{props.xpTotal} XP gesamt · noch {level.next} XP bis Level {level.level + 1}</span>
        </div>
      </div>

      <div className="wi-stats">
        <div className="wi-stat"><b>🔥 {streak}</b><span>{streak === 1 ? "Tag Serie" : "Tage Serie"}</span></div>
        <div className="wi-stat is-wide">
          <b>⚡ {today}/{DAILY_GOAL_XP} XP</b>
          <span className="wi-goal"><span style={{ width: `${goalPct}%` }} /></span>
          <span>Tagesziel</span>
        </div>
        <div className="wi-stat"><b>{weekXp(days)}</b><span>XP diese Woche</span></div>
      </div>

      {TOPICS.length > 1 && (
        <div className="wi-topics" role="tablist" aria-label="Thema">
          {TOPICS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === topic.id} className={`wi-topic${t.id === topic.id ? " is-on" : ""}`} onClick={() => pickTopic(t.id)}>
              <span className="wi-topic-icon" aria-hidden>{t.icon}</span>
              <b>{t.title}</b>
              <span className="muted small">{unitsOf(t.id).length ? `${Math.round(topicMastery(t.id, progress) * 100)} % gelernt` : "Inhalte folgen"}</span>
            </button>
          ))}
        </div>
      )}

      <div className="wi-actions">
        {current ? (
          <button type="button" className="wi-btn is-primary" onClick={() => props.onLesson(current)}>▶ Weiterlernen: {current.title}</button>
        ) : (
          <Notice tone="info">{topic.title}: Die Fragen zu diesem Thema werden gerade eingepflegt.</Notice>
        )}
        <div className="wi-actions-row">
          <button type="button" className="wi-btn" disabled={!due} onClick={() => props.onReview(topic.id)}>🔁 Wiederholen{due ? ` (${due} fällig)` : ""}</button>
          <button type="button" className="wi-btn is-blitz" onClick={props.onBlitz}>⚡ Blitzrunde · {BLITZ_SECONDS} s</button>
        </div>
      </div>

      <h2 className="wi-h2">Lernpfad</h2>
      <ol className="wi-path">
        {units.map((u, i) => {
          const unlocked = open.has(u.id);
          const ring = unitRing(u.id, progress);
          const isCurrent = u.id === current?.id;
          return (
            <li key={u.id} className={`wi-node${unlocked ? "" : " is-locked"}${isCurrent ? " is-current" : ""}`} style={{ "--shift": `${[0, 38, 56, 38, 0, -38, -56, -38][i % 8]}px` } as CSSProperties}>
              <button type="button" disabled={!unlocked} onClick={() => props.onLesson(u)} aria-label={`${u.title}${unlocked ? "" : " (gesperrt)"}`}>
                <span className="wi-ring" style={{ "--p": `${Math.round(ring * 100)}%` } as CSSProperties}>
                  <span className="wi-circle">{unlocked ? u.icon : "🔒"}</span>
                </span>
              </button>
              {isCurrent && <span className="wi-start">Start</span>}
              <span className="wi-node-title">{u.title}</span>
              <span className="wi-node-sub">{questionsOf(u.id).length} Fragen · {u.source}</span>
            </li>
          );
        })}
      </ol>
      <p className="muted small wi-hint">
        Nächste Lektion wird frei, wenn du 80 % der Fragen der vorigen mindestens einmal richtig hattest.
        Punkte gibt es für neue und fällige Fragen – falsche Antworten und reines Wiederholen bringen keine.
      </p>

      <h2 className="wi-h2">⚡ Blitzi-Karteikarten {dueC > 0 && <span className="wi-due">{dueC} fällig</span>}</h2>
      <div className="wi-weeks">
        {[1, 2, 3, 4, 5, 6].map((n) => {
          const decks = DECKS.filter((d) => d.week === n);
          if (!decks.length) return null;
          const opened = week === n;
          return (
            <section key={n} className={`wi-week${opened ? " is-open" : ""}`}>
              <button type="button" className="wi-week-head" onClick={() => setWeek(opened ? null : n)} aria-expanded={opened}>
                <b>Woche {n}</b>
                <span className="muted">{decks.length} Themen</span>
                <span className="wi-chev">{opened ? "▾" : "▸"}</span>
              </button>
              {opened && (
                <ul className="wi-decks">
                  {decks.map((d) => {
                    const cards = CARDS.filter((c) => c.deckId === d.id);
                    const known = cards.filter((c) => (progress.get(c.id)?.box ?? 0) >= 2).length;
                    return (
                      <li key={d.id}>
                        <button type="button" className="wi-deck" disabled={!cards.length} onClick={() => props.onDeck(d)}>
                          <span className="wi-deck-title">{d.title}</span>
                          <span className="wi-deck-meta">
                            <span className="wi-tag">{DECK_KIND[d.kind]}</span>
                            {cards.length ? <span>{known}/{cards.length} gewusst</span> : null}
                            {d.needsContent && <span className="wi-tag is-warn">Inhalt folgt – frag deinen Studioleiter</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- Fortschrittsbalken + Abschluss ----------------
function TopBar(props: { done: number; total: number; onClose: () => void; extra?: React.ReactNode }) {
  return (
    <div className="wi-top">
      <button type="button" className="wi-x" onClick={props.onClose} aria-label="Beenden">✕</button>
      <span className="wi-bar"><span style={{ width: `${props.total ? (props.done / props.total) * 100 : 0}%` }} /></span>
      {props.extra}
    </div>
  );
}

function Finish(props: { title: string; xp: number; lines: string[]; onClose: () => void }) {
  useEffect(() => sounds.finish(), []);
  return (
    <div className="wi wi-finish">
      <div className="wi-finish-blitzi"><Blitzi mood="party" size={150} stage={20} /></div>
      <h1>{props.title}</h1>
      <p className="wi-finish-xp">+{props.xp} XP</p>
      {props.lines.map((l) => <p key={l} className="muted">{l}</p>)}
      <button type="button" className="wi-btn is-primary" onClick={props.onClose}>Weiter</button>
    </div>
  );
}

// ---------------- Frage (Lektion und Blitzrunde) ----------------
function QuestionCard(props: { q: Question; onChecked: (ok: boolean, chosen: string[]) => void; onNext: () => void; quick?: boolean }) {
  const { q } = props;
  const options = useMemo(() => shuffle(q.options), [q]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [result, setResult] = useState<boolean | null>(null);
  const multi = q.type === "multi";
  const pick = (id: string) => {
    if (result !== null) return;
    setChosen((c) => (multi ? (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]) : [id]));
  };
  const check = () => {
    const ok = isCorrect(q, chosen);
    (ok ? sounds.correct : sounds.wrong)();
    setResult(ok);
    props.onChecked(ok, chosen);
    if (props.quick) setTimeout(props.onNext, ok ? 450 : 1400);
  };
  const state = (id: string) => {
    if (result === null) return chosen.includes(id) ? "is-chosen" : "";
    if (q.correct.includes(id)) return "is-right";
    return chosen.includes(id) ? "is-wrong" : "is-dim";
  };
  return (
    <div className={`wi-q${result === false ? " is-shake" : ""}`}>
      <p className="wi-q-meta">{["", "leicht", "mittel", "schwer"][q.difficulty]}{multi ? " · Mehrere Antworten möglich" : ""}</p>
      <h2 className="wi-q-prompt">{q.prompt}</h2>
      {q.image && <img className="wi-q-img" src={q.image} alt="" />}
      <div className="wi-options" role={multi ? "group" : "radiogroup"}>
        {options.map((o) => (
          <button key={o.id} type="button" className={`wi-option ${state(o.id)}`} onClick={() => pick(o.id)}
            role={multi ? "checkbox" : "radio"} aria-checked={chosen.includes(o.id)}>
            {multi && <span className="wi-box" aria-hidden>{chosen.includes(o.id) ? "✓" : ""}</span>}
            {o.text}
          </button>
        ))}
      </div>
      {result === null ? (
        <div className="wi-foot">
          <button type="button" className="wi-btn is-primary" disabled={!chosen.length} onClick={check}>Prüfen</button>
        </div>
      ) : (
        <div className={`wi-feedback ${result ? "is-ok" : "is-bad"}`} ref={(el) => el?.scrollIntoView({ behavior: "smooth", block: "end" })}>
          <b>{result ? "Richtig! ⚡" : "Nicht ganz – kommt gleich nochmal."}</b>
          {!props.quick && <p>{q.explanation}</p>}
          {!props.quick && <small>Quelle: {q.source}</small>}
          {!props.quick && <button type="button" className="wi-btn is-primary" onClick={props.onNext}>Weiter</button>}
        </div>
      )}
    </div>
  );
}

// ---------------- Lektion ----------------
function Lesson(props: { mode: "lesson" | "review"; title: string; questions: Question[]; progress: ProgressMap; save: Save; onClose: () => void }) {
  const [queue, setQueue] = useState(() => props.questions.map((q) => q.id));
  const [pos, setPos] = useState(0);
  const [first, setFirst] = useState<Map<string, boolean>>(new Map());
  const [solved, setSolved] = useState<Set<string>>(new Set());
  const [xp, setXp] = useState(0);
  const [earned, setEarned] = useState(0);
  const [bonus, setBonus] = useState(false);
  const [done, setDone] = useState(false);
  const total = props.questions.length;

  if (!total) {
    return (
      <div className="wi">
        <TopBar done={0} total={1} onClose={props.onClose} />
        <Notice tone="info">Gerade nichts zu wiederholen – stark!</Notice>
      </div>
    );
  }
  if (done) {
    const perfect = [...first.values()].every(Boolean);
    return (
      <Finish title={perfect ? "Fehlerfrei! 🎉" : "Lektion geschafft!"} xp={xp}
        lines={[
          `${[...first.values()].filter(Boolean).length} von ${total} beim ersten Versuch richtig`,
          ...(bonus ? [`+${PERFECT_BONUS} XP Bonus für null Fehler`] : []),
          ...(xp === 0 ? ["Übungsrunde: Diese Fragen kannst du schon – Punkte gibt es wieder für neue oder fällige Fragen."] : []),
        ]}
        onClose={props.onClose} />
    );
  }
  const q = QUESTIONS.find((x) => x.id === queue[pos])!;
  const checked = (ok: boolean, chosen: string[]) => {
    const isFirst = !first.has(q.id);
    const base = XP_BY_DIFFICULTY[q.difficulty];
    const gain = isFirst && earnsXp(props.progress.get(q.id), ok) ? base : 0;
    if (isFirst) setFirst((m) => new Map(m).set(q.id, ok));
    if (gain) setEarned((n) => n + 1);
    props.save({ id: q.id, type: "question", correct: ok, mode: props.mode, xp: gain, base, answer: chosen, leitner: isFirst });
    setXp((x) => x + gain);
    if (ok) setSolved((s) => new Set(s).add(q.id));
    else setQueue((list) => [...list, q.id]); // falsch → ans Ende, bis es sitzt
  };
  const next = () => {
    if (pos + 1 < queue.length) return setPos(pos + 1);
    // Bonus nur, wenn mindestens 5 Fragen dieser Runde Punkte gebracht haben (nicht fürs reine Wiederholen)
    const perfect = [...first.values()].every(Boolean) && earned >= 5;
    if (perfect) {
      props.save({ id: `bonus:${props.mode}`, type: "question", correct: true, mode: props.mode, xp: PERFECT_BONUS, base: PERFECT_BONUS, leitner: false });
      setXp((x) => x + PERFECT_BONUS);
    }
    setBonus(perfect);
    setDone(true);
  };
  return (
    <div className="wi wi-run">
      <TopBar done={solved.size} total={total} onClose={props.onClose} extra={<span className="wi-top-xp">⚡ {xp}</span>} />
      <p className="wi-run-title">{props.title}</p>
      <QuestionCard key={`${q.id}-${pos}`} q={q} onChecked={checked} onNext={next} />
    </div>
  );
}

// ---------------- Karteikarten ----------------
function FlipCard(props: { card: Flashcard; onAnswer: (known: boolean) => void }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <div className="wi-cardwrap">
      <button type="button" className={`wi-card${flipped ? " is-flipped" : ""}`} onClick={() => setFlipped(true)} aria-label={flipped ? "Rückseite" : "Umdrehen"}>
        <span className="wi-card-face is-front"><span className="wi-card-text">{props.card.front}</span><small>Tippen zum Umdrehen</small></span>
        <span className="wi-card-face is-back"><span className="wi-card-text">{props.card.back}</span><small>Quelle: {props.card.source}</small></span>
      </button>
      {flipped ? (
        <div className="wi-card-actions">
          <button type="button" className="wi-btn is-again" onClick={() => (sounds.wrong(), props.onAnswer(false))}>Nochmal</button>
          <button type="button" className="wi-btn is-primary" onClick={() => (sounds.known(), props.onAnswer(true))}>Gewusst</button>
        </div>
      ) : (
        <div className="wi-card-actions"><button type="button" className="wi-btn" onClick={() => setFlipped(true)}>Umdrehen</button></div>
      )}
    </div>
  );
}

function DeckRun(props: { deck: Deck; progress: ProgressMap; save: Save; onClose: () => void }) {
  const cards = useMemo(() => CARDS.filter((c) => c.deckId === props.deck.id), [props.deck.id]);
  const [queue, setQueue] = useState(() => cards.map((c) => c.id));
  const [pos, setPos] = useState(0);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [known, setKnown] = useState<Set<string>>(new Set());
  const [xp, setXp] = useState(0);
  if (pos >= queue.length) {
    return <Finish title="Deck geschafft!" xp={xp} lines={[`${props.deck.title} · ${cards.length} Karten`]} onClose={props.onClose} />;
  }
  const card = CARDS.find((c) => c.id === queue[pos])!;
  const answer = (ok: boolean) => {
    const isFirst = !seen.has(card.id);
    const gain = isFirst && earnsXp(props.progress.get(card.id), ok) ? CARD_XP : 0;
    setSeen((s) => new Set(s).add(card.id));
    if (ok) setKnown((s) => new Set(s).add(card.id));
    props.save({ id: card.id, type: "card", correct: ok, mode: "blitzi", xp: gain, base: CARD_XP, leitner: isFirst });
    setXp((x) => x + gain);
    if (!ok) setQueue((list) => [...list, card.id]);
    setPos(pos + 1);
  };
  return (
    <div className="wi wi-run">
      <TopBar done={known.size} total={cards.length} onClose={props.onClose} extra={<span className="wi-top-xp">⚡ {xp}</span>} />
      <p className="wi-run-title">Woche {props.deck.week} · {props.deck.title}</p>
      <FlipCard key={`${card.id}-${pos}`} card={card} onAnswer={answer} />
    </div>
  );
}

// ---------------- Blitzrunde (60 s) ----------------
type BlitzItem = { kind: "q"; q: Question } | { kind: "c"; c: Flashcard };

function blitzPool(progress: ProgressMap): BlitzItem[] {
  const open = unlockedUnits(progress);
  const dueQ = dueQuestions(progress).map((q) => ({ kind: "q", q }) as BlitzItem);
  const dueC = dueCards(progress).map((c) => ({ kind: "c", c }) as BlitzItem);
  const more = shuffle([
    ...QUESTIONS.filter((q) => open.has(q.unitId)).map((q) => ({ kind: "q", q }) as BlitzItem),
    ...CARDS.map((c) => ({ kind: "c", c }) as BlitzItem),
  ]);
  const seen = new Set<string>();
  const out: BlitzItem[] = [];
  // erst Fälliges, dann Neues (bringt Punkte), danach alles Übrige zum Üben
  const isNew = (it: BlitzItem) => !progress.has(it.kind === "q" ? it.q.id : it.c.id);
  for (const it of [...shuffle([...dueQ, ...dueC]), ...more.filter(isNew), ...more.filter((x) => !isNew(x))]) {
    const id = it.kind === "q" ? it.q.id : it.c.id;
    if (!seen.has(id)) (seen.add(id), out.push(it));
  }
  return out;
}

function BlitzRound(props: { progress: ProgressMap; save: Save; onClose: () => void }) {
  const [pool] = useState(() => blitzPool(props.progress));
  const [pos, setPos] = useState(0);
  const [left, setLeft] = useState(BLITZ_SECONDS);
  const [xp, setXp] = useState(0);
  const [right, setRight] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  if (left <= 0 || pos >= pool.length) {
    return <Finish title="Zeit um! ⏱️" xp={xp} lines={[`${right} richtig in ${BLITZ_SECONDS} Sekunden`]} onClose={props.onClose} />;
  }
  const it = pool[pos];
  const next = () => setPos((p) => p + 1);
  const scored = (id: string, type: ItemType, ok: boolean, base: number, answer?: string[]) => {
    const gain = earnsXp(props.progress.get(id), ok) ? base : 0;
    props.save({ id, type, correct: ok, mode: "blitzrunde", xp: gain, base, answer, leitner: true });
    setXp((x) => x + gain);
    if (ok) setRight((r) => r + 1);
  };
  return (
    <div className="wi wi-run">
      <TopBar done={BLITZ_SECONDS - left} total={BLITZ_SECONDS} onClose={props.onClose} extra={<span className={`wi-top-xp${left <= 10 ? " is-hurry" : ""}`}>⏱ {left}s</span>} />
      <p className="wi-run-title">⚡ Blitzrunde · {right} richtig · ⚡ {xp} XP</p>
      {it.kind === "q" ? (
        <QuestionCard key={`q-${pos}`} q={it.q} quick onNext={next}
          onChecked={(ok, chosen) => scored(it.q.id, "question", ok, XP_BY_DIFFICULTY[it.q.difficulty], chosen)} />
      ) : (
        <FlipCard key={`c-${pos}`} card={it.c} onAnswer={(ok) => (scored(it.c.id, "card", ok, CARD_XP), next())} />
      )}
    </div>
  );
}
