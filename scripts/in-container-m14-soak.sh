#!/usr/bin/env bash
set -euo pipefail

: "${NODERAG_SPK_INPUT:?NODERAG_SPK_INPUT is required}"
: "${NODERAG_M14_ARTIFACT_SHA256:?NODERAG_M14_ARTIFACT_SHA256 is required}"
[[ "$(id -u)" == "1000" ]]
[[ "$(id -g)" == "1000" ]]
mkdir -p /work/outer /work/package /work/watch-base/watch /evidence
tar -xf "${NODERAG_SPK_INPUT}" -C /work/outer
tar -xzf /work/outer/package.tgz -C /work/package
export SYNOPKG_PKGDEST=/work/package
export SYNOPKG_PKGVAR=/volume1/NodeRag/package-var
export NODERAG_NODE_BIN
NODERAG_NODE_BIN="$(command -v node)"
export NODERAG_PORT=8787
export NODERAG_TEST_EMBEDDER=1
export NODERAG_SIMULATOR=1
export NODERAG_PREFLIGHT_MEMORY_KIB=8388608
export NODERAG_MIN_DISK_KIB=1024
export NODERAG_SOURCE_ROOTS=/work/watch-base
export NODERAG_MODEL_IMPORT_ROOTS=/volume1/NodeRag
export NODERAG_STORAGE_REBUILD_RESERVE_BYTES=0
export NODERAG_LOG_ROTATE_BYTES=65536
export NODERAG_M14_EVIDENCE_ROOT=/evidence

cleanup() {
  /work/outer/scripts/start-stop-status stop >/dev/null 2>&1 || true
}
trap cleanup EXIT
install_wizard_output=/work/install-wizard.json
SYNOPKG_TEMP_LOGFILE="${install_wizard_output}" /work/outer/WIZARD_UIFILES/install_uifile.sh
wizard_setup_token="$(node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const field = value[0]?.items?.flatMap((item) => item.subitems ?? [])
    .find((item) => item.key === "wizard_setup_token");
  if (!/^setup_[a-f0-9]{64}$/.test(field?.defaultValue ?? "")) process.exit(1);
  process.stdout.write(field.defaultValue);
' "${install_wizard_output}")"
export wizard_setup_token
/work/outer/scripts/postinst
/work/outer/scripts/start-stop-status start
node /simulator/m14-soak-driver.mjs
/work/outer/scripts/start-stop-status stop
