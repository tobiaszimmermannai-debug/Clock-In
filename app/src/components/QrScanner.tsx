// QR-Code mit der Handykamera lesen: eingebauter BarcodeDetector (Android/Chrome),
// sonst jsQR (z. B. iPhone) – wird erst bei Bedarf geladen
import { useEffect, useRef, useState } from "react";
import { CameraView, sleep, useCamera } from "./Camera";

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

async function nativeDetector(): Promise<Detector | null> {
  const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor & { getSupportedFormats?: () => Promise<string[]> } })
    .BarcodeDetector;
  if (!Ctor) return null;
  try {
    const formats = (await Ctor.getSupportedFormats?.()) ?? ["qr_code"];
    return formats.includes("qr_code") ? new Ctor({ formats: ["qr_code"] }) : null;
  } catch {
    return null;
  }
}

export function QrScanner(props: { onResult: (text: string) => void }) {
  const { videoRef, error, ready } = useCamera();
  const [hint, setHint] = useState("Kamera startet …");
  const onResult = useRef(props.onResult);
  onResult.current = props.onResult;

  useEffect(() => {
    if (!ready) return;
    let stop = false;
    (async () => {
      const detector = await nativeDetector();
      const jsQR = detector ? null : (await import("jsqr")).default;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      setHint("QR-Code am Tablet in den Rahmen halten");

      while (!stop) {
        const video = videoRef.current;
        if (video && video.readyState >= 2 && video.videoWidth > 0) {
          let text: string | undefined;
          try {
            if (detector) {
              text = (await detector.detect(video))[0]?.rawValue;
            } else if (jsQR && ctx) {
              const scale = Math.min(1, 640 / video.videoWidth);
              canvas.width = Math.round(video.videoWidth * scale);
              canvas.height = Math.round(video.videoHeight * scale);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              text = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data;
            }
          } catch {
            // einzelnes Bild nicht lesbar – weiter mit dem nächsten
          }
          if (stop) return;
          if (text) return onResult.current(text);
        }
        await sleep(150);
      }
    })();
    return () => {
      stop = true;
    };
  }, [ready, videoRef]);

  return <CameraView videoRef={videoRef} error={error} hint={hint} />;
}
