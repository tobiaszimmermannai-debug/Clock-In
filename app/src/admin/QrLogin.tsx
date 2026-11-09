// Verwaltung: Anmeldung der Studioleitung per QR-Code (externe Geräte, z. B. privater PC).
// Der Browser zeigt einen Code; die Studioleitung scannt ihn mit ihrem registrierten Stempel-Handy und bestätigt.
import { useCallback, useEffect, useRef, useState } from "react";
import { QrCode } from "../components/QrCode";
import { Notice } from "../components/ui";
import { qrLoginUrl } from "../lib/qrLogin";
import { existingPhoneKey } from "../lib/stamp";
import { adminDb, portalDb } from "../lib/supabase";

const POLL_MS = 2_000;
const QR_MS = 2 * 60_000;

export function QrLogin(props: { onDone: () => void }) {
  const [code, setCode] = useState<{ token: string; secret: string } | null>(null);
  const [error, setError] = useState<string>();
  const [who, setWho] = useState<string | null>(null);
  const [here, setHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = useRef(props.onDone);
  done.current = props.onDone;

  const fresh = useCallback(async () => {
    const { data, error } = await adminDb.rpc("qr_login_challenge");
    if (error) return setError(error.message);
    setCode(data as { token: string; secret: string });
  }, []);

  useEffect(() => {
    void fresh();
  }, [fresh]);

  // Ist das hier selbst das registrierte Stempel-Handy (angemeldet im Mitarbeiterbereich)? Dann ohne Scannen bestätigen.
  useEffect(() => {
    if (!existingPhoneKey()) return;
    void portalDb.auth.getSession().then(({ data }) => setHere(Boolean(data.session)));
  }, []);
  async function confirmHere() {
    if (!code) return;
    setBusy(true);
    setError(undefined);
    const { error } = await portalDb.rpc("qr_login_unlock", { p_token: code.token, p_phone_key: existingPhoneKey() ?? "" });
    setBusy(false);
    if (error) setError(error.message);
  }

  useEffect(() => {
    if (!code) return;
    let stop = false;
    const started = Date.now();
    const tick = async () => {
      if (stop) return;
      if (Date.now() - started > QR_MS) return void fresh();
      const { data } = await adminDb.rpc("qr_login_status", { p_token: code.token, p_secret: code.secret });
      const st = data as { unlocked?: boolean; name?: string | null } | null;
      if (stop) return;
      if (!st?.unlocked) return void setTimeout(tick, POLL_MS);
      setWho(st.name ?? "Studioleitung");
      try {
        const res = await adminDb.functions.invoke("qr-login", { body: code });
        const body = res.data as { token_hash?: string; error?: string } | null;
        if (res.error || !body?.token_hash) throw new Error(body?.error ?? "Anmeldung fehlgeschlagen.");
        const { error: otpError } = await adminDb.auth.verifyOtp({ token_hash: body.token_hash, type: "magiclink" });
        if (otpError) throw new Error(otpError.message);
        done.current();
      } catch (e) {
        setWho(null);
        setError(e instanceof Error ? e.message : String(e));
        void fresh();
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [code, fresh]);

  return (
    <div className="panel stack qr-login">
      <div className="qr-login-code">{code ? <QrCode text={qrLoginUrl(code.token)} label="QR-Code zum Anmelden" /> : <span className="muted">Lädt …</span>}</div>
      <ol className="qr-login-steps">
        <li>Clock-In auf <b>deinem Stempel-Handy</b> öffnen</li>
        <li><b>Stempeln → Scannen</b> und diesen Code scannen</li>
        <li>„Am PC anmelden“ tippen – fertig</li>
      </ol>
      {here && (
        <button type="button" className="btn btn-primary btn-block" disabled={!code || busy || Boolean(who)} onClick={() => void confirmHere()}>
          Mit diesem Handy anmelden
        </button>
      )}
      {who && <Notice tone="ok">{who} hat bestätigt – du wirst angemeldet …</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <p className="muted small">Der Code wechselt alle 2 Minuten. Die Anmeldung gilt 12 Stunden.</p>
    </div>
  );
}
