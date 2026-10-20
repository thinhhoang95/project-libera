const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Exercise the compiled route and its shared chunks, not the TypeScript source.
// A source-only test missed a packaged build that called new toolchain helpers
// from an older bundled copy of toolchain.ts.
async function main() {
  const serverRoot = path.resolve(process.argv[2] || path.join(__dirname, "../.next/server"));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "libera-production-latex-"));
  const password = randomBytes(24).toString("hex");
  process.env.LIBERA_DATA_DIR = directory;
  process.env.LIBERA_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.LIBERA_PASSWORD_HASH = `sha256:${require("node:crypto").createHash("sha256").update(password).digest("hex")}`;
  const rootPath = "Smoke/main.tex";
  try {
    const notebook = path.join(directory, "users/admin/Smoke");
    await fs.mkdir(notebook, { recursive: true });
    await fs.writeFile(path.join(notebook, "main.tex"), "\\documentclass{article}\n\\begin{document}\nProduction compilation works.\\cite{knuth}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n");
    await fs.writeFile(path.join(notebook, "refs.bib"), "@book{knuth,author={Donald Knuth},title={The TeXbook},year={1984},publisher={Addison-Wesley}}\n");
    const login = require(path.join(serverRoot, "app/api/auth/login/route.js")).routeModule.userland;
    const loginResponse = await login.POST(new Request("http://localhost/api/auth/login", {
      method: "POST", body: JSON.stringify({ password }),
    }));
    assert.equal(loginResponse.status, 200, "production login route");
    const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
    const cookies = { get: (name) => name === "libera_session" ? { value: cookie.slice(cookie.indexOf("=") + 1) } : undefined };
    const compile = require(path.join(serverRoot, "app/api/latex/compile/route.js")).routeModule.userland;
    const response = await compile.POST({
      cookies, signal: AbortSignal.timeout(180_000),
      json: async () => ({ rootPath }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    if (result.status === "failure" && result.diagnostics?.some(({ message }) => message.startsWith("LaTeX was not found."))) {
      console.log("Production LaTeX smoke check skipped: TeX is not installed.");
      return;
    }
    assert.equal(result.status, "success", JSON.stringify({ diagnostics: result.diagnostics, output: result.output }));
    assert.equal(result.fresh, true);
    assert.ok(result.buildId);
    assert.ok(!result.diagnostics.some(({ message }) => /undefined|not found in the database/i.test(message)), "bibliography must resolve");
    const pdf = require(path.join(serverRoot, "app/api/latex/pdf/route.js")).routeModule.userland;
    const pdfResponse = await pdf.GET({ cookies, nextUrl: new URL(`http://localhost/api/latex/pdf?path=${encodeURIComponent(rootPath)}&build=${result.buildId}`) });
    assert.equal(pdfResponse.status, 200);
    assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await pdfResponse.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    console.log("Production LaTeX smoke check passed: authenticated compile, bibliography, and PDF response.");
  } finally {
    // Both directories are generated from this unique temporary data root.
    const key = require("node:crypto").createHash("sha256").update(path.join(directory, "users/admin/Smoke/main.tex")).digest("hex").slice(0, 24);
    await fs.rm(path.join(await fs.realpath(os.tmpdir()), "libera-latex", key), { recursive: true, force: true });
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
