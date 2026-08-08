import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, KeyRound, RotateCcw, Save, Shield, Trash2 } from "lucide-react";
import { useNavigate, useOutletContext, useParams } from "react-router";
import { z } from "zod";
import { Button, Status, SurfaceBoundary } from "@swp/ui";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { projectSchema } from "../app/schemas";
import { useAuth } from "../auth/auth-context";
import { ProjectContextHeader } from "../app/ProjectContextHeader";

const settingsSchema = z.object({
  project: projectSchema.extend({
    locale: z.string(),
    currency: z.string(),
    unitSystem: z.string(),
    paperSize: z.string(),
    frameRateNumerator: z.number(),
    frameRateDenominator: z.number(),
    aspectRatio: z.string(),
    confidentiality: z.string(),
    enabledModules: z.array(z.string()),
    legalHold: z.boolean(),
  }),
  sessions: z.array(
    z.object({
      id: z.string(),
      createdAt: z.number(),
      lastSeenAt: z.number(),
      current: z.boolean(),
      deviceLabel: z.string(),
      expiresAt: z.number(),
    }),
  ),
  providers: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      state: z.enum(["configured", "not_configured"]),
      fallback: z.string(),
    }),
  ),
});

export function ProjectSettingsPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"project" | "security" | "providers">("project");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordError, setPasswordError] = useState<string>();
  const settings = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["settings", projectId],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/settings`,
        settingsSchema,
      ),
  });
  const save = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      apiRequest(`/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}`, projectSchema, {
        method: "PATCH",
        headers: { "If-Match": `"${settings.data?.project.version ?? 0}"` },
        body: jsonBody(input),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const revokeSession = useMutation({
    mutationFn: (sessionId: string) =>
      apiRequest(
        `/api/v1/app/sessions/${encodeURIComponent(sessionId)}/revoke`,
        z.object({ revoked: z.literal(true) }),
        { method: "POST" },
      ),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["settings", projectId] }),
  });
  const changePassword = useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      auth.changePassword(input.currentPassword, input.newPassword),
    onSuccess: async () => {
      setPasswordOpen(false);
      setPasswordError(undefined);
      await queryClient.invalidateQueries({ queryKey: ["settings", projectId] });
    },
    onError: (error) =>
      setPasswordError(
        error instanceof ApiError ? error.message : "The password could not be changed.",
      ),
  });
  const lifecycle = useMutation({
    mutationFn: (action: "archive" | "restore") =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/${action}`,
        projectSchema,
        {
          method: "POST",
          headers: { "If-Match": `"${settings.data?.project.version ?? 0}"` },
        },
      ),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      if (project.archivedAt) await navigate("/projects");
      else await queryClient.invalidateQueries({ queryKey: ["settings", projectId] });
    },
  });

  if (!activeProject) return <SurfaceBoundary state="error" title="Project not found" />;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    save.mutate({
      title: form.get("title"),
      code: form.get("code"),
      phase: form.get("phase"),
      timezone: form.get("timezone"),
      locale: form.get("locale"),
      currency: form.get("currency"),
      unitSystem: form.get("unitSystem"),
      paperSize: form.get("paperSize"),
      aspectRatio: form.get("aspectRatio"),
    });
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError(undefined);
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword !== String(form.get("confirmation") ?? "")) {
      setPasswordError("The new-password confirmation does not match.");
      return;
    }
    changePassword.mutate({ currentPassword, newPassword });
  }

  return (
    <section className="project-page settings-page">
      <ProjectContextHeader project={activeProject} section="Settings" title="Project Settings" />
      <div className="settings-layout">
        <nav aria-label="Settings sections">
          <button
            aria-current={tab === "project" ? "page" : undefined}
            onClick={() => setTab("project")}
            type="button"
          >
            Project profile
          </button>
          <button
            aria-current={tab === "security" ? "page" : undefined}
            onClick={() => setTab("security")}
            type="button"
          >
            Security & sessions
          </button>
          <button
            aria-current={tab === "providers" ? "page" : undefined}
            onClick={() => setTab("providers")}
            type="button"
          >
            Providers & fallbacks
          </button>
        </nav>
        <div className="settings-content">
          {settings.isLoading ? <SurfaceBoundary state="loading" /> : null}
          {settings.isError ? <SurfaceBoundary state="error" /> : null}
          {settings.data && tab === "project" ? (
            <form className="settings-form" onSubmit={submit}>
              <header>
                <h2>Production defaults</h2>
                <p>Project-specific values override workspace defaults and flow into exports.</p>
              </header>
              <div className="form-grid">
                <label>
                  <span>Title</span>
                  <input defaultValue={settings.data.project.title} name="title" required />
                </label>
                <label>
                  <span>Code</span>
                  <input defaultValue={settings.data.project.code} name="code" required />
                </label>
                <label>
                  <span>Phase</span>
                  <select defaultValue={settings.data.project.phase} name="phase">
                    {[
                      "idea",
                      "development",
                      "writing",
                      "planning",
                      "ready_to_shoot",
                      "shooting",
                      "post",
                      "complete",
                      "archived",
                    ].map((value) => (
                      <option key={value} value={value}>
                        {value.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Timezone</span>
                  <input defaultValue={settings.data.project.timezone} name="timezone" required />
                </label>
                <label>
                  <span>Locale</span>
                  <input defaultValue={settings.data.project.locale} name="locale" required />
                </label>
                <label>
                  <span>Currency</span>
                  <input
                    defaultValue={settings.data.project.currency}
                    maxLength={3}
                    name="currency"
                    required
                  />
                </label>
                <label>
                  <span>Units</span>
                  <select defaultValue={settings.data.project.unitSystem} name="unitSystem">
                    <option value="metric">Metric / °C</option>
                    <option value="imperial">Imperial / °F</option>
                  </select>
                </label>
                <label>
                  <span>Paper</span>
                  <select defaultValue={settings.data.project.paperSize} name="paperSize">
                    <option value="A4">A4</option>
                    <option value="Letter">Letter</option>
                  </select>
                </label>
                <label>
                  <span>Aspect ratio</span>
                  <input defaultValue={settings.data.project.aspectRatio} name="aspectRatio" />
                </label>
              </div>
              {save.isError ? (
                <p className="form-error" role="alert">
                  Settings could not be saved. Review any conflicting update.
                </p>
              ) : null}
              <footer>
                <Button disabled={save.isPending} icon={<Save />} type="submit" variant="primary">
                  Save settings
                </Button>
              </footer>
              <section className="danger-zone">
                <h3>Project lifecycle</h3>
                <p>
                  Archive is recoverable. Permanent removal stays unavailable while retention or
                  legal safeguards apply.
                </p>
                <Button
                  disabled={lifecycle.isPending}
                  icon={settings.data.project.archivedAt ? <RotateCcw /> : <Archive />}
                  onClick={() =>
                    lifecycle.mutate(settings.data!.project.archivedAt ? "restore" : "archive")
                  }
                  variant={settings.data.project.archivedAt ? "secondary" : "danger"}
                >
                  {settings.data.project.archivedAt ? "Restore project" : "Archive project"}
                </Button>
              </section>
            </form>
          ) : null}
          {settings.data && tab === "security" ? (
            <section className="settings-section">
              <header>
                <Shield />
                <div>
                  <h2>Security & sessions</h2>
                  <p>Manage current devices. Password changes revoke all other sessions.</p>
                </div>
              </header>
              <div className="session-list">
                {settings.data.sessions.map((session) => (
                  <article key={session.id}>
                    <div>
                      <strong>{session.deviceLabel}</strong>
                      <span>
                        Last seen{" "}
                        {new Intl.DateTimeFormat("en-GB", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(session.lastSeenAt)}
                      </span>
                    </div>
                    {session.current ? (
                      <Status tone="success">Current</Status>
                    ) : (
                      <Button
                        disabled={revokeSession.isPending}
                        onClick={() => revokeSession.mutate(session.id)}
                        variant="quiet"
                      >
                        Revoke
                      </Button>
                    )}
                  </article>
                ))}
              </div>
              <Button icon={<KeyRound />} onClick={() => setPasswordOpen(true)}>
                Change password
              </Button>
              {auth.account?.role === "workspace_owner" ? (
                <div className="danger-zone">
                  <h3>Owner-only retention actions</h3>
                  <p>
                    Permanent deletion requires a verified archive, no legal hold, retention
                    approval, and typed confirmation.
                  </p>
                  <Button
                    disabled
                    icon={<Trash2 />}
                    title="No eligible deletion is selected"
                    variant="danger"
                  >
                    Permanent workspace deletion
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}
          {settings.data && tab === "providers" ? (
            <section className="settings-section">
              <header>
                <h2>Optional providers</h2>
                <p>
                  Manual entry, secure links, uploads and print remain available without providers.
                </p>
              </header>
              <div className="provider-list">
                {settings.data.providers.map((provider) => (
                  <article key={provider.key}>
                    <div>
                      <strong>{provider.label}</strong>
                      <span>{provider.fallback}</span>
                    </div>
                    <Status tone={provider.state === "configured" ? "success" : "neutral"}>
                      {provider.state.replaceAll("_", " ")}
                    </Status>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
      {passwordOpen ? (
        <div className="dialog-layer">
          <button
            aria-label="Cancel password change"
            className="dialog-layer__scrim"
            onClick={() => setPasswordOpen(false)}
            type="button"
          />
          <form
            aria-labelledby="change-password-title"
            aria-modal="true"
            className="form-dialog"
            onSubmit={submitPassword}
            role="dialog"
          >
            <header>
              <div>
                <h2 id="change-password-title">Change password</h2>
                <p>Saving revokes every other session and replaces this session.</p>
              </div>
            </header>
            <label>
              <span>Current password</span>
              <input
                autoComplete="current-password"
                name="currentPassword"
                required
                type="password"
              />
            </label>
            <label>
              <span>New password</span>
              <input
                autoComplete="new-password"
                minLength={14}
                name="newPassword"
                required
                type="password"
              />
            </label>
            <label>
              <span>Confirm new password</span>
              <input
                autoComplete="new-password"
                minLength={14}
                name="confirmation"
                required
                type="password"
              />
            </label>
            {passwordError ? (
              <p className="form-error" role="alert">
                {passwordError}
              </p>
            ) : null}
            <footer>
              <Button onClick={() => setPasswordOpen(false)} variant="quiet">
                Cancel
              </Button>
              <Button disabled={changePassword.isPending} type="submit" variant="primary">
                {changePassword.isPending ? "Changing…" : "Change password"}
              </Button>
            </footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}
