import { Hono } from "hono";
import { z } from "zod";

import { assertProjectAccess } from "../auth/policy";
import { requireActor, requireCsrf } from "../auth/session";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireSameOrigin } from "../http/security";
import type { ActorContext, AppEnv } from "../http/types";
import { getRecordTable } from "../records/catalog";

export const printRoutes = new Hono<AppEnv>();
printRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

printRoutes.get("/:artifactType/:artifactId", async (context) => {
  const actor = context.get("actor");
  const artifactType = z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_]*$/u)
    .parse(context.req.param("artifactType"));
  const artifactId = z.string().min(8).max(128).parse(context.req.param("artifactId"));
  const settings = z
    .object({
      paper: z.enum(["A4", "Letter"]).catch("A4"),
      orientation: z.enum(["portrait", "landscape"]).catch("portrait"),
    })
    .parse(context.req.query());
  if (artifactType === "readiness")
    return ok(context, await readinessPrint(context.env.DB, actor, artifactId, settings));
  const definition = getRecordTable(artifactType);
  if (!definition)
    throw new HttpError(
      404,
      "print_type_not_found",
      "This artifact type does not have a print route.",
    );
  const row = await context.env.DB.prepare(
    `SELECT id, project_id, title, status, summary, details_json, updated_at FROM ${definition.table} WHERE id = ?1 AND workspace_id = ?2 AND archived_at IS NULL LIMIT 1`,
  )
    .bind(artifactId, actor.workspaceId)
    .first<{
      id: string;
      project_id: string;
      title: string;
      status: string;
      summary: string | null;
      details_json: string;
      updated_at: number;
    }>();
  if (!row) throw new HttpError(404, "artifact_not_found", "The printable artifact was not found.");
  await assertProjectAccess(context.env.DB, actor, row.project_id);
  const details = parseJson(row.details_json);
  return ok(context, {
    title: row.title,
    subtitle: row.summary,
    issueLabel: `${artifactType.replaceAll("_", " ")} · ${row.status.replaceAll("_", " ")}`,
    confidentiality: "Sinbod Wayne · Internal production document",
    paperSize: settings.paper,
    orientation: settings.orientation,
    generatedAt: Date.now(),
    sections: [
      {
        id: "summary",
        heading: "Summary",
        html: paragraphs(row.summary ?? "No summary recorded."),
        breakBefore: false,
      },
      ...Object.entries(details)
        .filter(([, value]) => value !== null && value !== "" && value !== false)
        .map(([key, value]) => ({
          id: key,
          heading: humanise(key),
          html: valueHtml(value),
          breakBefore: false,
        })),
    ],
    footer: `Generated from live production data · ${row.id}`,
  });
});

async function readinessPrint(
  db: D1Database,
  actor: ActorContext,
  artifactId: string,
  settings: { paper: "A4" | "Letter"; orientation: "portrait" | "landscape" },
) {
  const issue = await db
    .prepare(
      "SELECT ri.id, ri.project_id, ri.issue_number, ri.title, ri.state, ri.manifest_hash, ri.issued_at, ri.manifest_json, p.code, p.title AS project_title, u.display_name AS actor_name FROM readiness_issues ri JOIN projects p ON p.id = ri.project_id AND p.workspace_id = ri.workspace_id JOIN user_identities u ON u.id = ri.issued_by_user_id WHERE ri.id = ?1 AND ri.workspace_id = ?2 LIMIT 1",
    )
    .bind(artifactId, actor.workspaceId)
    .first<{
      id: string;
      project_id: string;
      issue_number: number;
      title: string;
      state: string;
      manifest_hash: string;
      issued_at: number;
      manifest_json: string;
      code: string;
      project_title: string;
      actor_name: string;
    }>();
  if (issue) {
    await assertProjectAccess(db, actor, issue.project_id);
    const results = await db
      .prepare(
        "SELECT rr.result, rr.snapshot_json, r.title, r.category, r.severity FROM readiness_issue_results rr JOIN readiness_rules r ON r.id = rr.readiness_rule_id WHERE rr.readiness_issue_id = ?1 ORDER BY r.sort_rank, r.id",
      )
      .bind(issue.id)
      .all<{
        result: string;
        snapshot_json: string;
        title: string;
        category: string;
        severity: string;
      }>();
    const grouped = groupResults(
      results.results.map((result) => ({ ...result, snapshot: parseJson(result.snapshot_json) })),
    );
    return {
      title: issue.title,
      subtitle: `${issue.code} · ${issue.project_title}`,
      issueLabel: `Ready to Shoot · Issue ${issue.issue_number} · ${issue.state}`,
      confidentiality: "Sinbod Wayne · Confidential readiness certificate",
      paperSize: settings.paper,
      orientation: settings.orientation,
      generatedAt: issue.issued_at,
      sections: [
        {
          id: "certificate",
          heading: "Certificate",
          html: `<dl><dt>Issued by</dt><dd>${escapeHtml(issue.actor_name)}</dd><dt>Issued</dt><dd>${escapeHtml(new Date(issue.issued_at).toISOString())}</dd><dt>Manifest SHA-256</dt><dd><code>${escapeHtml(issue.manifest_hash)}</code></dd></dl>`,
          breakBefore: false,
        },
        ...grouped,
      ],
      footer: `Immutable readiness issue ${issue.issue_number} · ${issue.manifest_hash}`,
    };
  }
  const evaluation = await db
    .prepare(
      "SELECT re.id, re.project_id, re.completed_at, p.code, p.title AS project_title FROM readiness_evaluations re JOIN projects p ON p.id = re.project_id AND p.workspace_id = re.workspace_id WHERE re.id = ?1 AND re.workspace_id = ?2 LIMIT 1",
    )
    .bind(artifactId, actor.workspaceId)
    .first<{
      id: string;
      project_id: string;
      completed_at: number | null;
      code: string;
      project_title: string;
    }>();
  if (!evaluation)
    throw new HttpError(
      404,
      "readiness_not_found",
      "The readiness evaluation or issue was not found.",
    );
  await assertProjectAccess(db, actor, evaluation.project_id);
  const results = await db
    .prepare(
      "SELECT rr.result, rr.evidence_json AS snapshot_json, r.title, r.category, r.severity FROM readiness_results rr JOIN readiness_rules r ON r.id = rr.readiness_rule_id WHERE rr.readiness_evaluation_id = ?1 ORDER BY r.sort_rank, r.id",
    )
    .bind(evaluation.id)
    .all<{
      result: string;
      snapshot_json: string;
      title: string;
      category: string;
      severity: string;
    }>();
  return {
    title: "Readiness evaluation",
    subtitle: `${evaluation.code} · ${evaluation.project_title}`,
    issueLabel: "Working evaluation · Not an issued certificate",
    confidentiality: "Sinbod Wayne · Internal",
    paperSize: settings.paper,
    orientation: settings.orientation,
    generatedAt: evaluation.completed_at ?? Date.now(),
    sections: groupResults(
      results.results.map((result) => ({ ...result, snapshot: parseJson(result.snapshot_json) })),
    ),
    footer: `Working evaluation ${evaluation.id}`,
  };
}

function groupResults(
  results: readonly {
    result: string;
    title: string;
    category: string;
    severity: string;
    snapshot: Record<string, unknown>;
  }[],
) {
  const groups = new Map<string, typeof results>();
  for (const result of results)
    groups.set(result.category, [...(groups.get(result.category) ?? []), result]);
  return [...groups].map(([category, items], index) => ({
    id: category,
    heading: humanise(category),
    html: `<table><thead><tr><th>Check</th><th>Result</th><th>Severity</th></tr></thead><tbody>${items.map((item) => `<tr><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.result)}</td><td>${escapeHtml(item.severity)}</td></tr>`).join("")}</tbody></table>`,
    breakBefore: index > 0,
  }));
}

function paragraphs(value: string): string {
  return (
    value
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join("") || "<p>Not recorded.</p>"
  );
}
function valueHtml(value: unknown): string {
  if (Array.isArray(value))
    return `<ul>${value.map((item) => `<li>${escapeHtml(String(item))}</li>`).join("")}</ul>`;
  if (typeof value === "object" && value !== null)
    return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  return paragraphs(String(value));
}
function humanise(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/^./u, (letter) => letter.toUpperCase());
}
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
