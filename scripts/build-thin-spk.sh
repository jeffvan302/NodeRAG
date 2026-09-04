#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/.." && pwd)"
package_source="${repository_root}/spk/noderag"
work_root="${repository_root}/spk/work/m02"
outer_root="${work_root}/outer"
payload_root="${work_root}/payload"
artifact_root="${repository_root}/spk/artifacts"
artifact="${artifact_root}/noderag-0.2.0-1-x86_64.spk"

case "${work_root}" in
  "${repository_root}/spk/work/"*) ;;
  *) echo "Refusing to replace an unexpected package work path." >&2; exit 65 ;;
esac

rm -rf -- "${work_root}"
mkdir -p -- "${outer_root}/scripts" "${outer_root}/conf/port_conf" "${outer_root}/WIZARD_UIFILES" \
  "${outer_root}/ui/images" "${payload_root}/bin" "${payload_root}/platform" "${artifact_root}"

cp -- "${package_source}/INFO" "${outer_root}/INFO"
cp -- "${package_source}/conf/privilege" "${outer_root}/conf/privilege"
cp -- "${package_source}/conf/resource" "${outer_root}/conf/resource"
cp -- "${package_source}/conf/port_conf/NodeRag.sc" "${outer_root}/conf/port_conf/NodeRag.sc"
cp -- "${package_source}/WIZARD_UIFILES/install_uifile" "${outer_root}/WIZARD_UIFILES/install_uifile"
cp -- "${package_source}/ui/config" "${outer_root}/ui/config"
cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_72.PNG" "${outer_root}/PACKAGE_ICON.PNG"
cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_256.PNG" "${outer_root}/PACKAGE_ICON_256.PNG"
cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_72.PNG" "${outer_root}/ui/images/icon_72.png"
cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_256.PNG" "${outer_root}/ui/images/icon_256.png"
cp -- "${package_source}/scripts/"* "${outer_root}/scripts/"
chmod 755 -- "${outer_root}/scripts/"*

cp -- "${repository_root}/packages/server/dist/server.cjs" "${payload_root}/bin/server.cjs"
cp -- "${repository_root}/packages/server/dist/worker.cjs" "${payload_root}/bin/worker.cjs"
cp -R -- "${repository_root}/packages/server/dist/ui" "${payload_root}/ui"
cp -R -- "${repository_root}/packages/server/migrations" "${payload_root}/migrations"
cp -- "${repository_root}/platform/migration-checksums.v1.json" "${payload_root}/platform/migration-checksums.v1.json"
cp -- "${repository_root}/platform/route-authorization.v1.json" "${payload_root}/platform/route-authorization.v1.json"
cp -- "${repository_root}/platform/openapi.m03.json" "${payload_root}/platform/openapi.m03.json"

tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -czf "${outer_root}/package.tgz" -C "${payload_root}" .
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  -cf "${artifact}" -C "${outer_root}" .

sha256sum "${artifact}" >"${artifact}.sha256"
echo "Built thin SPK: ${artifact}"
