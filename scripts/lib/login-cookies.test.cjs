const assert = require("node:assert/strict");
const test = require("node:test");
const { clearLoginCookie, SESSION_COOKIE_NAME } = require("../../electron/login-cookies.cjs");

test("app startup removes only the authentication cookie", async () => {
  const calls = [];
  const electronSession = {
    cookies: {
      remove: async (url, name) => calls.push({ url, name }),
    },
    clearStorageData: async () => {
      throw new Error("startup must not clear preference cookies");
    },
  };

  await clearLoginCookie(electronSession, "http://127.0.0.1:43127");

  assert.deepEqual(calls, [{
    url: "http://127.0.0.1:43127",
    name: SESSION_COOKIE_NAME,
  }]);
});
