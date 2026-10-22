import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy, useEffect } from "react";
import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import { api } from "./lib/api";
import { useConfig } from "./lib/config";
import { navigate, parseRoute, usePath } from "./lib/router";
import { prefs } from "./lib/store";

const AdminPage = lazy(() => import("./components/Admin").then((m) => ({ default: m.AdminPage })));

function useTheme() {
  const { theme, density } = prefs.use();
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);
}

export function App() {
  useTheme();
  const path = usePath();
  const route = parseRoute(path);
  const config = useConfig();
  const session = useQuery({ queryKey: ["session"], queryFn: api.session, staleTime: 60_000 });

  const accounts = session.data?.accounts ?? [];
  const adding = route.name === "login" && new URLSearchParams(location.search).has("add");

  useEffect(() => {
    if (!session.data) return;
    if (!accounts.length && route.name !== "login") navigate("/login", { replace: true });
    else if (accounts.length && route.name === "login" && !adding) navigate("/u/0/inbox", { replace: true });
    else if (accounts.length && route.name === "none") navigate("/u/0/inbox", { replace: true });
    else if (accounts.length && route.name !== "login" && route.account >= accounts.length) navigate("/u/0/inbox", { replace: true });
    else if (accounts.length && route.name === "admin" && route.account < 0) {
      navigate(`/u/${accounts.find((a) => a.admin)?.index ?? 0}/admin`, { replace: true });
    } else if (accounts.length && route.name === "mailbox" && route.mailbox) {
      // A link for one mailbox (a notification's): to it, wherever it is in this browser.
      const found = accounts.find((a) => a.email.toLowerCase() === route.mailbox!.email);
      if (found) navigate(`/u/${found.index}/${route.mailbox.rest}`, { replace: true });
      else navigate(`/login?add=1&email=${encodeURIComponent(route.mailbox.email)}`, { replace: true });
    }
  }, [session.data, route.name, route.account, accounts.length, adding]);

  if (session.isPending || config.isPending) {
    return (
      <div className="login-page">
        <div className="spinner lg" aria-label="Loading" />
      </div>
    );
  }
  if (route.name === "login" || !accounts.length) {
    return <Login config={config.data} adding={adding} accounts={accounts} />;
  }
  if (route.name === "admin") {
    if (route.account < 0 || route.account >= accounts.length) return null;
    return (
      <Suspense fallback={<div className="login-page"><div className="spinner lg" aria-label="Loading" /></div>}>
        <AdminPage account={route.account} accounts={accounts} appName={config.data?.appName ?? "Viauna"} />
      </Suspense>
    );
  }
  if (route.account >= accounts.length || route.account < 0 || route.name === "none" || route.name === "mailbox") return null;
  return <Shell route={route} accounts={accounts} appName={config.data?.appName ?? "Viauna"} />;
}
