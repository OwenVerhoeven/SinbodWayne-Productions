import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import { z } from "zod";
import { SurfaceBoundary, Wordmark } from "@swp/ui";
import DOMPurify from "dompurify";

import { apiRequest } from "../api/client";

const printArtifactSchema = z.object({
  title: z.string(),
  subtitle: z.string().nullable(),
  issueLabel: z.string().nullable(),
  confidentiality: z.string().nullable(),
  paperSize: z.enum(["A4", "Letter"]),
  orientation: z.enum(["portrait", "landscape"]),
  generatedAt: z.number(),
  sections: z.array(
    z.object({ id: z.string(), heading: z.string(), html: z.string(), breakBefore: z.boolean() }),
  ),
  footer: z.string(),
});

export function PrintArtifactPage() {
  const { artifactId, artifactType } = useParams();
  const [params] = useSearchParams();
  const paper = params.get("paper") === "Letter" ? "Letter" : "A4";
  const orientation = params.get("orientation") === "landscape" ? "landscape" : "portrait";
  const artifact = useQuery({
    queryKey: ["print", artifactType, artifactId, paper, orientation],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/print/${encodeURIComponent(artifactType ?? "")}/${encodeURIComponent(artifactId ?? "")}?paper=${paper}&orientation=${orientation}`,
        printArtifactSchema,
      ),
  });

  if (artifact.isLoading)
    return (
      <main className="print-loading">
        <SurfaceBoundary state="loading" />
      </main>
    );
  if (artifact.isError || !artifact.data)
    return (
      <main className="print-loading">
        <SurfaceBoundary state="permission" title="Print view unavailable" />
      </main>
    );

  return (
    <main
      className={`print-document print-document--${artifact.data.paperSize.toLowerCase()} print-document--${artifact.data.orientation}`}
    >
      <header className="print-cover">
        <Wordmark />
        <p>{artifact.data.issueLabel ?? artifactType?.replaceAll("_", " ")}</p>
        <h1>{artifact.data.title}</h1>
        {artifact.data.subtitle ? <h2>{artifact.data.subtitle}</h2> : null}
        {artifact.data.confidentiality ? <strong>{artifact.data.confidentiality}</strong> : null}
        <time dateTime={new Date(artifact.data.generatedAt).toISOString()}>
          {new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short" }).format(
            artifact.data.generatedAt,
          )}
        </time>
      </header>
      {artifact.data.sections.map((section) => (
        <section className={section.breakBefore ? "print-break-before" : ""} key={section.id}>
          <h2>{section.heading}</h2>
          <div
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(section.html, { USE_PROFILES: { html: true } }),
            }}
          />
        </section>
      ))}
      <footer className="print-footer">{artifact.data.footer}</footer>
    </main>
  );
}
