const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createPreferencesBackup,
  parsePreferencesBackup,
} = require("../../electron/preferences-io.cjs");

test("preferences backups include dialog settings but never the session secret", () => {
  const config = {
    themePreference: "dark",
    dataDir: "/tmp/notebooks",
    openaiApiKey: "secret-api-key",
    passwordHash: "scrypt:salt:hash",
    aiFunctions: { chat: { model: "provider/default", alternativeModels: ["provider/fast", "provider/deep"] } },
    quickPrompts: [{ identifier: "summary", prompt: "Summarize $1." }],
    latexSnippets: [{ id: "a1", name: "twofig", body: "\\begin{figure}" }],
    sessionSecret: "must-not-leave-the-device",
    unrelatedFutureValue: true,
  };

  const backup = createPreferencesBackup(config, "2026-09-19T00:00:00.000Z");

  assert.deepEqual(backup, {
    format: "libera-preferences",
    version: 1,
    exportedAt: "2026-09-19T00:00:00.000Z",
    preferences: {
      themePreference: "dark",
      dataDir: "/tmp/notebooks",
      openaiApiKey: "secret-api-key",
      aiFunctions: { chat: { model: "provider/default", alternativeModels: ["provider/fast", "provider/deep"] } },
      quickPrompts: [{ identifier: "summary", prompt: "Summarize $1." }],
      latexSnippets: [{ id: "a1", name: "twofig", body: "\\begin{figure}" }],
      passwordHash: "scrypt:salt:hash",
    },
  });
  assert.deepEqual(parsePreferencesBackup(backup), backup.preferences);
  assert.equal(JSON.stringify(backup).includes("must-not-leave-the-device"), false);
});

test("preferences backups reject unrelated and unsupported JSON", () => {
  assert.throws(
    () => parsePreferencesBackup({ preferences: {} }),
    /not a Libera preferences backup/,
  );
  assert.throws(
    () => parsePreferencesBackup({ format: "libera-preferences", version: 2, preferences: {} }),
    /Unsupported Libera preferences backup version/,
  );
  assert.throws(
    () => parsePreferencesBackup({ format: "libera-preferences", version: 1 }),
    /missing its preferences object/,
  );
});

test("preferences backups carry the Markdown accent color, custom palette and lead-in switch", () => {
  const { normalizeMarkdownHeadingPalette, normalizeMarkdownHeadingColor } = require("../../electron/markdown-accents.cjs");
  const palette = { h1: "#aa0000", h2: "#00aa00", h3: "#0000aa", h4: "#123456", h5: "#654321", lists: "#abcdef" };
  const backup = createPreferencesBackup({
    markdownHeadingColor: "custom",
    markdownHeadingPalette: palette,
    markdownBoldLeadIns: false,
  });

  assert.deepEqual(parsePreferencesBackup(JSON.parse(JSON.stringify(backup))), {
    markdownHeadingColor: "custom",
    markdownHeadingPalette: palette,
    markdownBoldLeadIns: false,
  });
  assert.equal(normalizeMarkdownHeadingColor("custom"), "custom");
  // A hand-edited backup cannot inject CSS; bad entries fall back per color.
  assert.deepEqual(
    normalizeMarkdownHeadingPalette({ ...palette, h2: "red; background: url(x)", lists: "#ABCDEF" }),
    { ...palette, h2: "#1d4ed8", lists: "#abcdef" },
  );
  assert.deepEqual(normalizeMarkdownHeadingPalette(JSON.stringify(palette)), palette);
});

const {
  decryptPreferencesBackup,
  encryptPreferencesBackup,
  isEncryptedPreferencesBackup,
  readPreferencesBackup,
} = require("../../electron/preferences-io.cjs");

// The lowest work factor the reader accepts, so the tests stay fast.
const CHEAP_KDF = { N: 2 ** 14, r: 8, p: 1 };
const SECRET_CONFIG = {
  themePreference: "dark",
  dataDir: "/tmp/notebooks",
  openaiApiKey: "sk-secret-api-key",
  passwordHash: "scrypt:salt:hash",
  sessionSecret: "must-not-leave-the-device",
};

test("exported backups are encrypted with the master password and load with it", async () => {
  const backup = createPreferencesBackup(SECRET_CONFIG, "2026-11-08T00:00:00.000Z");
  const encrypted = await encryptPreferencesBackup(backup, "correct horse", CHEAP_KDF);
  const text = JSON.stringify(encrypted);

  assert.equal(encrypted.format, "libera-preferences");
  assert.equal(encrypted.version, 2);
  assert.equal(isEncryptedPreferencesBackup(JSON.parse(text)), true);
  assert.deepEqual(Object.keys(encrypted).sort(), ["data", "format", "iv", "kdf", "version"]);
  for (const secret of ["sk-secret-api-key", "scrypt:salt:hash", "/tmp/notebooks", "must-not-leave-the-device"]) {
    assert.equal(text.includes(secret), false, secret);
  }

  assert.deepEqual(await decryptPreferencesBackup(JSON.parse(text), "correct horse"), backup);
  assert.deepEqual(await readPreferencesBackup(JSON.parse(text), "correct horse"), backup.preferences);

  // A fresh salt and IV every time.
  const again = await encryptPreferencesBackup(backup, "correct horse", CHEAP_KDF);
  assert.notEqual(again.kdf.salt, encrypted.kdf.salt);
  assert.notEqual(again.iv, encrypted.iv);
});

test("encrypted backups refuse a wrong password, tampering and unsafe parameters", async () => {
  const encrypted = await encryptPreferencesBackup(createPreferencesBackup(SECRET_CONFIG), "correct horse", CHEAP_KDF);

  await assert.rejects(readPreferencesBackup(encrypted, "wrong"), (error) => error.code === "wrong-password");
  await assert.rejects(readPreferencesBackup(encrypted, ""), /master password is required/);
  await assert.rejects(readPreferencesBackup(encrypted, undefined), /master password is required/);

  const data = Buffer.from(encrypted.data, "base64");
  data[0] ^= 1;
  await assert.rejects(
    readPreferencesBackup({ ...encrypted, data: data.toString("base64") }, "correct horse"),
    (error) => error.code === "wrong-password",
  );

  // The header is authenticated: a lowered (but allowed) work factor is caught.
  const stronger = await encryptPreferencesBackup(createPreferencesBackup(SECRET_CONFIG), "correct horse", { N: 2 ** 15, r: 8, p: 1 });
  await assert.rejects(
    readPreferencesBackup({ ...stronger, kdf: { ...stronger.kdf, N: 2 ** 14 } }, "correct horse"),
    (error) => error.code === "wrong-password",
  );

  for (const kdf of [
    { ...encrypted.kdf, N: 2 ** 22 },
    { ...encrypted.kdf, N: 3 * 2 ** 14 },
    { ...encrypted.kdf, name: "pbkdf2" },
    { ...encrypted.kdf, salt: "short" },
  ]) {
    await assert.rejects(readPreferencesBackup({ ...encrypted, kdf }, "correct horse"), /unsupported or unsafe/);
  }
  await assert.rejects(readPreferencesBackup({ ...encrypted, iv: "AAAA" }, "correct horse"), /damaged/);
  await assert.rejects(encryptPreferencesBackup({}, "pw", { N: 2 ** 10, r: 8, p: 1 }), /Unsafe/);
});

test("plain backups written before encryption still load without a password", async () => {
  const backup = createPreferencesBackup(SECRET_CONFIG);
  assert.equal(isEncryptedPreferencesBackup(backup), false);
  assert.deepEqual(await readPreferencesBackup(JSON.parse(JSON.stringify(backup))), backup.preferences);
});
