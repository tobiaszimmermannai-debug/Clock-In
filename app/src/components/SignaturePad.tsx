// Unterschrift mit Finger/Stift; Ergebnis als kompaktes SVG (Vektor, kein Foto)
import { type PointerEvent, useEffect, useRef } from "react";

type Point = { x: number; y: number };
const MIN_POINTS = 12;

export function SignaturePad(props: { onChange: (svg: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = getComputedStyle(canvas).color;
  }, []);

  const pointOf = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: Math.round(e.clientX - rect.left), y: Math.round(e.clientY - rect.top) };
  };

  function down(e: PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    strokes.current.push([pointOf(e)]);
  }

  function move(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const stroke = strokes.current.at(-1)!;
    const prev = stroke.at(-1)!;
    const next = pointOf(e);
    stroke.push(next);
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    const total = strokes.current.reduce((n, s) => n + s.length, 0);
    props.onChange(total >= MIN_POINTS ? toSvg() : null);
  }

  function clear() {
    strokes.current = [];
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    props.onChange(null);
  }

  function toSvg(): string {
    const { width, height } = canvasRef.current!.getBoundingClientRect();
    const d = strokes.current
      .map((s) => `M${s.map((p) => `${p.x} ${p.y}`).join("L")}${s.length === 1 ? "l0.1 0" : ""}`)
      .join("");
    const w = Math.round(width);
    const h = Math.round(height);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${d}" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  return (
    <div className="signature">
      <canvas
        ref={canvasRef}
        className="signature-pad"
        aria-label="Unterschriftenfeld"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
      <div className="row">
        <span className="muted small">Mit Finger oder Stift unterschreiben</span>
        <span className="spacer" />
        <button type="button" className="btn btn-plain btn-sm" onClick={clear}>Löschen</button>
      </div>
    </div>
  );
}
