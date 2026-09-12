// Node's editor tests exercise DOM behavior without a bundler. Styles are
// handled by Next/Electron in the app and have no runtime exports to mock.
require.extensions[".css"] = () => {};
