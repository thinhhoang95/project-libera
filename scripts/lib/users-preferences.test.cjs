const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

function openPreferences(query = "?mode=configuration", { signedIn = true, switched = true } = {}) {
  const calls = { added: [], renamed: [], removed: [], switched: [] };
  let state = {
    activeProfileId: "default",
    maxProfiles: 8,
    profiles: [
      { id: "default", name: "Vy Tran", dataDir: "/notes/vy" },
      { id: "p-111111111111", name: "Bob", dataDir: "/notes/bob" },
    ],
  };
  const dom = new JSDOM(readFileSync(path.join(__dirname, "../../electron/setup.html"), "utf8"), {
    url: `http://localhost/${query}`,
    runScripts: "dangerously",
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.liberaSetup = {
        getState: async () => ({ dataDir: "/notes/vy", hasApiKey: true, hasPasswordHash: true, canManageProfiles: signedIn }),
        listOpenRouterModels: async () => ({ ok: true, models: [] }),
        selectDataDir: async () => "/notes/ann",
        listProfiles: async () => state,
        addProfile: async (input) => {
          calls.added.push(JSON.parse(JSON.stringify(input)));
          if (!input.name) throw new Error("Error invoking remote method 'setup:add-profile': Error: Enter a name for this user.");
          state = { ...state, profiles: [...state.profiles, { id: "p-222222222222", name: input.name, dataDir: input.dataDir }] };
          return state;
        },
        renameProfile: async (id, name, password) => {
          calls.renamed.push([id, name, password]);
          state = { ...state, profiles: state.profiles.map((profile) => profile.id === id ? { ...profile, name } : profile) };
          return state;
        },
        removeProfile: async (id, password) => {
          calls.removed.push([id, password]);
          state = { ...state, profiles: state.profiles.filter((profile) => profile.id !== id) };
          return { canceled: false, ...state };
        },
        switchProfile: async (id) => { calls.switched.push(id); return { switched }; },
      };
    },
  });
  return { dom, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let index = 0; index < 4; index += 1) await tick(); };
const rows = (document) => Array.from(document.querySelectorAll("#users-list .user-row"));
const buttonsOf = (row) => Array.from(row.querySelectorAll(".user-actions button")).map((button) => button.textContent);

test("Users lists everyone; only other, non-first users can be switched to or removed", async () => {
  const { dom } = openPreferences();
  try {
    await settle();
    const { document } = dom.window;
    assert.equal(document.querySelector("[data-section-button='users']").classList.contains("hidden"), false);
    const [me, bob] = rows(document);
    assert.match(me.textContent, /Vy Tran\s*You/);
    assert.match(me.textContent, /\/notes\/vy/);
    assert.deepEqual(buttonsOf(me), ["Rename"]);
    assert.deepEqual(buttonsOf(bob), ["Switch", "Rename", "Remove"]);
  } finally {
    dom.window.close();
  }
});

test("first-run setup has no Users section", async () => {
  const { dom } = openPreferences("?mode=setup");
  try {
    await settle();
    assert.equal(dom.window.document.querySelector("[data-section-button='users']").classList.contains("hidden"), true);
    assert.equal(rows(dom.window.document).length, 0);
  } finally {
    dom.window.close();
  }
});

test("adding a user sends the form, clears it, and shows the new user", async () => {
  const { dom, calls } = openPreferences();
  try {
    await settle();
    const { document } = dom.window;
    document.querySelector("#new-user-name").value = "Ann";
    document.querySelector("#new-user-browse-button").click();
    await settle();
    document.querySelector("#new-user-password").value = "correct horse";
    document.querySelector("#new-user-password-confirmation").value = "correct horse";
    document.querySelector("#add-user-button").click();
    await settle();
    assert.deepEqual(calls.added, [{ name: "Ann", dataDir: "/notes/ann", password: "correct horse", passwordConfirmation: "correct horse", openaiApiKey: "" }]);
    assert.equal(rows(document).length, 3);
    assert.equal(document.querySelector("#new-user-name").value, "");
    assert.match(document.querySelector("#users-status").textContent, /Added Ann/);
  } finally {
    dom.window.close();
  }
});

test("a rejected user shows the reason without the IPC prefix", async () => {
  const { dom } = openPreferences();
  try {
    await settle();
    const { document } = dom.window;
    document.querySelector("#add-user-button").click();
    await settle();
    assert.equal(document.querySelector("#error").textContent, "Enter a name for this user.");
    assert.equal(document.querySelector("#add-user-button").disabled, false);
  } finally {
    dom.window.close();
  }
});

test("rename saves on Enter once, and Escape keeps the old name", async () => {
  const { dom, calls } = openPreferences();
  try {
    await settle();
    const { document, KeyboardEvent } = dom.window;
    let bob = rows(document)[1];
    bob.querySelector("input[type=password]").value = "bob's password";
    bob.querySelector(".user-actions button:nth-child(2)").click();
    let input = bob.querySelector("input");
    input.value = "Robert";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new dom.window.FocusEvent("blur"));
    await settle();
    assert.deepEqual(calls.renamed, [["p-111111111111", "Robert", "bob's password"]]);
    assert.match(rows(document)[1].textContent, /Robert/);

    bob = rows(document)[1];
    bob.querySelector(".user-actions button:nth-child(2)").click();
    input = bob.querySelector("input");
    input.value = "Bobby";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    input.dispatchEvent(new dom.window.FocusEvent("blur"));
    await settle();
    assert.equal(calls.renamed.length, 1);
    assert.match(rows(document)[1].textContent, /Robert/);
  } finally {
    dom.window.close();
  }
});

test("switch and remove call through for the chosen user", async () => {
  const { dom, calls } = openPreferences();
  try {
    await settle();
    const { document } = dom.window;
    rows(document)[1].querySelector(".user-actions button").click();
    await settle();
    assert.deepEqual(calls.switched, ["p-111111111111"]);
    rows(document)[1].querySelector("input[type=password]").value = "bob's password";
    rows(document)[1].querySelector(".user-actions button:nth-child(3)").click();
    await settle();
    assert.deepEqual(calls.removed, [["p-111111111111", "bob's password"]]);
    assert.equal(rows(document).length, 1);
  } finally {
    dom.window.close();
  }
});

test("Users explains sign-in and hides management when signed out", async () => {
  const { dom, calls } = openPreferences("?mode=configuration", { signedIn: false });
  try {
    await settle();
    const { document } = dom.window;
    assert.equal(rows(document).length, 0);
    assert.equal(document.querySelector("#add-user-card").classList.contains("hidden"), true);
    assert.match(document.querySelector("#users-status").textContent, /Sign in first/);
    assert.equal(document.querySelector("#error").textContent, "");
    assert.deepEqual(calls.added, []);
  } finally { dom.window.close(); }
});

test("a cancelled switch re-enables Users controls and reports cancellation", async () => {
  const { dom } = openPreferences("?mode=configuration", { switched: false });
  try {
    await settle();
    const { document } = dom.window;
    const button = rows(document)[1].querySelector(".user-actions button");
    button.click();
    await settle();
    assert.equal(button.disabled, false);
    assert.match(document.querySelector("#users-status").textContent, /Switch cancelled/);
  } finally { dom.window.close(); }
});

test("another user's rename waits while entering their password and Save name submits it", async () => {
  const { dom, calls } = openPreferences();
  try {
    await settle();
    const { document } = dom.window;
    const bob = rows(document)[1];
    bob.querySelector(".user-actions button:nth-child(2)").click();
    const name = bob.querySelector("input[type=text]");
    name.value = "Robert";
    name.dispatchEvent(new dom.window.FocusEvent("blur"));
    await settle();
    assert.deepEqual(calls.renamed, []);
    bob.querySelector("input[type=password]").value = "bob secret";
    bob.querySelector(".user-actions button").click();
    await settle();
    assert.deepEqual(calls.renamed, [["p-111111111111", "Robert", "bob secret"]]);
    assert.equal(rows(document)[1].querySelector("input[type=password]").value, "");
  } finally { dom.window.close(); }
});
