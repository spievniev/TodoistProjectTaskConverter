// Newly-created resources are assigned "tmp-XXX" IDs until they are synced.
// API cannot use these IDs, it is required to wait or retry.
export const isSynced = (id: string) => !id.startsWith("tmp-");

// Subset of PersonalProject and WorkspaceProject to avoid handling type union.
export type Project = {
    id: string;
    name: string;
    inboxProject?: boolean;
};
