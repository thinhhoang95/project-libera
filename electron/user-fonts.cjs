// Per-user fonts on Windows, read straight from their files.
//
// Chromium learns about installed fonts from DirectWrite's system collection,
// which can be stale: fonts installed "for the current user" are then missing
// from queryLocalFonts() AND never match in CSS (docs/audits/
// 2026-11-18-windows-font-discovery.md). Refreshing DirectWrite from main needs
// a native addon and still leaves CSS matching broken, so this module skips
// DirectWrite entirely: it finds the per-user font files, reads their names
// from the sfnt headers, and serves each face to renderers over the privileged
// libera-font: protocol so they can register it as an @font-face.
//
// Only per-user fonts are covered (%LOCALAPPDATA%\Microsoft\Windows\Fonts plus
// absolute paths in HKCU's font registry). System-wide fonts keep going through
// Chromium. Nothing here touches the registry except to read it.
const { createHash } = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

const FONT_SCHEME = "libera-font";
const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc", ".otc"]);
const MAX_REQUEST_FAMILIES = 16;
const MAX_FAMILY_LENGTH = 256;
const MIN_RESCAN_MS = 5000;
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */, 0x74797031 /* typ1 */]);
const TTC_TAG = 0x74746366;
const REGISTRY_KEY = "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";

/** Name IDs we read: 1 family, 4 full name, 16 typographic family. */
const NAME_IDS = new Set([1, 4, 16]);

function decodeName(buffer, platformId, languageId) {
  if (platformId === 3 || platformId === 0) {
    const swapped = Buffer.from(buffer);
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (platformId === 1 && languageId === 0) return buffer.toString("latin1");
  return null;
}

function nameScore(platformId, languageId) {
  if (platformId === 3 && languageId === 0x409) return 4;
  if (platformId === 3) return 3;
  if (platformId === 0) return 2;
  return 1;
}

function parseNameTable(table) {
  if (table.length < 6) return {};
  const count = table.readUInt16BE(2);
  const stringOffset = table.readUInt16BE(4);
  const best = new Map();
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 12;
    if (at + 12 > table.length) break;
    const platformId = table.readUInt16BE(at);
    const languageId = table.readUInt16BE(at + 4);
    const nameId = table.readUInt16BE(at + 6);
    if (!NAME_IDS.has(nameId)) continue;
    const length = table.readUInt16BE(at + 8);
    const start = stringOffset + table.readUInt16BE(at + 10);
    if (start + length > table.length) continue;
    const text = decodeName(table.subarray(start, start + length), platformId, languageId)?.trim();
    if (!text) continue;
    const score = nameScore(platformId, languageId);
    if (!best.has(nameId) || best.get(nameId).score < score) best.set(nameId, { score, text });
  }
  return Object.fromEntries([...best].map(([id, { text }]) => [id, text]));
}

/** The table directory of the sfnt at `offset`: Map<tag, {offset, length}> plus its header words. */
async function readDirectory(handle, offset) {
  const header = Buffer.alloc(12);
  const { bytesRead } = await handle.read(header, 0, 12, offset);
  if (bytesRead < 12 || !SFNT_VERSIONS.has(header.readUInt32BE(0))) return null;
  const numTables = header.readUInt16BE(4);
  if (numTables === 0 || numTables > 512) return null;
  const records = Buffer.alloc(numTables * 16);
  await handle.read(records, 0, records.length, offset + 12);
  const tables = new Map();
  for (let index = 0; index < numTables; index++) {
    tables.set(records.toString("latin1", index * 16, index * 16 + 4), {
      offset: records.readUInt32BE(index * 16 + 8),
      length: records.readUInt32BE(index * 16 + 12),
    });
  }
  return { header, tables };
}

async function readTable(handle, directory, tag, limit = 1 << 20) {
  const entry = directory.tables.get(tag);
  if (!entry || entry.length === 0) return null;
  const buffer = Buffer.alloc(Math.min(entry.length, limit));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.offset);
  return buffer.subarray(0, bytesRead);
}

/** wght axis range of a variable font, or null. */
function parseWeightAxis(fvar) {
  if (!fvar || fvar.length < 16) return null;
  const axesOffset = fvar.readUInt16BE(4);
  const axisCount = fvar.readUInt16BE(8);
  const axisSize = fvar.readUInt16BE(10);
  for (let index = 0; index < axisCount; index++) {
    const at = axesOffset + index * axisSize;
    if (at + 20 > fvar.length) break;
    if (fvar.toString("latin1", at, at + 4) === "wght") {
      const min = Math.round(fvar.readInt32BE(at + 4) / 65536);
      const max = Math.round(fvar.readInt32BE(at + 12) / 65536);
      return min > 0 && max >= min ? { min, max } : null;
    }
  }
  return null;
}

async function readFace(handle, offset) {
  const directory = await readDirectory(handle, offset);
  if (!directory) return null;
  const name = await readTable(handle, directory, "name");
  if (!name) return null;
  const names = parseNameTable(name);
  const legacyFamily = names[1];
  const family = names[16] || legacyFamily;
  if (!family) return null;
  const os2 = await readTable(handle, directory, "OS/2", 96);
  const head = await readTable(handle, directory, "head", 64);
  const selection = os2 && os2.length >= 64 ? os2.readUInt16BE(62) : 0;
  const macStyle = head && head.length >= 46 ? head.readUInt16BE(44) : 0;
  const italic = Boolean(selection & 0x01 || selection & 0x200 || macStyle & 0x02);
  const bold = Boolean(selection & 0x20 || macStyle & 0x01);
  const classWeight = os2 && os2.length >= 6 ? os2.readUInt16BE(4) : 0;
  const axis = parseWeightAxis(await readTable(handle, directory, "fvar", 4096));
  const weight = axis ?? (() => {
    const value = classWeight >= 1 && classWeight <= 1000 ? classWeight : bold ? 700 : 400;
    return { min: value, max: value };
  })();
  return { family, legacyFamily: legacyFamily || family, fullName: names[4] || "", weight, italic, bold };
}

/** Every face in a font file; a collection (.ttc) yields one per member. */
async function readFontFile(file) {
  const handle = await fsp.open(file, "r");
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, 12, 0);
    if (bytesRead < 12) return [];
    const offsets = [];
    if (head.readUInt32BE(0) === TTC_TAG) {
      const count = Math.min(head.readUInt32BE(8), 64);
      const table = Buffer.alloc(count * 4);
      await handle.read(table, 0, table.length, 12);
      for (let index = 0; index < count; index++) offsets.push(table.readUInt32BE(index * 4));
    } else {
      offsets.push(0);
    }
    const isCollection = head.readUInt32BE(0) === TTC_TAG;
    const faces = [];
    for (const [index, offset] of offsets.entries()) {
      const face = await readFace(handle, offset).catch(() => null);
      if (face) faces.push({ ...face, collectionIndex: isCollection ? index : -1, offset });
    }
    return faces;
  } finally {
    await handle.close();
  }
}

/**
 * The bytes of one face as a standalone font file. Browsers cannot select a
 * member of a collection in @font-face, so a .ttc member is rewritten as a
 * plain sfnt that shares the original's table data.
 */
function extractCollectionMember(buffer, offset) {
  const numTables = buffer.readUInt16BE(offset + 4);
  const tables = [];
  for (let index = 0; index < numTables; index++) {
    const at = offset + 12 + index * 16;
    tables.push({
      tag: buffer.subarray(at, at + 4),
      checksum: buffer.readUInt32BE(at + 4),
      offset: buffer.readUInt32BE(at + 8),
      length: buffer.readUInt32BE(at + 12),
    });
  }
  let cursor = 12 + numTables * 16;
  const placed = tables.map((table) => {
    const start = cursor;
    cursor += (table.length + 3) & ~3;
    return { ...table, start };
  });
  const out = Buffer.alloc(cursor);
  buffer.copy(out, 0, offset, offset + 12);
  for (const [index, table] of placed.entries()) {
    const at = 12 + index * 16;
    table.tag.copy(out, at);
    out.writeUInt32BE(table.checksum, at + 4);
    out.writeUInt32BE(table.start, at + 8);
    out.writeUInt32BE(table.length, at + 12);
    buffer.copy(out, table.start, table.offset, table.offset + table.length);
  }
  return out;
}

function listRegistryFontFiles() {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("reg.exe", ["query", REGISTRY_KEY], { windowsHide: true, timeout: 5000, encoding: "utf8" }, (error, stdout) => {
      if (error) return resolve([]);
      const files = [];
      for (const line of stdout.split(/\r?\n/)) {
        const match = /\sREG_SZ\s+([A-Za-z]:\\.+)$/.exec(line);
        if (match) files.push(match[1].trim());
      }
      resolve(files);
    });
  });
}

function defaultUserFontDirectories() {
  const base = process.env.LOCALAPPDATA;
  return base ? [path.join(base, "Microsoft", "Windows", "Fonts")] : [];
}

function faceKey(face) {
  return `${face.family.toLowerCase()}|${face.weight.min}-${face.weight.max}|${face.italic ? "i" : "n"}`;
}

function createUserFonts({
  directories = defaultUserFontDirectories,
  registryFiles = listRegistryFontFiles,
  now = Date.now,
} = {}) {
  const parsed = new Map(); // file|mtime|size -> faces
  let faces = [];
  let byId = new Map();
  let scannedAt = 0;
  let scanning = null;

  async function candidateFiles() {
    const files = new Set();
    for (const directory of directories()) {
      const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.add(path.join(directory, entry.name));
      }
    }
    for (const file of await registryFiles().catch(() => [])) {
      if (FONT_EXTENSIONS.has(path.extname(file).toLowerCase())) files.add(path.normalize(file));
    }
    return [...files].sort();
  }

  async function scanNow() {
    const seenKeys = new Set();
    const live = new Set();
    const found = [];
    const seen = new Set();
    for (const file of await candidateFiles()) {
      const normalized = file.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      const cacheKey = `${file}|${stat.mtimeMs}|${stat.size}`;
      live.add(cacheKey);
      if (!parsed.has(cacheKey)) {
        const read = await readFontFile(file).catch(() => []);
        parsed.set(cacheKey, read.map((face) => ({
          ...face,
          file,
          id: createHash("sha1").update(`${cacheKey}|${face.collectionIndex}`).digest("hex").slice(0, 20),
        })));
      }
      for (const face of parsed.get(cacheKey)) {
        // Duplicate installs of one face (Regular, Regular2…): the first file wins.
        const key = faceKey(face);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        found.push(face);
      }
    }
    for (const key of parsed.keys()) if (!live.has(key)) parsed.delete(key);
    faces = found;
    byId = new Map(found.map((face) => [face.id, face]));
    scannedAt = now();
  }

  function scan() {
    scanning ??= scanNow().finally(() => { scanning = null; });
    return scanning;
  }

  const lower = (value) => value.toLowerCase();

  function describe(face, family, alias) {
    const weight = alias ? (face.bold ? 700 : 400) : face.weight.min === face.weight.max ? face.weight.min : `${face.weight.min} ${face.weight.max}`;
    return {
      family,
      weight: String(weight),
      style: face.italic ? "italic" : "normal",
      url: `${FONT_SCHEME}://face/${face.id}`,
      fullName: face.fullName,
    };
  }

  return {
    /** Family names, as Preferences should list them. Rescans (cheap: unchanged files are cached). */
    async listFamilies() {
      await scan();
      return [...new Set(faces.map((face) => face.family))].sort((a, b) => a.localeCompare(b));
    },

    /**
     * The faces to register for the given family names. A family is matched by
     * its typographic name ("Figtree") or by its legacy name ("Figtree Light"),
     * which is how DirectWrite names families and so what may already be saved.
     * A request for a family not found rescans once, unless it just did.
     */
    async facesFor(families) {
      const wanted = [...new Set(families)].filter((family) => typeof family === "string" && family && family.length <= MAX_FAMILY_LENGTH).slice(0, MAX_REQUEST_FAMILIES);
      if (wanted.length === 0) return [];
      const known = () => new Set(faces.flatMap((face) => [lower(face.family), lower(face.legacyFamily)]));
      if (scannedAt === 0 || (wanted.some((family) => !known().has(lower(family))) && now() - scannedAt >= MIN_RESCAN_MS)) await scan();
      const result = [];
      for (const family of wanted) {
        for (const face of faces) {
          if (lower(face.family) === lower(family)) result.push(describe(face, family, false));
          else if (lower(face.legacyFamily) === lower(family)) result.push(describe(face, family, true));
        }
      }
      return result;
    },

    /** The font file bytes for a face id, or null. Only scanned per-user fonts are served. */
    async readFace(id) {
      if (!byId.has(id) && now() - scannedAt >= MIN_RESCAN_MS) await scan();
      const face = byId.get(id);
      if (!face) return null;
      const buffer = await fsp.readFile(face.file).catch(() => null);
      if (!buffer) return null;
      const data = face.collectionIndex >= 0 ? extractCollectionMember(buffer, face.offset) : buffer;
      return { data, type: path.extname(face.file).toLowerCase() === ".otf" || data.toString("latin1", 0, 4) === "OTTO" ? "font/otf" : "font/ttf" };
    },
  };
}

const protocolSessions = new WeakSet();

/** Must run before the app is ready. */
function registerUserFontScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: FONT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

/** Serve libera-font://face/<id> from `userFonts` on one session. Safe to repeat. */
function attachUserFontProtocol(ses, userFonts) {
  if (protocolSessions.has(ses)) return;
  protocolSessions.add(ses);
  ses.protocol.handle(FONT_SCHEME, async (request) => {
    const url = new URL(request.url);
    const font = url.hostname === "face" ? await userFonts.readFace(url.pathname.slice(1)).catch(() => null) : null;
    if (!font) return new Response(null, { status: 404 });
    return new Response(font.data, {
      headers: { "Content-Type": font.type, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    });
  });
}

module.exports = {
  FONT_SCHEME,
  attachUserFontProtocol,
  createUserFonts,
  extractCollectionMember,
  parseNameTable,
  readFontFile,
  registerUserFontScheme,
};
