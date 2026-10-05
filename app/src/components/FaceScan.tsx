// Kiosk: Person per Gesicht erkennen (mehrere übereinstimmende Frames in Folge)
import { useEffect, useRef, useState } from "react";
import { detectFaces, loadModels } from "../lib/face";
import { identify, type Match } from "../lib/match";
import type { RosterEntry } from "../lib/types";
import { CameraView, sleep, useCamera } from "./Camera";

const TIMEOUT_MS = 15_000;
const REQUIRED_STREAK = 3;

export function FaceScan(props: {
  roster: RosterEntry[];
  onMatch: (m: Match) => void;
  onTimeout: () => void;
}) {
  const { videoRef, error, ready } = useCamera();
  const [hint, setHint] = useState("Kamera startet …");
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
      let streakId = "";
      let streak = 0;
      setHint("Bitte in die Kamera schauen");

      while (!stop) {
        const video = videoRef.current;
        if (video && video.readyState >= 2) {
          const faces = await detectFaces(video);
          if (stop) return;
          if (faces.length !== 1) {
            streak = 0;
            setHint(faces.length === 0 ? "Bitte in die Kamera schauen" : "Bitte nur eine Person vor der Kamera");
          } else {
            const match = identify(faces[0].descriptor, latest.current.roster);
            if (!match) {
              streak = 0;
              setHint("Nicht erkannt – bitte gerade in die Kamera schauen");
            } else {
              streak = match.entry.user_id === streakId ? streak + 1 : 1;
              streakId = match.entry.user_id;
              setHint("Erkenne …");
              if (streak >= REQUIRED_STREAK) return latest.current.onMatch(match);
            }
          }
        }
        if (Date.now() - started > TIMEOUT_MS) return latest.current.onTimeout();
        await sleep(120);
      }
    })();
    return () => {
      stop = true;
    };
  }, [ready, videoRef]);

  return <CameraView videoRef={videoRef} error={error} hint={hint} />;
}
