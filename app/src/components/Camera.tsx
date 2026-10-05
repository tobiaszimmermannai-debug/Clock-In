import { type RefObject, useEffect, useRef, useState } from "react";

// Rückkamera starten (QR-Code scannen); Stream wird beim Verlassen sofort beendet
export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Kamera nicht verfügbar. Die App muss über HTTPS geöffnet werden.");
      return;
    }
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(async (s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = s;
        await video.play().catch(() => {});
        setReady(true);
      })
      .catch((e: unknown) => setError(cameraError(e)));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return { videoRef, error, ready };
}

function cameraError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError") return "Kamera-Zugriff verweigert. Bitte in den Browser-Einstellungen erlauben.";
  if (name === "NotFoundError") return "Keine Kamera gefunden.";
  if (name === "NotReadableError") return "Die Kamera wird gerade von einer anderen App benutzt.";
  return "Die Kamera konnte nicht gestartet werden.";
}

export function CameraView(props: { videoRef: RefObject<HTMLVideoElement | null>; error: string | null; hint: string }) {
  return (
    <div className="camera">
      <div className="camera-frame">
        <video ref={props.videoRef} playsInline muted />
        <div className="camera-guide" aria-hidden="true" />
      </div>
      <p className={props.error ? "camera-hint is-error" : "camera-hint"} role="status" aria-live="polite">
        {props.error ?? props.hint}
      </p>
    </div>
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
