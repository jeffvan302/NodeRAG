#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" == "1000" ]]
[[ "$(id -g)" == "1000" ]]

mkdir -p /work/outer /work/package /work/var
: "${NODERAG_SPK_INPUT:?NODERAG_SPK_INPUT is required}"
tar -xf "${NODERAG_SPK_INPUT}" -C /work/outer
tar -xzf /work/outer/package.tgz -C /work/package
export SYNOPKG_PKGDEST=/work/package
export SYNOPKG_PKGVAR=/work/var
export NODERAG_NODE_BIN
NODERAG_NODE_BIN="$(command -v node)"
export NODERAG_PORT=8787

/work/outer/scripts/postinst
[[ "$(stat -c '%a' /work/var)" == "700" ]]
[[ "$(stat -c '%a' /work/var/secrets/root.key)" == "600" ]]
[[ "$(wc -c </work/var/secrets/root.key)" == "32" ]]
secret_root_sha="$(sha256sum /work/var/secrets/root.key | awk '{print $1}')"
/work/outer/scripts/postinst
[[ "$(sha256sum /work/var/secrets/root.key | awk '{print $1}')" == "${secret_root_sha}" ]]
printf 'retain-me\n' >/work/var/data/operator-state

health_check() {
  node - <<'NODE'
const response = await fetch('http://127.0.0.1:8787/health');
const body = await response.json();
if (!response.ok || body.status !== 'ok' || body.service !== 'noderag') process.exit(1);
NODE
}

/work/outer/scripts/start-stop-status start
health_check
/work/outer/scripts/start-stop-status status
/work/outer/scripts/start-stop-status restart
health_check
/work/outer/scripts/start-stop-status stop
! /work/outer/scripts/start-stop-status status

# Reboot simulation: package data survives while the service is stopped and restarted.
/work/outer/scripts/start-stop-status start
health_check
[[ "$(cat /work/var/data/operator-state)" == "retain-me" ]]
/work/outer/scripts/preuninst
/work/outer/scripts/postuninst
[[ "$(cat /work/var/data/operator-state)" == "retain-me" ]]

# Destructive uninstall is separate, explicit, and constrained to the package data path.
NODERAG_DELETE_DATA=yes /work/outer/scripts/postuninst
[[ ! -e /work/var ]]
echo "Non-root thin-SPK lifecycle simulation passed."
