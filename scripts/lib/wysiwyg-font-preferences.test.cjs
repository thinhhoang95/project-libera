const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

test("Markdown preferences loads installed fonts and saves the WYSIWYG font", async () => {
  let saved;
  const dom = new JSDOM(
    readFileSync(path.join(__dirname, "../../electron/setup.html"), "utf8"),
    {
      url: "http://localhost/?mode=configuration",
      runScripts: "dangerously",
      beforeParse(window) {
        window.matchMedia = () => ({ matches: false, addEventListener() {} });
        window.queryLocalFonts = async () => [
          { family: "Zed Sans" },
          { family: "Alpha Serif" },
          { family: "Zed Sans" },
        ];
        window.liberaSetup = {
          getState: async () => ({
            dataDir: "/tmp/notebooks",
            hasApiKey: true,
            hasPasswordHash: true,
            wysiwygEditorFontFamily: "Existing Serif",
          }),
          save: async (input) => {
            saved = JSON.parse(JSON.stringify(input));
          },
        };
      },
    },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { document, Event } = dom.window;
    document.querySelector('[data-section-button="markdown"]').click();
    const select = document.querySelector("#wysiwyg-editor-font-family");

    assert.equal(select.closest("[data-section]").dataset.section, "markdown");
    assert.equal(select.value, "Existing Serif");
    document.querySelector("#load-wysiwyg-system-fonts-button").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      Array.from(select.options, (option) => option.value),
      ["system-sans", "Alpha Serif", "Zed Sans", "Existing Serif"],
    );
    assert.match(
      document.querySelector("#wysiwyg-system-fonts-status").textContent,
      /2 installed font families found/,
    );

    select.value = "Zed Sans";
    document
      .querySelector("#setup-form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saved.wysiwygEditorFontFamily, "Zed Sans");
  } finally {
    dom.window.close();
  }
});
