// Route table for the control API: "/docs/:docId/text" style patterns.
//
// Patterns are matched segment by segment against the decoded path, so a
// parameter never spans a "/" and an encoded "%2F" inside an id stays part of
// that id (ControlRoutes encodes every id with encodeURIComponent).

import { ControlError, type ControlHandler, type ControlRouter } from "./types";

export type ControlMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface Route {
  method: ControlMethod;
  segments: string[];
  handler: ControlHandler;
}

export interface RouteMatch {
  handler: ControlHandler;
  params: Record<string, string>;
}

function split(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

export class Router implements ControlRouter {
  private routes: Route[] = [];

  add(method: ControlMethod, pattern: string, handler: ControlHandler): void {
    // ControlRoutes builders encode their arguments, so a pattern built as
    // ControlRoutes.docText(":docId") arrives as "%3AdocId".
    const segments = split(pattern).map((segment) => (/^%3a/i.test(segment) ? `:${segment.slice(3)}` : segment));
    const duplicate = this.routes.some(
      (route) =>
        route.method === method &&
        route.segments.length === segments.length &&
        route.segments.every((segment, index) => (segment.startsWith(":") ? segments[index].startsWith(":") : segment === segments[index])),
    );
    // A silent second registration would make one module's route unreachable.
    if (duplicate) throw new Error(`Control route ${method} ${pattern} is already registered`);
    this.routes.push({ method, segments, handler });
  }

  clear(): void {
    this.routes = [];
  }

  /**
   * Finds the handler for a request. Literal segments win over parameters,
   * so "/projects/share" is not taken for "/projects/:projectId".
   * Returns null when no pattern matches the path, and "method-not-allowed"
   * when the path exists for other methods only (the server answers 405
   * unless another router has the route).
   */
  match(method: string, path: string): RouteMatch | "method-not-allowed" | null {
    const raw = split(path);
    let best: { route: Route; params: Record<string, string>; literals: number } | null = null;
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== raw.length) continue;
      const params: Record<string, string> = {};
      let literals = 0;
      let ok = true;
      for (let index = 0; index < raw.length; index++) {
        const pattern = route.segments[index];
        if (pattern.startsWith(":")) {
          let value: string;
          try {
            value = decodeURIComponent(raw[index]);
          } catch {
            throw new ControlError(400, "bad-request", "The request path is not valid.");
          }
          params[pattern.slice(1)] = value;
        } else if (pattern === raw[index]) {
          literals++;
        } else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      if (!best || literals > best.literals) best = { route, params, literals };
    }
    if (best) return { handler: best.route.handler, params: best.params };
    return pathMatched ? "method-not-allowed" : null;
  }
}
