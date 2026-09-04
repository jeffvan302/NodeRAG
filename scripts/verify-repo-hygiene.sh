#!/usr/bin/env bash
set -euo pipefail

if git ls-files -z '*.sh' '*.mjs' '*.ts' '*.tsx' '*.json' '*.yaml' '*.yml' 'INFO' | \
  xargs -0 grep -Il $'\r' | grep -q .; then
  echo "A Linux/runtime source contains CRLF line endings." >&2
  exit 1
fi

while IFS= read -r script; do
  mode="$(git ls-files --stage -- "${script}" | awk '{print $1}')"
  if [[ "${mode}" != "100755" ]]; then
    echo "Shell script is not tracked executable: ${script}" >&2
    exit 1
  fi
done < <(git ls-files 'scripts/*.sh' 'docker-testbed/scripts/*.sh' 'spk/noderag/scripts/*')

while IFS= read -r script; do
  shebang="$(head -n 1 "${script}")"
  if [[ "${shebang}" == '#!/bin/sh' ]]; then
    sh -n "${script}"
  else
    bash -n "${script}"
  fi
done < <(git ls-files 'scripts/*.sh' 'docker-testbed/scripts/*.sh' 'spk/noderag/scripts/*')

if git ls-files | grep -E '(^|/)(node_modules|dist|coverage|artifacts|runtime-data|models)/' | \
  grep -Ev '/\.gitkeep$' | grep -q .; then
  echo "Generated runtime/build content is tracked." >&2
  exit 1
fi
echo "Line-ending, executable-mode, shell-syntax, and generated-content checks passed."
