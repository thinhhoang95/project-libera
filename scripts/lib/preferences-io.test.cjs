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
