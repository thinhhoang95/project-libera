// Node's editor tests exercise DOM behavior without a bundler. Styles are
// handled by Next/Electron in the app and have no runtime exports to mock.
require.extensions[".css"] = () => {};

// Tests answer OpenRouter requests with stubs; keep their made-up usage out of
// the Spending ledger in the real data folder (storage/usage-ledger.ts).
process.env.LIBERA_USAGE_LEDGER = "off";
