import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { maintenanceServer } from "../src/app/maintenance.js";
import { en } from "../src/app/messages/en.js";

/**
 * What answers while the machine is in maintenance mode. Fly's update waits on
 * /healthz, so it must pass; people get a page saying why, with a status a
 * client and a monitor read as "come back later".
 */
const server = maintenanceServer();
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("maintenance mode", () => {
  test("answers Fly's health check, so an update into it finishes", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("maintenance");
  });

  test("tells people why, and when to come back", async () => {
    for (const path of ["/", "/samples?scope=all", "/healthz/jobs"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("300");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.text();
      expect(body).toContain(en.errorPage.maintenance.heading);
      expect(body).toContain(en.errorPage.maintenance.body);
    }
  });

  test("a HEAD request gets the status without the page", async () => {
    const res = await fetch(`${base}/`, { method: "HEAD" });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("");
  });
});
