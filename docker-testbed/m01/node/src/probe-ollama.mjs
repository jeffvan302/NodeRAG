import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Ajv from "ajv";

const baseUrl = (process.env.NODERAG_M01_OLLAMA_URL ?? "http://host.docker.internal:11434").replace(/\/$/, "");
const requestedModel = process.env.NODERAG_M01_OLLAMA_MODEL ?? "";
const token = process.env.NODERAG_M01_OLLAMA_TOKEN ?? "";
const configuredParallelism = Number(process.env.NODERAG_M01_OLLAMA_PARALLEL ?? 1);
const contentMayLeaveLan = process.env.NODERAG_M01_CONTENT_MAY_LEAVE_LAN === "true";
const imagePath = process.env.NODERAG_M01_TABLE_IMAGE ?? "/workspace/fixtures/formats/images/table.png";
const headers = token ? { Authorization: `Bearer ${token}` } : {};

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

let result;
try {
  const tagsStarted = performance.now();
  const tags = await requestJson(`${baseUrl}/api/tags`);
  const tagsMs = performance.now() - tagsStarted;
  const modelNames = (tags.models ?? []).map((model) => model.name);
  const selectedModel = requestedModel || modelNames.find((name) => /llava|gemma3|qwen.*vl|vision/i.test(name)) || "";
  if (!selectedModel) {
    result = {
      baseUrl,
      route: new URL(baseUrl).hostname,
      authenticationConfigured: Boolean(token),
      configuredParallelism,
      contentMayLeaveLan,
      tagsMs,
      installedModels: modelNames,
      vision: "unavailable-no-vision-model",
      applicable: false,
      passed: true,
    };
  } else {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        markdown: { type: "string", minLength: 1 },
        title: { type: "string" },
      },
      required: ["markdown"],
    };
    const image = (await fs.readFile(path.resolve(imagePath))).toString("base64");
    const started = performance.now();
    const response = await requestJson(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selectedModel,
        stream: false,
        format: schema,
        options: { temperature: 0 },
        messages: [
          {
            role: "user",
            content: "Transcribe the table as concise Markdown. Return only the requested schema.",
            images: [image],
          },
        ],
      }),
    });
    const elapsedMs = performance.now() - started;
    const parsed = JSON.parse(response.message?.content ?? "{}");
    const valid = new Ajv({ allErrors: true }).compile(schema)(parsed);
    result = {
      baseUrl,
      route: new URL(baseUrl).hostname,
      authenticationConfigured: Boolean(token),
      configuredParallelism,
      contentMayLeaveLan,
      installedModels: modelNames,
      selectedModel,
      tagsMs,
      elapsedMs,
      schemaValid: valid,
      returnedMarkdownCharacters: parsed.markdown?.length ?? 0,
      applicable: true,
      passed: valid,
    };
  }
} catch (error) {
  result = {
    baseUrl,
    route: new URL(baseUrl).hostname,
    authenticationConfigured: Boolean(token),
    configuredParallelism,
    contentMayLeaveLan,
    vision: "unavailable-endpoint-error",
    error: error.message,
    applicable: false,
    passed: true,
  };
}

console.log(JSON.stringify(result, null, 2));
if (!result.passed) {
  process.exitCode = 1;
}
