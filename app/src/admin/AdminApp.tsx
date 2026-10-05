// Verwaltung (Leitung/Admin): Anmeldung inkl. 2FA, danach Dienstplan, Team, Zeiten, Freigaben, Tablets
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { Shell, type ShellTab } from "../components/Shell";
import { BrandMark, Field, Notice } from "../components/ui";
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

  if (phase.kind === "ready") {
    return <AdminHome profile={phase.profile} onLogout={logout} />;
  }

  return (
    <AuthLayout title="Verwaltung" text="Für Studioleitung und Geschäftsführung">
      {phase.kind === "loading" && <p className="muted" style={{ textAlign: "center" }}>Lädt …</p>}
      {phase.kind === "login" && <Login error={phase.error} onDone={resolve} />}
      {phase.kind === "denied" && (
        <div className="panel stack">
          <Notice tone="warn">{phase.text}</Notice>
          <button type="button" className="btn btn-outline" onClick={logout}>Abmelden</button>
        </div>
      )}
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
      {phase.kind !== "loading" && (
        <p className="auth-foot"><a href="#/">Zur Startseite</a></p>
      )}
    </AuthLayout>
  );
}

// Zentrierte Anmelde-Seite mit Logo (Verwaltung, Portal, Tablet)
export function AuthLayout(props: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-head">
          <BrandMark size={30} />
          <h1>{props.title}</h1>
          <p>{props.text}</p>
        </div>
        {props.children}
      </div>
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
    <form className="panel form" onSubmit={submit}>
      <Field label="E-Mail oder Benutzername">
        <input id="admin-email" name="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
      </Field>
      <Field label="Passwort">
        <input id="admin-password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Anmelden …" : "Anmelden"}</button>
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
      className="panel form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await props.onSubmit(code);
        setBusy(false);
        setCode("");
      }}
    >
      <h2>{props.title}</h2>
      <p className="muted">{props.text}</p>
      {props.children}
      <Field label="6-stelliger Code">
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
      </Field>
      {props.error && <Notice tone="error">{props.error}</Notice>}
      <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>Bestätigen</button>
    </form>
  );
}

type TabId = "plan" | "staff" | "times" | "approvals" | "tablets";

function AdminHome(props: { profile: Profile; onLogout: () => void }) {
  const { profile } = props;
  const isAdmin = profile.role === "admin";
  const [tab, setTab] = useState<TabId>("plan");
  const [open, setOpen] = useState(0);

  // Zähler für offene Freigaben in der Navigation
  useEffect(() => {
    void Promise.all([
      adminDb.from("time_logs").select("id", { count: "exact", head: true }).eq("approval_status", "pending"),
      adminDb.from("time_logs").select("id", { count: "exact", head: true }).eq("overtime_status", "pending"),
      adminDb.from("swap_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
    ]).then((r) => setOpen(r.reduce((n, x) => n + (x.count ?? 0), 0)));
  }, [tab]);

  const tabs: ShellTab<TabId>[] = [
    { id: "plan", label: "Dienstplan", icon: "calendar" },
    { id: "staff", label: "Team", icon: "users" },
    { id: "times", label: "Zeiten", icon: "clock" },
    { id: "approvals", label: "Freigaben", icon: "inbox", badge: open },
    ...(isAdmin ? [{ id: "tablets", label: "Tablets", icon: "tablet" } as const] : []),
  ];

  return (
    <Shell
      title="Clock-In"
      subtitle={`${profile.first_name} · ${isAdmin ? "Admin" : "Studioleitung"}`}
      tabs={tabs}
      current={tab}
      onTab={setTab}
      onLogout={props.onLogout}
    >
      {tab === "plan" && <Plan profile={profile} />}
      {tab === "staff" && <Staff profile={profile} />}
      {tab === "times" && <Times profile={profile} />}
      {tab === "approvals" && <Approvals profile={profile} />}
      {tab === "tablets" && isAdmin && <Tablets />}
    </Shell>
  );
}
