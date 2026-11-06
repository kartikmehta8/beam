---
name: Beam website
description: Orb’s white-and-ink website system, adapted to Beam’s Android wallet and approval flows.
colors:
  canvas: "#fff"
  ink: "#121314"
  ink-pressed: "#34373b"
  muted: "#55595f"
  faint: "#6b7077"
  surface: "#f3f4f6"
  border: "#e8eaed"
  blue: "#3d5afe"
  beam-blue: "#0080bc"
  blue-soft: "#e6eaff"
  green: "#1a7f4b"
  green-soft: "#e8f6ee"
  amber: "#9a5a0c"
  amber-soft: "#fff6e8"
  red: "#c22437"
  red-soft: "#fdedef"
  preview: "#eef0f3"
  terminal: "#17191d"
typography:
  display:
    fontFamily: "Inter, sans-serif"
    fontSize: "clamp(56px, 6.6vw, 96px)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Inter, sans-serif"
    fontSize: "clamp(36px, 4.2vw, 60px)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Inter, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  hero-body:
    fontFamily: "Inter, sans-serif"
    fontSize: "23px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.02em"
  button:
    fontFamily: "Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.3
  navigation:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 500
  mono:
    fontFamily: "Roboto Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  mark: "11px"
  field: "12px"
  button: "14px"
  panel: "16px"
  phone: "38px"
  pill: "99px"
spacing:
  inset: "16px"
  gutter: "40px"
components:
  brand-mark:
    backgroundColor: "{colors.beam-blue}"
    rounded: "{rounded.mark}"
    size: "36px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "17px 23px"
    height: "54px"
  button-primary-hover:
    backgroundColor: "{colors.ink-pressed}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "17px 23px"
    height: "54px"
  button-small:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    typography: "{typography.navigation}"
    rounded: "{rounded.field}"
    padding: "12px 18px"
    height: "44px"
  demo-frame:
    backgroundColor: "{colors.ink}"
    rounded: "{rounded.panel}"
  preview-player:
    backgroundColor: "{colors.preview}"
  preview-controls:
    backgroundColor: "{colors.terminal}"
    textColor: "{colors.canvas}"
    height: "54px"
---

# Beam website design system

## Overview

The website inherits Orb’s white canvas, ink controls, cool gray panels and roomy editorial layout. A white Beam glyph on an ENS-blue mark identifies the wallet. The product is explained through operable examples with readable controls and visible sample states.

The styles in `public/style.css`, `src/site.css`, `src/journey.css` and `src/preview.css` define the implementation. `PRODUCT.md` records product scope and `.impeccable/surfaces/home.md` records the home page direction.

## Colors

Ink leads actions and headings. Cool gray defines resting panels and dividers. Link blue provides keyboard focus and link hover, and Beam blue identifies the app mark. Pair green, amber and red washes with a written verdict and icon. Pale blue sits behind the ENS resolution scene.

## Typography

Use locally bundled Inter for interface text and Roboto Mono for technical values and templates. Semibold display and section headings have tight tracking. The masthead uses three short lines, with a muted line for contrast and separate supporting copy beside it on wider screens.

## Layout

The main shell has a 1280px maximum width, with gutters of 40px, 25px at 800px and below, and 20px at 600px and below. The masthead leads into the full-width preview, phone playground, feature explorer, safety lab, MCP terminal, walkthrough tabs, FAQ and setup footer. At narrow widths the hero and paired sections stack, and the header keeps the mark, motion control and setup action.

## Elevation & Depth

Resting panels rely on tone and fine borders. The phone, temporary review sheet and preview device use contained depth. Eligible pointer input can tilt the phone, and an eligible mobile success state can turn it once. Keyboard, paused and reduced-motion states preserve the same readable content.

## Shapes

Use 14px corners on standard buttons, 16px on panels and 12px on fields and compact actions. Reserve pills for filters and status labels. Frame the phone with its larger corner radius. Keep the Beam mark compact and rounded.

## Components

- **Actions and navigation.** Primary buttons use ink and secondary buttons use cool gray. Text links and small header actions retain 44px targets. The global keyboard ring is 3px in Link Blue. The motion control exposes its pressed state.
- **Guided preview.** The original media frame contains a four-step player with a two-column stage, a phone illustration and a dark control bar. The stage covers capture, payment review, World ID and device confirmation. Play, pause, replay, named step controls and a native transcript disclosure support exploration. Global pause stops automatic advancement and leaves step controls available. Spotlight Card follows the pointer in the guide and agent approval panel while motion is on.
- **Phone playground and agent approval.** Show sample amount, recipient, network, risk and approval status in the review. Where needed, World ID comes before a separate device confirmation. Keep cancel, reset and receipt actions available at their relevant stages. The playground uses two groups of 44px controls for sample network and amount. The summary displays the selected chain ID and approval path. Changing an input resets the example before a new review. Count Up animates the illustrative draft readout only. The screen reader and review display the final chosen amount immediately.
- **Feature explorer.** Pay, Check, ENS and World ID each have a reversible sample interaction. The World ID scene uses the inherited ink panel with a white mark tile and simulates approval. GSAP pins the explorer on motion-enabled screens at least 1000px wide and 650px high with hover and a fine pointer. Other conditions use native horizontal snapping. Arrows, named jumps and keyboard navigation remain available.
- **Android setup.** Use the inherited cool-gray action panel for the source build instructions and requirements disclosure. Numbered checkbox rows, dividers and a live count communicate progress, which stays in the current browser.

## Do's and Don'ts

- Keep Beam blue on the mark and ink on primary actions.
- Pair every approval or risk color with a clear written state.
- Preserve explicit sample labels, keyboard focus and motion controls.
- Keep World ID approval and phone confirmation distinct in previews and walkthroughs.
