// Registers every REST route. Each area lives in its own module under api/.

import type { FastifyInstance } from "fastify";

import type { ServerContext } from "../context.js";
import { registerAuthRoutes } from "./auth.js";
import { registerBlobRoutes } from "./blobs.js";
import { registerCommandRoutes } from "./commands.js";
import { registerDocumentRoutes } from "./documents.js";
import { registerInvitationRoutes } from "./invitations.js";
import { registerNotificationRoutes } from "./notifications.js";
import { registerProjectRoutes } from "./projects.js";
import { registerRevisionRoutes } from "./revisions.js";
import { registerSystemRoutes } from "./system.js";
import { registerThreadRoutes } from "./threads.js";

export async function registerApi(app: FastifyInstance, context: ServerContext): Promise<void> {
  registerSystemRoutes(app, context);
  registerAuthRoutes(app, context);
  registerProjectRoutes(app, context);
  registerInvitationRoutes(app, context);
  registerDocumentRoutes(app, context);
  registerBlobRoutes(app, context);
  registerThreadRoutes(app, context);
  registerRevisionRoutes(app, context);
  registerNotificationRoutes(app, context);
  registerCommandRoutes(app, context);
}
