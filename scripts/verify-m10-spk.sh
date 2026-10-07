#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/.." && pwd)"
artifact="${1:-${repository_root}/spk/artifacts/noderag-1.0.0-46-x86_64.spk}"
verify_root="$(mktemp -d "${TMPDIR:-/tmp}/noderag-spk-m10-verify.XXXXXX")"
trap 'rm -rf -- "${verify_root}"' EXIT
[[ -f "${artifact}" ]] || { echo "M10 SPK candidate not found." >&2; exit 66; }
mkdir -p -- "${verify_root}/outer" "${verify_root}/payload"

while IFS= read -r entry; do case "${entry}" in /*|../*|*/../*|*/..) exit 65;; esac; done < <(tar -tf "${artifact}")
outer_members="$(tar -tf "${artifact}")"
for member in INFO package.tgz scripts/ conf/; do
  grep -Fx "${member}" <<<"${outer_members}" >/dev/null || {
    echo "DSM root member is missing or incorrectly prefixed: ${member}" >&2
    exit 1
  }
done
tar -xf "${artifact}" -C "${verify_root}/outer"
while IFS= read -r entry; do case "${entry}" in /*|../*|*/../*|*/..) exit 65;; esac; done < <(tar -tzf "${verify_root}/outer/package.tgz")
tar -xzf "${verify_root}/outer/package.tgz" -C "${verify_root}/payload"

for member in INFO LICENSE THIRD-PARTY.md PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG \
  conf/privilege conf/resource \
  WIZARD_UIFILES/install_uifile.sh WIZARD_UIFILES/upgrade_uifile.sh \
  WIZARD_UIFILES/uninstall_uifile \
  scripts/preinst scripts/preflight scripts/postinst scripts/preuninst scripts/postuninst \
  scripts/preupgrade scripts/postupgrade scripts/service-setup scripts/start-stop-status; do
  [[ -e "${verify_root}/outer/${member}" ]] || { echo "Missing outer member: ${member}" >&2; exit 1; }
done
for member in bin/server.cjs bin/worker.cjs bin/embedder.cjs ui/index.html \
  ui/config ui/images/icon_16.png ui/images/icon_24.png ui/images/icon_32.png \
  ui/images/icon_48.png ui/images/icon_64.png ui/images/icon_72.png ui/images/icon_256.png \
  port_conf/NodeRag.sc \
  migrations/000008_package_lifecycle.sql migrations/000009_zero_downtime_rebuilds.sql \
  migrations/000010_evaluation_baselines.sql migrations/000011_recovery_hardening.sql \
  migrations/000012_vision_batching.sql migrations/000013_research_collections.sql \
  migrations/000014_pdf_layout_blocks.sql migrations/000015_pdf_hybrid_vision.sql \
  migrations/000016_vision_configuration_defaults.sql \
  migrations/000017_ingestion_log_window.sql migrations/000018_research_page_references.sql \
  migrations/000019_chat_provider_foundation.sql migrations/000020_chat_openai_oauth.sql \
  migrations/000021_chat_configuration.sql migrations/000022_chat_core.sql \
  migrations/000023_chat_research.sql migrations/000024_chat_rag.sql \
  migrations/000025_chat_web.sql migrations/000026_chat_artifacts.sql \
  migrations/000027_chat_exports.sql migrations/000028_chat_managed_context.sql \
  migrations/000029_chat_files.sql \
  platform/openapi.m10.json platform/openapi.m11.json platform/openapi.m12.json platform/openapi.m13.json \
  platform/openapi.m14.json platform/release-candidate.v1.json platform/release-freeze.v1.json \
  platform/backup-data-classification.v1.json platform/backup-manifest.v1.schema.json platform/backup-sidecar.v1.schema.json \
  platform/migration-checksums.v1.json platform/route-authorization.v1.json platform/sbom.spdx.json \
  runtime/postgresql-runtime.tar.gz runtime/postgresql-runtime.tar.gz.sha256 \
  bin/node_modules/@openai/codex/bin/codex.js \
  bin/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex \
  bin/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host \
  bin/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node \
  bin/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1 \
  bin/node_modules/onnxruntime-common/dist/cjs/backend-impl.js; do
  [[ -e "${verify_root}/payload/${member}" ]] || { echo "Missing payload member: ${member}" >&2; exit 1; }
done

# Web Station removes the configured alias before proxying to the service. The
# browser must therefore request built assets relative to `/noderag/`, not from
# the NAS root. Root-relative assets produce a successful but blank HTML page.
grep -q 'src="\./assets/' "${verify_root}/payload/ui/index.html"
grep -q 'href="\./assets/' "${verify_root}/payload/ui/index.html"
grep -q 'href="\./favicon\.svg"' "${verify_root}/payload/ui/index.html"
! grep -Eq '(src|href)="/(assets|favicon\.svg)' "${verify_root}/payload/ui/index.html"

grep -q '^arch="x86_64"$' "${verify_root}/outer/INFO"
grep -q '^os_min_ver="7\.2-' "${verify_root}/outer/INFO"
grep -q '^install_dep_packages="Node.js_v22:WebStation"$' "${verify_root}/outer/INFO"
grep -q '^version="1.0.0-46"$' "${verify_root}/outer/INFO"
grep -Fq 'description="Private local-first retrieval service. Open NodeRag at http://<ip address>/noderag/"' "${verify_root}/outer/INFO"
grep -q '^beta="yes"$' "${verify_root}/outer/INFO"
grep -q '^dsmuidir="ui"$' "${verify_root}/outer/INFO"
grep -q '^dsmappname="SYNO.SDS.NodeRag"$' "${verify_root}/outer/INFO"
expected_payload_md5="$(md5sum "${verify_root}/outer/package.tgz" | awk '{print $1}')"
grep -q "^checksum=\"${expected_payload_md5}\"$" "${verify_root}/outer/INFO"
node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value?.defaults?.["run-as"] !== "package") process.exit(1);
  if (Object.keys(value).join(",") !== "defaults") process.exit(1);
  if (/"run-as"\s*:\s*"root"|capabilities|setuid|setgid/i.test(JSON.stringify(value))) process.exit(1);
' "${verify_root}/outer/conf/privilege"
grep -q '"rw": \["noderag"\]' "${verify_root}/outer/conf/resource"
grep -q '"proxy_target": "http://127.0.0.1:8787"' "${verify_root}/outer/conf/resource"
grep -q '"name": "X-Forwarded-Host"' "${verify_root}/outer/conf/resource"
grep -q '"name": "X-Forwarded-Proto"' "${verify_root}/outer/conf/resource"
! grep -q '"proxy"[[:space:]]*:' "${verify_root}/outer/conf/resource"
grep -q 'wizard_delete_data' "${verify_root}/outer/WIZARD_UIFILES/uninstall_uifile"
grep -q "listen_addresses = ''" "${verify_root}/outer/scripts/service-setup"
grep -q 'unix_socket_permissions = 0700' "${verify_root}/outer/scripts/service-setup"
grep -q 'NODERAG_PG_DUMP' "${verify_root}/outer/scripts/service-setup"
grep -q 'NODERAG_MODEL_DOWNLOAD_HOSTS' "${verify_root}/outer/scripts/service-setup"
grep -Fq ': >"${SYNOPKG_PKGVAR}/run/embedder.required"' "${verify_root}/outer/scripts/service-setup"
! grep -R -E '(npm install|pnpm install|apt-get|apk add|yarn add)' "${verify_root}/outer/scripts"
! find "${verify_root}/payload" -type d \( -name test -o -name tests -o -name src \) -print -quit | grep -q .
find "${verify_root}/outer/scripts" -type f -print0 | xargs -0 -n1 sh -n
find "${verify_root}/outer/WIZARD_UIFILES" -type f -name '*.sh' -print0 | xargs -0 -n1 sh -n
(cd "${verify_root}/payload/runtime" && sha256sum -c postgresql-runtime.tar.gz.sha256)
runtime_members="$(tar -tzf "${verify_root}/payload/runtime/postgresql-runtime.tar.gz")"
grep -Fx './bin/postgres' <<<"${runtime_members}" >/dev/null
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "${verify_root}/outer/conf/resource"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "${verify_root}/outer/WIZARD_UIFILES/uninstall_uifile"
install_wizard_output="${verify_root}/install-wizard.json"
SYNOPKG_TEMP_LOGFILE="${install_wizard_output}" \
  "${verify_root}/outer/WIZARD_UIFILES/install_uifile.sh"
node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const field = value[0]?.items?.flatMap((item) => item.subitems ?? [])
    .find((item) => item.key === "wizard_setup_token");
  if (!/^setup_[a-f0-9]{64}$/.test(field?.defaultValue ?? "")) process.exit(1);
  if (field?.width !== "620") process.exit(1);
' "${install_wizard_output}"
upgrade_token_file="${verify_root}/upgrade-setup.token"
printf '%s\n' 'setup_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
  >"${upgrade_token_file}"
upgrade_wizard_output="${verify_root}/upgrade-wizard.json"
SYNOPKG_TEMP_LOGFILE="${upgrade_wizard_output}" NODERAG_SETUP_TOKEN_FILE="${upgrade_token_file}" \
  "${verify_root}/outer/WIZARD_UIFILES/upgrade_uifile.sh"
node -e '
  const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const field = value[0]?.items?.flatMap((item) => item.subitems ?? [])
    .find((item) => item.key === "wizard_existing_setup_token");
  if (!/^setup_[a-f0-9]{64}$/.test(field?.defaultValue ?? "")) process.exit(1);
' "${upgrade_wizard_output}"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "${verify_root}/payload/ui/config"
node -e 'Promise.all([[process.argv[1],64],[process.argv[2],256]].map(async ([path,size])=>{const m=await require("sharp")(path).metadata();if(m.width!==size||m.height!==size)throw new Error(`${path} must be ${size}x${size}`)}))' \
  "${verify_root}/outer/PACKAGE_ICON.PNG" "${verify_root}/outer/PACKAGE_ICON_256.PNG"
[[ "$(stat -c '%a' "${verify_root}/outer/INFO")" = 644 ]]
[[ "$(stat -c '%a' "${verify_root}/outer/scripts/preinst")" = 755 ]]
[[ "$(stat -c '%a' "${verify_root}/outer/WIZARD_UIFILES/install_uifile.sh")" = 755 ]]
[[ "$(stat -c '%a' "${verify_root}/outer/WIZARD_UIFILES/upgrade_uifile.sh")" = 755 ]]
[[ "$(stat -c '%a' "${verify_root}/payload/bin/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex")" = 755 ]]
[[ "$(stat -c '%a' "${verify_root}/payload/bin/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host")" = 755 ]]
if find "${verify_root}/outer" "${verify_root}/payload" -xdev -type f -perm /6000 -print -quit | grep -q .; then
  echo "SPK contains a setuid or setgid file." >&2
  exit 1
fi
bash "${script_dir}/simulate-m10-spk.sh" "${artifact}"
echo "M10 production SPK archive, runtime, metadata, and lifecycle passed."
