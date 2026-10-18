// The part of citeproc-js (the `citeproc` package, CommonJS, no bundled
// types) that format.ts uses.
declare module "citeproc" {
  const CSL: import("../format").CiteprocModule;
  export default CSL;
}
