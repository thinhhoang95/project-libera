// HTTP request latency per route for the Grafana dashboard. Routes are
// labelled by their pattern (/v1/documents/:docId), never by the raw URL, so
// ids do not become label values.

import type { FastifyInstance } from "fastify";
import { Histogram, type Registry } from "prom-client";

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function installHttpMetrics(app: FastifyInstance, registry: Registry): Histogram<"method" | "route" | "status"> {
  const histogram = new Histogram({
    name: "libera_http_request_duration_seconds",
    help: "HTTP request duration by method, route pattern and status class.",
    labelNames: ["method", "route", "status"],
    buckets: BUCKETS,
    registers: [registry],
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    histogram.observe(
      { method: request.method, route, status: `${Math.floor(reply.statusCode / 100)}xx` },
      reply.elapsedTime / 1000,
    );
  });
  return histogram;
}
