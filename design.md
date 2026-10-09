# Crosswake design system

Calm research software for traders investigating BTC transmission and researchers inspecting evidence. Primary action: inspect the evidence. The landing page explains the hypothesis; the workspace exposes the observations and their limitations.

## Structure

- Marketing: Split Studio, explanation paired with a clearly labelled illustrative transmission diagram; method sequence, evidence statement, FAQ, and a statement footer. Edge-aligned navigation.
- Workspace: Index-First research desk, compact persistent navigation, six distinct evidence views, metric strip, records and an evidence inspector. Inline command-search pill. Preserve Overview, Signals, Experiments and Context and every evidence action, alongside Trade signals and Strategy lab.
- Theme: the existing blue identity on warmer pale surfaces, ink typography, restrained accent usage. All pages share tokens, brand mark, control shapes and typography.

## Tokens and typography

Canonical tokens live in `packages/ui/tokens.css`. Existing Tailwind/shadcn semantic names map to those tokens in each app. Display: Space Grotesk, 500–700; body: Inter, 400–600; records/code: JetBrains Mono, 400–500. All headings are upright; no gradient text. Controls use at least 44px touch targets, visible focus, and single-line labels. Text and data must remain readable at 320px.

Pale paper, white-tinted raised surfaces, dark ink, blue focus and active indicators. Green, amber and red are semantic states, always accompanied by text or an icon. Use the shared spacing scale and subtle single-layer shadows. No decorative glass effects, fake application chrome, fabricated prices, win rates or testimonials.

## Libraries

Watermelon UI supplies source-owned card, button, accordion, badge, table, select and dialog primitives/blocks. Cult UI supplies source-owned rolling numbers and minimal surfaces, plus restrained animated transitions. Registry source URLs and adaptations are recorded in `docs/ui-redesign.md`. Both are shadcn-compatible source libraries, rather than runtime services.

## Behavior

Page content is visible without a reveal animation. Use only press feedback, brief view crossfades, and value changes. Honor reduced motion in both CSS and Motion. Keep evidence reads and explicitly submitted fill reports; unknown metrics show an em dash, empty samples never show a made-up performance result. Refresh preserves the last successful evidence during failures. Render unknown, empty, loading, populated and failure states deliberately.

## Responsive and accessibility

Verify 320/375/414/768/1440px widths. Root overflow uses clip. Sidebar becomes a six-item mobile navigation grid; record tables become compact decision cards on phones. Dialogs fit within the viewport, support Escape and restore focus. Search supports arrow keys and Enter. Use semantic headings, labelled filters, live refresh feedback and keyboard-visible focus.

## Review

Every frontend in this repo means `apps/landing` and `apps/dashboard`, including all six workspace views, search, evidence dialogs, empty/error/loading states, and framework error/loading/not-found screens. Command-line programs are outside this visual redesign.

## Public website variant — October 2026

The landing app uses an atmospheric Midnight variant: graphite surfaces, amber accents, Space Grotesk display and Inter body. Marketing uses a Marquee Hero with a market-field illustration, floating navigation and masthead footer. Docs use a persistent topic index and long-form articles. Landing-specific tokens live in `apps/landing/tokens.css`; the dashboard retains the shared research theme. Scroll reveals progressively enhance visible HTML; ambient transforms and opacity honor reduced motion. Public copy reflects daily trend research, all paper only, including inconclusive and failed results. No repository links or local workspace URLs are exposed.

### Kinetic landing revision
The public landing now uses a screenshot-led Feature Stack: asymmetric typography, an animated projected particle torus, a scroll-tilted product capture, and a pinned three-stage walkthrough. Slate-black and orange replace brown/amber on marketing only. Motion is intentionally visible, with a pause control and reduced-motion fallbacks. Actual local product captures are labelled with their data limitations; never fabricate populated records. Docs keep their reading layout.
