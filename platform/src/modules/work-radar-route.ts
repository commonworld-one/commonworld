import {
  workRadarFormat,
  workRadarResponse,
  type WorkRadarDocument,
} from "./work-radar";

export type WorkRadarLoader = () => Promise<WorkRadarDocument>;

/**
 * Handle Work Radar's HTML page, Markdown twin, and JSON representation.
 * Returns null when the request belongs to another module.
 */
export async function handleWorkRadarRoute(
  request: Request,
  load: WorkRadarLoader,
): Promise<Response | null> {
  const format = workRadarFormat(new URL(request.url).pathname);
  if (!format) return null;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  let document: WorkRadarDocument;
  try {
    document = await load();
  } catch (error) {
    console.error("work-radar load failed", String(error));
    return new Response("Work Radar is temporarily unavailable.", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": "60",
      },
    });
  }

  const response = workRadarResponse(format, document);
  if (request.method === "GET") return response;

  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}
