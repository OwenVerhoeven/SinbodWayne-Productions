import { Navigate, useLocation } from "react-router";
import { SurfaceBoundary } from "@swp/ui";
import type { ReactNode } from "react";

import { useAuth } from "./auth-context";

export function ProtectedRoute({ children }: { readonly children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.state === "loading") {
    return (
      <main className="auth-loading">
        <SurfaceBoundary state="loading" />
      </main>
    );
  }

  if (auth.state === "anonymous") {
    return <Navigate replace state={{ from: location.pathname }} to="/login" />;
  }

  return children;
}
