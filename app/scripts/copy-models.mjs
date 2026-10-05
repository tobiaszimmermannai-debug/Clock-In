// Kopiert die benötigten face-api-Modelle nach public/models (für Dev-Server, Build und Offline-Cache)
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/@vladmandic/face-api/model");
const dest = join(root, "public/models");
const models = ["tiny_face_detector_model", "face_landmark_68_model", "face_recognition_model"];

mkdirSync(dest, { recursive: true });
for (const m of models) {
  for (const file of [`${m}-weights_manifest.json`, `${m}.bin`]) copyFileSync(join(src, file), join(dest, file));
}
console.log(`face-api-Modelle kopiert → public/models (${models.length})`);
