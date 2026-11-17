const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createUserFonts, extractCollectionMember, readFontFile } = require("../../electron/user-fonts.cjs");

function nameTable(names) {
  const records = Object.entries(names).filter(([, text]) => text);
  const strings = records.map(([, text]) => { const b = Buffer.from(text, "utf16le"); b.swap16(); return b; });
  const head = Buffer.alloc(6 + records.length * 12);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(head.length, 4);
  let offset = 0;
  records.forEach(([id], index) => {
    const at = 6 + index * 12;
    head.writeUInt16BE(3, at); head.writeUInt16BE(1, at + 2); head.writeUInt16BE(0x409, at + 4);
    head.writeUInt16BE(Number(id), at + 6); head.writeUInt16BE(strings[index].length, at + 8); head.writeUInt16BE(offset, at + 10);
    offset += strings[index].length;
  });
  return Buffer.concat([head, ...strings]);
}

function fvarTable(min, max) {
  const table = Buffer.alloc(16 + 20);
  table.writeUInt16BE(16, 4); table.writeUInt16BE(1, 8); table.writeUInt16BE(20, 10);
  table.write("wght", 16, "latin1");
  table.writeInt32BE(min * 65536, 20); table.writeInt32BE(min * 65536, 24); table.writeInt32BE(max * 65536, 28);
  return table;
}

/** A tiny sfnt: enough tables for the name, style and weight to be read. */
function tables({ family, legacy = family, full = "", weight = 400, italic = false, bold = false, axis }) {
  const os2 = Buffer.alloc(96);
  os2.writeUInt16BE(weight, 4);
  os2.writeUInt16BE((italic ? 1 : 0) | (bold ? 0x20 : 0), 62);
  const head = Buffer.alloc(54);
  head.writeUInt16BE((bold ? 1 : 0) | (italic ? 2 : 0), 44);
  const out = { name: nameTable({ 1: legacy, 4: full, 16: family === legacy ? "" : family }), "OS/2": os2, head };
  if (axis) out.fvar = fvarTable(axis[0], axis[1]);
  return out;
}

function sfnt(spec) {
  const entries = Object.entries(tables(spec));
  const header = Buffer.alloc(12 + entries.length * 16);
  header.writeUInt32BE(0x00010000, 0); header.writeUInt16BE(entries.length, 4);
  let offset = header.length;
  const bodies = entries.map(([tag, body], index) => {
    header.write(tag, 12 + index * 16, "latin1");
    header.writeUInt32BE(offset, 12 + index * 16 + 8); header.writeUInt32BE(body.length, 12 + index * 16 + 12);
    const padded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
    offset += padded.length;
    return padded;
  });
  return Buffer.concat([header, ...bodies]);
}

/** A collection holding `specs`; each member keeps its own copy of its tables. */
function collection(specs) {
  const members = specs.map(sfnt);
  const head = Buffer.alloc(12 + members.length * 4);
  head.write("ttcf", 0, "latin1"); head.writeUInt32BE(0x00010000, 4); head.writeUInt32BE(members.length, 8);
  let offset = head.length;
  const rebased = members.map((member, index) => {
    head.writeUInt32BE(offset, 12 + index * 4);
    const copy = Buffer.from(member);
    for (let table = 0; table < copy.readUInt16BE(4); table++) copy.writeUInt32BE(copy.readUInt32BE(12 + table * 16 + 8) + offset, 12 + table * 16 + 8);
    offset += copy.length;
    return copy;
  });
  return Buffer.concat([head, ...rebased]);
}

function workspace(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "libera-user-fonts-test-"));
  for (const [name, content] of Object.entries(files)) {
    if (content === null) fs.mkdirSync(path.join(directory, name));
    else fs.writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

test("a font file's family, style and weight come from its name, OS/2 and head tables", async () => {
  const directory = workspace({
    "Plex-LightItalic.ttf": sfnt({ family: "IBM Plex Mono", legacy: "IBM Plex Mono Light", full: "IBM Plex Mono Light Italic", weight: 300, italic: true }),
    "Inter.ttf": sfnt({ family: "Inter", weight: 400, axis: [100, 900] }),
  });
  try {
    const [plex] = await readFontFile(path.join(directory, "Plex-LightItalic.ttf"));
    assert.deepEqual({ ...plex }, { family: "IBM Plex Mono", legacyFamily: "IBM Plex Mono Light", fullName: "IBM Plex Mono Light Italic", weight: { min: 300, max: 300 }, italic: true, bold: false, collectionIndex: -1, offset: 0 });
    const [inter] = await readFontFile(path.join(directory, "Inter.ttf"));
    assert.deepEqual(inter.weight, { min: 100, max: 900 });
    assert.equal(inter.legacyFamily, "Inter");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("per-user fonts are listed, deduplicated, and matched by typographic or legacy family name", async () => {
  const directory = workspace({
    "Figtree-Regular.ttf": sfnt({ family: "Figtree", full: "Figtree Regular" }),
    "Figtree-Regular2.ttf": sfnt({ family: "Figtree", full: "Figtree Regular" }),
    "Figtree-LightItalic.ttf": sfnt({ family: "Figtree", legacy: "Figtree Light", full: "Figtree Light Italic", weight: 300, italic: true }),
    "Figtree-Bold.ttf": sfnt({ family: "Figtree", full: "Figtree Bold", weight: 700, bold: true }),
    "notes.txt": "not a font",
    "broken.ttf": Buffer.from("not really a font file at all"),
    Deleted: null,
  });
  try {
    const fonts = createUserFonts({ directories: () => [directory], registryFiles: async () => [] });
    assert.deepEqual(await fonts.listFamilies(), ["Figtree"]);

    const faces = await fonts.facesFor(["figtree"]);
    assert.deepEqual(faces.map(({ family, weight, style }) => [family, weight, style]).sort(), [
      ["figtree", "300", "italic"], ["figtree", "400", "normal"], ["figtree", "700", "normal"],
    ]);
    assert.ok(faces.every((face) => /^libera-font:\/\/face\/[0-9a-f]{20}$/.test(face.url)));

    // DirectWrite's name for the light italic, which may be what Preferences saved.
    const legacy = await fonts.facesFor(["Figtree Light"]);
    assert.deepEqual(legacy.map(({ family, weight, style }) => [family, weight, style]), [["Figtree Light", "400", "italic"]]);

    assert.deepEqual(await fonts.facesFor(["Consolas"]), []);
    const served = await fonts.readFace(faces[0].url.split("/").pop());
    assert.equal(served.type, "font/ttf");
    assert.equal(await fonts.readFace("0".repeat(20)), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("variable fonts register one face spanning their weight range", async () => {
  const directory = workspace({ "Inter.ttf": sfnt({ family: "Inter", axis: [100, 900] }) });
  try {
    const fonts = createUserFonts({ directories: () => [directory], registryFiles: async () => [] });
    assert.deepEqual((await fonts.facesFor(["Inter"])).map((face) => face.weight), ["100 900"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a font installed after the first scan is found, but a missing family does not rescan on every call", async () => {
  const directory = workspace({ "A-Regular.ttf": sfnt({ family: "Alpha" }) });
  let clock = 1_000_000;
  try {
    const fonts = createUserFonts({ directories: () => [directory], registryFiles: async () => [], now: () => clock });
    assert.deepEqual(await fonts.listFamilies(), ["Alpha"]);
    fs.writeFileSync(path.join(directory, "B-Regular.ttf"), sfnt({ family: "Beta" }));
    clock += 100;
    assert.deepEqual(await fonts.facesFor(["Beta"]), []);
    clock += 10_000;
    assert.equal((await fonts.facesFor(["Beta"])).length, 1);
    fs.rmSync(path.join(directory, "B-Regular.ttf"));
    assert.deepEqual(await fonts.listFamilies(), ["Alpha"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a registry-listed font outside the fonts folder is included", async () => {
  const folder = workspace({});
  const elsewhere = workspace({ "Mono.otf": sfnt({ family: "Elsewhere Mono" }) });
  try {
    const fonts = createUserFonts({ directories: () => [folder], registryFiles: async () => [path.join(elsewhere, "Mono.otf"), path.join(elsewhere, "gone.ttf")] });
    assert.deepEqual(await fonts.listFamilies(), ["Elsewhere Mono"]);
    assert.equal((await fonts.readFace((await fonts.facesFor(["Elsewhere Mono"]))[0].url.split("/").pop())).type, "font/otf");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a member of a font collection is served as a standalone font", async () => {
  const directory = workspace({ "Pair.ttc": collection([{ family: "Pair Sans", weight: 400 }, { family: "Pair Sans", weight: 700, bold: true }]) });
  try {
    const fonts = createUserFonts({ directories: () => [directory], registryFiles: async () => [] });
    const faces = await fonts.facesFor(["Pair Sans"]);
    assert.deepEqual(faces.map((face) => face.weight).sort(), ["400", "700"]);
    const bold = faces.find((face) => face.weight === "700");
    const { data } = await fonts.readFace(bold.url.split("/").pop());
    assert.equal(data.readUInt32BE(0), 0x00010000);
    const file = path.join(directory, "single.ttf");
    fs.writeFileSync(file, data);
    const [member] = await readFontFile(file);
    assert.equal(member.family, "Pair Sans");
    assert.deepEqual(member.weight, { min: 700, max: 700 });
    assert.equal(member.collectionIndex, -1);
    assert.ok(extractCollectionMember);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
