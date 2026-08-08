import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import { SurfaceBoundary, Wordmark } from "@swp/ui";

import { apiRequest } from "../api/client";
import { planningControlsSchema } from "./schemas";
import type { PlanningControls } from "./schemas";
import type { PlanningArea } from "./PlanningControlsPage";

const titles: Record<PlanningArea, string> = {
  budget: "Budget report",
  "legal-safety": "Legal & safety register",
  equipment: "Equipment & reservations",
  logistics: "Logistics readiness plan",
};

export function PlanningPrintPage() {
  const { projectId, area: rawArea } = useParams();
  const [params] = useSearchParams();
  const area = isArea(rawArea) ? rawArea : "budget";
  const planning = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["planning-print", projectId, area],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/planning-controls`,
        planningControlsSchema,
      ),
  });
  if (planning.isLoading)
    return (
      <main className="print-loading">
        <SurfaceBoundary state="loading" />
      </main>
    );
  if (planning.isError || !planning.data)
    return (
      <main className="print-loading">
        <SurfaceBoundary state="permission" title="Planning print view unavailable" />
      </main>
    );
  const paper =
    params.get("paper") === "Letter" || planning.data.project.paperSize === "Letter"
      ? "letter"
      : "a4";
  return (
    <main className={`print-document print-document--${paper} planning-print`}>
      <header className="print-cover">
        <Wordmark />
        <p>Pre-production planning control</p>
        <h1>{titles[area]}</h1>
        <h2>Project record · {planning.data.project.timezone}</h2>
        <strong>Internal · permission-sensitive</strong>
        <time dateTime={new Date().toISOString()}>
          {new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short" }).format(
            Date.now(),
          )}
        </time>
      </header>
      {area === "budget" ? (
        <BudgetPrint data={planning.data} />
      ) : area === "legal-safety" ? (
        <LegalPrint data={planning.data} />
      ) : area === "equipment" ? (
        <EquipmentPrint data={planning.data} />
      ) : (
        <LogisticsPrint data={planning.data} />
      )}
      <footer className="print-footer">
        Sinbod Wayne Productions · Generated from live planning data · Save as PDF is the manual PDF
        fallback.
      </footer>
    </main>
  );
}

function BudgetPrint({ data }: { readonly data: PlanningControls }) {
  return (
    <>
      {data.budget.budgets
        .filter((budget) => !budget.archivedAt)
        .map((budget) => {
          const version =
            budget.versions.find((item) => item.id === budget.workingVersionId) ??
            budget.versions.find((item) => item.id === budget.approvedVersionId) ??
            budget.versions[0];
          if (!version) return null;
          const format = money(version.currency);
          return (
            <section key={budget.id}>
              <h2>
                {budget.title} · v{version.versionNumber} · {version.status}
              </h2>
              <div className="print-summary-grid">
                <span>
                  Estimate<strong>{format.format(version.totalEstimateMinor / 100)}</strong>
                </span>
                <span>
                  Approved<strong>{format.format(version.totalApprovedMinor / 100)}</strong>
                </span>
                <span>
                  Committed<strong>{format.format(version.totalCommittedMinor / 100)}</strong>
                </span>
                <span>
                  Actual<strong>{format.format(version.totalActualMinor / 100)}</strong>
                </span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Line</th>
                    <th>Estimate</th>
                    <th>Approved</th>
                    <th>Actual</th>
                  </tr>
                </thead>
                <tbody>
                  {version.accounts.flatMap((account) =>
                    account.lines.map((line) => (
                      <tr key={line.id}>
                        <td>
                          {account.code} · {account.title}
                        </td>
                        <td>{line.title}</td>
                        <td>{format.format(line.estimateMinor / 100)}</td>
                        <td>{format.format(line.approvedMinor / 100)}</td>
                        <td>{format.format(line.actualMinor / 100)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
              <p className="print-hash">Content hash: {version.contentHash}</p>
            </section>
          );
        })}
    </>
  );
}
function LegalPrint({ data }: { readonly data: PlanningControls }) {
  return (
    <>
      <section>
        <h2>Requirements</h2>
        <table>
          <thead>
            <tr>
              <th>Requirement</th>
              <th>Type</th>
              <th>Status</th>
              <th>Blocking</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {data.legalSafety.requirements
              .filter((row) => !row.archivedAt)
              .map((row) => (
                <tr key={row.id}>
                  <td>{row.title}</td>
                  <td>{human(row.requirementType)}</td>
                  <td>{human(row.status)}</td>
                  <td>{row.isBlocking ? "Yes" : "No"}</td>
                  <td>
                    {row.currentFileVersionId
                      ? `Pinned ${row.currentFileVersionId}`
                      : "Not attached"}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
      <section className="print-break-before">
        <h2>Risk assessments</h2>
        {data.legalSafety.risks
          .filter((risk) => !risk.archivedAt)
          .map((risk) => (
            <article key={risk.id}>
              <h3>
                {risk.title} · {human(risk.status)}
              </h3>
              <table>
                <thead>
                  <tr>
                    <th>Hazard</th>
                    <th>Initial</th>
                    <th>Residual</th>
                    <th>Controls</th>
                  </tr>
                </thead>
                <tbody>
                  {risk.hazards
                    .filter((hazard) => !hazard.archivedAt)
                    .map((hazard) => (
                      <tr key={hazard.id}>
                        <td>{hazard.title}</td>
                        <td>{hazard.initialScore}</td>
                        <td>{hazard.residualScore ?? "Not assessed"}</td>
                        <td>
                          {hazard.controls
                            .filter((control) => !control.archivedAt)
                            .map((control) => `${control.title} (${human(control.status)})`)
                            .join("; ") || "None"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </article>
          ))}
      </section>
      <section>
        <h2>Legal holds</h2>
        {data.legalSafety.legalHolds.length ? (
          <ul>
            {data.legalSafety.legalHolds.map((hold) => (
              <li key={hold.id}>
                {hold.title} · {hold.releasedAt ? "Released" : "ACTIVE"} · {hold.reason}
              </li>
            ))}
          </ul>
        ) : (
          <p>No legal holds recorded.</p>
        )}
        <p>
          <strong>Notice:</strong> This register tracks requirements and evidence; it does not make
          legal determinations.
        </p>
      </section>
    </>
  );
}
function EquipmentPrint({ data }: { readonly data: PlanningControls }) {
  return (
    <>
      <section>
        <h2>Equipment</h2>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Ownership</th>
              <th>Category</th>
              <th>Condition</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.equipment.items
              .filter((row) => !row.archivedAt)
              .map((row) => (
                <tr key={row.id}>
                  <td>{row.title}</td>
                  <td>{row.ownershipType}</td>
                  <td>{row.category}</td>
                  <td>{row.condition || "Not recorded"}</td>
                  <td>{human(row.status)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Reservations</h2>
        <table>
          <thead>
            <tr>
              <th>Resource</th>
              <th>Start UTC</th>
              <th>End UTC</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.equipment.reservations
              .filter((row) => !row.archivedAt)
              .map((row) => (
                <tr key={row.id}>
                  <td>{row.resourceTitle}</td>
                  <td>{new Date(row.startsAt).toISOString()}</td>
                  <td>{new Date(row.endsAt).toISOString()}</td>
                  <td>{row.status}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <p>{data.equipment.conflicts.length} blocking overlap(s) detected.</p>
      </section>
    </>
  );
}
function LogisticsPrint({ data }: { readonly data: PlanningControls }) {
  const plan = data.logistics.plans.find((item) => !item.archivedAt);
  return (
    <>
      <section>
        <h2>Readiness · {human(data.logistics.readiness.state)}</h2>
        {data.logistics.readiness.missing.length ? (
          <ul>
            {data.logistics.readiness.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p>All configured logistics checks pass.</p>
        )}
      </section>
      <section>
        <h2>{plan?.title ?? "No logistics plan"}</h2>
        {plan ? (
          <dl className="print-definition-grid">
            <div>
              <dt>Base camp</dt>
              <dd>{plan.baseCamp || "Not recorded"}</dd>
            </div>
            <div>
              <dt>Holding</dt>
              <dd>{plan.holding || "Not recorded"}</dd>
            </div>
            <div>
              <dt>Toilets</dt>
              <dd>{plan.toilets || "Not recorded"}</dd>
            </div>
            <div>
              <dt>Power</dt>
              <dd>{plan.powerCharging || "Not recorded"}</dd>
            </div>
            <div>
              <dt>Access</dt>
              <dd>{plan.accessNotes || "Not recorded"}</dd>
            </div>
            <div>
              <dt>Emergency</dt>
              <dd>{plan.emergencyNotes || "Not recorded"}</dd>
            </div>
          </dl>
        ) : null}
      </section>
      <section>
        <h2>Transport & catering</h2>
        <ul>
          {data.logistics.transport
            .filter((row) => !row.archivedAt)
            .map((row) => (
              <li key={row.id}>
                Transport · {row.title} · {human(row.status)}
              </li>
            ))}
          {data.logistics.catering
            .filter((row) => !row.archivedAt)
            .map((row) => (
              <li key={row.id}>
                Catering · {row.title} · {row.headCount} people · {human(row.status)}
              </li>
            ))}
        </ul>
        <p>
          Map links and bookings use manual fallbacks when optional providers are not configured.
        </p>
      </section>
    </>
  );
}
function isArea(value: string | undefined): value is PlanningArea {
  return (
    value === "budget" || value === "legal-safety" || value === "equipment" || value === "logistics"
  );
}
function human(value: string) {
  return value.replaceAll("_", " ");
}
function money(currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency });
  } catch {
    return new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}
