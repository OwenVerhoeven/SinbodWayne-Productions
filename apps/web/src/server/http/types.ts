import { KvPrivateObjectStore, type PrivateObjectStore } from "../storage/private-object-store";

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

export type ApplicationBindings = Omit<CloudflareBindings, "FILE_OBJECTS"> & {
  readonly FILE_OBJECTS: KVNamespace;
  readonly FILES: PrivateObjectStore;
};

export function applicationBindings(bindings: CloudflareBindings): ApplicationBindings {
  return {
    ...bindings,
    FILES: new KvPrivateObjectStore(bindings.FILE_OBJECTS),
  };
}

export type AppEnv = {
  Bindings: ApplicationBindings;
  Variables: {
    requestId: string;
    actor: ActorContext;
  };
};
