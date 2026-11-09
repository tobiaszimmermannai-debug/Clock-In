// Kurze Lern-Sounds (Reiter „Wissen“), direkt im Browser erzeugt (Web Audio) – keine Audiodateien, offline nutzbar.
// Stummschalten wird pro Gerät gemerkt.
const MUTE_KEY = "clockin-wissen-mute";

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // egal
  }
}

type Note = { f: number; at: number; len: number; type?: OscillatorType; vol?: number; slide?: number };

function play(notes: Note[]) {
  if (isMuted()) return;
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + 0.01;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.setValueAtTime(n.f, t0 + n.at);
    if (n.slide) osc.frequency.exponentialRampToValueAtTime(n.slide, t0 + n.at + n.len);
    const v = n.vol ?? 0.18;
    gain.gain.setValueAtTime(0.0001, t0 + n.at);
    gain.gain.exponentialRampToValueAtTime(v, t0 + n.at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.len + 0.02);
  }
}

export const sounds = {
  /** Richtig: heller Zwei-Ton aufwärts */
  correct: () => play([
    { f: 880, at: 0, len: 0.12, type: "triangle" },
    { f: 1318.5, at: 0.09, len: 0.22, type: "triangle" },
  ]),
  /** Falsch: tiefes, kurzes Brummen abwärts */
  wrong: () => play([
    { f: 196, at: 0, len: 0.16, type: "square", vol: 0.07, slide: 160 },
    { f: 155, at: 0.13, len: 0.24, type: "square", vol: 0.07, slide: 120 },
  ]),
  /** Karte gewusst: kurzer Ding */
  known: () => play([{ f: 1046.5, at: 0, len: 0.18, type: "sine", vol: 0.15 }]),
  /** Lektion / Runde geschafft: kleine Fanfare */
  finish: () => play([
    { f: 523.25, at: 0, len: 0.14, type: "triangle" },
    { f: 659.25, at: 0.12, len: 0.14, type: "triangle" },
    { f: 783.99, at: 0.24, len: 0.14, type: "triangle" },
    { f: 1046.5, at: 0.36, len: 0.4, type: "triangle", vol: 0.2 },
  ]),
};
