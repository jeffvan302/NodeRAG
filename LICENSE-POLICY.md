# Dependency and Redistribution License Policy

Runtime dependencies redistributed in the NodeRag package must have an approved
permissive license. The current allowlist is MIT, Apache-2.0, ISC, BSD-2-Clause,
BSD-3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, Python-2.0, PostgreSQL, and the
Unlicense public-domain dedication. OFL-1.1 is allowed for redistributed font
software when its complete copyright notice and license accompany the package.
PSF-2.0 is allowed when its attribution, change-summary, and license conditions
are preserved.

GPL, AGPL, SSPL, source-available, unknown, unlicensed, or custom runtime terms
block a release until reviewed and explicitly documented. Development-only
tools are reported separately and do not automatically authorize redistribution.

Package-specific conclusions are narrow and versioned. DOMPurify 3.4.14 and
3.4.15 are redistributed under their Apache-2.0 option. Khroma 2.1.0 omits a
package metadata license field, but its bundled and upstream `license` file is
MIT; the scanner recognizes only that exact name/version decision. A new
version or any other unknown license remains release-blocking.

JSZip 3.10.1 and 3.10.2 are used under their express MIT option. Pako 1.0.11 is
used under its bundled MIT license. The exact Noto Sans 5.3.0 font assets and
argparse 3.0.2 require their complete notices to remain in the distribution.

Run `pnpm license:check` after each dependency change. Regenerate and review
`THIRD-PARTY.md` for every release candidate, including native binaries, model
licenses, and assets that do not appear in the npm lockfile.
