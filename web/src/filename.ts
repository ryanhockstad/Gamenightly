// Shared by the front end and the dev mock API (no browser-only imports).

/** Strip characters that are invalid in filenames on common OSes; fall back to the app name. */
export function safeFilename(title: string): string {
  const clean = title
    // eslint-disable-next-line no-control-regex -- control characters are invalid in filenames
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, "");
  return clean || "GameNightly event";
}
