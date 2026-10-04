import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { messagesFor } from "./messages/index.js";
import { staticMaintenancePage } from "./views/error-page.js";

/**
 * What answers on the app's port while the machine is in maintenance mode
 * (infra/fly/entrypoint.sh): the app is stopped so the store is free for a
 * CLI, and something still has to answer, for two reasons.
 *
 * Fly. `fly machine update` and `fly deploy` wait for the service check on
 * /healthz to pass, and while nothing listened it never did: switching into
 * maintenance sat for five minutes holding the machine's lease, then reported
 * a timeout — so switching back out had to wait for the lease to lapse, and a
 * deploy into maintenance always "failed" (Peter, 2026-10-04: flipping into
 * maintenance mode shouldn't hang a deployment). /healthz here says the
 * machine is up and meant to be: a check passing is what lets the update
 * finish, and it is also what makes the proxy route people here rather than
 * nowhere.
 *
 * People. Everything else is a 503 with Retry-After and a page in the
 * catalog's words, instead of the proxy's connection error.
 *
 * It must never touch the store — maintenance mode exists so that a CLI can
 * hold it — and it imports nothing that does: the catalog and the page of
 * last resort, both plain data and strings. /healthz/jobs is a 503 like the
 * rest: no job runs while the app is stopped, and a monitor should hear so.
 */
export function maintenanceServer(): Server {
  const m = messagesFor(null);
  const page = staticMaintenancePage(m);
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("maintenance");
      return;
    }
    res.writeHead(503, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "300",
      // The app's own headers (src/app/security-headers.ts) are middleware in
      // an app that is not running; this page needs only its inline style.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : page);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 3054);
  const server = maintenanceServer();
  server.listen(port, () => console.log(`maintenance responder on port ${port}: /healthz answers, everything else is 503`));
  // Stop at once on Fly's kill signal: there is nothing to settle and no
  // store to close, and the next boot is the one somebody is waiting for.
  // close() alone waits for keep-alive connections the proxy holds open,
  // which would run to Fly's two-minute kill timeout.
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
