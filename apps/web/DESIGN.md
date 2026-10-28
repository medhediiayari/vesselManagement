---
name: AMC — Plateforme maritime
description: Fleet operations platform for Africa Marine Company (vessels, crew, certificates, security, purchasing, voyages and Noon Reports), kept like a ship's logbook.
colors:
  navy: "#102B44"
  navy-950: "#0B1F33"
  navy-700: "#214B65"
  navy-600: "#2F5F7B"
  navy-100: "#DCE5EC"
  navy-50: "#EDF2F6"
  action: "#176A79"
  action-700: "#105562"
  action-100: "#D3E9EC"
  action-50: "#ECF5F6"
  teal: "#1B9AAA"
  teal-700: "#0F6E7A"
  teal-100: "#D3EEF1"
  teal-50: "#EBF7F8"
  canvas: "#F3F6F8"
  surface: "#FFFFFF"
  surface-sunken: "#F7F9FA"
  ink: "#1F2D3A"
  ink-muted: "#556677"
  ink-soft: "#687786"
  line: "#DCE3E9"
  line-strong: "#C3CED8"
  ok: "#08703F"
  ok-bg: "#E6F4EC"
  ok-line: "#A9D9BE"
  warn: "#A64B06"
  warn-bg: "#FDF1E4"
  warn-line: "#F0C590"
  danger: "#B42318"
  danger-bg: "#FCEBE9"
  danger-line: "#F1B3AC"
  info: "#1D5FB8"
  info-bg: "#EAF1FB"
  info-line: "#B5CCEE"
  neutral: "#4A5868"
  neutral-bg: "#EFF2F5"
  neutral-line: "#CFD6DE"
  on-navy-warn: "#F8C77E"
  on-navy-danger: "#FFA197"
  on-navy-ok: "#86DDB8"
typography:
  display:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: "38px"
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: "30px"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  title-sm:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "24px"
  body:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  body-sm:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  label-lg:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "22px"
  label:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "20px"
  tag:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
  column-head:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
  caption:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  overline:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: "14px"
    letterSpacing: "0.08em"
  figure:
    fontFamily: "IBM Plex Sans Variable, IBM Plex Sans, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: "32px"
    fontFeature: "tnum"
  ref:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "0.93em"
    fontWeight: 400
    letterSpacing: "-0.025em"
    fontFeature: "tnum"
rounded:
  sm: "3px"
  DEFAULT: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  full: "9999px"
spacing:
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.surface}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.action-700}"
  button-navy:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.surface}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-navy-hover:
    backgroundColor: "{colors.navy-700}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-sunken}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.navy-50}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.surface}"
    typography: "{typography.label-lg}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-danger-hover:
    backgroundColor: "#912018"
  button-sm:
    typography: "{typography.label}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  input-disabled:
    backgroundColor: "{colors.neutral-bg}"
  field-label:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
  status-tag-ok:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.ok}"
    typography: "{typography.tag}"
    rounded: "{rounded.DEFAULT}"
    padding: "1px 6px"
  status-tag-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn}"
    typography: "{typography.tag}"
    rounded: "{rounded.DEFAULT}"
    padding: "1px 6px"
  status-tag-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
    typography: "{typography.tag}"
    rounded: "{rounded.DEFAULT}"
    padding: "1px 6px"
  status-tag-info:
    backgroundColor: "{colors.info-bg}"
    textColor: "{colors.info}"
    typography: "{typography.tag}"
    rounded: "{rounded.DEFAULT}"
    padding: "1px 6px"
  status-tag-neutral:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral}"
    typography: "{typography.tag}"
    rounded: "{rounded.DEFAULT}"
    padding: "1px 6px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "16px"
  panel-header:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.navy}"
    typography: "{typography.title-sm}"
    padding: "8px 16px"
    height: "48px"
  table-head:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.column-head}"
    padding: "8px 12px"
  table-cell:
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    padding: "10px 12px"
  table-row-selected:
    backgroundColor: "{colors.action-50}"
  register-row:
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    padding: "8px 0"
  sidebar:
    backgroundColor: "{colors.navy-950}"
    textColor: "{colors.surface}"
    width: "248px"
  sidebar-item:
    textColor: "rgba(255,255,255,0.70)"
    typography: "{typography.body-sm}"
    rounded: "{rounded.DEFAULT}"
    padding: "7px 8px"
  sidebar-item-active:
    backgroundColor: "rgba(255,255,255,0.09)"
    textColor: "{colors.surface}"
  topbar:
    backgroundColor: "{colors.surface}"
    height: "56px"
    padding: "0 24px"
  tab:
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    padding: "8px 12px"
  tab-active:
    textColor: "{colors.navy}"
  dialog:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    width: "576px"
  dialog-footer:
    backgroundColor: "{colors.surface-sunken}"
    padding: "12px 20px"
  dashboard-hero:
    backgroundColor: "#081828"
    textColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "24px 20px 20px"
---

# Design System: AMC — Plateforme maritime

## Overview

**Creative North Star: "The Logbook" (Le Livre de bord)**

AMC reads like a well-kept ship's logbook: every page ruled, every entry dated, every reference copied exactly, nothing written for effect. It is an operations tool used ashore and on board by masters, chief engineers, superintendents, the CSO and purchasing staff. The interface exists so that a reader can answer, at a glance, *which vessel, which document, which deadline, who acts next*. Its tone is factual, ruled and unhurried. Older code comments call the direction « Passerelle » (the bridge); the vocabulary is compatible. The bridge is where the logbook is kept, which is why the top bar carries a UTC and ship's-time watch clock and the dashboard opens on a view from the bridge at dusk.

Density is deliberate. Tables run compact (13px text, 10px row padding) because comparison across rows is the work. Forms and dialogs breathe more because entry errors are costly. Surfaces are flat white sheets on a pale canvas, outlined by a 1px hairline rather than lifted by shadow. Structure comes from rules: the ruled bottom border under every page header, ruled table rows, the 2px left rule of an instrument reading, the 3px top rule of a dialog. Business references (IMO numbers, PR/BC numbers, voyages, certificates) are set in IBM Plex Mono as they appear on ship's papers. The UI is entirely in French and keeps the trade acronyms (PR, RFQ, BC, BL, CSO, IMO, Charter Party, Noon Report).

Decoration is rationed to one motif per context. The authentication screen carries a faint chart graticule. The dashboard hero carries the dusk sea scene. Every other screen is plain paper. Motion is functional only: colour transitions on hover, a spinner inside a busy button, a pulse on loading skeletons. Nothing enters with an animation, and `prefers-reduced-motion` collapses all transitions to zero. The system explicitly rejects generic SaaS dashboards: mosaics of identical rounded cards, grey drop shadows under every block, empty gradients, repeated anchor icons, a marketing hero inside the tool, colour-only statuses.

**Key Characteristics:**
- Flat, hairline-ruled white surfaces on a cool canvas (#F3F6F8); shadows only on floating layers.
- One action colour (Ledger Ocean) for everything you can press or follow.
- Every status is a text label plus icon, colour only reinforces it.
- References in IBM Plex Mono; all figures tabular and right-aligned in columns.
- Tight corners: 4px tags, 6px controls, 8px panels. No pills.
- Navy chrome (sidebar, dashboard hero, dialog top rule) frames white working paper.
- One decorative motif per context: graticule at login, dusk scene on the dashboard, none elsewhere.

## Colors

A cool, low-chroma maritime palette: deep navy structure, a single ocean-teal action colour, a brighter teal used only as a thin mark, and five labelled status triplets.

### Primary
- **Ledger Ocean** (`action`): the only interactive colour. Primary buttons, links, the focus outline, focused input borders, the active tab underline, the selected-row marker, notification counts. Hover deepens to **Deep Ledger Ocean** (`action-700`). The pale tints (`action-100`, `action-50`) mark hover and selection in tables, registers and active tab counters. 6.2:1 on white.

### Secondary
- **Logbook Ink** (`navy`): structure and authority. Headings (h1–h3 default to it), panel and dialog titles, figures in registers and tiles, the dialog top rule, the AMC monogram, the theme colour. `navy-950` (**Night Watch Navy**) is the sidebar and the auth panel; `navy-700` is the hover of the navy button; `navy-600` is icon tint in empty states; `navy-100`/`navy-50` are quiet hover fills for ghost controls and skeleton blocks. Overlays use `navy` at 40–50% opacity.

### Tertiary
- **Waterline Teal** (`teal`): the brand mark. The waterline under the AMC monogram, the 3px active marker and active icon in the sidebar, the short rule on the login panel, the dashboard hero eyebrow (`teal-100`). On light surfaces, teal text is always `teal-700` on `teal-50`/`teal-100` (5.4:1).

### Neutral
- **Chart Room Canvas** (`canvas`): the application background behind every sheet.
- **Paper** (`surface`, #FFFFFF): panels, tables, forms, the top bar, dialogs.
- **Sunken Paper** (`surface-sunken`): table header rows, panel header bands, dialog footers, the watch clock.
- **Ink** (`ink`): body text. 14:1 on white.
- **Muted Ink** (`ink-muted`): secondary text, descriptions, table column heads, hints, inactive tabs. 5.9:1 on white, 5.4:1 on canvas.
- **Faint Ink** (`ink-soft`): placeholders, zero values in registers, chevrons, tertiary hints. Clears AA on white only (4.6:1).
- **Hairline** (`line`): panel outlines, table row rules, header and tab rules.
- **Strong Hairline** (`line-strong`): input borders, table head rule, gauge rule, hovered outlines.

### Status
Five semantic triplets, each a foreground, a tinted background and a border line: **ok** (approved, valid, received, closed), **warn** (pending, in progress, partial, expiring), **danger** (rejected, expired, cancelled, failed), **info** (unlimited validity, informational, scheduled), **neutral** (draft, unknown expiry, archived, superseded). Each foreground scores ≥5.2:1 on its background. `defaultTone()` in `components/ui/badge.tsx` maps status codes to tones; reuse it rather than choosing per screen.

On the dashboard hero the light status tints `on-navy-warn`, `on-navy-danger` and `on-navy-ok` replace the foregrounds (7.4–9.3:1 on navy). Together with the scene's own sky and sea colours, they are the only literal hex values allowed in components outside the Tailwind config, along with the AMC monogram SVG.

### Named Rules
**The Labelled Status Rule.** Colour never carries meaning alone. Every status is a word plus an icon (check, triangle, cross, clock, infinity, question mark); colour only reinforces it. A zero value in a register stays neutral grey, never green.

**The Ocean Means Act Rule.** Ledger Ocean is reserved for what can be pressed, followed or is currently selected. It never colours a heading, an illustration or a passive value.

**The Waterline Rule.** Waterline Teal appears only as a thin mark (2.5–3px rules, active icons on navy). It is never a fill, never a button, and never text on a light surface (3.4:1 on white fails).

## Typography

**Display Font:** IBM Plex Sans Variable (with IBM Plex Sans, system-ui, Segoe UI)
**Body Font:** IBM Plex Sans Variable (same stack)
**Label/Mono Font:** IBM Plex Mono 400/500 (with ui-monospace, Consolas)

**Character:** Plex Sans is an engineer's typeface, precise without being cold, and holds up at 12–13px in dense tables. Plex Mono is reserved for references, so a PR number or an IMO reads exactly as it is printed on the document.

The scale is set in px and runs small on purpose: 13px is the workhorse, used more than any other size (tables, descriptions, menus), with 12px for metadata and 14px as the body default.

### Hierarchy
- **Display** (600, 30px/38px, -0.01em): the dashboard hero greeting (its h1, in white) and the login panel statement. Never inside working screens.
- **Headline** (600, 24px/30px, -0.01em): the page title (`PageHeader` h1), Logbook Ink.
- **Title** (600, 16px/24px): dialog titles and section headings inside a page.
- **Title Small** (600, 15px/24px): panel and dashboard-card headers, register values.
- **Body** (400, 14px/22px): default body text, input values, md buttons at weight 500 (**Label Large**).
- **Body Small** (400, 13px/20px): table cells, descriptions, menu items, sidebar links (13.5px), page-header descriptions capped at `max-w-3xl`.
- **Label** (500, 13px/20px): field labels, sm buttons, tabs.
- **Caption / Tag / Column Head** (12px/16px at 400 / 500 / 600): hints and metadata / status tags / table column heads.
- **Overline** (600, 11px/14px, 0.08em, uppercase): sidebar group names, the « Périmètre » block, the dashboard hero eyebrow (0.1em), key/value terms on the vessel sheet.
- **Figure** (600, 26px/32px, tabular): dashboard hero indicators. Legacy KPI tiles use 24px/28px.
- **Ref** (IBM Plex Mono 400, 0.93em, -0.025em, tabular): business references via the `.ref` class.

### Named Rules
**The Ledger Figures Rule.** Every count, amount, quantity, date and time uses tabular figures (`.tabular`), and numeric columns align right. Amounts carry their ISO currency; quantities carry their unit.

**The Reference Rule.** Plex Mono is for references only (IMO, PR/RFQ/BC/BL numbers, voyage codes, certificate numbers, request IDs). Labels, headings and prose are never set in mono.

**The Sentence Case Rule.** Headings, buttons, tabs and labels are in sentence case. Uppercase is limited to 11–12px semibold overlines with 0.06–0.1em tracking.

## Layout

The app shell is a fixed 248px Night Watch Navy sidebar on the left from 1024px (`lg`) up, replaced below that by a 264px drawer over a navy scrim. A sticky 56px white top bar holds, left to right: the menu button (mobile), the vessel picker, global search (from 768px), and pushed right the watch clock (from 1280px), notifications and the account menu. Content sits on the canvas with 16px side padding (24px from `lg`) and 24px vertical padding.

Pages follow fixed sequences. A **list page** is: page header (breadcrumb, h1, description, meta tags, actions on the right, a 1px rule beneath, 20px gap), then the filter bar (a white ruled strip, 12px padding, controls bottom-aligned with 8px gaps), then the table, then cursor pagination (« Charger plus »). A **detail page** is: header with identity and status, then the next actor and actions, then panels of business content, linked documents, and history. Detail fields use `DefinitionGrid`: 12px muted term over 13px medium value, 2 to 4 columns from 640px.

Spacing is Tailwind's 4px grid, used in a tight rhythm: 4–6px inside tags and between icon and label, 8px between controls (the most common gap), 12px for cell and control padding, 16px panel padding and dense section gaps, 20px between page sections. Every `.grid` defaults to `minmax(0, 1fr)` tracks so a truncated label or a wide table can never widen the page on mobile.

Breakpoints are Tailwind defaults (640 / 768 / 1024 / 1280 / 1536px) plus arbitrary `min-[1440px]` and up for dashboard grids. Screens are checked at 390, 768, 1280 and 1440px. On small screens wide tables scroll horizontally behind an explicit hint (« Faites défiler le tableau horizontalement… »). Columns are only hidden below a breakpoint (`hideBelow`) when they are not essential to the decision.

## Elevation & Depth

The system is flat. Depth at rest is expressed by a 1px hairline ring (`box-shadow: 0 0 0 1px #DCE3E9`) and by tone: white paper on a cool canvas, sunken header bands. Real shadows exist only for layers that float above the page: menus, dialogs, tooltips and the expiry-horizon popover.

### Shadow Vocabulary
- **Panel** (`box-shadow: 0 0 0 1px #DCE3E9`): every resting surface (panels, filter bar, KPI tiles, dashboard cards). A ring, not a drop.
- **Raised** (`box-shadow: 0 1px 2px rgba(16,43,68,0.06), 0 0 0 1px #DCE3E9`): a hairline with the faintest lift; rare (one use).
- **Pop** (`box-shadow: 0 12px 32px rgba(11,31,51,0.20), 0 0 0 1px rgba(11,31,51,0.06)`): dropdown menus, dialogs, tooltips.
- **Scrim**: `navy` at 40% behind dialogs, 50% behind the mobile drawer.

### Named Rules
**The Ruled Page Rule.** Surfaces at rest are flat sheets outlined by a hairline. A drop shadow means "this floats above the page"; it is never used to make a resting card look important. Hover on a linked surface strengthens the ring (`#C3CED8`), and an active filter tile takes a 2px ocean ring. Neither lifts the surface.

## Shapes

Corners are tight and functional, like printed forms. 4px on status tags and small marks, 6px on buttons, inputs, menu items and icon buttons, 8px on panels, dialogs, the filter bar and KPI tiles. The dashboard hero alone takes 10px. Full rounding is reserved for things that are naturally round: avatars, unread counters, status dots on the expiry horizon, the empty-state icon disc.

Rules do the structural work: the 1px rule under the page header, ruled table rows, the 2px left rule of a gauge reading, the 2px ocean underline of the active tab, the 3px inset ocean bar on a selected row's first cell, the 3px navy top rule of a dialog, and the 3px teal bar beside the active sidebar link.

### Named Rules
**The No-Pill Rule.** Status tags are 4px-cornered rectangles with a 1px tinted border, like a stamp in a register, never rounded pills.

## Components

### Buttons
Plain and decisive: a solid block of colour, a medium-weight label, no gradient, no shadow.
- **Shape:** gently squared (6px), 36px tall at `md` (16px side padding, 14px/500 text) and 32px at `sm` (12px padding, 13px text). Icon gap 8px (`md`) / 6px (`sm`).
- **Primary:** Ledger Ocean with white text, hovering to Deep Ledger Ocean. One primary per action group.
- **Navy:** Logbook Ink with white text, for structural commands that are not the main flow action.
- **Secondary:** white with a strong-hairline border and ink text, hovering to sunken paper; the default for « Annuler » and secondary actions.
- **Ghost:** transparent ink text, Night Watch tint on hover; for toolbars and low-emphasis actions.
- **Danger:** Signal Red (`danger`) with white text, darkening to #912018; destructive confirmations only.
- **Loading / Disabled:** a 16px spinner precedes the label and the button is disabled with `aria-busy`. Disabled solid buttons drop to 50% fill; outline buttons fade the text to faint ink.
- **Icon button:** 32px square, 6px corners, muted icon that turns ink on a navy-50 hover; it always carries an `aria-label` and a tooltip `title`.

### Status Tags (chips)
- **Style:** 4px corners, 1px border in the tone's `-line` colour, tone background, tone foreground, 12px/500 label, 1px × 6px padding, a 14px leading icon (check / triangle / cross / clock), truncation with `title` when space runs out.
- **Tones:** ok, warn, danger, info, neutral for statuses; navy and teal for neutral categorisation (roles, scopes). Certificate validity adds infinity (unlimited) and question mark (unknown expiry). Unknown expiry is never shown as unlimited.
- **Use:** secondary to text. The page still states the status and next action in words; tags never replace a quantity or a reconciliation figure.

### Panels (cards / containers)
- **Corner Style:** 8px.
- **Background:** white paper on canvas.
- **Shadow Strategy:** the hairline ring only (see Elevation).
- **Header:** optional 48px band in sunken paper with a hairline beneath, 15px semibold navy title on the left, actions on the right.
- **Internal Padding:** 16px.
- **Dashboard card:** same surface, but the title sits directly on white (14px top padding) with an ocean « Voir tout › » link whose accessible name says which list it opens.

### Inputs / Fields
- **Style:** 36px tall, white, 1px strong-hairline border, 6px corners, 12px side padding, 14px ink text, faint-ink placeholder. Textareas grow from 84px.
- **Label:** 13px/500 ink above the field (4px gap); a required field adds a red asterisk.
- **Focus:** border turns Ledger Ocean with a 2px `action-100` ring; no glow.
- **Error:** `aria-invalid` turns the border Signal Red with a `danger-bg` ring; a 12px semibold red message replaces the hint below (`role="alert"`).
- **Disabled:** neutral-bg fill and not-allowed cursor.
- **Hint:** 12px muted ink below the field.
- **Focus outline (global):** every focusable element shows a 2px solid Ledger Ocean outline, offset 2px, with 4px corners (WCAG 2.4.7 / 2.4.11).

### Navigation
- **Sidebar:** Night Watch Navy, 248px. At the top, a 56px brand block (AMC monogram, « Africa Marine Company », « Exploitation de flotte »). Links are grouped under 11px uppercase overlines (Pilotage, Flotte & équipages, Conformité, Achats, Opérations, Administration) and filtered by permission. Links are 13.5px, white at 70% with icons at 50%. Hover gives a 5% white fill. Active gives a 9% white fill, full white medium text, a teal icon and a 3px teal bar at the left edge. A footer block states the user's vessel scope (« Toute la flotte » / « Navires affectés » · n navires).
- **Top bar:** white, 56px, a hairline beneath, sticky.
- **Tabs:** a hairline-ruled strip, 13px/500 muted labels, a 2px Ledger Ocean underline and navy text when active; an optional count chip (navy-50, turning action-100/action-700 when active). Scrolls horizontally with no visible scrollbar.
- **Breadcrumb:** 12px muted, chevron separators, links turning ocean on hover, current page in ink.

### Data Table (signature: the ruled register)
The core reading surface of the product. Full-width, collapsed spacing, 13px text. Column heads are sticky, on sunken paper, 12px semibold muted, with a strong hairline beneath. Rows are ruled with a hairline, have 10px × 12px cells, and are vertically centred. Hover tints the row `action-50` at 70%. A selected row takes a full `action-50` fill and a 3px inset Ledger Ocean bar on its first cell. Optional group headers gather rows (e.g. orders by Purchase Request). Loading shows skeleton bars, errors show the error state with a retry, and pagination is cursor-based.

### Register (signature)
The logbook's tally sheet, replacing tile mosaics for numeric summaries. It is a ruled list (hairline above, between and below) of label / value rows. The value is 15px semibold tabular, right-aligned, toned by severity (danger / warn / info / ok / navy) and grey when zero. A chevron marks a row that links to the filtered list; the hover gives an `action-50` fill.

### Gauge (instrument reading)
A value marked by a 2px strong-hairline rule on its left (12px indent, 2px vertical padding), with no card and no shadow. When it is a link or a button, the rule turns Ledger Ocean on hover over an `action-50` wash. Use it for small sets of readings beside other content.

### Dialogs
White, 8px corners, a 3px Logbook Ink top rule, pop shadow over a 40% navy scrim. Width 448 / 576 / 768 / 1152px (sm–xl), capped at 90vh with an internal scroll. Header: 16px semibold navy title and muted description above a hairline, close button top right. Footer: sunken paper, right-aligned actions. Confirmations of sensitive actions state « Cette action est journalisée ». When a reason is required, a mandatory « Motif » field (minimum 3 characters) is « conservé dans le journal d'audit ».

### Empty, error and forbidden states
Centred, 48px vertical padding: a navy-50 disc holding a 20px navy-600 icon, a semibold navy title, a muted description capped at `max-w-md`, and an optional action. Error states keep the API request reference in faint ink. Forbidden states never reveal that a resource exists.

### Watch Clock (signature)
A sunken, hairline-bordered capsule in the top bar (from 1280px) reading `UTC hh:mm` and, when a single vessel with a declared time zone is selected, `Bord hh:mm UTC±n`. Labels are 12px semibold muted, times semibold tabular navy. It is informational only; official timestamps come from the server.

### Expiry Horizon (signature)
Certificates plotted on an axis from D-30 to D+90 like ports of call on a route. Tinted bands mark the expired zone (danger-bg) and the 30-day zone (warn-bg). A navy « Aujourd'hui » line runs through the axis. Markers are 14px dots with a white border and a tinted ring, each one a link with a full `aria-label` and a navy tooltip. A priority list beside it is the accessible alternative.

### Dashboard Hero (signature, dashboard only)
The one illustrated surface in the product (`FleetHero`). It is a deep-sea band (#081828, 10px corners) with a dusk scene: an inline SVG of a bulk carrier on the horizon, sky and sea gradients from navy through dusk violet, and an amber sun glow and reflection. The scene is `aria-hidden` and anchored right so the ship keeps its scale, while a CSS gradient (`SKY_SEA`) extends sky and sea to the left. Readability veils darken the text side and the foot of the band. On the left sit an 11px teal-100 eyebrow (« Tableau de bord »), the 30px white greeting, and a context and freshness line. Along the foot runs a row of key indicators, each with a 24px line icon, a 26px semibold tabular figure, a 14px label and a 12px sub-line in white 70% or an on-navy status tint. Each indicator links to its list. They wrap into 2 or 3 columns and become a single row ruled by 15% white dividers from 1440px. No figure is shown until it has loaded. (`SituationStrip`, a navy band with a teal top rule, exists in `components/dashboard/` but is not used by any page.)

### KPI Tiles (legacy)
Tinted 44px icon squares with a label, a 24px navy figure and a sub-line, on hairline tiles. They are kept only as a row of toggle filters (`aria-pressed`, 2px ocean ring when active) above a list. For numeric summaries, use the Register.

## Do's and Don'ts

### Do:
- **Do** build every new screen from `PageHeader`, `FilterBar`, `Panel`, `DataTable`, `Register`, `Badge`/`StatusBadge` and `Dialog`/`ConfirmDialog` before writing new markup.
- **Do** use the Tailwind tokens (`navy`, `action`, `teal`, `ink-*`, `line-*`, status triplets) and the `.panel`, `.gauge`, `.ref`, `.tabular`, `.input`, `.table-amc` classes; they are the source of truth.
- **Do** pair every status colour with a French label and an icon, and keep the next action stated in words.
- **Do** set business references in `.ref` (Plex Mono 0.93em) and every figure in tabular numerals, right-aligned in columns, with units and ISO currency.
- **Do** keep resting surfaces flat with the hairline ring (`0 0 0 1px #DCE3E9`); reserve `shadow-pop` for menus, dialogs and tooltips.
- **Do** use `ink-muted` for any secondary text on canvas or sunken paper; `ink-soft` passes AA only on white.
- **Do** give a wide table a horizontal scroll and the explicit scroll hint on mobile instead of silently dropping essential columns.
- **Do** keep the global focus outline (2px Ledger Ocean, 2px offset) visible on every interactive element.

### Don't:
- **Don't** build mosaics of identical rounded cards or put a drop shadow under every block.
- **Don't** add gradients, wave motifs, repeated anchor icons or illustrations outside the two sanctioned contexts (the login graticule and the dashboard hero).
- **Don't** reuse the dusk scene, its gradients or its on-navy tints on any screen other than the dashboard; vessel, voyage and module headers stay plain `PageHeader`s.
- **Don't** use Ledger Ocean for headings, decoration or passive values, or Waterline Teal as a fill, a button or text on a light surface.
- **Don't** round status tags into pills or use full rounding on anything that is not naturally round.
- **Don't** set labels, headings or prose in Plex Mono, or use spaced uppercase beyond 11–12px overlines.
- **Don't** hard-code hex values in components; only the dashboard hero and the AMC monogram may use literal colours.
- **Don't** add entrance animations or decorative motion; transitions are limited to colour, rings and opacity, and must collapse under `prefers-reduced-motion`.
- **Don't** add a new KPI tile row for a numeric summary; use the Register.
