import http from "node:http";
import path from "node:path";
import { Store } from "./store.js";
import { readJsonBody } from "./util.js";

const routes = [];

function route(method, pattern, handler) {
  routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
}

function matchRoute(method, pathname) {
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length !== candidate.parts.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < candidate.parts.length; index += 1) {
      const part = candidate.parts[index];
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(segments[index]);
      } else if (part !== segments[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: candidate.handler, params, pattern: candidate.parts.join("/") };
  }
  return null;
}

function send(response, status, payload) {
  response
    .writeHead(status, { "content-type": "application/json; charset=utf-8" })
    .end(JSON.stringify(payload));
}

function fromStore(result, successStatus = 200) {
  if (result.ok) return [successStatus, result.result];
  return [
    result.status,
    { error: { code: result.code, message: result.message, details: result.details ?? null } },
  ];
}

route("GET", "/health", () => [200, { status: "ok", service: "戏曲舞台口令服务" }]);

route("PUT", "/people/:personId", ({ store, params, body }) =>
  fromStore(store.registerPerson(params.personId, body?.staffRoles), 200),
);
route("GET", "/people/:personId", ({ store, params }) => fromStore(store.getPerson(params.personId)));

route("POST", "/shows", ({ store, body }) => fromStore(store.createShow(body), 201));
route("GET", "/shows/:showId", ({ store, params }) => fromStore(store.getShow(params.showId)));
route("POST", "/shows/:showId/open", ({ store, params }) => fromStore(store.openShow(params.showId)));
route("POST", "/shows/:showId/close", ({ store, params }) => fromStore(store.closeShow(params.showId)));
route("GET", "/shows/:showId/readiness", ({ store, params }) =>
  fromStore(store.getReadiness(params.showId)),
);
route("GET", "/shows/:showId/review", ({ store, params }) => fromStore(store.getReview(params.showId)));
route("GET", "/shows/:showId/authorizations", ({ store, params }) =>
  fromStore(store.listAuthorizations(params.showId)),
);

route("POST", "/shows/:showId/roles/:roleId/versions", ({ store, params, body }) =>
  fromStore(store.createRoleVersion(params.showId, params.roleId, body), 201),
);
route("POST", "/shows/:showId/roles/:roleId/versions/:version/release", ({ store, params }) => {
  const version = Number.parseInt(params.version, 10);
  if (!Number.isInteger(version) || version < 1) {
    return [400, { error: { code: "invalid_request", message: "版本号必须是正整数", details: null } }];
  }
  return fromStore(store.releaseRoleVersion(params.showId, params.roleId, version));
});

route("POST", "/shows/:showId/cues", ({ store, params, body }) =>
  fromStore(store.createCue(params.showId, body), 201),
);
route("POST", "/shows/:showId/safety-points", ({ store, params, body }) =>
  fromStore(store.createSafetyPoint(params.showId, body), 201),
);

route("POST", "/shows/:showId/cast-changes", ({ store, params, body }) =>
  fromStore(store.requestCastChange(params.showId, body), 201),
);
route("GET", "/shows/:showId/cast-changes", ({ store, params }) =>
  fromStore(store.listCastChanges(params.showId)),
);
route("GET", "/shows/:showId/cast-changes/:castChangeId", ({ store, params }) =>
  fromStore(store.getCastChange(params.showId, params.castChangeId)),
);
route("POST", "/shows/:showId/cast-changes/:castChangeId/signatures", ({ store, params, body }) =>
  fromStore(store.signCastChange(params.showId, params.castChangeId, body)),
);
route("POST", "/shows/:showId/cast-changes/:castChangeId/cancel", ({ store, params, body }) =>
  fromStore(store.cancelCastChange(params.showId, params.castChangeId, body)),
);

route("POST", "/shows/:showId/executions", ({ store, params, body }) =>
  fromStore(store.executeCue(params.showId, body), 201),
);
route("POST", "/shows/:showId/skips", ({ store, params, body }) =>
  fromStore(store.skipCue(params.showId, body), 201),
);
route("POST", "/shows/:showId/rehearsal-receipts", ({ store, params, body }) =>
  fromStore(store.recordRehearsalReceipt(params.showId, body), 201),
);

route("GET", "/leases", ({ store }) => fromStore(store.listLeases()));

export function createServer({ dataDir, now, logger } = {}) {
  const store = new Store({
    dataDir: dataDir ?? process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
    now,
  });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const matched = matchRoute(request.method, url.pathname);
    if (!matched) {
      send(response, 404, { error: { code: "not_found", message: "路由不存在", details: null } });
      return;
    }
    let status = 500;
    try {
      const needsBody = request.method === "POST" || request.method === "PUT";
      const body = needsBody ? await readJsonBody(request) : {};
      const [resolvedStatus, payload] = await matched.handler({
        store,
        params: matched.params,
        body,
        query: url.searchParams,
      });
      status = resolvedStatus;
      send(response, status, payload);
    } catch (error) {
      status = error.code === "invalid_json" || error.code === "payload_too_large" ? 400 : 500;
      send(response, status, {
        error: {
          code: error.code ?? "internal_error",
          message: status === 500 ? "服务内部错误" : error.message,
          details: null,
        },
      });
    } finally {
      // 日志只记录方法与路由模板，不写入联系人、身份信息或原始凭据。
      if (logger) logger(`${request.method} /${matched.pattern} -> ${status}`);
    }
  });
  server.store = store;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8082);
  createServer({ logger: (line) => console.log(line) }).listen(port, "0.0.0.0");
}
