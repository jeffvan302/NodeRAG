import fs from "node:fs/promises";
import path from "node:path";

function mountFor(targetPath, mounts) {
  return mounts
    .filter((mount) => targetPath === mount.mountPoint || targetPath.startsWith(`${mount.mountPoint}/`))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
}

function parseMountInfo(text) {
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const [left, right] = line.split(" - ");
      const leftFields = left.split(" ");
      const rightFields = right.split(" ");
      return { mountPoint: leftFields[4].replaceAll("\\040", " "), filesystem: rightFields[0], source: rightFields[1] };
    });
}

async function writeProbe(root) {
  const resolvedRoot = await fs.realpath(root);
  const probe = path.join(resolvedRoot, `noderag-storage-probe-${process.pid}`);
  await fs.mkdir(probe, { mode: 0o700 });
  await fs.chmod(probe, 0o700);
  const stat = await fs.stat(probe);
  const filePath = path.join(probe, "probe.txt");
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile("NodeRag storage probe\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const content = await fs.readFile(filePath, "utf8");
  await fs.rm(filePath);
  await fs.rmdir(probe);
  return { root, resolvedRoot, mode: (stat.mode & 0o777).toString(8).padStart(3, "0"), contentMatches: content === "NodeRag storage probe\n" };
}

function validateRequestedPath(requestedPath, allowedRoots) {
  const resolved = path.resolve(requestedPath);
  const allowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
  return { requestedPath, resolved, allowed, reason: allowed ? null : "outside-approved-storage-roots" };
}

const mounts = parseMountInfo(await fs.readFile("/proc/self/mountinfo", "utf8"));
const bindPath = await fs.realpath("/workspace/fixtures");
const volumePath = await fs.realpath("/probe-volume");
const writableProbe = await writeProbe("/probe-volume");
const unsafe = ["/", "/etc", "/workspace"].map((requestedPath) =>
  validateRequestedPath(requestedPath, ["/probe-volume", "/tmp/noderag"]),
);
const result = {
  uid: process.getuid?.(),
  gid: process.getgid?.(),
  bindMount: { path: bindPath, ...mountFor(bindPath, mounts) },
  namedVolume: { path: volumePath, ...mountFor(volumePath, mounts), probe: writableProbe },
  unsafePaths: unsafe,
  passed:
    process.getuid?.() !== 0 &&
    writableProbe.mode === "700" &&
    writableProbe.contentMatches &&
    unsafe.every((entry) => !entry.allowed),
};
console.log(JSON.stringify(result, null, 2));
if (!result.passed) {
  process.exitCode = 1;
}
