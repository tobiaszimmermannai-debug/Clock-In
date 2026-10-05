// Kiosk: Person erkennen + Lebenderkennung (zufällige Kopfdrehung) gegen Fotos
import { useEffect, useRef, useState } from "react";
import { detectFaces, loadModels } from "../lib/face";
import { type Box, type Direction, isCentered, randomChallenges, sameFace, turnedTo } from "../lib/liveness";
import { identify, type Match, MATCH_THRESHOLD, rankCandidates } from "../lib/match";
import type { RosterEntry } from "../lib/types";
import { CameraView, sleep, useCamera } from "./Camera";

const TIMEOUT_MS = 20_000;
const REQUIRED_STREAK = 3;   // aufeinanderfolgende Treffer für die Identifikation
const LIVENESS_STEPS = 2;    // Anzahl zufälliger Drehungen
const TURN_FRAMES = 2;       // Drehung muss in so vielen Bildern hintereinander sichtbar sein

const ARROW: Record<Direction, string> = { left: "←", right: "→" };
const TURN_HINT: Record<Direction, string> = {
  left: "Kopf langsam nach links drehen",
  right: "Kopf langsam nach rechts drehen",
};

type Step = { kind: "identify" } | { kind: "turn"; index: number } | { kind: "center"; index: number };

export function FaceScan(props: {
  roster: RosterEntry[];
  onMatch: (m: Match) => void;
  onTimeout: () => void;
}) {
  const { videoRef, error, ready } = useCamera();
  const [hint, setHint] = useState("Kamera startet …");
  const [arrow, setArrow] = useState<Direction | null>(null);
  const [diag, setDiag] = useState("");
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!ready) return;
    let stop = false;
    (async () => {
      setHint("Gesichtserkennung wird geladen …");
      try {
        await loadModels();
      } catch {
        setHint("Gesichtserkennung konnte nicht geladen werden.");
        return;
      }
      const started = Date.now();
      let step: Step = { kind: "identify" };
      let streakId = "";
      let streak = 0;
      let turnFrames = 0;
      let match: Match | null = null;
      let challenges: Direction[] = [];
      let lastBox: Box | null = null;

      const restart = (text: string) => {
        step = { kind: "identify" };
        streak = 0;
        match = null;
        lastBox = null;
        setArrow(null);
        setHint(text);
      };
      setHint("Bitte geradeaus in die Kamera schauen");

      while (!stop) {
        if (Date.now() - started > TIMEOUT_MS) return latest.current.onTimeout();
        const video = videoRef.current;
        if (!video || video.readyState < 2) {
          await sleep(100);
          continue;
        }
        const faces = await detectFaces(video);
        if (stop) return;

        if (faces.length !== 1) {
          if (step.kind !== "identify") restart("Bitte vor der Kamera bleiben – Prüfung startet neu");
          else setHint(faces.length === 0 ? "Bitte geradeaus in die Kamera schauen" : "Bitte nur eine Person vor der Kamera");
          streak = 0;
          await sleep(80);
          continue;
        }
        const face = faces[0];
        if (step.kind !== "identify" && lastBox && !sameFace(lastBox, face.box)) {
          restart("Bitte ruhig vor der Kamera bleiben – Prüfung startet neu");
          continue;
        }
        lastBox = face.box;

        if (step.kind === "identify") {
          // Diagnose für die Einrichtung: Kopfhaltung und Ähnlichkeit zur nächsten gespeicherten Person
          const [best] = rankCandidates(face.descriptor, latest.current.roster);
          setDiag(
            `${latest.current.roster.length} Person(en) gespeichert · Kopf ${isCentered(face.yaw) ? "gerade" : "seitlich"} (${
              face.yaw.toFixed(2)
            }) · Abstand ${best ? best.distance.toFixed(2) : "–"} (nötig unter ${MATCH_THRESHOLD.toFixed(2)})`,
          );
          if (!isCentered(face.yaw)) {
            streak = 0;
            setHint("Bitte geradeaus in die Kamera schauen");
          } else {
            const m = identify(face.descriptor, latest.current.roster);
            if (!m) {
              streak = 0;
              setHint("Nicht erkannt – bitte geradeaus in die Kamera schauen");
            } else {
              streak = m.entry.user_id === streakId ? streak + 1 : 1;
              streakId = m.entry.user_id;
              setHint("Erkenne …");
              if (streak >= REQUIRED_STREAK) {
                match = m;
                challenges = randomChallenges(LIVENESS_STEPS);
                step = { kind: "turn", index: 0 };
                turnFrames = 0;
                setArrow(challenges[0]);
                setHint(`${TURN_HINT[challenges[0]]} (1/${LIVENESS_STEPS})`);
              }
            }
          }
        } else if (step.kind === "turn") {
          turnFrames = turnedTo(face.yaw, challenges[step.index]) ? turnFrames + 1 : 0;
          if (turnFrames >= TURN_FRAMES) {
            step = { kind: "center", index: step.index };
            setArrow(null);
            setHint("Und wieder geradeaus schauen");
          }
        } else {
          // Zurück in der Mitte: dieselbe Person muss wieder erkannt werden
          if (isCentered(face.yaw)) {
            const again = identify(face.descriptor, latest.current.roster);
            if (again && match && again.entry.user_id !== match.entry.user_id) {
              restart("Personenwechsel erkannt – Prüfung startet neu");
            } else if (again && match) {
              const next: number = step.index + 1;
              if (next >= LIVENESS_STEPS) return latest.current.onMatch(match);
              step = { kind: "turn", index: next };
              turnFrames = 0;
              setArrow(challenges[next]);
              setHint(`${TURN_HINT[challenges[next]]} (${next + 1}/${LIVENESS_STEPS})`);
            }
          }
        }
        await sleep(60);
      }
    })();
    return () => {
      stop = true;
    };
  }, [ready, videoRef]);

  return (
    <CameraView
      videoRef={videoRef}
      error={error}
      hint={hint}
      overlay={arrow && <div className={`turn-arrow turn-${arrow}`} aria-hidden="true">{ARROW[arrow]}</div>}
    >
      {diag && <p className="camera-diag">{diag}</p>}
    </CameraView>
  );
}
