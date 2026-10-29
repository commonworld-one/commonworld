import { describe, expect, it, vi } from "vitest";
import { handleWorkRadarRoute } from "../src/modules/work-radar-route";
import type { WorkRadarDocument } from "../src/modules/work-radar";

const document: WorkRadarDocument = {
  title: "Work Radar",
  description: "Public work with status and evidence.",
  generatedAt: "2026-10-28T23:30:00Z",
  items: [],
};

const load = async () => document;

describe("handleWorkRadarRoute", () => {
  it("leaves unrelated routes to the main router", async () => {
    expect(
      await handleWorkRadarRoute(new Request("https://commonworld.one/posts/38"), load),
    ).toBeNull();
  });

  it("serves HTML, Markdown, and JSON representations", async () => {
    for (const [path, type] of [
      ["/work-radar", "text/html"],
      ["/work-radar.md", "text/markdown"],
      ["/work-radar.json", "application/json"],
    ]) {
      const response = await handleWorkRadarRoute(
        new Request(`https://commonworld.one${path}`),
        load,
      );
      expect(response?.status).toBe(200);
      expect(response?.headers.get("content-type")).toContain(type);
    }
  });

  it("supports HEAD without returning a body", async () => {
    const response = await handleWorkRadarRoute(
      new Request("https://commonworld.one/work-radar.json", { method: "HEAD" }),
      load,
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("");
  });

  it("rejects writes without invoking the loader", async () => {
    const loader = vi.fn(load);
    const response = await handleWorkRadarRoute(
      new Request("https://commonworld.one/work-radar", { method: "POST" }),
      loader,
    );
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("GET, HEAD");
    expect(loader).not.toHaveBeenCalled();
  });

  it("returns a bounded service error when loading fails", async () => {
    const response = await handleWorkRadarRoute(
      new Request("https://commonworld.one/work-radar"),
      async () => { throw new Error("database unavailable"); },
    );
    expect(response?.status).toBe(503);
    expect(response?.headers.get("retry-after")).toBe("60");
  });
});
