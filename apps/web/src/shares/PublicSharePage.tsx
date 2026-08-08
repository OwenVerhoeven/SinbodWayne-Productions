import { useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Download,
  LockKeyhole,
  MessageSquareText,
  ShieldCheck,
  Stamp,
  UserRound,
} from "lucide-react";
import { useParams } from "react-router";
import { z } from "zod";
import { Button, Status, SurfaceBoundary, Wordmark } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";

const shareViewSchema = z.object({
  shareSession: z.string(),
  expiresAt: z.number(),
  purpose: z.enum(["viewer", "commenter", "approver", "candidate", "call_sheet_recipient"]),
  artifact: z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    subtitle: z.string().nullable(),
    confidentiality: z.string(),
    issuedAt: z.number().nullable(),
    content: z.array(
      z.object({ heading: z.string(), body: z.string(), private: z.boolean().optional() }),
    ),
    downloadHref: z.string().nullable(),
  }),
  recipient: z
    .object({
      displayName: z.string(),
      confirmedAt: z.number().nullable(),
      viewedAt: z.number().nullable(),
      privateNote: z.string().nullable(),
    })
    .nullable(),
  approval: z.object({ id: z.string(), status: z.string(), updatedAt: z.number() }).nullable(),
  permissions: z.object({
    comment: z.boolean(),
    approve: z.boolean(),
    confirm: z.boolean(),
    download: z.boolean(),
    submit: z.boolean(),
  }),
});
const commentResponseSchema = z.object({
  comment: z.object({ id: z.string(), body: z.string(), createdAt: z.number() }),
});
const submissionResponseSchema = z.object({
  submitted: z.literal(true),
  referenceId: z.string(),
  message: z.string(),
});
type ShareView = z.infer<typeof shareViewSchema>;

export function PublicSharePage() {
  const { publicId } = useParams();
  const [view, setView] = useState<ShareView>();
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    const secret = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    window.history.replaceState(null, "", window.location.pathname);
    if (!publicId) {
      setError(true);
      return;
    }
    const request = secret
      ? apiRequest(
          `/api/v1/public/shares/${encodeURIComponent(publicId)}/exchange`,
          shareViewSchema,
          { method: "POST", body: jsonBody({ secret }) },
        )
      : apiRequest(`/api/v1/public/shares/${encodeURIComponent(publicId)}`, shareViewSchema);
    void request.then(setView).catch(() => setError(true));
  }, [publicId]);

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || !publicId) return;
    setSubmitting("confirm");
    const form = new FormData(event.currentTarget);
    try {
      setView(
        await shareMutation(
          publicId,
          view,
          "confirm",
          { note: String(form.get("note") ?? "") },
          shareViewSchema,
        ),
      );
      setNotice("Receipt confirmed with verified evidence.");
    } finally {
      setSubmitting(undefined);
    }
  }

  async function comment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || !publicId) return;
    setSubmitting("comment");
    const form = new FormData(event.currentTarget);
    try {
      await shareMutation(
        publicId,
        view,
        "comment",
        { body: String(form.get("body") ?? "") },
        commentResponseSchema,
      );
      event.currentTarget.reset();
      setNotice("Comment recorded for the production team.");
    } finally {
      setSubmitting(undefined);
    }
  }

  async function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || !publicId) return;
    setSubmitting("approve");
    const form = new FormData(event.currentTarget);
    try {
      setView(
        await shareMutation(
          publicId,
          view,
          "approve",
          {
            decision: String(form.get("decision") ?? "changes_requested"),
            displayName: String(form.get("displayName") ?? ""),
            comment: String(form.get("comment") ?? ""),
          },
          shareViewSchema,
        ),
      );
      setNotice("Your immutable approval decision was recorded.");
    } finally {
      setSubmitting(undefined);
    }
  }

  async function submitCandidate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || !publicId) return;
    setSubmitting("submit");
    const form = new FormData(event.currentTarget);
    try {
      const result = await shareMutation(
        publicId,
        view,
        "submit",
        {
          displayName: String(form.get("displayName") ?? ""),
          email: String(form.get("email") ?? ""),
          phone: optionalString(form.get("phone")),
          representation: optionalString(form.get("representation")),
          reelLinks: lineList(form.get("reelLinks")),
          note: String(form.get("note") ?? ""),
          consentAccepted: form.get("consentAccepted") === "on",
          privacyNoticeVersion: "candidate-submission-v1",
        },
        submissionResponseSchema,
      );
      event.currentTarget.reset();
      setNotice(`${result.message} Reference: ${result.referenceId}`);
    } finally {
      setSubmitting(undefined);
    }
  }

  if (error)
    return (
      <main className="public-shell">
        <Wordmark />
        <SurfaceBoundary
          description="This link is invalid, expired, revoked, or outside its permitted scope."
          state="permission"
          title="Secure link unavailable"
        />
      </main>
    );
  if (!view)
    return (
      <main className="public-shell">
        <Wordmark />
        <SurfaceBoundary state="loading" />
      </main>
    );

  return (
    <main className="public-shell">
      <header className="public-header">
        <Wordmark />
        <div>
          <LockKeyhole aria-hidden="true" />
          <span>Scoped secure view · expires {formatDate(view.expiresAt)}</span>
        </div>
      </header>
      <article className="public-artifact">
        <header>
          <p>{view.artifact.type.replaceAll("_", " ")}</p>
          <h1>{view.artifact.title}</h1>
          {view.artifact.subtitle ? <span>{view.artifact.subtitle}</span> : null}
          <div>
            <Status tone="warning">{view.artifact.confidentiality}</Status>
            {view.artifact.issuedAt ? (
              <time dateTime={new Date(view.artifact.issuedAt).toISOString()}>
                Issued {formatDate(view.artifact.issuedAt)}
              </time>
            ) : null}
          </div>
        </header>
        {view.recipient?.privateNote ? (
          <aside className="recipient-note">
            <MessageSquareText aria-hidden="true" />
            <div>
              <strong>Private note for {view.recipient.displayName}</strong>
              <p>{view.recipient.privateNote}</p>
            </div>
          </aside>
        ) : null}
        <div className="artifact-sections">
          {view.artifact.content.map((section) => (
            <section key={section.heading}>
              <h2>{section.heading}</h2>
              <p>{section.body}</p>
            </section>
          ))}
        </div>
      </article>
      {notice ? (
        <p className="public-notice" role="status">
          <CheckCircle2 aria-hidden="true" />
          {notice}
        </p>
      ) : null}
      <section aria-label="Secure link actions" className="public-action-stack">
        <div className="public-actions">
          {view.permissions.download && view.artifact.downloadHref ? (
            <a className="swp-button swp-button--secondary" href={view.artifact.downloadHref}>
              <Download /> Download
            </a>
          ) : null}
          {view.permissions.confirm && !view.recipient?.confirmedAt ? (
            <form onSubmit={confirm}>
              <label>
                <span className="swp-visually-hidden">Optional confirmation note</span>
                <input maxLength={500} name="note" placeholder="Optional confirmation note" />
              </label>
              <Button
                disabled={submitting === "confirm"}
                icon={<CheckCircle2 />}
                type="submit"
                variant="primary"
              >
                {submitting === "confirm" ? "Confirming…" : "Confirm receipt"}
              </Button>
            </form>
          ) : view.recipient?.confirmedAt ? (
            <Status tone="success">Confirmed {formatDate(view.recipient.confirmedAt)}</Status>
          ) : null}
        </div>
        {view.permissions.comment ? (
          <form className="public-response-form" onSubmit={comment}>
            <header>
              <MessageSquareText aria-hidden="true" />
              <div>
                <h2>Comment on this item</h2>
                <p>Your comment is attached only to this shared artifact.</p>
              </div>
            </header>
            <label>
              <span>Comment</span>
              <textarea maxLength={4_000} name="body" required rows={4} />
            </label>
            <Button disabled={submitting === "comment"} type="submit">
              Send comment
            </Button>
          </form>
        ) : null}
        {view.permissions.approve && view.approval?.status === "requested" ? (
          <form className="public-response-form" onSubmit={decide}>
            <header>
              <Stamp aria-hidden="true" />
              <div>
                <h2>Record approval decision</h2>
                <p>This decision is immutable and pinned to the shared version.</p>
              </div>
            </header>
            <label>
              <span>Your display name</span>
              <input maxLength={160} minLength={2} name="displayName" required />
            </label>
            <label>
              <span>Decision</span>
              <select name="decision">
                <option value="approved">Approve</option>
                <option value="changes_requested">Request changes</option>
                <option value="rejected">Reject</option>
              </select>
            </label>
            <label>
              <span>Comment</span>
              <textarea maxLength={2_000} name="comment" rows={3} />
            </label>
            <Button disabled={submitting === "approve"} type="submit" variant="primary">
              Record decision
            </Button>
          </form>
        ) : view.approval ? (
          <p className="public-approval-state">
            <Status tone={view.approval.status === "approved" ? "success" : "warning"}>
              Approval {view.approval.status.replaceAll("_", " ")}
            </Status>
          </p>
        ) : null}
        {view.permissions.submit ? (
          <form className="public-response-form" onSubmit={submitCandidate}>
            <header>
              <UserRound aria-hidden="true" />
              <div>
                <h2>Candidate submission</h2>
                <p>
                  Only the casting team receives these details. No wider project access is granted.
                </p>
              </div>
            </header>
            <label>
              <span>Name</span>
              <input maxLength={160} minLength={2} name="displayName" required />
            </label>
            <label>
              <span>Email</span>
              <input maxLength={254} name="email" required type="email" />
            </label>
            <label>
              <span>Phone (optional)</span>
              <input maxLength={50} name="phone" type="tel" />
            </label>
            <label>
              <span>Representation (optional)</span>
              <input maxLength={200} name="representation" />
            </label>
            <label>
              <span>Reel links</span>
              <textarea name="reelLinks" placeholder="One https:// link per line" rows={3} />
            </label>
            <label>
              <span>Note</span>
              <textarea maxLength={2_000} name="note" rows={4} />
            </label>
            <label className="choice-row">
              <input name="consentAccepted" required type="checkbox" />
              <span>
                I consent to Sinbod Wayne using these details for this casting process and its
                stated retention period.
              </span>
            </label>
            <Button disabled={submitting === "submit"} type="submit" variant="primary">
              Submit securely
            </Button>
          </form>
        ) : null}
      </section>
      <p className="public-privacy">
        <ShieldCheck aria-hidden="true" /> This view is limited to this recipient and artifact. It
        does not expose the wider project.
      </p>
    </main>
  );
}

async function shareMutation<T>(
  publicId: string,
  view: ShareView,
  action: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  return apiRequest(`/api/v1/public/shares/${encodeURIComponent(publicId)}/${action}`, schema, {
    method: "POST",
    headers: {
      Authorization: `Share ${view.shareSession}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: jsonBody(body),
  });
}
function optionalString(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}
function lineList(value: FormDataEntryValue | null): string[] {
  return [
    ...new Set(
      String(value ?? "")
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
function formatDate(value: number): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}
