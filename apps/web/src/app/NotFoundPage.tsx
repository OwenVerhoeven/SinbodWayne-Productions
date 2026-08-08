import { Button, SurfaceBoundary } from "@swp/ui";
import { useNavigate } from "react-router";

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <main className="standalone-boundary">
      <SurfaceBoundary
        action={
          <Button onClick={() => void navigate(-1)} variant="primary">
            Go back
          </Button>
        }
        description="The address may be outdated, or your current scope may not include this object."
        state="error"
        title="Page not found"
      />
    </main>
  );
}
