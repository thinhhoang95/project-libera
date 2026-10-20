// Kysely table types for migrations/*.sql. Keep them in step with the SQL:
// there is no code generation.

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

import type { Actor, Provenance } from "../protocol.js";

type CreatedAt = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTime = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, T | string, T | string>;

export interface AccountsTable {
  id: string;
  email: string;
  display_name: string;
  color: string;
  password_hash: string;
  created_at: CreatedAt;
  disabled_at: NullableTime;
}

export interface RefreshTokensTable {
  id: string;
  account_id: string;
  token_hash: string;
  family_id: string;
  device_name: string | null;
  created_at: CreatedAt;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: NullableTime;
  replaced_by: string | null;
}

export interface ProjectsTable {
  id: string;
  name: string;
  owner_id: string;
  manifest_doc_id: string;
  created_at: CreatedAt;
  deleted_at: NullableTime;
}

export interface MembershipsTable {
  project_id: string;
  account_id: string;
  role: "owner" | "editor" | "commenter" | "viewer";
  created_at: CreatedAt;
}

export interface InvitationsTable {
  id: string;
  project_id: string;
  email: string;
  role: "editor" | "commenter" | "viewer";
  token_hash: string;
  invited_by: string;
  created_at: CreatedAt;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  accepted_at: NullableTime;
  accepted_by: string | null;
  revoked_at: NullableTime;
}

export interface DocumentsTable {
  id: string;
  project_id: string;
  kind: "markdown" | "latex" | "text" | "manifest";
  file_id: string | null;
  schema_version: ColumnType<number, number | undefined, number>;
  last_server_seq: ColumnType<number, number | undefined, number>;
  created_by: string | null;
  created_at: CreatedAt;
  deleted_at: NullableTime;
}

export type SubdocColumn = "content" | "annotations" | "meta" | "manifest";

export interface DocUpdatesTable {
  doc_id: string;
  subdoc: SubdocColumn;
  server_seq: number;
  account_id: string | null;
  client_id: string;
  client_seq: number;
  actor: Json<Actor | null>;
  provenance: Json<Provenance | null>;
  update: Uint8Array;
  size: number;
  received_at: CreatedAt;
}

export interface DocSnapshotsTable {
  doc_id: string;
  subdoc: SubdocColumn;
  upto_server_seq: number;
  state: Uint8Array;
  state_vector: Uint8Array;
  created_at: CreatedAt;
}

export interface RevisionsTable {
  id: string;
  doc_id: string;
  server_seq: number;
  label: string | null;
  kind: "auto" | "named" | "session-end" | "pre-accept-all" | "pre-restore" | "review-base";
  created_by: string | null;
  created_at: CreatedAt;
}

export interface BlobsTable {
  project_id: string;
  hash: string;
  size: number;
  mime: string;
  created_by: string | null;
  created_at: CreatedAt;
}

export interface ThreadsTable {
  id: string;
  doc_id: string;
  project_id: string;
  anchor_id: string;
  quote_text: string;
  status: "open" | "resolved" | "detached";
  actor: Json<Actor>;
  account_id: string;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  resolved_by: string | null;
  resolved_at: NullableTime;
  deleted_at: NullableTime;
}

export interface MessagesTable {
  id: string;
  thread_id: string;
  actor: Json<Actor>;
  account_id: string;
  body: string;
  mentions: Json<string[]>;
  created_at: CreatedAt;
  edited_at: NullableTime;
  deleted_at: NullableTime;
}

export interface SuggestionsTable {
  id: string;
  doc_id: string;
  project_id: string;
  group_id: string | null;
  actor: Json<Actor>;
  account_id: string;
  base_quote: string;
  replacement: string;
  status: "pending" | "accepted" | "rejected" | "stale" | "withdrawn";
  thread_ids: Json<string[]>;
  created_at: CreatedAt;
  updated_at: CreatedAt;
  decided_by: string | null;
  decided_at: NullableTime;
  decision_server_seq: number | null;
  stale_reason: string | null;
}

export interface ReviewsTable {
  id: string;
  doc_id: string;
  project_id: string;
  requested_by: string;
  base_revision_id: string;
  scope: Json<Record<string, unknown>>;
  note: ColumnType<string, string | undefined, string>;
  status: "open" | "approved" | "changes-requested" | "closed";
  created_at: CreatedAt;
  closed_at: NullableTime;
}

export interface ReviewAssignmentsTable {
  review_id: string;
  account_id: string;
  decision: ColumnType<"pending" | "approved" | "changes-requested", "pending" | "approved" | "changes-requested" | undefined, "pending" | "approved" | "changes-requested">;
  decided_revision_id: string | null;
  decided_server_seq: number | null;
  decided_at: NullableTime;
  outdated: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface NotificationsTable {
  id: string;
  account_id: string;
  project_id: string | null;
  doc_id: string | null;
  kind: string;
  payload: Json<Record<string, unknown>>;
  created_at: CreatedAt;
  read_at: NullableTime;
  emailed_at: NullableTime;
}

export interface CommandsTable {
  account_id: string;
  id: string;
  kind: string;
  status: number;
  result: Json<unknown>;
  created_at: CreatedAt;
}

export interface AuditLogTable {
  id: Generated<number>;
  project_id: string | null;
  actor: Json<Actor | null>;
  account_id: string | null;
  action: string;
  target: string;
  details: Json<Record<string, unknown>>;
  at: CreatedAt;
}

/** migrations/002_quarantine.sql: updates detached by `admin doc quarantine`. */
export interface QuarantinedUpdatesTable {
  doc_id: string;
  subdoc: SubdocColumn;
  server_seq: number;
  account_id: string | null;
  client_id: string;
  client_seq: number;
  actor: Json<Actor | null>;
  provenance: Json<Provenance | null>;
  update: Uint8Array;
  size: number;
  received_at: ColumnType<Date, Date | string, Date | string>;
  quarantine_id: string;
  reason: "range" | "dependent";
  quarantined_at: CreatedAt;
}

/** migrations/003_registration_codes.sql: admin-issued codes for new accounts. */
export interface RegistrationCodesTable {
  id: string;
  code_hash: string;
  note: string | null;
  max_uses: Generated<number>;
  uses: Generated<number>;
  created_at: CreatedAt;
  expires_at: NullableTime;
  revoked_at: NullableTime;
}

/** migrations/004_folder_leases.sql: which installation writes a synced notebook folder. */
export interface FolderLeasesTable {
  project_id: string;
  account_id: string;
  folder_id: string;
  holder: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  contended_at: NullableTime;
  updated_at: CreatedAt;
}

/** migrations/005_device_grants.sql: sign-in grants shared between one person's computers. */
export interface DeviceGrantsTable {
  id: string;
  account_id: string;
  token_hash: string;
  device_name: string | null;
  created_at: CreatedAt;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  last_used_at: NullableTime;
  revoked_at: NullableTime;
}

export interface SchemaMigrationsTable {
  name: string;
  applied_at: CreatedAt;
}

export interface DB {
  accounts: AccountsTable;
  refresh_tokens: RefreshTokensTable;
  projects: ProjectsTable;
  memberships: MembershipsTable;
  invitations: InvitationsTable;
  documents: DocumentsTable;
  doc_updates: DocUpdatesTable;
  doc_snapshots: DocSnapshotsTable;
  revisions: RevisionsTable;
  blobs: BlobsTable;
  threads: ThreadsTable;
  messages: MessagesTable;
  suggestions: SuggestionsTable;
  reviews: ReviewsTable;
  review_assignments: ReviewAssignmentsTable;
  notifications: NotificationsTable;
  commands: CommandsTable;
  audit_log: AuditLogTable;
  quarantined_updates: QuarantinedUpdatesTable;
  registration_codes: RegistrationCodesTable;
  folder_leases: FolderLeasesTable;
  device_grants: DeviceGrantsTable;
  schema_migrations: SchemaMigrationsTable;
}

export type AccountRow = Selectable<AccountsTable>;
export type ProjectRow = Selectable<ProjectsTable>;
export type DocumentRow = Selectable<DocumentsTable>;
export type DocUpdateRow = Selectable<DocUpdatesTable>;
export type NewDocUpdate = Insertable<DocUpdatesTable>;
export type ThreadRow = Selectable<ThreadsTable>;
export type MessageRow = Selectable<MessagesTable>;
export type SuggestionRow = Selectable<SuggestionsTable>;
export type SuggestionUpdate = Updateable<SuggestionsTable>;
