// src/handoff.ts
var HANDOFF_VERSION = "commonworld-handoff/1";
var HANDOFF_MAX_BYTES = 64 * 1024;
var HANDOFF_FIELDS = [
  ["brief", "Brief"],
  ["acceptance", "Acceptance conditions"],
  ["completed", "Completed work (self-reported)"],
  ["evidence", "Evidence and verification limits"],
  ["pending", "Pending or uncertain operations (reconcile before retrying)"],
  ["blockers", "Blockers"],
  ["next_step", "Exact next step"]
];
function handoffTemplate() {
  return { format: HANDOFF_VERSION, brief: "", acceptance: "", completed: "", evidence: "", pending: "", blockers: "", next_step: "" };
}
function parseHandoff(input) {
  if (new TextEncoder().encode(input).length > HANDOFF_MAX_BYTES) throw new Error("Checkpoint exceeds 64 KiB.");
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("Checkpoint must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Checkpoint must be an object.");
  const obj = value;
  if (obj.format !== HANDOFF_VERSION) throw new Error("Unsupported checkpoint format.");
  const allowed = /* @__PURE__ */ new Set(["format", ...HANDOFF_FIELDS.map(([key]) => key)]);
  if (Object.keys(obj).some((key) => !allowed.has(key))) throw new Error("Unknown checkpoint field.");
  const result = handoffTemplate();
  for (const [key, label] of HANDOFF_FIELDS) {
    const text = obj[key];
    if (typeof text !== "string") throw new Error(`${label} must be text.`);
    if (text.length > 8e3) throw new Error(`${label} exceeds 8000 characters.`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error(`${label} contains unsupported control characters.`);
    result[key] = text;
  }
  for (const key of ["brief", "acceptance", "next_step"]) {
    if (!result[key].trim()) throw new Error(`${HANDOFF_FIELDS.find(([field]) => field === key)[1]} is required.`);
  }
  return result;
}
function handoffMarkdown(checkpoint) {
  const checked = parseHandoff(JSON.stringify(checkpoint));
  return [
    "# Task handoff",
    "",
    "Voluntary, self-reported checkpoint. Not independent verification or permission to act.",
    "Reconcile uncertain operations before retrying. This file does not execute or wake an agent.",
    "",
    ...HANDOFF_FIELDS.flatMap(([key, label]) => [
      `## ${label}`,
      "",
      ...(checked[key] || "(not supplied)").replace(/\r\n?/g, "\n").split("\n").map((line) => `    ${line}`),
      ""
    ])
  ].join("\n");
}

// browser/handoff.ts
var form = document.querySelector("#handoff-form");
if (form) {
  const message = document.querySelector("#handoff-message");
  const imported = document.querySelector("#handoff-import");
  const say = (text) => {
    message.textContent = text;
  };
  const read = () => {
    const value = handoffTemplate();
    for (const [key] of HANDOFF_FIELDS) value[key] = form.elements.namedItem(key).value;
    return parseHandoff(JSON.stringify(value));
  };
  const download = (text, extension, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `commonworld-handoff.${extension}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  };
  for (const button of document.querySelectorAll("[data-handoff-export]")) {
    button.addEventListener("click", () => {
      try {
        const value = read();
        const markdown = button.dataset.handoffExport === "md";
        download(markdown ? handoffMarkdown(value) : JSON.stringify(value, null, 2), markdown ? "md" : "json", markdown ? "text/markdown;charset=utf-8" : "application/json");
        say("Download prepared locally. Review its contents before sharing.");
      } catch (error) {
        say(error instanceof Error ? error.message : "Cannot export checkpoint.");
      }
    });
  }
  imported.addEventListener("change", async () => {
    const file = imported.files?.[0];
    if (!file) return;
    try {
      if (file.size > HANDOFF_MAX_BYTES) throw new Error("Checkpoint exceeds 64 KiB.");
      const value = parseHandoff(await file.text());
      for (const [key] of HANDOFF_FIELDS) form.elements.namedItem(key).value = value[key];
      say("Checkpoint imported locally. Reconcile uncertain operations before continuing.");
    } catch (error) {
      say(error instanceof Error ? error.message : "Cannot import checkpoint.");
    } finally {
      imported.value = "";
    }
  });
  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("reset", () => {
    imported.value = "";
    say("Checkpoint cleared. Downloaded files are unchanged.");
  });
  form.querySelectorAll("fieldset").forEach((fieldset) => {
    fieldset.disabled = false;
  });
  say("Ready. Input stays in this tab; download before closing or reloading.");
}
