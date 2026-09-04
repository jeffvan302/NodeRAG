#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${script_dir}/common.sh"
secret_dir="${testbed_dir}/.secrets"
secret_file="${secret_dir}/postgres_password"

docker_compose version >/dev/null

mkdir -p -- "${secret_dir}" "${testbed_dir}/artifacts" "${testbed_dir}/runtime"
chmod 700 -- "${secret_dir}"

if [[ ! -s "${secret_file}" ]]; then
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 36 | tr -d '\n' > "${secret_file}"
  else
    head -c 36 /dev/urandom | base64 | tr -d '\n' > "${secret_file}"
  fi
  printf '\n' >> "${secret_file}"
  chmod 600 -- "${secret_file}"
  echo "Created the local PostgreSQL testbed secret. Its value was not displayed."
fi

secret_mode="$(stat -c '%a' "${secret_file}")"
if [[ "${secret_mode}" != "600" ]]; then
  if command -v icacls.exe >/dev/null 2>&1 && command -v whoami.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
    windows_identity="$(whoami.exe | tr -d '\r\n')"
    secret_dir_windows="$(wslpath -w "${secret_dir}")"
    secret_file_windows="$(wslpath -w "${secret_file}")"
    icacls.exe "${secret_dir_windows}" /inheritance:r /grant:r "${windows_identity}:(OI)(CI)(F)" >/dev/null
    icacls.exe "${secret_file_windows}" /inheritance:r /grant:r "${windows_identity}:(F)" >/dev/null
    echo "Secured the local secret with a user-only Windows ACL (WSL mount does not preserve mode 0600)."
  else
    echo "The local PostgreSQL secret is not mode 0600 and no supported Windows ACL fallback is available." >&2
    exit 1
  fi
fi

docker_compose config --quiet
echo "NodeRag Docker testbed configuration is ready (${docker_transport})."
