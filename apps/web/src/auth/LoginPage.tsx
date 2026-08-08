import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Button, Wordmark } from "@swp/ui";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";

import { ApiError } from "../api/client";
import { useAuth } from "./auth-context";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  if (auth.state === "authenticated") {
    return <Navigate replace to="/projects" />;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await auth.signIn(username, password);
      const state = location.state as { from?: string } | null;
      await navigate(state?.from ?? "/projects", { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Sign-in failed. Check your details and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section aria-labelledby="login-title" className="login-panel">
        <div className="login-panel__brand">
          <Wordmark />
        </div>
        <div className="login-panel__intro">
          <p>Secure production workspace</p>
          <h1 id="login-title">Prepare every detail before the camera rolls.</h1>
          <span>Authorised Sinbod Wayne team members only.</span>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label htmlFor="login-username">
            <span>Username</span>
          </label>
          <input
            autoComplete="username"
            autoCapitalize="none"
            id="login-username"
            name="username"
            onChange={(event) => setUsername(event.currentTarget.value)}
            required
            spellCheck={false}
            value={username}
          />
          <label htmlFor="login-password">
            <span>Password</span>
          </label>
          <span className="password-field">
            <input
              autoComplete="current-password"
              id="login-password"
              name="password"
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
              type={showPassword ? "text" : "password"}
              value={password}
            />
            <button
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((value) => !value)}
              type="button"
            >
              {showPassword ? <EyeOff /> : <Eye />}
            </button>
          </span>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button disabled={submitting} type="submit" variant="primary">
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="login-panel__security">
          <ShieldCheck aria-hidden="true" /> Passwords and sessions are protected by the production
          security policy.
        </p>
      </section>
      <aside aria-hidden="true" className="login-atmosphere">
        <div className="login-atmosphere__grid" />
        <p>IDEA</p>
        <span>→</span>
        <p>PLAN</p>
        <span>→</span>
        <p>READY</p>
      </aside>
    </main>
  );
}
