import fs from "node:fs/promises";
import path from "node:path";

const root = process.env.NODERAG_M01_CONTRACT_ROOT ?? "/opt/noderag/m01/contracts";
const adapter = JSON.parse(await fs.readFile(path.join(root, "dsm-adapter-contract.json"), "utf8"));
const privilege = JSON.parse(await fs.readFile(path.join(root, "privilege.fixture.json"), "utf8"));
const resource = JSON.parse(await fs.readFile(path.join(root, "resource.fixture.json"), "utf8"));
const serviceConfig = await fs.readFile(path.join(root, "NodeRag.sc"), "utf8");

const requiredMethods = new Set([
  "packageIdentity",
  "targetPath",
  "dataPath",
  "configPath",
  "homePath",
  "resolveGrantedShare",
  "validateStoragePath",
  "checkPortConflict",
  "serviceAction",
  "serviceStatus",
]);
const requiredLifecycle = new Set([
  "preinst",
  "postinst",
  "preupgrade",
  "postupgrade",
  "preuninst",
  "postuninst",
  "prestart",
  "start",
  "status",
  "prestop",
  "stop",
]);
const errors = [];

if (privilege.defaults?.["run-as"] !== "package") {
  errors.push("conf/privilege must set defaults.run-as to package");
}
if (JSON.stringify(privilege).includes('"run-as":"root"')) {
  errors.push("root lifecycle identity is forbidden");
}
for (const method of requiredMethods) {
  if (!adapter.requiredAdapterMethods.includes(method)) {
    errors.push(`missing DSM adapter method: ${method}`);
  }
}
for (const action of requiredLifecycle) {
  if (!adapter.lifecycleActions.includes(action)) {
    errors.push(`missing DSM lifecycle action: ${action}`);
  }
}
const shares = resource["data-share"]?.shares ?? [];
if (!shares.some((share) => share.name === adapter.defaultShare && share.permission?.rw?.includes(adapter.package))) {
  errors.push("default data share does not grant the package identity read/write access");
}
if (resource["port-config"]?.["protocol-file"] !== "port_conf/NodeRag.sc") {
  errors.push("resource port-config does not point to NodeRag.sc");
}
if (!/^\[noderag\]$/m.test(serviceConfig) || !/^dst\.ports="8787\/tcp"$/m.test(serviceConfig)) {
  errors.push("NodeRag.sc does not register TCP port 8787");
}
if (!resource.webservice?.services?.some((service) => service.service === "noderag" && service.type === "reverse_proxy")) {
  errors.push("DSM webservice reverse-proxy contract is absent");
}
if (adapter.statusCodes.running !== 0 || adapter.statusCodes.stopped !== 3 || adapter.statusCodes.broken !== 150) {
  errors.push("DSM status-code contract is incomplete");
}

const result = {
  package: adapter.package,
  runAs: privilege.defaults?.["run-as"],
  adapterMethods: adapter.requiredAdapterMethods.length,
  lifecycleActions: adapter.lifecycleActions.length,
  defaultShare: adapter.defaultShare,
  defaultPort: adapter.defaultPort,
  webIntegration: "reverse_proxy",
  errors,
  passed: errors.length === 0,
};
console.log(JSON.stringify(result, null, 2));
if (!result.passed) {
  process.exitCode = 1;
}
