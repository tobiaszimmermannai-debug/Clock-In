// Verwaltung (Leitung/Admin): Anmeldung inkl. 2FA, danach Mitarbeiter & Gesichtserfassung
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { staffLoginEmail } from "../lib/config";
import { adminDb } from "../lib/supabase";
import type { Role } from "../lib/types";
import { Approvals } from "./Approvals";
import { Plan } from "./Plan";
import { Staff } from "./Staff";
import { Tablets } from "./Tablets";
import { Times } from "./Times";

export type Profile = { id: string; first_name: string; last_name: string; role: Role };

type Phase =
  | { kind: "loading" }
  | { kind: "login"; error?: string }
  | { kind: "mfa-verify"; factorId: string; error?: string }
  | { kind: "mfa-enroll"; factorId: string; qr: string; secret: string; error?: string }
  | { kind: "denied"; text: string }
  | { kind: "ready"; profile: Profile; mfa: boolean };

export function AdminApp() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const resolve = useCallback(async () => {
    const { data } = await adminDb.auth.getSession();
    if (!data.session) return setPhase({ kind: "login" });

    const { data: profile } = await adminDb
      .from("users")
      .select("id, first_name, last_name, role")
      .eq("auth_user_id", data.session.user.id)
      .maybeSingle<Profile>();
    if (!profile || (profile.role !== "admin" && profile.role !== "manager")) {
      return setPhase({ kind: "denied", text: "Die Verwaltung ist nur für Studioleitung und Admins." });
    }

    const { data: aal } = await adminDb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === "aal2") return setPhase({ kind: "ready", profile, mfa: true });

    const { data: factors } = await adminDb.auth.mfa.listFactors();
    const verified = factors?.totp.find((f) => f.status === "verified");
    if (verified) return setPhase({ kind: "mfa-verify", factorId: verified.id });

    // Admins brauchen 2FA zwingend, Studioleitung optional
    if (profile.role !== "admin") return setPhase({ kind: "ready", profile, mfa: false });
    for (const f of factors?.all ?? []) {
      if (f.factor_type === "totp" && f.status === "unverified") await adminDb.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data: enrolled, error } = await adminDb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Clock-In" });
    if (error || !enrolled) return setPhase({ kind: "denied", text: `2FA-Einrichtung fehlgeschlagen: ${error?.message}` });
    setPhase({ kind: "mfa-enroll", factorId: enrolled.id, qr: enrolled.totp.qr_code, secret: enrolled.totp.secret });
  }, []);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  async function verify(factorId: string, code: string) {
    const { error } = await adminDb.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) {
      setPhase((p) => (p.kind === "mfa-verify" || p.kind === "mfa-enroll" ? { ...p, error: "Code falsch oder abgelaufen." } : p));
      return;
    }
    void resolve();
  }

  async function logout() {
    await adminDb.auth.signOut();
    setPhase({ kind: "login" });
  }

  return (
    <div className="screen admin">
      <header className="admin-bar">
        <strong>Clock-In Verwaltung</strong>
        <nav>
          <a href="#/kiosk">Kiosk</a>
          {phase.kind !== "login" && phase.kind !== "loading" && (
            <button type="button" className="btn-link" onClick={logout}>Abmelden</button>
          )}
        </nav>
      </header>
      <main className="admin-main">
        {phase.kind === "loading" && <p className="muted">Lädt …</p>}
        {phase.kind === "login" && <Login error={phase.error} onDone={resolve} />}
        {phase.kind === "denied" && <p className="card">{phase.text}</p>}
        {phase.kind === "mfa-verify" && (
          <CodeForm
            title="Bestätigungscode"
            text="Code aus deiner Authenticator-App eingeben."
            error={phase.error}
            onSubmit={(code) => verify(phase.factorId, code)}
          />
        )}
        {phase.kind === "mfa-enroll" && (
          <CodeForm
            title="2FA einrichten"
            text="Admin-Rechte gibt es nur mit zweitem Faktor. QR-Code mit einer Authenticator-App scannen (z. B. Google Authenticator, Microsoft Authenticator) und den 6-stelligen Code eingeben."
            error={phase.error}
            onSubmit={(code) => verify(phase.factorId, code)}
          >
            <img className="qr" src={phase.qr} alt="QR-Code für die Authenticator-App" width={200} height={200} />
            <p className="muted small">
              Ohne Kamera: Schlüssel manuell eingeben <code className="secret">{phase.secret}</code>
            </p>
          </CodeForm>
        )}
        {phase.kind === "ready" && (
          <>
            {!phase.mfa && (
              <p className="notice notice-info">Tipp: 2FA lässt sich auch für die Studioleitung aktivieren.</p>
            )}
            <AdminHome profile={phase.profile} />
          </>
        )}
      </main>
    </div>
  );
}

function Login(props: { error?: string; onDone: () => void }) {
  const [error, setError] = useState(props.error);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    const { error } = await adminDb.auth.signInWithPassword({
      email: staffLoginEmail(String(form.get("email"))),
      password: String(form.get("password")),
    });
    setBusy(false);
    if (error) return setError("Anmeldung fehlgeschlagen. E-Mail oder Passwort falsch.");
    props.onDone();
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h1>Anmelden</h1>
      <label>
        E-Mail oder Benutzername
        <input id="admin-email" name="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
      </label>
      <label>
        Passwort
        <input id="admin-password" name="password" type="password" autoComplete="current-password" required />
      </label>
      {error && <p className="form-error">{error}</p>}
      <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Anmelden …" : "Anmelden"}</button>
    </form>
  );
}

function CodeForm(props: {
  title: string;
  text: string;
  error?: string;
  onSubmit: (code: string) => Promise<void>;
  children?: React.ReactNode;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await props.onSubmit(code);
        setBusy(false);
        setCode("");
      }}
    >
      <h1>{props.title}</h1>
      <p className="muted">{props.text}</p>
      {props.children}
      <label>
        6-stelliger Code
        <input
          id="mfa-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          required
        />
      </label>
      {props.error && <p className="form-error">{props.error}</p>}
      <button type="submit" className="btn-primary" disabled={busy || code.length !== 6}>Bestätigen</button>
    </form>
  );
}

function AdminHome({ profile }: { profile: Profile }) {
  const isAdmin = profile.role === "admin";
  const tabs = [
    { id: "staff", label: "Mitarbeiter" },
    { id: "plan", label: "Dienstplan" },
    { id: "times", label: "Zeiten" },
    { id: "approvals", label: "Freigaben" },
    ...(isAdmin ? [{ id: "tablets", label: "Tablets" }] : []),
  ] as const;
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("staff");
  return (
    <>
      <nav className="tabs" aria-label="Bereiche">
        {tabs.map((t) => (
          <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>
      {tab === "staff" && <Staff profile={profile} />}
      {tab === "plan" && <Plan profile={profile} />}
      {tab === "times" && <Times profile={profile} />}
      {tab === "approvals" && <Approvals profile={profile} />}
      {tab === "tablets" && isAdmin && <Tablets />}
    </>
  );
}
