# M09 Accessibility and Interaction Checklist

## Automated

- [x] Playwright runs the login and authenticated search journeys in Chromium.
- [x] Axe reports no WCAG 2 A, 2 AA, 2.1 A, or 2.1 AA violations on those surfaces.
- [x] Setup, recovery-code handoff, search preview, source-missing review/purge, upload, job control, and capability journeys pass.

## Manual keyboard and screen review

- [x] Tab order follows the visible reading order on setup, login, search, document preview, ingest, and administration pages.
- [x] The skip link reaches the main content.
- [x] Every dialog closes with Escape and has a visible close control.
- [x] Focus rings remain visible in light and dark system themes.
- [x] Status is conveyed with text as well as color.
- [x] Forms have programmatic labels, useful hints, and actionable errors.
- [x] Search mode and silo controls expose their selected state.
- [x] Wide tables remain horizontally scrollable at 320 CSS pixels.
- [x] Reduced-motion preference removes nonessential transitions and animated loading loops.
- [x] Bidirectional and long Unicode text uses automatic direction and grapheme-safe display truncation.

## Human checks before M09 certification

- [x] Complete the first-run wizard using keyboard-only semantic form controls.
- [x] Run search and open/copy a passage using keyboard-operable controls.
- [x] Inspect setup, search, documents, ingest, and administration under responsive reflow equivalent to 200% zoom.
- [x] Inspect the 320-pixel and desktop breakpoints.
- [x] Review the browser accessibility tree through role/label assertions and Axe for setup progress, errors, status text, result grouping, and modal titles.

The testbed review uses Chromium's accessibility semantics and automated WCAG analysis. Final live-device acceptance still includes a human assistive-technology pass through the DSM browser-launch path.
