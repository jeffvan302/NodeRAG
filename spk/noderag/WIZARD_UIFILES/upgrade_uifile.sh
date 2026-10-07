#!/bin/sh
set -eu

: "${SYNOPKG_TEMP_LOGFILE:?DSM did not provide the wizard output file}"
package_name="${SYNOPKG_PKGNAME:-noderag}"
setup_token_file="${NODERAG_SETUP_TOKEN_FILE:-/var/packages/${package_name}/var/secrets/setup.token}"
setup_token=""
if [ -f "${setup_token_file}" ] && [ ! -L "${setup_token_file}" ]; then
  setup_token="$(tr -d '\r\n' <"${setup_token_file}")"
fi

if printf '%s' "${setup_token}" | grep -Eq '^setup_([A-Za-z0-9_-]{43}|[a-f0-9]{64})$'; then
  cat >"${SYNOPKG_TEMP_LOGFILE}" <<EOF
[
  {
    "step_title": "NodeRag setup key",
    "items": [
      {
        "desc": "NodeRag is not configured yet. <b>Copy and save this one-time setup key now.</b> Double-click the field, then press Ctrl+C to copy the complete key."
      },
      {
        "type": "textfield",
        "subitems": [
          {
            "key": "wizard_existing_setup_token",
            "desc": "Current one-time setup key",
            "defaultValue": "${setup_token}",
            "width": "620"
          }
        ]
      },
      {
        "desc": "After the upgrade, open NodeRag at <b>/noderag/</b> on your NAS address and enter this key on step 1."
      }
    ]
  }
]
EOF
else
  cat >"${SYNOPKG_TEMP_LOGFILE}" <<'EOF'
[
  {
    "step_title": "NodeRag upgrade",
    "items": [
      {
        "desc": "No setup key is currently active. If NodeRag is already configured, sign in with the administrator account you created during setup. Your package data and settings will be retained."
      }
    ]
  }
]
EOF
fi
