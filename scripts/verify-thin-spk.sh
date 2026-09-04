#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_dir}/.." && pwd)"
artifact="${repository_root}/spk/artifacts/noderag-0.2.0-1-x86_64.spk"
verify_root="${repository_root}/spk/work/m02-verify"

[[ -f "${artifact}" ]] || {
  echo "Thin SPK not found; run pnpm package:thin first." >&2
  exit 66
}
bash "${script_dir}/verify-spksrc-vendor.sh"
case "${verify_root}" in
  "${repository_root}/spk/work/"*) ;;
  *) echo "Refusing to replace an unexpected package verification path." >&2; exit 65 ;;
esac
rm -rf -- "${verify_root}"
mkdir -p -- "${verify_root}/outer" "${verify_root}/payload"

while IFS= read -r entry; do
  case "${entry}" in
    /*|../*|*/../*|*/..) echo "Unsafe outer archive path: ${entry}" >&2; exit 65 ;;
  esac
done < <(tar -tf "${artifact}")
tar -xf "${artifact}" -C "${verify_root}/outer"
tar -tzf "${verify_root}/outer/package.tgz" | while IFS= read -r entry; do
  case "${entry}" in
    /*|../*|*/../*|*/..) echo "Unsafe payload archive path: ${entry}" >&2; exit 65 ;;
  esac
done
tar -xzf "${verify_root}/outer/package.tgz" -C "${verify_root}/payload"

for required in INFO PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG package.tgz conf/privilege conf/resource \
  conf/port_conf/NodeRag.sc scripts/service-setup scripts/start-stop-status scripts/postinst \
  WIZARD_UIFILES/install_uifile ui/config; do
  [[ -e "${verify_root}/outer/${required}" ]] || { echo "Missing SPK member: ${required}" >&2; exit 1; }
done
for required in bin/server.cjs bin/worker.cjs ui/index.html migrations/000001_foundation.sql \
  platform/migration-checksums.v1.json; do
  [[ -e "${verify_root}/payload/${required}" ]] || { echo "Missing payload member: ${required}" >&2; exit 1; }
done

grep -q '^package="noderag"$' "${verify_root}/outer/INFO"
grep -q '^arch="x86_64"$' "${verify_root}/outer/INFO"
grep -q '^install_dep_packages="Node.js_v22"$' "${verify_root}/outer/INFO"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${verify_root}/outer/conf/privilege"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${verify_root}/outer/conf/resource"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${verify_root}/outer/WIZARD_UIFILES/install_uifile"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${verify_root}/outer/ui/config"
grep -q '"run-as": "package"' "${verify_root}/outer/conf/privilege"
grep -q '127.0.0.1:8787' "${verify_root}/outer/conf/resource"

find "${verify_root}/outer/scripts" -type f -print0 | xargs -0 -n1 sh -n
bash "${script_dir}/simulate-thin-spk.sh" "${artifact}"
echo "Thin SPK archive, metadata, resources, payload, and lifecycle passed."
