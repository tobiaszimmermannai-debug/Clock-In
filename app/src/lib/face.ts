// Gesichtserkennung im Browser (face-api.js). Es werden nur 128-d Vektoren verarbeitet, keine Bilder gespeichert.
// Die Bibliothek (inkl. TensorFlow, ~1,7 MB) wird erst bei Bedarf geladen.
import { type Box, yaw } from "./liveness";

type FaceApi = typeof import("@vladmandic/face-api");

let api: FaceApi | null = null;
let loading: Promise<void> | null = null;

export function loadModels(): Promise<void> {
  loading ??= (async () => {
    const faceapi = await import("@vladmandic/face-api");
    // Die mitgelieferten tfjs-Typen sind unvollständig; ready() existiert zur Laufzeit
    await (faceapi.tf as unknown as { ready(): Promise<void> }).ready();
    const url = `${import.meta.env.BASE_URL}models`;
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(url),
      faceapi.nets.faceLandmark68Net.loadFromUri(url),
      faceapi.nets.faceRecognitionNet.loadFromUri(url),
    ]);
    api = faceapi;
  })().catch((e) => {
    loading = null; // nächster Versuch lädt neu
    throw e;
  });
  return loading;
}

export type DetectedFace = { descriptor: Float32Array; score: number; yaw: number; box: Box };

export async function detectFaces(input: HTMLVideoElement | HTMLCanvasElement): Promise<DetectedFace[]> {
  await loadModels();
  const faceapi = api!;
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const results = await faceapi.detectAllFaces(input, options).withFaceLandmarks().withFaceDescriptors();
  return results.map((r) => {
    const { x, y, width, height } = r.detection.box;
    return {
      descriptor: r.descriptor,
      score: r.detection.score,
      yaw: yaw(r.landmarks.positions),
      box: { x, y, width, height },
    };
  });
}
