// Öffentliche Schnittstelle des Moduls (eigenständige Web-App und Clock-In nutzen dasselbe)
export { NotesWorkspace, type NotesWorkspaceProps } from "./Workspace";
export { LocalStore } from "./store/local";
export { SupabaseStore } from "./store/supabase";
export type { Member, NotesStore, PageMeta } from "./types";
