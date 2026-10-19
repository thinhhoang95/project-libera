import { globToRegExp } from "../glob";
import { ALL_TOOLS, ok, optionalString, resolve, ToolError, type AgentTool, type ToolContext, type ToolResult } from "../tools";

// A read scope for child runs: Read, Grep and Glob wrapped so they reach only
// the files a check is about (its sources' attachments and the document).
// Any other path is refused before the real tool runs; Grep without a path
// searches each allowed file; Glob lists only allowed files. The child's
// ToolContext is unchanged, so the real tools keep their own sandbox too.

function samePath(left: string, right: string) {
  return left === right || left.toLowerCase() === right.toLowerCase();
}

function baseTool(name: string) {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`The ${name} tool is missing.`);
  return tool;
}

export type ReadScope = { paths: string[] };

function outsideScope(scope: ReadScope, path: string) {
  return new ToolError(`${path} is outside this check. You may read only these files: ${scope.paths.join(", ")}.`);
}

async function allowedPath(scope: ReadScope, context: ToolContext, input: string) {
  const resolved = await resolve(context, input);
  const match = scope.paths.find((candidate) => samePath(candidate, resolved.path));
  if (!match) throw outsideScope(scope, resolved.path);
  return match;
}

/** Read, Grep and Glob limited to `paths` (library paths). */
export function scopedReadTools(paths: string[]): AgentTool[] {
  const scope: ReadScope = { paths: [...new Set(paths)] };
  const read = baseTool("Read");
  const grep = baseTool("Grep");
  const glob = baseTool("Glob");
  const note = `\n\nIn this check you may read only: ${scope.paths.join(", ")}.`;
  return [
    {
      ...read,
      description: `${read.description}${note}`,
      async run(args, context) {
        const filePath = await allowedPath(scope, context, typeof args.file_path === "string" ? args.file_path : "");
        return read.run({ ...args, file_path: filePath }, context);
      },
    },
    {
      ...grep,
      description: `${grep.description}${note} Without path, each of these files is searched.`,
      async run(args, context) {
        const input = optionalString(args, "path");
        if (input) return grep.run({ ...args, path: await allowedPath(scope, context, input) }, context);
        // No path: search every allowed file and join what they found.
        const parts: string[] = [];
        let matched = 0;
        let last: ToolResult | null = null;
        for (const filePath of scope.paths) {
          let result: ToolResult;
          try { result = await grep.run({ ...args, path: filePath }, context); }
          catch (error) {
            if (context.signal.aborted) throw error;
            continue;
          }
          last = result;
          if (/^No matches for /.test(result.text)) continue;
          matched++;
          parts.push(result.text);
        }
        if (!matched) return ok(`No matches for ${JSON.stringify(String(args.pattern ?? ""))} in ${scope.paths.join(", ")}.`, "No matches");
        return ok(parts.join("\n\n"), matched === 1 && last ? last.result : `Matches in ${matched} files`, parts.join("\n\n").slice(0, 1_500));
      },
    },
    {
      ...glob,
      description: `Lists the files this check may read whose path or name matches a glob pattern, e.g. "*.pdf".${note}`,
      async run(args) {
        const pattern = typeof args.pattern === "string" && args.pattern.trim() ? args.pattern.trim() : "*";
        let matcher: RegExp;
        try { matcher = globToRegExp(pattern); }
        catch { throw new ToolError(`"${pattern}" is not a valid glob pattern.`); }
        const matches = scope.paths.filter((filePath) => matcher.test(filePath) || matcher.test(filePath.split("/").slice(1).join("/")) || matcher.test(filePath.split("/").at(-1)!));
        if (!matches.length) return ok(`No files you may read match "${pattern}". You may read: ${scope.paths.join(", ")}.`, "No matches");
        return ok(matches.join("\n"), `${matches.length} file${matches.length === 1 ? "" : "s"}`);
      },
    },
  ];
}
