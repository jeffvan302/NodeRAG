#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/.." && pwd)"
artifact="${repository_root}/spk/artifacts/noderag-1.0.0-rc.1-x86_64-thin.spk"
verify_root="$(mktemp -d "${TMPDIR:-/tmp}/noderag-spk-m02-verify.XXXXXX")"
trap 'rm -rf -- "${verify_root}"' EXIT

[[ -f "${artifact}" ]] || {
  echo "Thin SPK not found; run pnpm package:thin first." >&2
  exit 66
}
bash "${script_dir}/verify-spksrc-vendor.sh"
mkdir -p -- "${verify_root}/outer" "${verify_root}/payload"

while IFS= read -r entry; do
  case "${entry}" in
    /*|../*|*/../*|*/..) echo "Unsafe outer archive path: ${entry}" >&2; exit 65 ;;
  esac
done < <(tar -tf "${artifact}")
outer_members="$(tar -tf "${artifact}")"
for member in INFO package.tgz scripts/ conf/; do
  grep -Fx "${member}" <<<"${outer_members}" >/dev/null || {
    echo "DSM root member is missing or incorrectly prefixed: ${member}" >&2
    exit 1
  }
done
tar -xf "${artifact}" -C "${verify_root}/outer"
tar -tzf "${verify_root}/outer/package.tgz" | while IFS= read -r entry; do
  case "${entry}" in
    /*|../*|*/../*|*/..) echo "Unsafe payload archive path: ${entry}" >&2; exit 65 ;;
  esac
done
tar -xzf "${verify_root}/outer/package.tgz" -C "${verify_root}/payload"

for required in INFO LICENSE THIRD-PARTY.md PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG package.tgz conf/privilege conf/resource \
  scripts/preinst scripts/service-setup scripts/start-stop-status \
  scripts/postinst scripts/preuninst scripts/postuninst scripts/preupgrade scripts/postupgrade \
  WIZARD_UIFILES/install_uifile.sh WIZARD_UIFILES/upgrade_uifile.sh \
  WIZARD_UIFILES/uninstall_uifile; do
  [[ -e "${verify_root}/outer/${required}" ]] || { echo "Missing SPK member: ${required}" >&2; exit 1; }
done
for required in bin/server.cjs bin/worker.cjs bin/embedder.cjs ui/index.html \
  ui/config ui/images/icon_16.png ui/images/icon_24.png ui/images/icon_32.png \
  ui/images/icon_48.png ui/images/icon_64.png ui/images/icon_72.png ui/images/icon_256.png \
  port_conf/NodeRag.sc \
  bin/vendor/pdf.mjs bin/vendor/pdf.worker.mjs \
  migrations/000001_foundation.sql migrations/000002_identity_foundation.sql \
  migrations/000003_markdown_slice.sql migrations/000004_durable_ingestion.sql \
  migrations/000005_vision_recovery.sql migrations/000006_retrieval_interfaces.sql \
  migrations/000007_operator_ui.sql migrations/000008_package_lifecycle.sql \
  migrations/000009_zero_downtime_rebuilds.sql migrations/000010_evaluation_baselines.sql \
  migrations/000011_recovery_hardening.sql migrations/000012_vision_batching.sql \
  migrations/000013_research_collections.sql \
  bin/node_modules/@napi-rs/canvas/index.js \
  bin/node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node \
  platform/migration-checksums.v1.json platform/sbom.spdx.json; do
  [[ -e "${verify_root}/payload/${required}" ]] || { echo "Missing payload member: ${required}" >&2; exit 1; }
done
[[ -e "${verify_root}/payload/platform/route-authorization.v1.json" ]] || {
  echo "Missing payload member: platform/route-authorization.v1.json" >&2
  exit 1
}
[[ -e "${verify_root}/payload/platform/openapi.m03.json" ]] || {
  echo "Missing payload member: platform/openapi.m03.json" >&2
  exit 1
}
[[ -e "${verify_root}/payload/platform/openapi.m04.json" ]] || {
  echo "Missing payload member: platform/openapi.m04.json" >&2
  exit 1
}
[[ -e "${verify_root}/payload/platform/openapi.m05.json" ]] || {
  echo "Missing payload member: platform/openapi.m05.json" >&2
  exit 1
}
[[ -e "${verify_root}/payload/platform/openapi.m06.json" ]] || {
  echo "Missing payload member: platform/openapi.m06.json" >&2
  exit 1
}
[[ -e "${verify_root}/payload/platform/openapi.m07.json" ]] || {
  echo "Missing payload member: platform/openapi.m07.json" >&2
  exit 1
}
[[ -e "${verify_root}/payload/platform/openapi.m09.json" ]] || {
  echo "Missing payload member: platform/openapi.m09.json" >&2
  exit 1
}
[[ -e "${verify_root}/payload/platform/openapi.m12.json" ]] || {
  echo "Missing payload member: platform/openapi.m12.json" >&2
  exit 1
}
[[ -e "${verify_root}/payload/platform/openapi.m14.json" ]] || {
  echo "Missing payload member: platform/openapi.m14.json" >&2
  exit 1
}

grep -q '^package="noderag"$' "${verify_root}/outer/INFO"
grep -q '^arch="x86_64"$' "${verify_root}/outer/INFO"
grep -q '^install_dep_packages="Node.js_v22:WebStation"$' "${verify_root}/outer/INFO"
grep -q '^dsmuidir="ui"$' "${verify_root}/outer/INFO"
grep -q '^dsmappname="SYNO.SDS.NodeRag"$' "${verify_root}/outer/INFO"
expected_payload_md5="$(md5sum "${verify_root}/outer/package.tgz" | awk '{print $1}')"
grep -q "^checksum=\"${expected_payload_md5}\"$" "${verify_root}/outer/INFO"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${verify_root}/outer/conf/privilege"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${verify_root}/outer/conf/resource"
install_wizard_output="${verify_root}/install-wizard.json"
SYNOPKG_TEMP_LOGFILE="${install_wizard_output}" \
  "${verify_root}/outer/WIZARD_UIFILES/install_uifile.sh"
node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const field = value[0]?.items?.flatMap((item) => item.subitems ?? [])
    .find((item) => item.key === "wizard_setup_token");
  if (!/^setup_[a-f0-9]{64}$/.test(field?.defaultValue ?? "")) process.exit(1);
' "${install_wizard_output}"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${verify_root}/payload/ui/config"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "${verify_root}/payload/platform/route-authorization.v1.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "${verify_root}/payload/platform/openapi.m03.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "${verify_root}/payload/platform/openapi.m04.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "${verify_root}/payload/platform/openapi.m05.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "${verify_root}/payload/platform/openapi.m06.json"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "${verify_root}/payload/platform/openapi.m07.json"
grep -F '"openapi": "3.1.1"' \
  "${verify_root}/payload/platform/openapi.m09.json"
grep -F '"openapi": "3.1.1"' \
  "${verify_root}/payload/platform/openapi.m12.json"
grep -F '"openapi": "3.1.1"' \
  "${verify_root}/payload/platform/openapi.m14.json"
for recovery_contract in \
  backup-data-classification.v1.json backup-manifest.v1.schema.json backup-sidecar.v1.schema.json \
  sbom.spdx.json; do
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
    "${verify_root}/payload/platform/${recovery_contract}"
done
grep -q '"run-as": "package"' "${verify_root}/outer/conf/privilege"
grep -q '"proxy_target": "http://127.0.0.1:8787"' "${verify_root}/outer/conf/resource"
grep -q '"name": "X-Forwarded-Host"' "${verify_root}/outer/conf/resource"
grep -q '"name": "X-Forwarded-Proto"' "${verify_root}/outer/conf/resource"
! grep -q '"proxy"[[:space:]]*:' "${verify_root}/outer/conf/resource"
node -e 'Promise.all([[process.argv[1],64],[process.argv[2],256]].map(async ([path,size])=>{const m=await require("sharp")(path).metadata();if(m.width!==size||m.height!==size)throw new Error(`${path} must be ${size}x${size}`)}))' \
  "${verify_root}/outer/PACKAGE_ICON.PNG" "${verify_root}/outer/PACKAGE_ICON_256.PNG"
[[ "$(stat -c '%a' "${verify_root}/outer/INFO")" = 644 ]]
[[ "$(stat -c '%a' "${verify_root}/outer/scripts/preinst")" = 755 ]]
[[ "$(stat -c '%a' "${verify_root}/outer/WIZARD_UIFILES/install_uifile.sh")" = 755 ]]
[[ "$(stat -c '%a' "${verify_root}/outer/WIZARD_UIFILES/upgrade_uifile.sh")" = 755 ]]

find "${verify_root}/outer/scripts" -type f -print0 | xargs -0 -n1 sh -n
find "${verify_root}/outer/WIZARD_UIFILES" -type f -name '*.sh' -print0 | xargs -0 -n1 sh -n
if ! bash "${script_dir}/simulate-thin-spk.sh" "${artifact}"; then
  echo "Thin-SPK simulator encountered a transient Docker start failure; retrying once." >&2
  bash "${script_dir}/simulate-thin-spk.sh" "${artifact}"
fi
echo "Thin SPK archive, metadata, resources, payload, and lifecycle passed."
