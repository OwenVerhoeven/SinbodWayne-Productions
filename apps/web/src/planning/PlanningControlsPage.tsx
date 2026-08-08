import { useQuery } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { Link, useOutletContext, useParams } from "react-router";
import { Button, SurfaceBoundary } from "@swp/ui";

import { apiRequest } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import { BudgetControl } from "./BudgetControl";
import { EquipmentControl } from "./EquipmentControl";
import { LegalSafetyControl } from "./LegalSafetyControl";
import { LogisticsControl } from "./LogisticsControl";
import { planningControlsSchema } from "./schemas";

export type PlanningArea = "budget" | "legal-safety" | "equipment" | "logistics";

const areaCopy: Record<PlanningArea, { title: string; description: string }> = {
  budget: {
    title: "Budget & Vendors",
    description:
      "Build versioned cost plans in integer minor units, approve a pinned version and track commitments against actuals.",
  },
  "legal-safety": {
    title: "Legal & Safety",
    description:
      "Track requirements and evidence, assess hazards, record controls and enforce owner-managed legal holds.",
  },
  equipment: {
    title: "Equipment & Resources",
    description:
      "Plan physical assets and kits, reserve them in half-open time windows and resolve double bookings before the shoot.",
  },
  logistics: {
    title: "Logistics",
    description:
      "Confirm base operations, transport and catering with a truthful readiness checklist and manual provider fallbacks.",
  },
};

export function PlanningControlsPage({ area }: { readonly area: PlanningArea }) {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const endpoint = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/planning-controls`;
  const query = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["planning-controls", projectId],
    queryFn: () => apiRequest(endpoint, planningControlsSchema),
    refetchInterval: 25_000,
  });
  const copy = areaCopy[area];
  const activeBudget = query.data?.budget.budgets.find((budget) => !budget.archivedAt);

  if (!activeProject || !projectId)
    return <SurfaceBoundary state="error" title="Project unavailable" />;

  return (
    <section className={`project-page planning-page planning-page--${area}`}>
      <ProjectContextHeader
        actions={
          <>
            {area === "budget" && activeBudget ? (
              <Button
                icon={<Download />}
                onClick={() =>
                  window.open(
                    `${endpoint}/budgets/${encodeURIComponent(activeBudget.id)}/export.csv`,
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                Export CSV
              </Button>
            ) : null}
            <Button
              icon={<Printer />}
              onClick={() =>
                window.open(
                  `/print/planning/${encodeURIComponent(projectId)}/${area}`,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Print view
            </Button>
          </>
        }
        project={activeProject}
        section="Production Planning"
        title={copy.title}
      />
      <div className="page-intro">
        <p>{copy.description}</p>
      </div>
      <nav aria-label="Planning controls" className="planning-tabs">
        {(Object.keys(areaCopy) as PlanningArea[]).map((key) => (
          <Link
            aria-current={key === area ? "page" : undefined}
            key={key}
            to={`/projects/${encodeURIComponent(projectId)}/${key}`}
          >
            {areaCopy[key].title}
          </Link>
        ))}
      </nav>
      {query.isLoading ? (
        <SurfaceBoundary state="loading" title="Loading planning controls" />
      ) : null}
      {query.isError ? (
        <SurfaceBoundary
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
          state="error"
          title="Planning controls could not be loaded"
        />
      ) : null}
      {query.data ? (
        area === "budget" ? (
          <BudgetControl data={query.data} endpoint={endpoint} projectId={projectId} />
        ) : area === "legal-safety" ? (
          <LegalSafetyControl data={query.data} endpoint={endpoint} projectId={projectId} />
        ) : area === "equipment" ? (
          <EquipmentControl data={query.data} endpoint={endpoint} projectId={projectId} />
        ) : (
          <LogisticsControl data={query.data} endpoint={endpoint} projectId={projectId} />
        )
      ) : null}
    </section>
  );
}
