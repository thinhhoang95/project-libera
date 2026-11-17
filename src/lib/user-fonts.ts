// Registers Windows per-user fonts that Chromium's font list misses, as
// @font-face rules backed by the font files (electron/user-fonts.cjs). Nothing
// happens where main reports no such fonts (macOS, Linux, or any font Chromium
// already resolves and main does not list).

const loading = new Map<string, Promise<boolean>>();
const inFlight = new Set<Promise<unknown>>();

async function registerFamily(family: string): Promise<boolean> {
  const getFaces = window.liberaWindow?.getUserFontFaces;
  if (!getFaces || typeof FontFace === "undefined" || !document.fonts) return false;
  const faces = await getFaces(family ? [family] : []).catch(() => []);
  const results = await Promise.all(
    faces.map(async (face) => {
      const source = `url(${JSON.stringify(face.url)})${face.fullName ? `, local(${JSON.stringify(face.fullName)})` : ""}`;
      try {
        const loaded = await new FontFace(face.family, source, { weight: face.weight, style: face.style }).load();
        document.fonts.add(loaded);
        return true;
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

/**
 * Makes `families` (the font names saved in Preferences) resolvable in this
 * window. Resolves once their faces are loaded; true if any face was added, in
 * which case text already laid out in them is re-measured.
 */
export function ensureUserFonts(families: Iterable<string>): Promise<boolean> {
  const pending: Promise<boolean>[] = [];
  for (const raw of families) {
    const family = raw.trim();
    if (!family) continue;
    let promise = loading.get(family.toLowerCase());
    if (!promise) {
      promise = registerFamily(family);
      loading.set(family.toLowerCase(), promise);
      inFlight.add(promise);
      void promise.finally(() => inFlight.delete(promise!));
    }
    pending.push(promise);
  }
  return Promise.all(pending).then((added) => {
    const any = added.some(Boolean);
    // Editors measure text once its font is ready; tell them it changed.
    if (any && typeof window !== "undefined") window.dispatchEvent(new Event("resize"));
    return any;
  });
}

/** Resolves when every font load started by ensureUserFonts has settled. */
export async function whenUserFontsLoaded(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
