// Fotonachweis vor dem Hochladen verkleinern: spart mobiles Datenvolumen beim Hochladen, Speicherplatz und
// die Datenmenge der Telegram-Nachricht an die Leitung. Längste Seite höchstens 1280 px, JPEG-Qualität 0,7
// (typisch 150–300 KB statt 3–5 MB). Kein Bild oder Fehler → Originaldatei.
export const MAX_SIDE = 1280;
export const QUALITY = 0.7;

/** Zielgröße bei gleichem Seitenverhältnis */
export function fitSize(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || typeof document === "undefined") return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    const { w, h } = fitSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", QUALITY));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}
