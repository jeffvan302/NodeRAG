import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.getuid?.() === 0) {
  throw new Error("Lifecycle simulation must run as a non-root package identity.");
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "noderag-package-sim-"));
const target = path.join(root, "target");
const variable = path.join(root, "var");
const config = path.join(root, "etc");
const home = path.join(root, "home");
const run = path.join(root, "run");
const pidFile = path.join(run, "service.pid");

try {
  for (const directory of [target, variable, config, run]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o750 });
  }
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(variable, "retained-data.txt"), "retain on normal uninstall\n", { mode: 0o600 });
  await fs.writeFile(pidFile, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  const runningStatus = (await fs.readFile(pidFile, "utf8")).trim() === `${process.pid}` ? 0 : 4;
  await fs.rm(pidFile);
  const stoppedStatus = await fs.access(pidFile).then(() => 1).catch(() => 3);
  const retainedBeforeCleanup = await fs.readFile(path.join(variable, "retained-data.txt"), "utf8");
  const result = {
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    runningStatus,
    stoppedStatus,
    homeMode: ((await fs.stat(home)).mode & 0o777).toString(8).padStart(3, "0"),
    retainedData: retainedBeforeCleanup.trim(),
    lifecycle: ["preinst", "postinst", "prestart", "start", "status", "prestop", "stop", "preuninst", "postuninst"],
  };
  result.passed = runningStatus === 0 && stoppedStatus === 3 && result.homeMode === "700";
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) {
    process.exitCode = 1;
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
