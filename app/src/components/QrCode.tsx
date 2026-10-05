// QR-Code als SVG (scharf in jeder Größe, ohne Bilddatei)
import qrcode from "qrcode-generator";
import { useMemo } from "react";

const QUIET = 3; // Ruhezone in Modulen

export function QrCode(props: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(props.text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    }
    return { size: n + 2 * QUIET, path: d };
  }, [props.text]);

  return (
    <svg className="qr-code" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={props.label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
