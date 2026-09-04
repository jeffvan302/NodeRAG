#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
testbed_dir="$(cd -- "${script_dir}/.." && pwd)"
repository_root="$(cd -- "${testbed_dir}/.." && pwd)"
source "${script_dir}/common.sh"

spksrc_commit="1f638f9f331d881b2fd5cb45bb24071e9f723400"
spksrc_image="ghcr.io/synocommunity/spksrc@sha256:31b66390e2357d5ab0be8c2e521dbc658a44afdfd50eb2e10346e5539f4e9811"
spksrc_volume="${NODERAG_M10_SPKSRC_VOLUME:-noderag-m01-spksrc-1f638f9f}"
output_dir="${repository_root}/spk/generated/m10"
output_mount="${output_dir}"
if [[ "${docker_transport}" == "windows-cli-interop" ]]; then
  output_mount="$(wslpath -w "${output_dir}")"
fi

mkdir -p -- "${output_dir}"
case "${output_dir}" in
  "${repository_root}/spk/generated/m10") ;;
  *) echo "Refusing to replace an unexpected PostgreSQL runtime output path." >&2; exit 65 ;;
esac
"${docker_command[@]}" volume inspect "${spksrc_volume}" >/dev/null 2>&1 ||
  "${docker_command[@]}" volume create "${spksrc_volume}" >/dev/null

"${docker_command[@]}" run --rm --platform linux/amd64 \
  --mount "type=volume,source=${spksrc_volume},target=/spksrc" \
  --mount "type=bind,source=${output_mount},target=/output" \
  --workdir /spksrc \
  -e "SPKSRC_COMMIT=${spksrc_commit}" \
  -e "SPKSRC_IMAGE=${spksrc_image}" \
  "${spksrc_image}" bash -lc '
    set -euo pipefail
    if [[ ! -d .git ]]; then
      git clone --filter=blob:none https://github.com/SynoCommunity/spksrc.git .
      git checkout --detach "${SPKSRC_COMMIT}"
    fi
    [[ "$(git rev-parse HEAD)" == "${SPKSRC_COMMIT}" ]]
    [[ -f local.mk ]] || make setup
    pg_root="cross/postgresql/work-x64-7.2/install/usr/local/postgresql"
    vector_root="cross/pgvector/work-x64-7.2/install/usr/local/pgvector"
    if [[ ! -x "${pg_root}/bin/postgres" ]]; then
      make -C cross/postgresql ARCH=x64 TCVERSION=7.2
    fi
    if [[ ! -f "${vector_root}/lib/vector.so" ]]; then
      make -C cross/pgvector ARCH=x64 TCVERSION=7.2
    fi

    stage=/tmp/noderag-postgresql-runtime
    rm -rf -- "${stage}"
    mkdir -p -- "${stage}"
    cp -a -- "${pg_root}/." "${stage}/"
    mkdir -p -- "${stage}/share/extension"
    cp -- "${vector_root}/lib/vector.so" "${stage}/lib/vector.so"
    cp -- "${vector_root}/share/extension/"vector* "${stage}/share/extension/"
    rm -rf -- "${stage}/include" "${stage}/share/doc" "${stage}/share/man" \
      "${stage}/share/aclocal" "${stage}/share/terminfo" "${stage}/lib/pkgconfig"
    find "${stage}/lib" -type f \( -name "*.a" -o -name "*.la" \) -delete
    find "${stage}" -type d -empty -delete

    postgres_version="$(LD_LIBRARY_PATH="${stage}/lib" "${stage}/bin/postgres" --version | awk "{print \$3}")"
    vector_version="$(sed -n "s/^default_version = '\''\([^'\'']*\)'\''/\1/p" "${stage}/share/extension/vector.control")"
    {
      printf "spksrc_commit=%s\n" "${SPKSRC_COMMIT}"
      printf "builder_image=%s\n" "${SPKSRC_IMAGE}"
      printf "architecture=x86_64\n"
      printf "toolchain=dsm-7.2-x64\n"
      printf "postgresql=%s\n" "${postgres_version}"
      printf "pgvector=%s\n" "${vector_version}"
    } >"${stage}/NODERAG-RUNTIME"
    (
      cd "${stage}"
      find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
    )
    tar --sort=name --mtime="@0" --owner=0 --group=0 --numeric-owner \
      -cf - -C "${stage}" . | gzip -n -9 > /output/postgresql-runtime.tar.gz
    (cd /output && sha256sum postgresql-runtime.tar.gz > postgresql-runtime.tar.gz.sha256)
    cp -- "${stage}/NODERAG-RUNTIME" /output/postgresql-runtime.txt
  '

test -f "${output_dir}/postgresql-runtime.tar.gz"
test -f "${output_dir}/postgresql-runtime.tar.gz.sha256"
grep -q '^postgresql=17\.11$' "${output_dir}/postgresql-runtime.txt"
grep -q '^pgvector=0\.8\.6$' "${output_dir}/postgresql-runtime.txt"
echo "Prepared pinned DSM x64 PostgreSQL/pgvector runtime archive in ${output_dir}."
