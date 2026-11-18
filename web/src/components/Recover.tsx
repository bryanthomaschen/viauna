import { CircleAlert, CircleCheck } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import type { AppConfig } from "../lib/types";

type Step =
  | { name: "address" }
  | { name: "code" }
  | { name: "password"; token: string; email: string }
  | { name: "done"; email: string }
  | { name: "loading" }
  | { name: "gone"; message: string };

/**
 * Forgot password? (/forgot): an address, then a code (emailed to its recovery address,
 * or a backup code), then a new password. An admin's reset link (/reset#token) goes
 * straight to the new password. Signed in or not: an admin may open a link to check it.
 */
export function Recover({ config, signedIn }: { config: AppConfig | undefined; signedIn: boolean }) {
  const appName = config?.appName ?? "Viauna";
  const fromLink = location.pathname === "/reset";
  const methods = config?.recovery ?? { offered: false, email: false, codes: false };
  const [step, setStep] = useState<Step>(() => (fromLink ? { name: "loading" } : { name: "address" }));
  const [email, setEmail] = useState(() => new URLSearchParams(location.search).get("email") ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  // An admin's link: the token is in the #fragment, which never reaches a server's log.
  // It's read once, then taken out of the address bar.
  useEffect(() => {
    if (!fromLink) return;
    const token = location.hash.slice(1);
    history.replaceState(null, "", "/reset");
    if (!token) {
      setStep({ name: "gone", message: "This link is missing its code. Open the whole link you were given, or ask for a new one." });
      return;
    }
    api
      .resetInfo(token)
      .then((info) => setStep({ name: "password", token, email: info.email }))
      .catch((err: Error) => setStep({ name: "gone", message: err.message }));
  }, [fromLink]);

  const run = async (e: FormEvent, fn: () => Promise<void>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signIn = (address: string) => navigate(`/login?${signedIn ? "add=1&" : ""}email=${encodeURIComponent(address)}`);
  const back = (
    <a href="/login" onClick={(e) => { e.preventDefault(); navigate("/login"); }}>Back to sign in</a>
  );
  const problem = error && <div className="error" role="alert"><CircleAlert size={16} /> {error}</div>;

  const card = (title: string, lead: ReactNode, body: ReactNode, onSubmit?: (e: FormEvent) => void) => (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit ?? ((e) => e.preventDefault())}>
        <div>
          <img src="/favicon.svg" alt="" width={48} height={48} />
          <h1>{title}</h1>
          <p className="lead">{lead}</p>
        </div>
        <div className="login-form">{body}</div>
      </form>
      <div className="login-foot">{appName}</div>
    </div>
  );

  if (step.name === "loading") {
    return <div className="login-page"><div className="spinner lg" aria-label="Loading" /></div>;
  }

  if (step.name === "gone") {
    return card("This link doesn't work", step.message, (
      <div className="buttons">
        {back}
        {methods.offered && <button type="button" className="btn btn-primary" onClick={() => navigate("/forgot")}>Forgot password?</button>}
      </div>
    ));
  }

  if (step.name === "done") {
    return card("Password changed", <>Sign in to {step.email} with your new password.</>, (
      <>
        <p className="recover-note">
          Every browser that was signed in to it has been signed out, and your other mail apps will ask for the new password. A notice is on its way to the mailbox.
        </p>
        <div className="buttons">
          <span />
          <button type="button" className="btn btn-primary" autoFocus onClick={() => signIn(step.email)}>Sign in</button>
        </div>
      </>
    ));
  }

  if (step.name === "password") {
    const finish = (e: FormEvent) =>
      run(e, async () => {
        if (password !== again) throw new Error("The passwords don't match.");
        const done = await api.finishReset(step.token, password);
        setStep({ name: "done", email: done.email });
      });
    return card("Choose a new password", <>for {step.email}</>, (
      <>
        <input type="text" autoComplete="username" value={step.email} readOnly hidden />
        <input className="text-input" type="password" autoComplete="new-password" placeholder="New password" aria-label="New password"
          minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        <input className="text-input" type="password" autoComplete="new-password" placeholder="Confirm new password" aria-label="Confirm new password"
          value={again} onChange={(e) => setAgain(e.target.value)} required />
        <p className="recover-note">
          At least 8 characters{config?.breachCheck ? ", and not one known from a data breach" : ""}. Every browser signed in to this mailbox will be signed out, and your mail apps will ask for the new password.
        </p>
        {problem}
        <div className="buttons">
          {back}
          <button type="submit" className="btn btn-primary" disabled={busy || !password || !again}>{busy ? "Changing…" : "Change password"}</button>
        </div>
      </>
    ), (e) => void finish(e));
  }

  if (!methods.offered) {
    return card("Forgot your password?", "Getting back in from here isn't available on this server.", (
      <>
        <p className="recover-note">Ask whoever runs your mail for a reset link.</p>
        <div className="buttons">{back}</div>
      </>
    ));
  }

  if (step.name === "code") {
    const verify = (e: FormEvent) =>
      run(e, async () => {
        const proof = await api.verifyRecovery(email, code);
        setPassword("");
        setAgain("");
        setStep({ name: "password", token: proof.token, email: proof.email });
      });
    const resend = async () => {
      setError(null);
      try {
        await api.startRecovery(email);
        setResent(true);
      } catch (err) {
        setError((err as Error).message);
      }
    };
    return card("Enter a code", <>for {email}</>, (
      <>
        <p className="recover-note">
          {methods.email && <>If {email} has a recovery address, a code is on its way there. It works for 15 minutes. </>}
          {methods.email && methods.codes && <>Or enter one of your backup codes.</>}
          {!methods.email && methods.codes && <>Enter one of the backup codes you saved for it.</>}
        </p>
        <input className="text-input" autoComplete="one-time-code" spellCheck={false} placeholder={methods.email ? "Code" : "Backup code"} aria-label="Code"
          value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
        {problem}
        {methods.email && (
          <p className="recover-note">
            {resent ? "If it has one, another code is on its way." : (
              <>No code? Check its spam folder, or{" "}
                <button type="button" className="link-button" onClick={() => void resend()}>send another</button>.</>
            )}
          </p>
        )}
        <div className="buttons">
          <button type="button" className="link-button" onClick={() => { setCode(""); setError(null); setStep({ name: "address" }); }}>Use a different address</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>{busy ? "Checking…" : "Next"}</button>
        </div>
      </>
    ), (e) => void verify(e));
  }

  const start = (e: FormEvent) =>
    run(e, async () => {
      await api.startRecovery(email);
      setResent(false);
      setStep({ name: "code" });
    });
  return card("Forgot your password?", "Enter your email address to choose a new password.", (
    <>
      <input className="text-input" type="email" autoComplete="username" placeholder="Email address" aria-label="Email address"
        value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      <p className="recover-note">
        {methods.email && methods.codes && "You'll need a code sent to your recovery address, or one of your backup codes."}
        {methods.email && !methods.codes && "You'll need a code sent to your recovery address."}
        {!methods.email && methods.codes && "You'll need one of your backup codes."}
        {" "}Without either, ask whoever runs your mail for a reset link.
      </p>
      {problem}
      <div className="buttons">
        {back}
        <button type="submit" className="btn btn-primary" disabled={busy || !email}>{busy ? "Just a moment…" : "Next"}</button>
      </div>
    </>
  ), (e) => void start(e));
}
