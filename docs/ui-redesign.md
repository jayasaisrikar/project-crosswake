# Crosswake UI redesign

Implemented 8 October 2026. The user selected a calm research product: readable evidence, precise status language, and inspection as the primary action.

## Scope

- Landing: navigation, split introduction, labelled transmission illustration, method, evidence index, FAQ, footer.
- Workspace: Overview, Signals ledger, Experiments, Context, Trade signals, Strategy lab.
- Search palette, record inspector, fill-report form, empty and unavailable states, refresh feedback, and framework loading/error/not-found pages.
- Shared tokens: `packages/ui/tokens.css`; design decisions: root `design.md`.

The residual delivery and validation screens appeared during the redesign in the shared working tree. They are integrated into the workspace navigation and receive the same typography, cards, controls, and responsive styling. Their backend work remains separate from this redesign.

## Library provenance

[Watermelon UI](https://ui.watermelon.sh/cli) is a source registry, not a required runtime dependency. The repository's existing Watermelon/shadcn-compatible card, button, badge, accordion, select, table, input, skeleton and Radix dialog sources are retained and restyled through shared semantic tokens. Demo sign-in blocks are not used as product authentication. The documented `registry.watermelon.sh` endpoint returned HTTP 403 during this task; an official `ui.watermelon.sh/r/card-1.json` response was available for inspection. Existing vendored source avoided a network dependency during builds.

[Cult UI](https://www.cult-ui.com/docs/installation) also distributes source-owned components. Existing Cult `MinimalCard`, `RollingNumber`, and `CodeBlock` implementations are used in the workspace; MinimalCard and RollingNumber are also used on the landing page. RollingNumber now jumps directly to its value when reduced motion is requested. MinimalCard surfaces follow Crosswake tokens. Motion's shared reduced-motion policy covers view transitions. Both apps' registry configuration records the official Watermelon and Cult endpoints.

No invented prices, performance metrics, or testimonials are part of the product. The landing diagram is explicitly illustrative. Test records existed only inside browser request interception.

## Validation

- Both Next.js production builds pass, including their TypeScript checks.
- Separate dashboard and landing TypeScript checks pass.
- Browser flows: collection inspector; signal filtering and its empty result; record expansion; protocol/experiment inspection; selected experiment metrics; context snapshot; search with arrows/Enter; Escape dismissal; stale-snapshot warning after failed refresh; missing-page routes.
- Delivery flows: active signal display; invalid fill rejection; successful fill submission against an intercepted test endpoint; strategy results and their evidence inspector.
- Responsive checks: all six workspace views and landing at 320, 375, 414, 768 and 1440 CSS pixels. No document overflow. Populated delivery and strategy tables were also checked at all five widths; wide tables scroll inside their containers.
- Additional state checks: delayed loading, stale context, no search matches, JSON clipboard copy, keyboard shortcut, focus restoration, and framework error-boundary recovery after an intentionally malformed fixture. All passed.
- Landing FAQ expanded and collapsed at all five widths. Reduced-motion landing reload verified. Mobile and desktop screenshots reviewed for landing, overview and signal delivery.

The local research API was unavailable during the initial real-service check. The UI correctly showed an unavailable state. Populated, empty, stale and submission behavior were verified with browser fixtures; these checks do not establish trading performance or live delivery success.

## Running the apps

Use the existing root dashboard command and the landing package's dev command. Landing defaults its workspace link to `http://127.0.0.1:3000`; set `NEXT_PUBLIC_WORKSPACE_URL` at build time for another deployment.
