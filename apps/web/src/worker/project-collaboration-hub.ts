import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

const clientEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("presence"),
      objectType: z.string().max(64),
      objectId: z.string().max(80).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("invalidate"),
      objectType: z.string().max(64),
      objectId: z.string().max(80),
      version: z.number().int().positive(),
    })
    .strict(),
  z.object({ type: z.literal("heartbeat"), at: z.number().int() }).strict(),
]);

export class ProjectCollaborationHub extends DurableObject<CloudflareBindings> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket upgrade required", { status: 426 });
    const workspaceId = request.headers.get("X-SWP-Workspace-ID");
    const projectId = request.headers.get("X-SWP-Project-ID");
    const actorId = request.headers.get("X-SWP-Actor-ID");
    if (!workspaceId || !projectId || !actorId)
      return new Response("Authorisation context missing", { status: 403 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [
      `workspace:${workspaceId}`,
      `project:${projectId}`,
      `actor:${actorId}`,
    ]);
    server.serializeAttachment({ workspaceId, projectId, actorId });
    this.broadcast({ type: "presence_joined", actorId, occurredAt: Date.now() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > 8_192) {
      socket.close(1009, "Message too large");
      return;
    }
    try {
      const event = clientEventSchema.parse(JSON.parse(message));
      const attachment = socket.deserializeAttachment() as {
        workspaceId: string;
        projectId: string;
        actorId: string;
      } | null;
      if (!attachment) {
        socket.close(1008, "Missing session context");
        return;
      }
      if (event.type === "heartbeat") {
        socket.send(JSON.stringify({ type: "heartbeat_ack", at: Date.now() }));
        return;
      }
      this.broadcast(
        {
          ...event,
          actorId: attachment.actorId,
          projectId: attachment.projectId,
          occurredAt: Date.now(),
        },
        socket,
      );
    } catch {
      socket.send(JSON.stringify({ type: "error", code: "invalid_event" }));
    }
  }

  override webSocketClose(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as { actorId: string } | null;
    if (attachment)
      this.broadcast(
        { type: "presence_left", actorId: attachment.actorId, occurredAt: Date.now() },
        socket,
      );
  }

  private broadcast(event: Record<string, unknown>, exclude?: WebSocket): void {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== exclude) socket.send(payload);
    }
  }
}
