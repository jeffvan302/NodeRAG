#!/bin/sh
set -eu

: "${SYNOPKG_TEMP_LOGFILE:?DSM did not provide the wizard output file}"
setup_token="setup_$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"

cat >"${SYNOPKG_TEMP_LOGFILE}" <<EOF
[
  {
    "step_title": "NodeRag setup key",
    "invalid_next_disabled_v2": true,
    "items": [
      {
        "desc": "<b>Copy and save this one-time setup key now.</b> You will enter it on step 1 of the NodeRag website. It expires 24 hours after NodeRag first starts and is removed after setup is complete. Double-click the field, then press Ctrl+C to copy the complete key."
      },
      {
        "type": "textfield",
        "subitems": [
          {
            "key": "wizard_setup_token",
            "desc": "One-time setup key",
            "defaultValue": "${setup_token}",
            "width": "620",
            "validator": {
              "allowBlank": false,
              "regex": {
                "expr": "/^setup_[a-f0-9]{64}$/",
                "errorText": "Keep the complete setup key exactly as generated."
              }
            }
          }
        ]
      },
      {
        "desc": "After installation, open NodeRag at <b>/noderag/</b> on your NAS address. The package runs as the dedicated non-root noderag identity and keeps its database private."
      }
    ]
  }
]
EOF
