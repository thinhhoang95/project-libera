import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the TeX binaries live. Desktop apps launched from the Finder or Start
 * menu do not inherit the shell's PATH, so common install locations are
 * searched as well. */
export type TexToolchain = { binDirectory: string | null; hasLatexmk: boolean };

const executableName = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);
let cached: Promise<TexToolchain> | null = null;

async function isExecutable(file: string) {
  try {
    await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function globTexLiveBins(root: string) {
  try {
    const years = (await readdir(root)).filter((name) => /^\d{4}$/.test(name)).sort().reverse();
    const directories: string[] = [];
    for (const year of years) {
      const binRoot = path.join(root, year, "bin");
      for (const platform of await readdir(binRoot).catch(() => [] as string[])) directories.push(path.join(binRoot, platform));
    }
    return directories;
  } catch {
    return [];
  }
}

async function candidateDirectories() {
  const configured = process.env.LIBERA_TEX_BIN ? [process.env.LIBERA_TEX_BIN] : [];
  const fromPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const pdflatexOverride = process.env.LIBERA_PDFLATEX_PATH ? [path.dirname(process.env.LIBERA_PDFLATEX_PATH)] : [];

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean) as string[];
    return [
      ...configured, ...pdflatexOverride, ...fromPath,
      path.join(localAppData, "Programs", "MiKTeX", "miktex", "bin", "x64"),
      ...programFiles.map((root) => path.join(root, "MiKTeX", "miktex", "bin", "x64")),
      ...(await globTexLiveBins("C:\\texlive")),
    ];
  }

  return [
    ...configured, ...pdflatexOverride, ...fromPath,
    "/Library/TeX/texbin",
    ...(await globTexLiveBins("/usr/local/texlive")),
    ...(await globTexLiveBins(path.join(os.homedir(), "texlive"))),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin",
  ];
}

async function locate(): Promise<TexToolchain> {
  for (const directory of await candidateDirectories()) {
    if (await isExecutable(path.join(directory, executableName("pdflatex")))) {
      const latexmk = path.join(directory, executableName("latexmk"));
      // MiKTeX ships latexmk as a script that needs Perl; check it really runs.
      const hasLatexmk = (await isExecutable(latexmk)) && await new Promise<boolean>((resolve) => {
        execFile(latexmk, ["-v"], { timeout: 10_000, env: texEnvironment({ binDirectory: directory, hasLatexmk: false }) }, (error) => resolve(!error));
      });
      return { binDirectory: directory, hasLatexmk };
    }
  }
  return { binDirectory: null, hasLatexmk: false };
}

export function findTexToolchain() {
  cached ??= locate().then((toolchain) => {
    // Retry on a later request if TeX gets installed while Libera runs.
    if (!toolchain.binDirectory) cached = null;
    return toolchain;
  });
  return cached;
}

export function texExecutable(toolchain: TexToolchain, name: string) {
  return toolchain.binDirectory ? path.join(toolchain.binDirectory, executableName(name)) : executableName(name);
}

/** A minimal environment for TeX: no API keys or app secrets, the TeX binary
 * folder first on PATH, and kpathsea settings that keep logs unwrapped. */
export function texEnvironment(toolchain: TexToolchain, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const passthrough = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "SystemRoot", "SystemDrive", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "PERL5LIB", "TEXMFHOME", "TEXMFVAR", "TEXMFCONFIG", "MIKTEX_USERCONFIG", "MIKTEX_USERDATA"];
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of passthrough) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  environment.PATH = [toolchain.binDirectory, ...pathEntries, ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].filter(Boolean).join(path.delimiter);
  environment.max_print_line = "10000";
  environment.error_line = "254";
  environment.half_error_line = "238";
  return { ...environment, ...extra };
}

export function texMissingMessage() {
  return process.platform === "darwin"
    ? "LaTeX was not found. Install MacTeX (or BasicTeX) from tug.org/mactex, then compile again."
    : process.platform === "win32"
      ? "LaTeX was not found. Install MiKTeX or TeX Live, then compile again."
      : "LaTeX was not found. Install TeX Live (for example the texlive-latex-extra package), then compile again.";
}
