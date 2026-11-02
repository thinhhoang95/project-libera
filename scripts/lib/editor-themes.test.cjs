const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
  BUILT_IN_EDITOR_THEMES,
  normalizeEditorThemes,
  resolveEditorThemes,
  createEditorThemesFile,
  parseEditorThemesFile,
} = require("../../electron/editor-themes.cjs");

const colors = (background, text, heading = "#123456") => ({ background, text, h1: heading, h2: heading, h3: heading, h4: heading, h5: heading, lists: heading });
const custom = { id: "custom-a1", name: "Night", light: colors("#fafafa", "#111111"), dark: colors("#000000", "#eeeeee", "#abcdef"), textFont: "Georgia", codeFont: "" };

test("editor themes keep valid user themes and choices, dropping the rest", () => {
  const preferences = normalizeEditorThemes({
    visual: "custom-a1",
    source: "sepia",
    latex: "missing",
    themes: [custom, { ...custom }, { id: "bad id", ...custom }, { id: "custom-b2", name: "", light: custom.light, dark: custom.dark }],
  });
  assert.equal(preferences.visual, "custom-a1");
  assert.equal(preferences.source, "sepia");
  assert.equal(preferences.latex, "default");
  assert.deepEqual(preferences.themes.map((theme) => theme.id), ["custom-a1"]);
});

test("a missing heading color falls back to the theme's text color", () => {
  const [theme] = normalizeEditorThemes({ themes: [{ id: "custom-x", name: "X", light: { background: "#FFFFFF", text: "#000000" }, dark: { background: "#000000", text: "#ffffff", h1: "#ff0000" } }] }).themes;
  assert.equal(theme.light.background, "#ffffff");
  assert.equal(theme.light.h1, "#000000");
  assert.equal(theme.dark.h1, "#ff0000");
  assert.equal(theme.dark.lists, "#ffffff");
});

test("the former heading color becomes the visual editor's theme", () => {
  assert.equal(normalizeEditorThemes(undefined).visual, "blue");
  assert.equal(normalizeEditorThemes(undefined, { headingColor: "spectrum" }).visual, "spectrum");
  assert.equal(normalizeEditorThemes(undefined, { headingColor: "none" }).visual, "plain");
  const migrated = normalizeEditorThemes(undefined, { headingColor: "custom", headingPalette: { h1: "#000000", h2: "#ff0000" } });
  assert.equal(migrated.visual, "custom-headings");
  assert.equal(migrated.themes[0].light.h1, "#000000");
  assert.equal(migrated.themes[0].dark.h1, "#808080");
  assert.equal(migrated.themes[0].light.background, "#ffffff");
  // Once themes are saved, the old setting no longer matters.
  assert.equal(normalizeEditorThemes({ visual: "default" }, { headingColor: "teal" }).visual, "default");
});

test("theme fonts are names of installed families, or empty for the system font", () => {
  const [theme] = normalizeEditorThemes({ version: 2, themes: [{ ...custom, textFont: "  Iowan Old Style ", codeFont: "system-monospace" }] }).themes;
  assert.equal(theme.textFont, "Iowan Old Style");
  assert.equal(theme.codeFont, "");
  assert.equal(normalizeEditorThemes({ version: 2, themes: [{ ...custom, textFont: "x".repeat(300) }] }).themes[0].textFont, "");
});

test("the former fonts move into a copy of each editor's theme", () => {
  const legacy = { headingColor: "teal", textFont: "Georgia", codeFont: "Menlo" };
  const migrated = normalizeEditorThemes(undefined, legacy);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.visual, "custom-fonts-teal");
  // Source and LaTeX both used the app colors, so they share one copy.
  assert.equal(migrated.source, "custom-fonts-default");
  assert.equal(migrated.latex, "custom-fonts-default");
  assert.deepEqual(migrated.themes.map((theme) => [theme.name, theme.textFont, theme.codeFont]), [
    ["Teal with my fonts", "Georgia", "Menlo"],
    ["App colors with my fonts", "Georgia", "Menlo"],
  ]);
  assert.equal(migrated.themes[0].light.h1, BUILT_IN_EDITOR_THEMES.find((theme) => theme.id === "teal").light.h1);
  // A user theme already chosen takes the fonts itself.
  const own = normalizeEditorThemes({ visual: "custom-a1", themes: [{ ...custom, textFont: "" }] }, legacy);
  assert.equal(own.visual, "custom-a1");
  assert.equal(own.themes.find((theme) => theme.id === "custom-a1").textFont, "Georgia");
  // System fonts need no copies, and saved version-2 themes are left alone.
  assert.equal(normalizeEditorThemes(undefined, { textFont: "system-sans", codeFont: "system-monospace" }).themes.length, 0);
  assert.equal(normalizeEditorThemes({ version: 2, visual: "blue" }, legacy).visual, "blue");
});

test("resolved themes carry only the colors each editor uses", () => {
  const resolved = resolveEditorThemes({ visual: "custom-a1", source: "paper", latex: "default", themes: [custom] });
  assert.deepEqual(resolved.visual, { light: custom.light, dark: custom.dark, textFont: "Georgia", codeFont: "" });
  assert.equal(resolved.source.light.background, BUILT_IN_EDITOR_THEMES.find((theme) => theme.id === "paper").light.background);
  assert.equal(resolved.latex, null);
});

test("theme files round-trip without ids and reject other files", () => {
  const file = JSON.parse(JSON.stringify(createEditorThemesFile([custom, { name: "broken" }], "2026-10-28T00:00:00.000Z")));
  assert.equal(file.themes.length, 1);
  assert.equal(file.themes[0].id, undefined);
  assert.deepEqual(parseEditorThemesFile(file), [{ name: "Night", light: custom.light, dark: custom.dark, textFont: "Georgia", codeFont: "" }]);
  assert.throws(() => parseEditorThemesFile({ format: "libera-preferences" }), /not a Libera editor themes file/);
  assert.throws(() => parseEditorThemesFile({ ...file, version: 9 }), /Unsupported/);
  assert.throws(() => parseEditorThemesFile({ ...file, themes: [] }), /any usable themes/);
});

test("Preferences picks, duplicates, imports and saves editor themes", async () => {
  let saved;
  let exported;
  // The native theme menu: records its items and picks the queued label.
  let menuItems = [];
  let pickLabel = null;
  const dom = new JSDOM(readFileSync(path.join(__dirname, "../../electron/setup.html"), "utf8"), {
    url: "http://localhost/?mode=configuration",
    runScripts: "dangerously",
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.confirm = () => true;
      window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
      window.queryLocalFonts = async () => [{ family: "Zed Sans" }, { family: "Alpha Mono" }, { family: "Zed Sans" }];
      window.liberaMenu = {
        popup: async ({ items }) => {
          menuItems = items;
          const picked = items.find((item) => item.label === pickLabel);
          pickLabel = null;
          return picked?.id ?? null;
        },
      };
      window.liberaSetup = {
        getState: async () => ({
          dataDir: "/tmp/notebooks",
          hasApiKey: true,
          hasPasswordHash: true,
          editorThemeBuiltIns: JSON.parse(JSON.stringify(BUILT_IN_EDITOR_THEMES)),
          markdownEditorThemes: { version: 2, visual: "custom-a1", source: "default", latex: "default", themes: [custom] },
        }),
        importEditorThemes: async () => ({ canceled: false, fileName: "mine.json", themes: [{ name: "Night", light: custom.light, dark: custom.dark }] }),
        exportEditorThemes: async (themes) => { exported = themes; return { canceled: false, fileName: "x.json", count: themes.length }; },
        save: async (input) => { saved = JSON.parse(JSON.stringify(input)); },
      };
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { document, Event, MouseEvent } = dom.window;
    const tile = (id) => document.querySelector(`#editor-theme-band [data-theme-id="${id}"]`);
    assert.equal(tile("custom-a1").getAttribute("aria-checked"), "true");
    assert.equal(document.querySelector('.editor-theme-scopes [data-scope="visual"] small').textContent, "Night");

    // Choose Sepia for the source editor.
    document.querySelector('.editor-theme-scopes [data-scope="source"]').click();
    tile("sepia").click();
    assert.equal(tile("sepia").getAttribute("aria-checked"), "true");

    // Right-click Night and duplicate it.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const menuLabels = () => menuItems.map((item) => item.label);
    pickLabel = "Duplicate";
    tile("custom-a1").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await settle();
    assert.ok(menuLabels().includes("Delete"));
    assert.ok(Array.from(document.querySelectorAll(".editor-theme-name")).some((name) => name.textContent === "Night copy"));

    // Built-ins can be exported but not deleted.
    pickLabel = "Export…";
    tile("paper").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await settle();
    await settle();
    assert.equal(menuLabels().includes("Delete"), false);
    assert.equal(exported[0].name, "Paper");

    document.querySelector("#editor-theme-import").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(document.querySelector("#editor-theme-status").textContent, /Imported 1 theme from mine\.json/);
    assert.ok(Array.from(document.querySelectorAll(".editor-theme-name")).some((name) => name.textContent === "Night 2"));

    // The + tile adds a theme from the selected one and opens the editor.
    document.querySelector("#editor-theme-band .editor-theme-add").click();
    assert.equal(document.querySelector("#editor-theme-editor").classList.contains("hidden"), false);
    const nameInput = document.querySelector("#editor-theme-editor input[type=text]");
    nameInput.value = "Reading";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    // Its typefaces start as the source theme's (Sepia: system fonts) and can be changed.
    const [textFontSelect, codeFontSelect] = document.querySelectorAll("#editor-theme-editor select");
    assert.equal(textFontSelect.value, "");
    assert.equal(document.querySelector("#editor-theme-editor .editor-theme-fonts-row button").textContent, "Load system fonts");
    document.querySelector("#editor-theme-editor .editor-theme-fonts-row button").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(Array.from(codeFontSelect.options, (option) => option.value), ["", "Alpha Mono", "Zed Sans"]);
    codeFontSelect.value = "Alpha Mono";
    codeFontSelect.dispatchEvent(new Event("change", { bubbles: true }));

    // Deleting the visual editor's theme returns it to the app colors.
    document.querySelector('.editor-theme-scopes [data-scope="visual"]').click();
    pickLabel = "Delete";
    tile("custom-a1").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await settle();

    document.querySelector("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const themes = saved.markdownEditorThemes;
    assert.equal(themes.visual, "default");
    assert.equal(themes.latex, "default");
    assert.deepEqual(themes.themes.map((theme) => theme.name), ["Night copy", "Night 2", "Reading"]);
    assert.equal(themes.source, themes.themes[2].id);
    assert.deepEqual(themes.themes[2].light, BUILT_IN_EDITOR_THEMES.find((theme) => theme.id === "sepia").light);
    assert.equal(themes.version, 2);
    assert.equal(themes.themes[2].codeFont, "Alpha Mono");
    assert.equal(themes.themes[0].textFont, "Georgia");
    // Fonts are no longer saved apart from themes.
    assert.equal(saved.wysiwygEditorFontFamily, undefined);
    assert.ok(Array.from(document.querySelectorAll(".editor-theme-fonts")).some((line) => line.textContent === "Georgia"));
    assert.deepEqual(normalizeEditorThemes(themes).themes.length, 3);
  } finally {
    dom.window.close();
  }
});
