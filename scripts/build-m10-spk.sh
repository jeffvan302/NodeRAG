#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/.." && pwd)"
package_source="${repository_root}/spk/noderag"
runtime_root="${repository_root}/spk/generated/m10"
work_root="${repository_root}/spk/work/m10"
outer_root="${work_root}/outer"
payload_root="${work_root}/payload"
artifact_root="${repository_root}/spk/artifacts"
artifact="${artifact_root}/noderag-0.2.0-1-x86_64-production.spk"

[[ -f "${runtime_root}/postgresql-runtime.tar.gz" ]] || {
  echo "M10 PostgreSQL runtime is missing; run pnpm package:runtime first." >&2
  exit 66
}
case "${work_root}" in "${repository_root}/spk/work/"*) ;; *) exit 65;; esac
rm -rf -- "${work_root}"
mkdir -p -- "${outer_root}/scripts" "${outer_root}/conf/port_conf" \
  "${outer_root}/WIZARD_UIFILES" "${outer_root}/ui/images" "${payload_root}/bin" \
  "${payload_root}/platform" "${payload_root}/runtime" "${artifact_root}"

cp -- "${package_source}/INFO" "${outer_root}/INFO"
cp -- "${package_source}/conf/privilege" "${outer_root}/conf/privilege"
cp -- "${package_source}/conf/resource" "${outer_root}/conf/resource"
cp -- "${package_source}/conf/port_conf/NodeRag.sc" "${outer_root}/conf/port_conf/NodeRag.sc"
cp -- "${package_source}/WIZARD_UIFILES/"* "${outer_root}/WIZARD_UIFILES/"
cp -- "${package_source}/ui/config" "${outer_root}/ui/config"
cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_72.PNG" "${outer_root}/PACKAGE_ICON.PNG"
cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_256.PNG" "${outer_root}/PACKAGE_ICON_256.PNG"
cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_72.PNG" "${outer_root}/ui/images/icon_72.png"
cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_256.PNG" "${outer_root}/ui/images/icon_256.png"
cp -- "${package_source}/scripts/"* "${outer_root}/scripts/"
cp -- "${repository_root}/LICENSE" "${outer_root}/LICENSE"
cp -- "${repository_root}/THIRD-PARTY.md" "${outer_root}/THIRD-PARTY.md"
chmod 755 -- "${outer_root}/scripts/"*

cp -- "${repository_root}/packages/server/dist/server.cjs" "${payload_root}/bin/server.cjs"
cp -- "${repository_root}/packages/server/dist/worker.cjs" "${payload_root}/bin/worker.cjs"
cp -- "${repository_root}/packages/server/dist/embedder.cjs" "${payload_root}/bin/embedder.cjs"
cp -R -- "${repository_root}/packages/server/dist/vendor" "${payload_root}/bin/vendor"
cp -R -- "${repository_root}/packages/server/dist/node_modules" "${payload_root}/bin/node_modules"
cp -R -- "${repository_root}/packages/server/dist/ui" "${payload_root}/ui"
cp -R -- "${repository_root}/packages/server/migrations" "${payload_root}/migrations"
cp -- "${repository_root}/platform/migration-checksums.v1.json" "${payload_root}/platform/"
cp -- "${repository_root}/platform/route-authorization.v1.json" "${payload_root}/platform/"
cp -- "${repository_root}/platform/openapi.m"*.json "${payload_root}/platform/"
cp -- "${runtime_root}/postgresql-runtime.tar.gz" "${payload_root}/runtime/"
cp -- "${runtime_root}/postgresql-runtime.tar.gz.sha256" "${payload_root}/runtime/"
cp -- "${runtime_root}/postgresql-runtime.txt" "${payload_root}/runtime/"

tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -czf "${outer_root}/package.tgz" -C "${payload_root}" .
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -cf "${artifact}" -C "${outer_root}" .
sha256sum "${artifact}" >"${artifact}.sha256"
echo "Built M10 production SPK candidate: ${artifact}"
