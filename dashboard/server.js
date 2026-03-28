/**
 * Embedded HTTP server for the Meridian dashboard.
 * Zero new dependencies — uses Node's native `http` module.
 */

import http from "http";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { log } from "../logger.js";
import {
  handleStats,
  handleWallet,
  handlePositions,
  handlePortfolio,
  handleHistory,
  handleJournal,
  handleLessons,
  handleDeleteLesson,
  handleLogs,
} from "./api.js";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, "index.html");

export function startDashboard(port = 3000, password = null) {
  const server = http.createServer(async (req, res) => {
    // ─── Basic Auth ───────────────────────────────────────────
    if (password) {
      const auth = req.headers["authorization"] ?? "";
      const encoded = Buffer.from(`:${password}`).toString("base64");
      if (auth !== `Basic ${encoded}`) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Meridian"' });
        res.end("Unauthorized");
        return;
      }
    }

    const url      = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    // Serve dashboard HTML
    if (pathname === "/" || pathname === "/index.html") {
      try {
        const html = fs.readFileSync(INDEX_HTML, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" });
        res.end(html);
      } catch {
        res.writeHead(500);
        res.end("Dashboard HTML not found.");
      }
      return;
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      res.end();
      return;
    }

    // API routing
    if (pathname.startsWith("/api/")) {
      try {
        if (pathname === "/api/stats")     return await handleStats(req, res);
        if (pathname === "/api/wallet")    return await handleWallet(req, res);
        if (pathname === "/api/positions") return await handlePositions(req, res);
        if (pathname === "/api/portfolio") return await handlePortfolio(req, res);
        if (pathname === "/api/history")   return await handleHistory(req, res);
        if (pathname === "/api/journal")   return await handleJournal(req, res, url);
        if (pathname === "/api/lessons")   return await handleLessons(req, res, url);
        if (req.method === "DELETE" && pathname.startsWith("/api/lessons/")) return await handleDeleteLesson(req, res, pathname);
        if (pathname === "/api/logs")      return await handleLogs(req, res, url);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown API endpoint" }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, "0.0.0.0", () => {
    log("dashboard", `Dashboard running on port ${port}`);
  });

  server.on("error", (e) => {
    log("dashboard", `Server error: ${e.message}`);
  });

  return server;
}
