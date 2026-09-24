import http from "node:http";
import { Store } from "./store.js";
import { ApiError, CueService } from "./service.js";
import "./domain.js"; // 注册事件 reducer

const MAX_BODY_BYTES = 1_000_000;

export function createServer({ store, dir, now } = {}) {
  const dataStore = store ?? new Store({ dir: dir ?? process.env.DATA_DIR ?? null, now });
  const service = new CueService(dataStore);

  const server = http.createServer(async (request, response) => {
    try {
      await route(request, response, service);
    } catch (error) {
      sendError(response, error);
    }
  });

  server.store = dataStore;
  server.service = service;
  return server;
}

async function readJson(request) {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "body_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  if (error instanceof ApiError) {
    send(response, error.status, { error: error.code, ...error.details });
    return;
  }
  // 不向调用方泄露内部细节；日志同样不记录载荷或身份信息。
  console.error("internal_error", error?.name ?? "Error");
  send(response, 500, { error: "internal_error" });
}

async function route(request, response, service) {
  const { pathname } = new URL(request.url, "http://localhost");
  const body = await readJson(request);
  const method = request.method;

  if (method === "GET" && pathname === "/health") {
    send(response, 200, { status: "ok", service: "戏曲舞台口令服务" });
    return;
  }

  const match = (pattern) => {
    const asRegex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, "(?<$1>[^/]+)")}$`);
    const result = pathname.match(asRegex);
    return result ? (result.groups ?? {}) : null;
  };

  const routes = [
    ["POST", "/v1/people", () => service.registerPerson(body)],
    ["POST", "/v1/shows", () => service.createShow(body)],
    ["POST", "/v1/packages", () => service.createPackage(body)],
    ["POST", "/v1/role-versions", () => service.createRoleVersion(body)],
    ["POST", "/v1/rehearsal-receipts", () => service.recordReceipt(body)],
    ["POST", "/v1/performances", () => service.createPerformance(body)],
    [
      "POST",
      "/v1/performances/:id/release",
      (g) => service.releasePackage(g.id, body),
    ],
    [
      "POST",
      "/v1/performances/:id/change-requests",
      (g) => service.createChangeRequest(g.id, body),
    ],
    [
      "POST",
      "/v1/performances/:id/start",
      (g) => service.startPerformance(g.id, body),
    ],
    [
      "POST",
      "/v1/performances/:id/safety-points",
      (g) => service.declareSafetyPoint(g.id, body),
    ],
    [
      "POST",
      "/v1/performances/:id/switches",
      (g) => service.switchAtSafetyPoint(g.id, body),
    ],
    [
      "GET",
      "/v1/performances/:id/timeline",
      (g) => service.performanceTimeline(g.id),
    ],
    [
      "GET",
      "/v1/performances/:id",
      (g) => service.getPerformance(g.id),
    ],
    ["POST", "/v1/change-requests/:id/reconfirmations", (g) => service.recordReconfirmation(g.id, body)],
    ["POST", "/v1/change-requests/:id/signatures", (g) => service.signRequest(g.id, body)],
    ["POST", "/v1/change-requests/:id/authorize", (g) => service.authorize(g.id, body)],
    ["POST", "/v1/change-requests/:id/withdraw", (g) => service.withdrawRequest(g.id, body)],
    ["GET", "/v1/change-requests/:id", (g) => service.requestReport(g.id)],
    ["POST", "/v1/leases", () => service.acquireLease(body)],
    ["GET", "/v1/leases", () => {
      const query = new URL(request.url, "http://localhost").searchParams;
      return service.listLeases({
        resourceKind: query.get("resourceKind"),
        resourceId: query.get("resourceId"),
      });
    }],
    ["POST", "/v1/leases/:id/release", (g) => service.releaseLease(g.id, body)],
    ["POST", "/v1/bypasses", () => service.createBypass(body)],
    ["POST", "/v1/cue-executions", () => service.executeCue(body)],
  ];

  for (const [verb, pattern, handler] of routes) {
    if (verb !== method) continue;
    const groups = match(pattern);
    if (!groups) continue;
    const result = await handler(groups);
    send(response, 200, result ?? { ok: true });
    return;
  }

  send(response, 404, { error: "not_found" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(Number(process.env.PORT ?? 8082), "0.0.0.0");
}
