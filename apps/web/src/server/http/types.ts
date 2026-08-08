export type WorkspaceRole = "workspace_owner" | "producer";

export interface ActorContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: WorkspaceRole;
  readonly authEpoch: number;
  readonly csrfHash: string;
  readonly lastSeenAt: number;
}

export type AppEnv = {
  Bindings: CloudflareBindings;
  Variables: {
    requestId: string;
    actor: ActorContext;
  };
};
