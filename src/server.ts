import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";

import swagger from "@fastify/swagger";

import swaggerUi from "@fastify/swagger-ui";

import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from "fastify";

import { swaggerConfig, swaggerUiConfig } from "./api-spec.js";

import type { Config } from "./config.js";

import { checkHealth } from "./db.js";

import { errorCodeForStatus, redactErrorMessage } from "./error-redaction.js";

import { logger } from "./logger.js";

import { registerMetricsPlugin } from "./metrics-plugin.js";

import { isTrustedProxyAddress, parseTrustedProxies } from "./proxy.js";

import { parseQueryString } from "./query-string-parser.js";

import { REQUEST_ID_HEADER, sanitizeRequestId } from "./request-id.js";

import { getIndexerPosition } from "./repositories/indexer-state.js";

import {
  apiErrorSchema,
  indexerStatusSchema,
  streamListResponseSchema,
  streamSummaryResponseSchema,
  streamViewSchema,
  apiIndexSchema,
} from "./schema.js";

import { serviceVersion } from "./version.js";


// Error redaction and structured error codes live in `./error-redaction.ts`
// so they are testable independently of the server wiring.

// Builds the Fastify instance with the shared logger, CORS, the OpenAPI
// plugin, and the routes that do not depend on external services. Route groups
// that need the database are registered by the caller during bootstrap.
//
// @fastify/swagger MUST be registered before any routes so that it can observe
// every route schema. The shared JSON Schema definitions ($id-bearing objects)
// are added to the Fastify schema store here so that routes may reference them
// with $ref and the plugin emits them as reusable OpenAPI components.
export async function buildServer(config?: Partial<Config>): Promise<FastifyInstance> {
  const trustedProxies = config?.trustedProxies ?? [];
  const app = Fastify({
    // Fastify types its logger as FastifyBaseLogger; the pino instance
    // satisfies that interface at runtime.
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: config?.bodyLimit,
    // Forwarded headers (X-Forwarded-For, X-Forwarded-Proto) are honored only
    // when the direct connection peer is an explicitly trusted proxy (#75).
    // Without configuration the socket address is used as-is, so a direct
    // client cannot spoof the recorded client address in logs or request
    // metadata.
    trustProxy:
      trustedProxies.length > 0
        ? (address: string) => isTrustedProxyAddress(address, trustedProxies)
        : false,
    // Derive the request id from a client-supplied header when it is safe,
    // otherwise generate one. Fastify binds the id to the per-request child
    // logger, so it lands in every structured request log line as `reqId`.
    genReqId: (req) =>
      sanitizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID(),
    querystringParser: parseQueryString,
  });

  app.addHook("onRequest", async (request, reply) => {
    const rawQuery = request.raw.url?.split('?')[1] ?? '';
    if (config?.queryStringLimit && rawQuery.length > config.queryStringLimit) {
      void reply.status(400).send({
        code: "VALIDATION_ERROR",
        error: "query string too long",
        requestId: request.id,
      });
      return reply;
    }
  });

  // Record every response against the Prometheus counters and histograms.
  await registerMetricsPlugin(app);


  // Echo the request id on every response so clients can quote it back. Set
  // before routing, so even requests that fail early carry the header.
  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  // Attach the request id to error bodies so an error a client saw can be
  // traced to its log lines. Status codes are preserved and each failure
  // carries a stable machine-readable code (#73). Outgoing messages are
  // redacted so connection strings, SQL fragments, or stack traces never
  // reach the client (#74); the original error is logged server-side with
  // the request id for diagnosis.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const statusCode = typeof err.statusCode === "number" && err.statusCode >= 400
      ? err.statusCode
      : 500;
    if (statusCode >= 500) {
      request.log.error({ err }, "request failed");
    }
    const message =
      statusCode >= 500
        ? "internal server error"
        : redactErrorMessage(err.message);
    void reply.status(statusCode).send({
      code: errorCodeForStatus(statusCode),
      error: message,
      requestId: request.id,
    });
  });

  // Unmatched routes bypass the error handler, so they get their own handler —
  // with the request id attached like every other error response.
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      code: errorCodeForStatus(404),
      error: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    });
  });

  // The web client fetches this API from the browser, so it is always a
  // cross-origin caller once the two run on separate ports or hosts. The data
  // served here is public and read-only, so any origin is reflected by
  // default; set CORS_ORIGIN to pin deployments to a known frontend. Not
  // awaited because Fastify defers plugin loading until ready/listen, which
  // keeps this builder synchronous for its callers.
  void app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? true,
  });

  // Register shared schemas so routes can reference them with { $ref: "$id" }.
  // @fastify/swagger will emit them as named components in the spec.
  app.addSchema(streamViewSchema);
  app.addSchema(streamListResponseSchema);
  app.addSchema(streamSummaryResponseSchema);
  app.addSchema(indexerStatusSchema);
  app.addSchema(apiErrorSchema);
  app.addSchema(apiIndexSchema);

  // Generate the OpenAPI 3.0 spec from route schemas automatically.
  await app.register(swagger, swaggerConfig);

  // Serve the interactive Swagger UI at /docs and the raw spec at /docs/json
  // and /docs/yaml (these paths are the @fastify/swagger-ui defaults).
  await app.register(swaggerUi, swaggerUiConfig);

  app.get("/health", {
    schema: {
      summary: "Liveness check",
      description:
        "Returns 200 when the server is up, along with the running service version. No database read is performed.",
      tags: ["indexer"],
      response: {
        200: {
          type: "object",
          required: ["status", "version"],
          properties: {
            status: { type: "string", enum: ["ok"] },
            version: {
              type: "string",
              description:
                "Service version from the package manifest, for distinguishing binaries during rolling releases.",
            },
          },
        },
      },
    },
  }, async () => {
    return { status: "ok", version: serviceVersion };
  });

  app.get("/ready", {
    schema: {
      summary: "Readiness check",
      description:
        "Verifies database connectivity and reports indexer lag. Returns 503 when a dependency is unavailable.",
      tags: ["indexer"],
      response: {
        200: {
          type: "object",
          required: ["status", "database", "indexer"],
          properties: {
            status: { type: "string", enum: ["ready"] },
            database: { type: "string", enum: ["up"] },
            indexer: {
              type: "object",
              required: ["lagLedgers"],
              properties: {
                lagLedgers: { type: ["integer", "null"] },
              },
            },
          },
        },
        503: {
          type: "object",
          required: ["status", "database"],
          properties: {
            status: { type: "string", enum: ["not_ready"] },
            database: { type: "string", enum: ["down"] },
            error: { type: "string" },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const db = await checkHealth();
    if (db.status === "down") {
      void reply.status(503);
      return { status: "not_ready", database: "down", error: db.error };
    }

    const position = await getIndexerPosition();
    const lagLedgers = position
      ? Math.max(0, position.chainLedger - position.lastLedger)
      : null;

    return { status: "ready", database: "up", indexer: { lagLedgers } };
  });

  return app;
}
