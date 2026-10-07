#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/.." && pwd)"
package_source="${repository_root}/spk/noderag"
runtime_root="${repository_root}/spk/generated/m10"
work_root="$(mktemp -d "${TMPDIR:-/tmp}/noderag-spk-m10.XXXXXX")"
outer_root="${work_root}/outer"
payload_root="${work_root}/payload"
artifact_root="${repository_root}/spk/artifacts"
artifact="${artifact_root}/noderag-1.0.0-45-x86_64.spk"
trap 'rm -rf -- "${work_root}"' EXIT

[[ -f "${runtime_root}/postgresql-runtime.tar.gz" ]] || {
  echo "M10 PostgreSQL runtime is missing; run pnpm package:runtime first." >&2
  exit 66
}
mkdir -p -- "${outer_root}/scripts" "${outer_root}/conf" \
  "${outer_root}/WIZARD_UIFILES" "${payload_root}/bin" \
  "${payload_root}/platform" "${payload_root}/runtime" "${artifact_root}"

cp -- "${package_source}/INFO" "${outer_root}/INFO"
cp -- "${package_source}/conf/privilege" "${outer_root}/conf/privilege"
cp -- "${package_source}/conf/resource" "${outer_root}/conf/resource"
cp -- "${package_source}/WIZARD_UIFILES/"* "${outer_root}/WIZARD_UIFILES/"
cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_64.PNG" "${outer_root}/PACKAGE_ICON.PNG"
cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_256.PNG" "${outer_root}/PACKAGE_ICON_256.PNG"
cp -- "${package_source}/scripts/"* "${outer_root}/scripts/"
cp -- "${repository_root}/LICENSE" "${outer_root}/LICENSE"
cp -- "${repository_root}/THIRD-PARTY.md" "${outer_root}/THIRD-PARTY.md"

cp -- "${repository_root}/packages/server/dist/server.cjs" "${payload_root}/bin/server.cjs"
cp -- "${repository_root}/packages/server/dist/worker.cjs" "${payload_root}/bin/worker.cjs"
cp -- "${repository_root}/packages/server/dist/embedder.cjs" "${payload_root}/bin/embedder.cjs"
cp -R -- "${repository_root}/packages/server/dist/vendor" "${payload_root}/bin/vendor"
cp -R -- "${repository_root}/packages/server/dist/node_modules" "${payload_root}/bin/node_modules"
cp -R -- "${repository_root}/packages/server/dist/ui" "${payload_root}/ui"
mkdir -p -- "${payload_root}/ui/images" "${payload_root}/port_conf"
cp -- "${package_source}/ui/config" "${payload_root}/ui/config"
for icon_size in 16 24 32 48 64 72 256; do
  cp -- "${repository_root}/spk/generated/m02/icons/PACKAGE_ICON_${icon_size}.PNG" \
    "${payload_root}/ui/images/icon_${icon_size}.png"
done
cp -- "${package_source}/conf/port_conf/NodeRag.sc" "${payload_root}/port_conf/NodeRag.sc"
cp -R -- "${repository_root}/packages/server/migrations" "${payload_root}/migrations"
cp -- "${repository_root}/platform/migration-checksums.v1.json" "${payload_root}/platform/"
cp -- "${repository_root}/platform/route-authorization.v1.json" "${payload_root}/platform/"
cp -- "${repository_root}/platform/openapi.m"*.json "${payload_root}/platform/"
cp -- "${repository_root}/platform/backup-"*.json "${payload_root}/platform/"
cp -- "${repository_root}/platform/sbom.spdx.json" "${payload_root}/platform/"
cp -- "${repository_root}/platform/release-candidate.v1.json" "${payload_root}/platform/"
cp -- "${repository_root}/platform/release-freeze.v1.json" "${payload_root}/platform/"
cp -- "${runtime_root}/postgresql-runtime.tar.gz" "${payload_root}/runtime/"
cp -- "${runtime_root}/postgresql-runtime.tar.gz.sha256" "${payload_root}/runtime/"
cp -- "${runtime_root}/postgresql-runtime.txt" "${payload_root}/runtime/"

find "${outer_root}" "${payload_root}" -type d -exec chmod 755 -- {} +
find "${outer_root}" "${payload_root}" -type f -exec chmod 644 -- {} +
chmod 755 -- "${outer_root}/scripts/"*
find "${outer_root}/WIZARD_UIFILES" -type f -name '*.sh' -exec chmod 755 -- {} +
find "${payload_root}/bin/node_modules/@openai/codex-linux-x64/vendor" -type f \
  \( -name codex -o -name codex-code-mode-host -o -path '*/codex-path/rg' \
     -o -path '*/codex-resources/bwrap' \) -exec chmod 755 -- {} +

tar --sort=name --mtime='@946684800' --owner=0 --group=0 --numeric-owner \
  -czf "${outer_root}/package.tgz" -C "${payload_root}" .
printf 'checksum="%s"\n' "$(md5sum "${outer_root}/package.tgz" | awk '{print $1}')" \
  >>"${outer_root}/INFO"
tar --sort=name --mtime='@946684800' --owner=0 --group=0 --numeric-owner \
  -cf "${artifact}" -C "${outer_root}" INFO package.tgz scripts conf WIZARD_UIFILES \
  LICENSE PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG THIRD-PARTY.md
(cd "${artifact_root}" && \
  sha256sum "$(basename -- "${artifact}")" >"$(basename -- "${artifact}").sha256")
echo "Built M10 production SPK candidate: ${artifact}"
