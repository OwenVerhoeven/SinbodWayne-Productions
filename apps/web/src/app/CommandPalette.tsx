import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command, Search, X } from "lucide-react";
import { IconButton, SurfaceBoundary } from "@swp/ui";
import { useNavigate } from "react-router";
import { z } from "zod";

import { apiRequest } from "../api/client";
import type { ProjectSummary } from "./schemas";

const searchResultSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      objectType: z.string(),
      title: z.string(),
      subtitle: z.string().nullable(),
      href: z.string(),
    }),
  ),
});

export function CommandPalette({
  activeProject,
  onClose,
  open,
}: {
  readonly activeProject: ProjectSummary | undefined;
  readonly onClose: () => void;
  readonly open: boolean;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const search = useQuery({
    enabled: open && query.trim().length >= 2,
    queryKey: ["search", activeProject?.id, query],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/search?q=${encodeURIComponent(query.trim())}${activeProject ? `&projectId=${encodeURIComponent(activeProject.id)}` : ""}`,
        searchResultSchema,
      ),
  });

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (open && event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="dialog-layer" role="presentation">
      <button
        aria-label="Close command palette"
        className="dialog-layer__scrim"
        onClick={onClose}
        type="button"
      />
      <section
        aria-label="Search production"
        aria-modal="true"
        className="command-palette"
        role="dialog"
      >
        <div className="command-palette__input">
          <Search aria-hidden="true" />
          <input
            aria-label="Search projects and production records"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search scenes, people, files, tasks…"
            ref={inputRef}
            value={query}
          />
          <IconButton label="Close" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <div className="command-palette__results">
          {query.trim().length < 2 ? (
            <div className="command-hint">
              <Command aria-hidden="true" />
              <span>Type at least two characters. Results are permission filtered.</span>
            </div>
          ) : search.isLoading ? (
            <SurfaceBoundary state="loading" />
          ) : search.isError ? (
            <SurfaceBoundary state="error" />
          ) : search.data?.items.length ? (
            <ul>
              {search.data.items.map((result) => (
                <li key={`${result.objectType}:${result.id}`}>
                  <button
                    onClick={() => {
                      onClose();
                      void navigate(result.href);
                    }}
                    type="button"
                  >
                    <span>{result.title}</span>
                    <small>
                      {result.objectType.replaceAll("_", " ")}
                      {result.subtitle ? ` · ${result.subtitle}` : ""}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <SurfaceBoundary
              description="No permitted records match this search."
              state="empty"
              title="No results"
            />
          )}
        </div>
      </section>
    </div>
  );
}
