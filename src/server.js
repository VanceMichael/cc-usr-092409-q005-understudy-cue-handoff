import http from "node:http";

export function createServer() {
  return http.createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.stringify({ status: "ok", service: "戏曲舞台口令服务" });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(body);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(Number(process.env.PORT ?? 8082), "0.0.0.0");
}
