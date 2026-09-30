#!/usr/bin/env node
// Minimal stand-in for the Dune Docker Console API, used by test-upgrade.sh.
// It only answers what docker/install.sh checks: the maps scope (partitions)
// and the bases scope (an unknown base id gives 404 when the scope is present).
//   node scripts/mock-console.js <port>
const http = require("http");

const TOKEN = "dak_ci_test_key";
const port = Number(process.argv[2]);
if (!port) {
  console.error("usage: mock-console.js <port>");
  process.exit(1);
}

http
  .createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${TOKEN}`;
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!ok) return send(401, { error: "unauthorized" });
    if (req.url.startsWith("/api/map/partitions")) return send(200, []);
    if (req.url.startsWith("/api/bases/")) return send(404, { error: "not found" });
    return send(404, { error: "not found" });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock console on 127.0.0.1:${port}`));
