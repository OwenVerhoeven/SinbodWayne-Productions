import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquare, Reply, RotateCcw, Stamp } from "lucide-react";
import { z } from "zod";
import { Button, Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";
import { useAuth } from "../auth/auth-context";

const memberSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: z.string(),
});
const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  parentCommentId: z.string().nullable(),
  authorUserId: z.string().nullable(),
  authorName: z.string(),
  resolvedAt: z.number().nullable(),
  resolvedByName: z.string().nullable(),
  version: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  mentions: z.array(z.object({ userId: z.string(), displayName: z.string() })),
});
const decisionSchema = z.object({
  id: z.string(),
  decision: z.string(),
  comment: z.string().nullable(),
  pinnedVersionId: z.string().nullable(),
  actorName: z.string(),
  createdAt: z.number(),
});
const approvalSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  ownerUserId: z.string().nullable(),
  ownerName: z.string().nullable(),
  approverUserId: z.string().nullable(),
  approverName: z.string().nullable(),
  pinnedVersionId: z.string().nullable(),
  requestedAt: z.number(),
  dueAt: z.number().nullable(),
  selfApprovalAllowed: z.boolean(),
  version: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  decisions: z.array(decisionSchema),
});
const collaborationSchema = z.object({
  object: z.object({ id: z.string(), objectType: z.string(), title: z.string().nullable() }),
  members: z.array(memberSchema),
  comments: z.array(commentSchema),
  approvals: z.array(approvalSchema),
  activity: z.array(
    z.object({
      id: z.string(),
      verb: z.string(),
      summary: z.string(),
      actorName: z.string().nullable(),
      metadata: z.record(z.string(), z.unknown()),
      createdAt: z.number(),
    }),
  ),
});

type Comment = z.infer<typeof commentSchema>;
type Approval = z.infer<typeof approvalSchema>;

export function ObjectCollaborationPanel({
  projectId,
  objectType,
  objectId,
}: {
  readonly projectId: string;
  readonly objectType: string;
  readonly objectId: string;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"comments" | "approvals" | "activity">("comments");
  const [replyTo, setReplyTo] = useState<Comment>();
  const [approvalForm, setApprovalForm] = useState(false);
  const endpoint = `/api/v1/app/projects/${encodeURIComponent(projectId)}/collaboration/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`;
  const queryKey = ["collaboration", projectId, objectType, objectId];
  const collaboration = useQuery({
    queryKey,
    queryFn: () => apiRequest(endpoint, collaborationSchema),
  });
  const invalidate = async () => queryClient.invalidateQueries({ queryKey });

  const comment = useMutation({
    mutationFn: (input: { body: string; parentCommentId?: string; mentionUserIds: string[] }) =>
      apiRequest(`${endpoint}/comments`, commentSchema, { method: "POST", body: jsonBody(input) }),
    onSuccess: async () => {
      setReplyTo(undefined);
      await invalidate();
    },
  });
  const resolve = useMutation({
    mutationFn: (input: { comment: Comment; resolved: boolean }) =>
      apiRequest(
        `${endpoint}/comments/${encodeURIComponent(input.comment.id)}/resolve`,
        commentSchema,
        {
          method: "POST",
          headers: { "If-Match": `"${input.comment.version}"` },
          body: jsonBody({ resolved: input.resolved }),
        },
      ),
    onSuccess: invalidate,
  });
  const requestApproval = useMutation({
    mutationFn: (input: {
      title: string;
      summary: string;
      approverUserId: string;
      selfApprovalAllowed: boolean;
    }) =>
      apiRequest(`${endpoint}/approvals`, approvalSchema, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: jsonBody(input),
      }),
    onSuccess: async () => {
      setApprovalForm(false);
      await invalidate();
    },
  });
  const decide = useMutation({
    mutationFn: (input: {
      approval: Approval;
      decision: "approved" | "changes_requested" | "rejected";
    }) =>
      apiRequest(
        `${endpoint}/approvals/${encodeURIComponent(input.approval.id)}/decisions`,
        approvalSchema,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: jsonBody({ decision: input.decision, comment: "" }),
        },
      ),
    onSuccess: invalidate,
  });

  function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = String(form.get("body") ?? "");
    const mentionUserIds = form.getAll("mentions").map(String);
    comment.mutate({ body, mentionUserIds, ...(replyTo ? { parentCommentId: replyTo.id } : {}) });
    event.currentTarget.reset();
  }

  function submitApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    requestApproval.mutate({
      title: String(form.get("title") ?? ""),
      summary: String(form.get("summary") ?? ""),
      approverUserId: String(form.get("approverUserId") ?? ""),
      selfApprovalAllowed: form.get("selfApprovalAllowed") === "on",
    });
  }

  return (
    <section className="object-collaboration">
      <div aria-label="Collaboration views" className="collaboration-tabs" role="tablist">
        <button
          aria-selected={tab === "comments"}
          onClick={() => setTab("comments")}
          role="tab"
          type="button"
        >
          Comments <span>{collaboration.data?.comments.length ?? 0}</span>
        </button>
        <button
          aria-selected={tab === "approvals"}
          onClick={() => setTab("approvals")}
          role="tab"
          type="button"
        >
          Approvals <span>{collaboration.data?.approvals.length ?? 0}</span>
        </button>
        <button
          aria-selected={tab === "activity"}
          onClick={() => setTab("activity")}
          role="tab"
          type="button"
        >
          Activity
        </button>
      </div>
      {collaboration.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : collaboration.isError ? (
        <SurfaceBoundary
          description="The collaboration history could not be loaded."
          state="error"
        />
      ) : tab === "comments" ? (
        <div className="collaboration-pane">
          <form className="comment-form" onSubmit={submitComment}>
            {replyTo ? (
              <div className="reply-context">
                <span>Replying to {replyTo.authorName}</span>
                <button onClick={() => setReplyTo(undefined)} type="button">
                  Cancel reply
                </button>
              </div>
            ) : null}
            <label>
              <span>Comment</span>
              <textarea
                aria-label="Comment"
                maxLength={8_000}
                name="body"
                placeholder="Add a production note or decision context…"
                required
                rows={3}
              />
            </label>
            <details>
              <summary>Mention team member</summary>
              {collaboration.data?.members
                .filter((member) => member.id !== auth.account?.id)
                .map((member) => (
                  <label className="choice-row" key={member.id}>
                    <input name="mentions" type="checkbox" value={member.id} />
                    <span>@{member.username}</span>
                  </label>
                ))}
            </details>
            <Button
              disabled={comment.isPending}
              icon={<MessageSquare />}
              type="submit"
              variant="primary"
            >
              Comment
            </Button>
          </form>
          <div className="comment-thread">
            {collaboration.data?.comments.length ? (
              collaboration.data.comments.map((item) => (
                <article
                  className={`${item.parentCommentId ? "comment-card comment-card--reply" : "comment-card"}${item.resolvedAt ? " comment-card--resolved" : ""}`}
                  key={item.id}
                >
                  <header>
                    <strong>{item.authorName}</strong>
                    <time dateTime={new Date(item.createdAt).toISOString()}>
                      {formatDate(item.createdAt)}
                    </time>
                  </header>
                  <p>{item.body}</p>
                  {item.mentions.length ? (
                    <small>
                      Mentioned {item.mentions.map((mention) => mention.displayName).join(", ")}
                    </small>
                  ) : null}
                  <footer>
                    <button onClick={() => setReplyTo(item)} type="button">
                      <Reply aria-hidden="true" /> Reply
                    </button>
                    <button
                      onClick={() => resolve.mutate({ comment: item, resolved: !item.resolvedAt })}
                      type="button"
                    >
                      {item.resolvedAt ? (
                        <RotateCcw aria-hidden="true" />
                      ) : (
                        <Check aria-hidden="true" />
                      )}
                      {item.resolvedAt ? "Reopen" : "Resolve"}
                    </button>
                  </footer>
                </article>
              ))
            ) : (
              <p className="collaboration-empty">No comments yet.</p>
            )}
          </div>
        </div>
      ) : tab === "approvals" ? (
        <div className="collaboration-pane">
          <Button
            icon={<Stamp />}
            onClick={() => setApprovalForm((value) => !value)}
            variant="primary"
          >
            Request approval
          </Button>
          {approvalForm ? (
            <form className="approval-form" onSubmit={submitApproval}>
              <label>
                <span>Decision needed</span>
                <input maxLength={240} minLength={2} name="title" required />
              </label>
              <label>
                <span>Context</span>
                <textarea maxLength={2_000} name="summary" rows={3} />
              </label>
              <label>
                <span>Approver</span>
                <select name="approverUserId" required>
                  <option value="">Select approver</option>
                  {collaboration.data?.members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="choice-row">
                <input name="selfApprovalAllowed" type="checkbox" />
                <span>Allow requester to self-approve</span>
              </label>
              <Button disabled={requestApproval.isPending} type="submit">
                Send request
              </Button>
            </form>
          ) : null}
          <div className="approval-list">
            {collaboration.data?.approvals.length ? (
              collaboration.data.approvals.map((approval) => (
                <article className="approval-card" key={approval.id}>
                  <header>
                    <strong>{approval.title}</strong>
                    <Status
                      tone={
                        approval.status === "approved"
                          ? "success"
                          : approval.status === "rejected" ||
                              approval.status === "changes_requested"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {approval.status.replaceAll("_", " ")}
                    </Status>
                  </header>
                  <p>{approval.summary || "No additional context."}</p>
                  <small>
                    Approver: {approval.approverName ?? "Unassigned"} · Requested{" "}
                    {formatDate(approval.requestedAt)}
                  </small>
                  {approval.status === "requested" &&
                  (approval.approverUserId === auth.account?.id ||
                    auth.account?.role === "workspace_owner") ? (
                    <footer>
                      <Button onClick={() => decide.mutate({ approval, decision: "approved" })}>
                        Approve
                      </Button>
                      <Button
                        onClick={() => decide.mutate({ approval, decision: "changes_requested" })}
                        variant="quiet"
                      >
                        Request changes
                      </Button>
                      <Button
                        onClick={() => decide.mutate({ approval, decision: "rejected" })}
                        variant="quiet"
                      >
                        Reject
                      </Button>
                    </footer>
                  ) : null}
                  {approval.decisions.map((decision) => (
                    <div className="approval-decision" key={decision.id}>
                      <strong>{decision.actorName}</strong>
                      <span>
                        {decision.decision.replaceAll("_", " ")} · {formatDate(decision.createdAt)}
                      </span>
                    </div>
                  ))}
                </article>
              ))
            ) : (
              <p className="collaboration-empty">No approval requests yet.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="activity-list">
          {collaboration.data?.activity.length ? (
            collaboration.data.activity.map((activity) => (
              <article key={activity.id}>
                <span className="activity-marker" />
                <div>
                  <strong>{activity.summary}</strong>
                  <time dateTime={new Date(activity.createdAt).toISOString()}>
                    {activity.actorName ?? "System"} · {formatDate(activity.createdAt)}
                  </time>
                </div>
              </article>
            ))
          ) : (
            <p className="collaboration-empty">No activity recorded for this object yet.</p>
          )}
        </div>
      )}
    </section>
  );
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}
