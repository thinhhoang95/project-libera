import os from "node:os";
import path from "node:path";

/* Next's file tracer (nft) evaluates path.join/path.resolve over values it can
 * work out at build time (os.homedir(), process.cwd(), string templates), then
 * globs the resulting folder to copy "assets" into the standalone output. For a
 * runtime location that means scanning the home folder, AppData, the whole
 * project or the user's data directory during `next build`: slow, and it fails
 * outright on Windows folders that deny listing (for example the
 * `AppData\Local\Application Data` junction).
 *
 * These paths are runtime locations, not files to bundle. Building them through
 * these wrappers keeps their values opaque to the tracer. Files that really have
 * to ship (prompts, workers) keep their plain path.join(process.cwd(), ...). */
export const homeDirectory = () => os.homedir();
export const workingDirectory = () => process.cwd();
export const joinPath = (...segments: string[]) => path.join(...segments);
export const resolvePath = (...segments: string[]) => path.resolve(...segments);
