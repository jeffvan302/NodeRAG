import fs from "node:fs/promises";
import { createEmbedder } from "./model.mjs";

async function readCgroupNumber(name) {
  const value = (await fs.readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim();
  return value === "max" ? null : Number(value);
}

const before = {
  rssBytes: process.memoryUsage().rss,
  cgroupCurrentBytes: await readCgroupNumber("memory.current"),
};
const first = await createEmbedder({ threads: 4, maxTokens: 1024 });
const longText = "maintenance procedure inspection schedule archive search ".repeat(2048);
const firstResult = await first.embed(longText);
const afterFirst = {
  rssBytes: process.memoryUsage().rss,
  cgroupCurrentBytes: await readCgroupNumber("memory.current"),
};
const second = await createEmbedder({ threads: 1, maxTokens: 64 });
const secondResult = await second.embed(`${second.manifest.queryPrefix}Where is the inspection record?`);
const afterSecond = {
  rssBytes: process.memoryUsage().rss,
  cgroupCurrentBytes: await readCgroupNumber("memory.current"),
  cgroupPeakBytes: await readCgroupNumber("memory.peak"),
  cgroupLimitBytes: await readCgroupNumber("memory.max"),
};

const result = {
  scenario: "one 1024-token session plus a second short-query session",
  before,
  afterFirst,
  afterSecond,
  firstTokens: firstResult.tokenCount,
  secondTokens: secondResult.tokenCount,
  dimensions: [firstResult.vector.length, secondResult.vector.length],
  passed:
    firstResult.tokenCount === 1024 &&
    secondResult.tokenCount > 0 &&
    firstResult.vector.length === 1024 &&
    secondResult.vector.length === 1024 &&
    afterSecond.cgroupLimitBytes === 8 * 1024 ** 3 &&
    afterSecond.cgroupPeakBytes < afterSecond.cgroupLimitBytes,
};

await second.release();
await first.release();
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
