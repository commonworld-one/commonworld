import { describe, expect, it } from "vitest";
import {
  renderWorkRadarHtml,
  renderWorkRadarMarkdown,
  workRadarFormat,
  workRadarResponse,
  type WorkRadarDocument,
} from "../src/modules/work-radar";

const document: WorkRadarDocument = {
  title: "Work Radar",
  description: "Public work that can be picked up, reviewed, and evidenced.",
  generatedAt: "2026-10-28T23:30:00Z",
  items: [
    {
      id: "done-1",
      title: "Published receipt",
      summary: "A completed item.",
      url: "https://commonworld.one/posts/19",
      state: "done",
      updatedAt: "2026-10-27T12:00:00Z",
      evidenceUrl: "https://commonworld.one/posts/19.json",
    },
    {
      id: "open-1",
      title: "Map the next task",
      summary: "An open item.",
      url: "https://commonworld.one/posts/38",
      state: "open",
      updatedAt: "2026-10-28T12:00:00Z",
      owner: "agent-7",
    },
  ],
};

describe("workRadarFormat", () => {
  it("maps the page and both required twins", () => {
    expect(workRadarFormat("/work-radar")).toBe("html");
    expect(workRadarFormat("/work-radar/")).toBe("html");
    expect(workRadarFormat("/work-radar.md")).toBe("markdown");
    expect(workRadarFormat("/work-radar.json")).toBe("json");
    expect(workRadarFormat("/work-radar.xml")).toBeNull();
  });
});

describe("Work Radar representations", () => {
  it("orders active work before completed work in Markdown", () => {
    const markdown = renderWorkRadarMarkdown(document);
    expect(markdown).toContain("# Work Radar");
    expect(markdown.indexOf("Map the next task")).toBeLessThan(
      markdown.indexOf("Published receipt"),
    );
  });

  it("links the HTML page to its Markdown and JSON twins", () => {
    const html = renderWorkRadarHtml(document);
    expect(html).toContain('href="/work-radar.md"');
    expect(html).toContain('href="/work-radar.json"');
  });

  it("escapes untrusted content and rejects unsafe links", () => {
    const html = renderWorkRadarHtml({
      ...document,
      title: "<script>alert(1)</script>",
      items: [{
        ...document.items[0],
        title: "<img src=x onerror=alert(1)>",
        url: "javascript:alert(1)",
      }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("returns the correct content type for each representation", async () => {
    const html = workRadarResponse("html", document);
    const markdown = workRadarResponse("markdown", document);
    const json = workRadarResponse("json", document);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(json.headers.get("content-type")).toContain("application/json");
    expect((await json.json()).items[0].state).toBe("open");
  });
});
