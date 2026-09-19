# Clank design pass

## Direction

Preserve Clank's dark interface and green action color, existing navigation, guide content, and component APIs. Use a common semantic color foundation, legible product typography, restrained headings, and practical mobile controls.

Design dials: variance 3/10, motion 2/10, density 5/10. These are developer tools used repeatedly; predictable navigation and readable examples take priority over decorative effects. The frontend design skill informs the docs landing page; product-specific references inform the dashboard and Studio.

## Mobbin references

- [Mintlify documentation](https://mobbin.com/screens/731c0653-266e-4c03-aae6-df4d07631ebd): sidebar hierarchy, readable article proportions, contextual component previews.
- [Vercel dashboard](https://mobbin.com/screens/71889386-ec08-4bcf-851d-3c431af4db45): compact navigation, clear project status, restrained panel hierarchy.
- [Railway deployment details](https://mobbin.com/screens/411620e7-9ff6-4062-934b-9d0d31784174): status emphasis and scannable operational information.

References were viewed through Mobbin MCP. No reference assets or source code were copied.

## Findings and changes

- Docs had an independent hardcoded palette. Its build now generates the shared Clank theme, with semantic aliases for page styles.
- Small metadata and navigation labels across the surfaces were 7–11px. They now use a readable 12–13px floor, with 16px article text even on phones.
- Oversized landing and component headings obscured useful content. Reduced heading scales and section spacing bring examples and navigation into view sooner.
- Studio's decorative mock dialog had an inert action. The overview now embeds the real dialog story with keyboard interaction.
- Studio hid component search on phones. Search now remains visible and opens the filtered navigation when used.
- Dashboard neutral fills and low-contrast metadata drifted from the theme. Shared surface and text roles, green actions, consistent focus rings, and more generous project rows align it with docs and Studio.
- All ten theme presets had their normal text and filled-control contrast checked mathematically. Failing text and action shades were adjusted while retaining each theme's hue, geometry, and token contract. A regression test enforces 4.5:1 contrast for text and accent ink across the five standard surfaces and filled action states.

No dependencies, public APIs, route names, or authentication flows were changed. The design-system guide now documents the shared visual foundation.

## Accessibility corrections

Browser verification also exposed existing defects in the examples and renderer:

- Omitted reflected DOM properties could recreate attributes such as `role="false"`; attributes are now removed after resetting their properties.
- Closed selects referenced an active descendant in an unmounted popup. They now announce it only while open.
- Toggle groups exposed an unsupported orientation attribute on `role="group"`; their styling attribute and keyboard behavior are retained.
- Checkbox, radio, and switch stories used inappropriate label roles and nested native controls. The interactive roots now use valid elements, and native form projections remain hidden.
- Documentation search now presents named result links in a region, and code blocks and wide tables are keyboard focusable.

Regression tests cover reflected attributes, select presence, toggle-group semantics, and contrast.

## Validation

- Browser sweep at 1440px and 390px: Studio overview, theme laboratory, and all 39 component routes, totaling 82 rendered pages. No page overflow, browser errors, or automated accessibility violations.
- Dashboard sweep at both widths: overview, usage, activity, people, and nine project views, totaling 26 rendered pages. No page overflow, browser errors, or automated accessibility violations. This uses disposable synthetic accounts, inactive projects, and metrics; live deployment operations are not exercised.
- Long docs guide: zero automated accessibility violations at both widths after fixing keyboard access to code and tables. Search returns native links and Escape dismisses results.
- All ten themes: live selection, portal styling, dialog opening, Escape dismissal, and focus return pass; zero automated accessibility violations in the final theme interaction sweep.
- Manual interaction checks: mobile component search opens filtered navigation and closes on selection; selection updates its value; form submission displays the submitted email and role; menu opens and supports its checkbox; viewport, grid, and usage controls update the preview.
- Both sites: build, doctor (7/7 each), and offline deployment checks pass. Nothing was uploaded.
- `npm run check` passes on Node 24.21.0: all 860 tests, coverage thresholds, framework/docs/Studio/Synth builds, documentation audit, packaged-release conformance, and security audit. `git diff --check` also passes.

Automated accessibility results are a regression check, not a substitute for assistive-technology testing. Screenshot and raw browser evidence for this local run live in `/tmp/clank-design-audit`.
