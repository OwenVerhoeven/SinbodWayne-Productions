import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";

import { apiRequest, jsonBody, setCsrfToken } from "../api/client";

const accountSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(["workspace_owner", "producer", "viewer"]),
  workspaceId: z.string(),
});

const sessionResponseSchema = z.discriminatedUnion("authenticated", [
  z.object({ authenticated: z.literal(false) }),
  z.object({
    authenticated: z.literal(true),
    account: accountSchema,
    csrfToken: z.string(),
    expiresAt: z.number(),
  }),
]);

export type Account = z.infer<typeof accountSchema>;
type AuthState = "loading" | "anonymous" | "authenticated";

interface AuthContextValue {
  readonly account: Account | undefined;
  readonly state: AuthState;
  readonly changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly signIn: (username: string, password: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<AuthState>("loading");
  const [account, setAccount] = useState<Account>();

  const refresh = useCallback(async () => {
    try {
      const session = await apiRequest("/api/v1/auth/session", sessionResponseSchema);
      if (session.authenticated) {
        setCsrfToken(session.csrfToken);
        setAccount(session.account);
        setState("authenticated");
      } else {
        setCsrfToken(undefined);
        setAccount(undefined);
        setState("anonymous");
      }
    } catch {
      setCsrfToken(undefined);
      setAccount(undefined);
      setState("anonymous");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (username: string, password: string) => {
    const session = await apiRequest("/api/v1/auth/login", sessionResponseSchema, {
      method: "POST",
      body: jsonBody({ username, password }),
    });
    if (!session.authenticated) {
      throw new Error("Authentication did not establish a session");
    }
    setCsrfToken(session.csrfToken);
    setAccount(session.account);
    setState("authenticated");
  }, []);

  const signOut = useCallback(async () => {
    await apiRequest("/api/v1/auth/logout", z.object({ revoked: z.literal(true) }), {
      method: "POST",
      body: jsonBody({}),
    });
    setCsrfToken(undefined);
    setAccount(undefined);
    setState("anonymous");
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const session = await apiRequest("/api/v1/auth/password", sessionResponseSchema, {
      method: "POST",
      body: jsonBody({ currentPassword, newPassword }),
    });
    if (!session.authenticated)
      throw new Error("Password change did not establish a replacement session");
    setCsrfToken(session.csrfToken);
    setAccount(session.account);
    setState("authenticated");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ account, changePassword, refresh, signIn, signOut, state }),
    [account, changePassword, refresh, signIn, signOut, state],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
