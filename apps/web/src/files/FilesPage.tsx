import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, FilePlus2, History, RotateCcw, UploadCloud, X } from "lucide-react";
import { useOutletContext, useParams } from "react-router";
import { createSHA256 } from "hash-wasm";
import { z } from "zod";
import { Button, IconButton, ProgressBar, Status, SurfaceBoundary } from "@swp/ui";

import { apiRequest, jsonBody } from "../api/client";
import type { AppOutletContext } from "../app/AppShell";
import { ProjectContextHeader } from "../app/ProjectContextHeader";
import { ShareLinksPanel } from "../shares/ShareLinksPanel";

const MAX_TEST_FILE_BYTES = 25 * 1024 * 1024;

const currentVersionSchema = z.object({
  id: z.string(),
  versionNumber: z.number(),
  byteSize: z.number().nullable(),
  mimeType: z.string().nullable(),
  sha256: z.string().nullable(),
  scanState: z.string().nullable(),
});
const fileSchema = z.object({
  id: z.string(),
  folderId: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  safeDisplayName: z.string(),
  currentVersionId: z.string().nullable(),
  provenance: z.string().nullable(),
  retentionClass: z.string().nullable(),
  retentionReviewAt: z.number().nullable(),
  version: z.number(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const fileListItemSchema = fileSchema.extend({ currentVersion: currentVersionSchema.nullable() });
const fileListSchema = z.object({ items: z.array(fileListItemSchema) });
const versionSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  versionNumber: z.number(),
  originalName: z.string(),
  safeDisplayName: z.string(),
  byteSize: z.number(),
  mimeType: z.string(),
  sha256: z.string(),
  uploaderUserId: z.string(),
  provenance: z.string().nullable(),
  scanState: z.string(),
  scanConfigured: z.boolean(),
  retentionClass: z.string().nullable(),
  createdAt: z.number(),
});
const fileDetailSchema = z.object({ file: fileSchema, versions: z.array(versionSchema) });
const uploadAuthorizationSchema = z.object({
  id: z.string(),
  fileId: z.string().nullable(),
  mode: z.literal("single"),
  state: z.string(),
  byteSize: z.number(),
  mimeType: z.string(),
  sha256: z.string(),
  expiresAt: z.number(),
  contentHref: z.string().nullable(),
  partHrefTemplate: z.string().nullable(),
  completeHref: z.string().nullable(),
  abortHref: z.string(),
  multipartPartBytes: z.number().nullable(),
  scanState: z.literal("not_configured"),
});
const uploadCompleteSchema = z.object({
  uploadSessionId: z.string(),
  state: z.literal("complete"),
  fileId: z.string(),
  version: versionSchema,
});
type FileItem = z.infer<typeof fileListItemSchema>;
type UploadAuthorization = z.infer<typeof uploadAuthorizationSchema>;

export function FilesPage() {
  const { projectId } = useParams();
  const { activeProject } = useOutletContext<AppOutletContext>();
  const queryClient = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"active" | "archived">("active");
  const [selected, setSelected] = useState<FileItem>();
  const [uploadFile, setUploadFile] = useState<File>();
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState<string>();
  const [selectionError, setSelectionError] = useState<string>();
  const [uploadResume, setUploadResume] = useState<{
    file: File;
    checksum: string;
    authorization: UploadAuthorization;
  }>();
  const base = `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/files`;
  const files = useQuery({
    enabled: Boolean(projectId),
    queryKey: ["files", projectId, state],
    queryFn: () => apiRequest(`${base}?state=${state}`, fileListSchema),
  });
  const detail = useQuery({
    enabled: Boolean(selected),
    queryKey: ["file", projectId, selected?.id],
    queryFn: () =>
      apiRequest(`${base}/${encodeURIComponent(selected?.id ?? "")}`, fileDetailSchema),
  });
  const lifecycle = useMutation({
    mutationFn: (file: FileItem) =>
      apiRequest(
        `${base}/${encodeURIComponent(file.id)}/${file.archivedAt ? "restore" : "archive"}`,
        fileSchema,
        { method: "POST", headers: { "If-Match": `"${file.version}"` } },
      ),
    onSuccess: async () => {
      setSelected(undefined);
      await queryClient.invalidateQueries({ queryKey: ["files", projectId] });
    },
  });
  const makeCurrent = useMutation({
    mutationFn: (input: { file: z.infer<typeof fileSchema>; versionId: string }) =>
      apiRequest(
        `${base}/${encodeURIComponent(input.file.id)}/versions/${encodeURIComponent(input.versionId)}/make-current`,
        fileSchema,
        { method: "POST", headers: { "If-Match": `"${input.file.version}"` } },
      ),
    onSuccess: async (file) => {
      setSelected((current) => (current ? { ...current, ...file } : current));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["file", projectId, file.id] }),
        queryClient.invalidateQueries({ queryKey: ["files", projectId] }),
      ]);
    },
  });
  const upload = useMutation({
    mutationFn: async (input: {
      file: File;
      title: string;
      provenance: string;
      retentionClass: string;
      existingFileId?: string;
    }) => {
      let resumed = uploadResume?.file === input.file ? uploadResume : undefined;
      if (!resumed) {
        setUploadStage("Calculating SHA-256 checksum");
        const checksum = await hashFile(input.file, (value) =>
          setUploadProgress(Math.round(value * 25)),
        );
        const authorization = await apiRequest(
          `${base}/uploads/authorize`,
          uploadAuthorizationSchema,
          {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: jsonBody({
              ...(input.existingFileId ? { fileId: input.existingFileId } : {}),
              title: input.title,
              name: input.file.name,
              mimeType: input.file.type || "application/octet-stream",
              byteSize: input.file.size,
              sha256: checksum,
              mode: "auto",
              provenance: input.provenance,
              retentionClass: input.retentionClass,
            }),
          },
        );
        resumed = { file: input.file, checksum, authorization };
        setUploadResume(resumed);
      }
      const { authorization, checksum } = resumed;
      try {
        if (!authorization.contentHref)
          throw new Error("Single-upload authorization is incomplete.");
        setUploadStage("Uploading and verifying private object");
        setUploadProgress(35);
        const result = await apiRequest(authorization.contentHref, uploadCompleteSchema, {
          method: "PUT",
          headers: { "Content-Type": authorization.mimeType, "X-Content-SHA256": checksum },
          body: input.file,
        });
        setUploadProgress(100);
        return result;
      } catch (error) {
        setUploadStage("Upload interrupted · authorization retained for retry");
        throw error;
      }
    },
    onSuccess: async (result) => {
      setUploadResume(undefined);
      setUploadStage(`Version ${result.version.versionNumber} verified in private storage`);
      await queryClient.invalidateQueries({ queryKey: ["files", projectId] });
      setTimeout(() => {
        setUploadFile(undefined);
        setUploadProgress(0);
        setUploadStage(undefined);
      }, 1_500);
    },
  });

  if (!activeProject) return <SurfaceBoundary state="error" title="Project unavailable" />;

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (file) {
      setUploadProgress(0);
      if (file.size > MAX_TEST_FILE_BYTES) {
        setUploadFile(undefined);
        setSelectionError("That file is larger than the 25 MiB test-storage limit.");
      } else {
        setUploadFile(file);
        setSelectionError(undefined);
        setUploadStage(undefined);
      }
    }
    event.currentTarget.value = "";
  }
  function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadFile) return;
    const form = new FormData(event.currentTarget);
    upload.mutate({
      file: uploadFile,
      title: String(form.get("title") ?? uploadFile.name),
      provenance: String(form.get("provenance") ?? ""),
      retentionClass: String(form.get("retentionClass") ?? "production"),
      ...(selected ? { existingFileId: selected.id } : {}),
    });
  }
  async function cancelUpload() {
    if (upload.isPending) return;
    if (uploadResume)
      await apiRequest(
        uploadResume.authorization.abortHref,
        z.object({ aborted: z.literal(true) }),
        { method: "POST" },
      ).catch(() => undefined);
    setUploadResume(undefined);
    setUploadFile(undefined);
    setUploadStage(undefined);
    setUploadProgress(0);
  }

  return (
    <section className="project-page">
      <ProjectContextHeader
        actions={
          <>
            <input className="swp-visually-hidden" onChange={chooseFile} ref={picker} type="file" />
            <Button
              icon={<UploadCloud />}
              onClick={() => {
                setSelected(undefined);
                picker.current?.click();
              }}
              variant="primary"
            >
              Upload file
            </Button>
          </>
        }
        project={activeProject}
        section="Documents"
        title="Files & Media"
      />
      <div className="page-intro">
        <p>
          Private logical files with immutable, checksummed versions. The no-subscription test
          profile uses Workers KV and can later migrate behind the same storage interface.
        </p>
      </div>
      <div className="provider-state">
        <Status tone="success">No subscription</Status>
        <span>
          Private test storage: 25 MiB per file, 1 GB total, and up to 1,000 writes per day. Large
          media and NAS archival can be added later without changing logical file IDs.
        </span>
      </div>
      {selectionError ? (
        <p className="form-error" role="alert">
          {selectionError}
        </p>
      ) : null}
      <div className="provider-state">
        <Status tone="warning">Not configured</Status>
        <span>
          Malware scan provider. File signatures and SHA-256 integrity are still verified; policy
          review is required.
        </span>
      </div>
      <div className="registry-toolbar">
        <Button
          icon={<Archive />}
          onClick={() => setState((value) => (value === "active" ? "archived" : "active"))}
          aria-pressed={state === "archived"}
          variant="quiet"
        >
          {state === "archived" ? "Active files" : "Archived files"}
        </Button>
        <span className="registry-count">{files.data?.items.length ?? 0} logical files</span>
      </div>
      {files.isLoading ? (
        <SurfaceBoundary state="loading" />
      ) : files.isError ? (
        <SurfaceBoundary state="error" />
      ) : files.data?.items.length ? (
        <div className="file-grid">
          {files.data.items.map((file) => (
            <article className="file-card" key={file.id}>
              <button onClick={() => setSelected(file)} type="button">
                <span className="file-card__type">
                  {file.currentVersion?.mimeType ?? "Pending"}
                </span>
                <strong>{file.title}</strong>
                <small>{file.safeDisplayName}</small>
              </button>
              <dl>
                <div>
                  <dt>Version</dt>
                  <dd>{file.currentVersion?.versionNumber ?? "—"}</dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>
                    {file.currentVersion?.byteSize
                      ? formatBytes(file.currentVersion.byteSize)
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Scan</dt>
                  <dd>
                    <Status
                      tone={file.currentVersion?.scanState === "clean" ? "success" : "warning"}
                    >
                      {file.currentVersion?.scanState?.replaceAll("_", " ") ?? "pending"}
                    </Status>
                  </dd>
                </div>
              </dl>
              <footer>
                <IconButton
                  label={`Upload a new version of ${file.title}`}
                  onClick={() => {
                    setSelected(file);
                    picker.current?.click();
                  }}
                >
                  <FilePlus2 />
                </IconButton>
                <IconButton
                  label={file.archivedAt ? `Restore ${file.title}` : `Archive ${file.title}`}
                  onClick={() => lifecycle.mutate(file)}
                >
                  {file.archivedAt ? <RotateCcw /> : <Archive />}
                </IconButton>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <SurfaceBoundary
          action={
            <Button
              icon={<UploadCloud />}
              onClick={() => picker.current?.click()}
              variant="primary"
            >
              Upload first file
            </Button>
          }
          description="Files stay private and become immutable versions after storage and checksum verification."
          state="empty"
          title="No files yet"
        />
      )}
      {uploadFile ? (
        <div className="dialog-layer">
          <button
            aria-label="Cancel upload"
            className="dialog-layer__scrim"
            onClick={() => void cancelUpload()}
            type="button"
          />
          <form
            aria-labelledby="upload-file-title"
            aria-modal="true"
            className="form-dialog"
            onSubmit={submitUpload}
            role="dialog"
          >
            <header>
              <h2 id="upload-file-title">
                {selected ? `New version of ${selected.title}` : "Upload private file"}
              </h2>
              <p>
                {uploadFile.name} · {formatBytes(uploadFile.size)}
              </p>
            </header>
            <label>
              <span>Display title</span>
              <input
                defaultValue={selected?.title ?? uploadFile.name}
                maxLength={240}
                name="title"
                required
              />
            </label>
            <label>
              <span>Provenance</span>
              <input
                maxLength={500}
                name="provenance"
                placeholder="Created internally, supplied by location owner…"
              />
            </label>
            <label>
              <span>Retention class</span>
              <select defaultValue="production" name="retentionClass">
                <option value="production">Production record</option>
                <option value="legal">Legal evidence</option>
                <option value="candidate">Candidate data</option>
                <option value="temporary">Temporary working file</option>
              </select>
            </label>
            {uploadStage ? (
              <div className="upload-progress" role="status">
                <strong>{uploadStage}</strong>
                <ProgressBar label="Upload progress" value={uploadProgress} />
              </div>
            ) : null}
            {upload.isError ? (
              <p className="form-error" role="alert">
                Upload stopped before verification. The same selected file can retry the retained
                session without claiming false completion.
              </p>
            ) : null}
            <footer>
              <Button
                disabled={upload.isPending}
                onClick={() => void cancelUpload()}
                variant="quiet"
              >
                Cancel upload
              </Button>
              <Button disabled={upload.isPending} type="submit" variant="primary">
                {upload.isPending
                  ? "Working…"
                  : uploadResume
                    ? "Resume and verify"
                    : "Upload and verify"}
              </Button>
            </footer>
          </form>
        </div>
      ) : null}
      {selected && !uploadFile ? (
        <div className="drawer-layer">
          <button
            aria-label="Close file history"
            className="drawer-scrim"
            onClick={() => setSelected(undefined)}
            type="button"
          />
          <aside
            aria-labelledby="file-history-title"
            aria-modal="true"
            className="record-editor"
            role="dialog"
          >
            <header>
              <div>
                <p>Immutable versions</p>
                <h2 id="file-history-title">{selected.title}</h2>
              </div>
              <IconButton label="Close file history" onClick={() => setSelected(undefined)}>
                <X />
              </IconButton>
            </header>
            {detail.isLoading ? (
              <SurfaceBoundary state="loading" />
            ) : detail.isError ? (
              <SurfaceBoundary state="error" />
            ) : (
              <>
                <div className="file-version-list">
                  {detail.data?.versions.map((version) => (
                    <article key={version.id}>
                      <header>
                        <div>
                          <History aria-hidden="true" />
                          <strong>Version {version.versionNumber}</strong>
                        </div>
                        {detail.data.file.currentVersionId === version.id ? (
                          <Status tone="success">Current</Status>
                        ) : null}
                      </header>
                      <span>
                        {version.safeDisplayName} · {formatBytes(version.byteSize)}
                      </span>
                      <code>{version.sha256}</code>
                      <small>
                        Scan: {version.scanState.replaceAll("_", " ")} ·{" "}
                        {formatDate(version.createdAt)}
                      </small>
                      <footer>
                        <Button
                          icon={<Download />}
                          onClick={() =>
                            window.open(
                              `${base}/${encodeURIComponent(selected.id)}/versions/${encodeURIComponent(version.id)}/download`,
                              "_blank",
                              "noopener,noreferrer",
                            )
                          }
                        >
                          Download
                        </Button>
                        {detail.data.file.currentVersionId !== version.id ? (
                          <Button
                            disabled={makeCurrent.isPending}
                            onClick={() =>
                              makeCurrent.mutate({ file: detail.data.file, versionId: version.id })
                            }
                            variant="quiet"
                          >
                            Make current
                          </Button>
                        ) : null}
                      </footer>
                    </article>
                  ))}
                </div>
                {projectId && detail.data?.file.currentVersionId ? (
                  <ShareLinksPanel
                    objectId={detail.data.file.currentVersionId}
                    objectType="file_version"
                    projectId={projectId}
                  />
                ) : null}
              </>
            )}
          </aside>
        </div>
      ) : null}
    </section>
  );
}

async function hashFile(file: File, progress: (value: number) => void): Promise<string> {
  const hasher = await createSHA256();
  const chunkBytes = 8 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    hasher.update(
      new Uint8Array(
        await file.slice(offset, Math.min(file.size, offset + chunkBytes)).arrayBuffer(),
      ),
    );
    progress(Math.min(1, (offset + chunkBytes) / file.size));
  }
  return hasher.digest("hex");
}
function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MiB`;
  return `${(value / 1_073_741_824).toFixed(2)} GiB`;
}
function formatDate(value: number): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    value,
  );
}
