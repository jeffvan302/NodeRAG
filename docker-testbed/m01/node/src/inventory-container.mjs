import fs from "node:fs/promises";
import os from "node:os";

async function readOptional(filePath) {
  return fs.readFile(filePath, "utf8").then((value) => value.trim()).catch(() => null);
}

const cpuInfo = await readOptional("/proc/cpuinfo");
const firstFlags = cpuInfo
  ?.split("\n")
  .find((line) => /^flags\s*:/i.test(line))
  ?.split(":", 2)[1]
  ?.trim()
  ?.split(/\s+/);
const memoryMax = await readOptional("/sys/fs/cgroup/memory.max");
const cpuMax = await readOptional("/sys/fs/cgroup/cpu.max");
const pressure = {
  cpu: await readOptional("/proc/pressure/cpu"),
  memory: await readOptional("/proc/pressure/memory"),
  io: await readOptional("/proc/pressure/io"),
};

console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      kernel: os.release(),
      cpuModel: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      cpuFlags: firstFlags,
      avx2: firstFlags?.includes("avx2") ?? false,
      avx512: firstFlags?.some((flag) => flag.startsWith("avx512")) ?? false,
      containerMemoryBytes: memoryMax === "max" ? null : Number(memoryMax),
      cpuQuota: cpuMax,
      osTotalMemoryBytes: os.totalmem(),
      osFreeMemoryBytes: os.freemem(),
      pressure,
      passed: process.arch === "x64" && (firstFlags?.includes("avx2") ?? false),
    },
    null,
    2,
  ),
);
