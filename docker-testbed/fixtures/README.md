# Testbed fixtures

Only synthetic, public-domain, or explicitly approved test files belong here.
Never copy production documents, extracted private text, model weights, database
backups, API keys, or generated vectors into this directory.

Milestone-specific fixtures should eventually be grouped under:

- `formats/` for TXT, Markdown, PDF, DOCX, and XLSX;
- `unicode/` for UTF-8, UTF-16, combining characters, astral characters, RTL,
  and malformed-input cases;
- `faults/` for truncated, corrupt, oversized, and permission-denied cases;
- `golden/` for non-private evaluation inputs and expected results.
