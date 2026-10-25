# TourPulse design

The working screen follows one production dashboard reference: the Tremor Planner template (https://planner.tremor.so, MIT source at https://github.com/tremorlabs/template-planner). Structure and colour roles are borrowed; no template code or assets are copied. Printed documents (Day Sheet, recipient proposal, evidence appendix) use the paper counterparts of the same roles, type and components; their rules live in `tour-visuals.css`, `proposal-print.css`, `day-sheet-print.css` and the print blocks of `globals.css`.

## Tokens

| Role | Value |
|---|---|
| Ground, panels, inputs | `#030712` |
| Tone step (hover, selected row, group rows, chips) | `#111827` |
| Rule | `#1f2937` |
| Strong rule (control and pill borders) | `#374151` |
| Text / secondary / tertiary | `#f9fafb` / `#9ca3af` / `#7c8595` |
| Accent (primary action, active tab, selection, focus, drive bars) | `#3b82f6`, hover `#2563eb` |
| Link and information text | `#60a5fa` |
| Success / warning / danger | `#34d399` / `#fbbf24` / `#f87171`; over-cap bars `#ef4444` |

Type is Inter only: 14px body, 12px labels, 18px page and dossier titles, 600 weight for headings and table headers, tabular figures throughout. Monospace is reserved for `code` and `pre`. Controls and pills use a 6px radius; dialogs 8px. Shadows appear only on menus, popups and dialogs.

## Composition

- Shell: setup sidebar, centre workspace and stop dossier share the ground and are separated by 1px rules.
- Centre page: 18px title and meta line, inline route metrics (label, value, quieter qualifier; a three-step level marker only for real ratios), underline tabs (Overview, Day sheet, Map and neighborhoods), then one toolbar row.
- Charts carry a title, a one-line description and a legend at the top right, sit on the ground without boxes, and pair two per row when the centre is wider than 720px.
- Tables and the venue research queue use a semibold header row, 14px rows separated by rules and status pills with a dot plus text.

## Signature move

The Daily drive chart: hour ticks and gridlines, the user's daily cap as a dashed rule, blue bars for estimated hours, red only for a day over the cap, value labels above bars and two-line day labels (date, then city or travel/rest). A hidden table carries the same values for screen readers.

## Paper

| Role | Value |
|---|---|
| Ink / secondary / tertiary | `#111827` / `#6b7280` / `#6b7280` |
| Rule / strong rule / tint | `#e5e7eb` / `#d1d5db` / `#f9fafb` |
| Accent, accent tint, accent line | `#3b82f6`, `#eff6ff`, `#bfdbfe` |
| Shortlist / hold / exclude | `#059669` / `#d97706` / `#dc2626` |

Paper is Inter only, with sentence-case labels and no tracked capitals. The Day Sheet prints the same route metrics, Route order sketch and Daily drive chart components as the screen; `.print-sheet` remaps the screen variables those components read to the paper roles above.

Release accessibility adjustment: tertiary screen text uses `#7c8595` (5.41:1 against the ground), and metric qualifiers use the secondary token. Paper qualifiers use `#6b7280` (4.83:1 against white). The reference's lower-contrast grays are retained only for non-text rules and decorative marks.
