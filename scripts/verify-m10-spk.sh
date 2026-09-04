#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/.." && pwd)"
artifact="${1:-${repository_root}/spk/artifacts/noderag-0.2.0-1-x86_64-production.spk}"
verify_root="${repository_root}/spk/work/m10-verify"
[[ -f "${artifact}" ]] || { echo "M10 SPK candidate not found." >&2; exit 66; }
case "${verify_root}" in "${repository_root}/spk/work/"*) ;; *) exit 65;; esac
rm -rf -- "${verify_root}"
mkdir -p -- "${verify_root}/outer" "${verify_root}/payload"

while IFS= read -r entry; do case "${entry}" in /*|../*|*/../*|*/..) exit 65;; esac; done < <(tar -tf "${artifact}")
tar -xf "${artifact}" -C "${verify_root}/outer"
while IFS= read -r entry; do case "${entry}" in /*|../*|*/../*|*/..) exit 65;; esac; done < <(tar -tzf "${verify_root}/outer/package.tgz")
tar -xzf "${verify_root}/outer/package.tgz" -C "${verify_root}/payload"

for member in INFO LICENSE THIRD-PARTY.md PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG \
  conf/privilege conf/resource conf/port_conf/NodeRag.sc ui/config \
  WIZARD_UIFILES/install_uifile WIZARD_UIFILES/uninstall_uifile \
  scripts/preflight scripts/postinst scripts/preuninst scripts/postuninst \
  scripts/preupgrade scripts/postupgrade scripts/service-setup scripts/start-stop-status; do
  [[ -e "${verify_root}/outer/${member}" ]] || { echo "Missing outer member: ${member}" >&2; exit 1; }
done
for member in bin/server.cjs bin/worker.cjs bin/embedder.cjs ui/index.html \
  migrations/000008_package_lifecycle.sql migrations/000009_zero_downtime_rebuilds.sql \
  migrations/000010_evaluation_baselines.sql migrations/000011_recovery_hardening.sql \
  platform/openapi.m10.json platform/openapi.m11.json platform/openapi.m12.json platform/openapi.m13.json \
  platform/backup-data-classification.v1.json platform/backup-manifest.v1.schema.json platform/backup-sidecar.v1.schema.json \
  platform/migration-checksums.v1.json platform/route-authorization.v1.json platform/sbom.spdx.json \
  runtime/postgresql-runtime.tar.gz runtime/postgresql-runtime.tar.gz.sha256 \
  bin/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node \
  bin/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1 \
  bin/node_modules/onnxruntime-common/dist/cjs/backend-impl.js; do
  [[ -e "${verify_root}/payload/${member}" ]] || { echo "Missing payload member: ${member}" >&2; exit 1; }
done

grep -q '^arch="x86_64"$' "${verify_root}/outer/INFO"
grep -q '^os_min_ver="7\.2-' "${verify_root}/outer/INFO"
grep -q '^install_dep_packages="Node.js_v22"$' "${verify_root}/outer/INFO"
grep -q '"run-as": "package"' "${verify_root}/outer/conf/privilege"
grep -q '"username": "sc-noderag"' "${verify_root}/outer/conf/privilege"
grep -q '127.0.0.1:8787' "${verify_root}/outer/conf/resource"
grep -q 'wizard_delete_data' "${verify_root}/outer/WIZARD_UIFILES/uninstall_uifile"
grep -q "listen_addresses = ''" "${verify_root}/outer/scripts/service-setup"
grep -q 'unix_socket_permissions = 0700' "${verify_root}/outer/scripts/service-setup"
! grep -R -E '(npm install|pnpm install|apt-get|apk add|yarn add)' "${verify_root}/outer/scripts"
! find "${verify_root}/payload" -type d \( -name test -o -name tests -o -name src \) -print -quit | grep -q .
find "${verify_root}/outer/scripts" -type f -print0 | xargs -0 -n1 sh -n
(cd "${verify_root}/payload/runtime" && sha256sum -c postgresql-runtime.tar.gz.sha256)
tar -tzf "${verify_root}/payload/runtime/postgresql-runtime.tar.gz" | grep '^\./bin/postgres$' >/dev/null
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "${verify_root}/outer/conf/resource"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "${verify_root}/outer/WIZARD_UIFILES/uninstall_uifile"
bash "${script_dir}/simulate-m10-spk.sh" "${artifact}"
echo "M10 production SPK archive, runtime, metadata, and lifecycle passed."
