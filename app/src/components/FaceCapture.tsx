// Leitung/Admin: mehrere Embeddings einer Person aufnehmen (nur Vektoren, kein Foto)
import { useEffect, useRef, useState } from "react";
import { detectFaces, loadModels } from "../lib/face";
import { euclidean } from "../lib/match";
import { CameraView, sleep, useCamera } from "./Camera";

const SAMPLES = 5;
const MIN_SCORE = 0.75;
const MIN_GAP_MS = 350;
// Proben einer Person müssen untereinander ähnlich sein (sonst wackelig / andere Person im Bild)
const MAX_SPREAD = 0.45;

export function FaceCapture(props: { onCaptured: (descriptors: Float32Array[]) => void }) {
  const { videoRef, error, ready } = useCamera();
  const [hint, setHint] = useState("Kamera startet …");
  const [progress, setProgress] = useState(0);
  const onCaptured = useRef(props.onCaptured);
  onCaptured.current = props.onCaptured;

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
      let samples: Float32Array[] = [];
      let lastAt = 0;
      setHint("Gerade in die Kamera schauen, Kopf leicht bewegen");

      while (!stop) {
        const video = videoRef.current;
        if (video && video.readyState >= 2 && Date.now() - lastAt >= MIN_GAP_MS) {
          const faces = await detectFaces(video);
          if (stop) return;
          if (faces.length > 1) setHint("Bitte nur eine Person vor der Kamera");
          else if (faces.length === 1 && faces[0].score >= MIN_SCORE) {
            samples.push(faces[0].descriptor);
            lastAt = Date.now();
            setProgress(samples.length / SAMPLES);
            setHint(`Aufnahme ${samples.length} von ${SAMPLES} …`);
          }
          if (samples.length === SAMPLES) {
            if (spread(samples) <= MAX_SPREAD) return onCaptured.current(samples);
            samples = [];
            setProgress(0);
            setHint("Bitte ruhiger halten – Aufnahme startet neu");
          }
        }
        await sleep(100);
      }
    })();
    return () => {
      stop = true;
    };
  }, [ready, videoRef]);

  return <CameraView videoRef={videoRef} error={error} hint={hint} progress={progress} />;
}

function spread(samples: Float32Array[]): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) max = Math.max(max, euclidean(samples[i], samples[j]));
  }
  return max;
}
