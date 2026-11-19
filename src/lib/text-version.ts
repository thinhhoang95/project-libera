/**
 * The version of a text, as the server computes it (storage/files.ts
 * textVersion: SHA-256 of the UTF-8 bytes, hex). An editor sends the version of
 * the text it last loaded or saved so a save never replaces a newer file.
 * Undefined where the browser has no SubtleCrypto: the save then carries no
 * version and replaces whatever is there, as before.
 */
export async function textVersion(text: string): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}
