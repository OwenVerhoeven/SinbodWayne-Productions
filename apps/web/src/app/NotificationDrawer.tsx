import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, X } from "lucide-react";
import { Button, IconButton, SurfaceBoundary, Status } from "@swp/ui";
import { z } from "zod";

import { apiRequest } from "../api/client";

const notificationsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      createdAt: z.number(),
      readAt: z.number().nullable(),
    }),
  ),
  unread: z.number(),
});

export function NotificationDrawer({
  onClose,
  open,
}: {
  readonly onClose: () => void;
  readonly open: boolean;
}) {
  const queryClient = useQueryClient();
  const notifications = useQuery({
    enabled: open,
    queryKey: ["notifications"],
    queryFn: () => apiRequest("/api/v1/app/notifications?limit=50", notificationsSchema),
  });
  const markRead = useMutation({
    mutationFn: () =>
      apiRequest("/api/v1/app/notifications/read", z.object({ updated: z.number() }), {
        method: "POST",
      }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  useEffect(() => {
    if (open)
      requestAnimationFrame(() =>
        document.querySelector<HTMLButtonElement>(".notification-drawer button")?.focus(),
      );
  }, [open]);

  if (!open) return null;

  return (
    <div className="drawer-layer">
      <button
        aria-label="Close notifications"
        className="drawer-scrim"
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label="Notifications"
        aria-modal="true"
        className="notification-drawer"
        role="dialog"
      >
        <header>
          <div>
            <Bell aria-hidden="true" />
            <h2>Notifications</h2>
          </div>
          <IconButton label="Close notifications" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        {notifications.data?.unread ? (
          <div className="notification-drawer__actions">
            <Status tone="info">{notifications.data.unread} unread</Status>
            <Button onClick={() => markRead.mutate()} variant="quiet">
              Mark all read
            </Button>
          </div>
        ) : null}
        <div className="notification-list">
          {notifications.isLoading ? (
            <SurfaceBoundary state="loading" />
          ) : notifications.isError ? (
            <SurfaceBoundary state="error" />
          ) : notifications.data?.items.length ? (
            notifications.data.items.map((item) => (
              <article className={item.readAt ? "" : "notification--unread"} key={item.id}>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <time dateTime={new Date(item.createdAt).toISOString()}>
                  {new Intl.DateTimeFormat("en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(item.createdAt)}
                </time>
              </article>
            ))
          ) : (
            <SurfaceBoundary
              description="Mentions, approvals and recent changes will appear here."
              state="empty"
              title="You are up to date"
            />
          )}
        </div>
      </aside>
    </div>
  );
}
