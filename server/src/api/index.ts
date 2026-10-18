// Registers every REST route. Each area lives in its own module under api/.

import type { FastifyInstance } from "fastify";

import type { ServerContext } from "../context.js";
import { registerSystemRoutes } from "./system.js";

export async function registerApi(app: FastifyInstance, context: ServerContext): Promise<void> {
  registerSystemRoutes(app, context);
}
