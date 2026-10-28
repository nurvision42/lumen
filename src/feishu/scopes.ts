/** User-identity scopes requested at app setup and again at user OAuth. */
export interface ScopeSpec {
  scope: string;
  group: string;
  summary: string;
}

export const USER_SCOPE_SPECS: readonly ScopeSpec[] = [
  { scope: "offline_access", group: "login", summary: "Refresh the user access token" },
  { scope: "drive:drive", group: "drive", summary: "View, comment, edit, and manage every file in My Space" },
  { scope: "drive:drive.search:readonly", group: "drive", summary: "Search docs in the user's drive" },
  { scope: "drive:drive.metadata:readonly", group: "drive", summary: "Read file metadata" },
  { scope: "drive:file", group: "drive", summary: "Upload and download drive files" },
  { scope: "drive:file:upload", group: "drive", summary: "Upload files into a drive folder" },
  { scope: "drive:file:download", group: "drive", summary: "Download drive files" },
  { scope: "space:document:retrieve", group: "drive", summary: "List files in a drive folder" },
  { scope: "space:document:move", group: "drive", summary: "Move files and folders" },
  { scope: "space:document:delete", group: "drive", summary: "Delete files and folders" },
  { scope: "space:document:shortcut", group: "drive", summary: "Create shortcuts" },
  { scope: "search:docs:read", group: "drive", summary: "Search docs the user can open" },
  { scope: "docx:document", group: "docx", summary: "Create and edit new docs (docx)" },
  { scope: "docx:document:write_only", group: "docx", summary: "Edit new doc content" },
  { scope: "docs:document.content:read", group: "docx", summary: "Read doc content" },
  { scope: "docs:document.media:upload", group: "docx", summary: "Upload images and attachments into docs" },
  { scope: "docs:document.media:download", group: "docx", summary: "Download images and attachments from docs" },
  { scope: "docs:doc", group: "doc", summary: "View, comment, edit, and manage classic docs" },
  { scope: "sheets:spreadsheet", group: "sheet", summary: "View, comment, edit, and manage spreadsheets" },
  { scope: "bitable:app", group: "bitable", summary: "View, comment, edit, and manage bitables" },
  { scope: "wiki:wiki", group: "wiki", summary: "View, edit, and manage wikis" },
  { scope: "wiki:space:retrieve", group: "wiki", summary: "List wiki spaces" },
  { scope: "wiki:space:read", group: "wiki", summary: "Read wiki space info" },
  { scope: "wiki:node:retrieve", group: "wiki", summary: "List wiki nodes" },
  { scope: "wiki:node:read", group: "wiki", summary: "Read a wiki node" },
  { scope: "wiki:node:create", group: "wiki", summary: "Create wiki nodes" },
  { scope: "wiki:node:update", group: "wiki", summary: "Update wiki nodes" },
  { scope: "mindnote:node:read", group: "mindnote", summary: "Read mindnote nodes" },
  { scope: "mindnote:node:create", group: "mindnote", summary: "Create mindnote nodes" },
  { scope: "board:whiteboard:node:read", group: "board", summary: "Read whiteboard nodes" },
  { scope: "board:whiteboard:node:create", group: "board", summary: "Create whiteboard nodes" },
  { scope: "board:whiteboard:node:update", group: "board", summary: "Update whiteboard nodes" },
  { scope: "board:whiteboard:node:delete", group: "board", summary: "Delete whiteboard nodes" },
  { scope: "slides:presentation:read", group: "slides", summary: "Read slides" },
  { scope: "slides:presentation:write_only", group: "slides", summary: "Create and edit slides" },
  { scope: "docs:document.comment:create", group: "comment", summary: "Add doc comments and replies" },
  { scope: "docs:document.comment:read", group: "comment", summary: "Read doc comments" },
  { scope: "docs:document.comment:update", group: "comment", summary: "Update doc comments" },
  { scope: "docs:document.comment:delete", group: "comment", summary: "Delete doc comments" },
  { scope: "docs:permission.member", group: "permission", summary: "View, add, update, and remove collaborators" },
  { scope: "docs:permission.member:create", group: "permission", summary: "Add collaborators" },
  { scope: "docs:permission.member:retrieve", group: "permission", summary: "List collaborators" },
  { scope: "docs:permission.member:update", group: "permission", summary: "Update collaborator roles" },
  { scope: "docs:permission.member:delete", group: "permission", summary: "Remove collaborators" },
  { scope: "docs:permission.setting", group: "permission", summary: "View and update share settings" },
  { scope: "docs:permission.setting:read", group: "permission", summary: "Read share settings" },
  { scope: "docs:permission.setting:write_only", group: "permission", summary: "Update share settings" },
];

export const USER_SCOPES: readonly string[] = USER_SCOPE_SPECS.map((item) => item.scope);

export function userScopeString(): string {
  return USER_SCOPES.join(" ");
}

export function missingScopes(granted: string | undefined): string[] {
  const have = new Set((granted ?? "").split(/\s+/).filter((item) => item.length > 0));
  return USER_SCOPES.filter((scope) => !have.has(scope));
}
