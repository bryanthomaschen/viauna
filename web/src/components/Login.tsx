import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Lock } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import type { AppConfig, SessionAccount } from "../lib/types";

export function Login({ config, adding, accounts }: { config: AppConfig | undefined; adding: boolean; accounts: SessionAccount[] }) {
  const client = useQueryClient();
  // ?email= from a link meant for a mailbox not signed in here.
  const [email, setEmail] = useState(() => new URLSearchParams(location.search).get("email") ?? "");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [imap, setImap] = useState({ host: "", port: 993, security: "tls" });
  const [smtp, setSmtp] = useState({ host: "", port: 465, security: "tls" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const appName = config?.appName ?? "Viauna";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const custom = config?.customServers && imap.host ? { imap, smtp: { ...smtp, host: smtp.host || imap.host } } : {};
      const res = await api.login({ email, password, username: username || undefined, add: adding, ...custom });
      await client.invalidateQueries({ queryKey: ["session"] });
      navigate(`/u/${res.index}/inbox`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div>
          <img src="/favicon.svg" alt="" width={48} height={48} />
          <h1>{adding ? "Add another account" : "Sign in"}</h1>
          <p className="lead">to continue to {appName}</p>
          {adding && accounts.length > 0 && (
            <p style={{ color: "var(--text-3)", marginTop: 24 }}>
              Signed in as {accounts.map((a) => a.email).join(", ")}.{" "}
              <a href="/u/0/inbox" onClick={(e) => { e.preventDefault(); navigate("/u/0/inbox"); }}>Back to your inbox</a>
            </p>
          )}
        </div>
        <div className="login-form">
          <input className="text-input" type="email" autoComplete="username" placeholder="Email address" aria-label="Email address"
            value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <input className="text-input" type="password" autoComplete="current-password" placeholder="Password" aria-label="Password"
            value={password} onChange={(e) => setPassword(e.target.value)} required />
          {error && (
            <div className="error" role="alert"><CircleAlert size={16} /> {error}</div>
          )}
          {config?.customServers && (
            <details>
              <summary>Server settings</summary>
              <p style={{ fontSize: 13, color: "var(--text-3)" }}>Leave blank to use this server's default.</p>
              <input className="text-input" style={{ height: 40, fontSize: 14 }} placeholder="Username (if not your email address)" aria-label="Username"
                value={username} onChange={(e) => setUsername(e.target.value)} />
              {(["IMAP", "SMTP"] as const).map((kind) => {
                const v = kind === "IMAP" ? imap : smtp;
                const set = kind === "IMAP" ? setImap : setSmtp;
                return (
                  <div className="servers" key={kind}>
                    <input className="text-input" placeholder={`${kind} server`} aria-label={`${kind} server`} value={v.host} onChange={(e) => set({ ...v, host: e.target.value })} />
                    <input className="text-input" type="number" aria-label={`${kind} port`} value={v.port} onChange={(e) => set({ ...v, port: Number(e.target.value) })} />
                    <select className="text-input" aria-label={`${kind} security`} value={v.security} onChange={(e) => set({ ...v, security: e.target.value })}>
                      <option value="tls">SSL/TLS</option>
                      <option value="starttls">STARTTLS</option>
                    </select>
                  </div>
                );
              })}
            </details>
          )}
          <div className="buttons">
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-3)" }}>
              <Lock size={14} /> Your password is encrypted and only usable with this browser's session.
            </span>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Signing in…" : "Next"}</button>
          </div>
        </div>
      </form>
      <div className="login-foot">
        {appName} {config?.version ? `v${config.version}` : ""} · open-source webmail ·{" "}
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">AGPL-3.0</a>
      </div>
    </div>
  );
}
