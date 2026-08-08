import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, ShieldX } from "lucide-react";
import { z } from "zod";
import { Button, Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";

const shareSchema = z.object({
  id: z.string(),
  publicLocator: z.string(),
  purpose: z.enum(["viewer", "commenter", "approver", "candidate", "call_sheet_recipient"]),
  objectType: z.string(),
  objectId: z.string(),
  allowedActions: z.array(z.string()),
  expiresAt: z.number(),
  revokedAt: z.number().nullable(),
  lastUsedAt: z.number().nullable(),
  createdAt: z.number(),
  secretShownOnce: z.boolean(),
  secret: z.string().nullable(),
  url: z.string().nullable(),
});
const shareListSchema = z.object({ items: z.array(shareSchema) });
type SharePurpose = "viewer" | "commenter" | "approver";

export function ShareLinksPanel({
  projectId,
  objectType,
  objectId,
  approvalId,
}: {
  readonly projectId: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly approvalId?: string;
}) {
  const queryClient = useQueryClient();
  const [newUrl, setNewUrl] = useState<string>();
  const [copied, setCopied] = useState(false);
  const base = `/api/v1/app/projects/${encodeURIComponent(projectId)}/shares`;
  const queryKey = ["shares", projectId];
  const links = useQuery({ queryKey, queryFn: () => apiRequest(base, shareListSchema) });
  const relevant =
    links.data?.items.filter(
      (link) => link.objectType === objectType && link.objectId === objectId,
    ) ?? [];
  const create = useMutation({
    mutationFn: (input: { purpose: SharePurpose; days: number }) =>
      apiRequest(base, shareSchema, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: jsonBody({
          purpose: input.purpose,
          objectType,
          objectId,
          ...(input.purpose === "approver" && approvalId ? { approvalId } : {}),
          allowedActions:
            input.purpose === "viewer"
              ? ["view", "download"]
              : input.purpose === "commenter"
                ? ["view", "comment", "download"]
                : ["view", "comment", "approve", "download"],
          expiresAt: Date.now() + input.days * 86_400_000,
        }),
      }),
    onSuccess: async (share) => {
      if (share.url) setNewUrl(share.url);
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiRequest(
        `${base}/${encodeURIComponent(id)}/revoke`,
        z.object({ revoked: z.literal(true), revokedAt: z.number() }),
        { method: "POST" },
      ),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      purpose: String(form.get("purpose") ?? "viewer") as SharePurpose,
      days: Number(form.get("days") ?? 7),
    });
  }
  async function copyUrl() {
    if (!newUrl) return;
    await navigator.clipboard.writeText(newUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <section className="share-links-panel">
      <header>
        <div>
          <Link2 aria-hidden="true" />
          <strong>Scoped secure links</strong>
        </div>
        <span>Secrets are shown once</span>
      </header>
      <form onSubmit={submit}>
        <label>
          <span>Purpose</span>
          <select name="purpose">
            <option value="viewer">Viewer</option>
            <option value="commenter">Commenter</option>
            {approvalId ? <option value="approver">Approver</option> : null}
          </select>
        </label>
        <label>
          <span>Expiry</span>
          <select defaultValue="7" name="days">
            <option value="1">1 day</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        </label>
        <Button disabled={create.isPending} type="submit">
          Create link
        </Button>
      </form>
      {newUrl ? (
        <div className="share-secret-once" role="status">
          <strong>Copy this link now</strong>
          <p>The secret is held in the URL fragment and will not be shown again.</p>
          <div>
            <input aria-label="New secure link" readOnly value={newUrl} />
            <Button icon={<Copy />} onClick={() => void copyUrl()}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setNewUrl(undefined)} variant="quiet">
            I stored it safely
          </Button>
        </div>
      ) : null}
      {links.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : links.isError ? (
        <SurfaceBoundary state="error" />
      ) : relevant.length ? (
        <div className="share-link-list">
          {relevant.map((link) => (
            <article key={link.id}>
              <div>
                <Status
                  tone={
                    link.revokedAt ? "danger" : link.expiresAt <= Date.now() ? "warning" : "success"
                  }
                >
                  {link.revokedAt ? "revoked" : link.expiresAt <= Date.now() ? "expired" : "active"}
                </Status>
                <strong>{link.purpose}</strong>
                <span>
                  Expires {formatDate(link.expiresAt)}
                  {link.lastUsedAt
                    ? ` · last used ${formatDate(link.lastUsedAt)}`
                    : " · never opened"}
                </span>
              </div>
              {!link.revokedAt && link.expiresAt > Date.now() ? (
                <Button icon={<ShieldX />} onClick={() => revoke.mutate(link.id)} variant="quiet">
                  Revoke
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="collaboration-empty">No links exist for this exact version.</p>
      )}
    </section>
  );
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}
