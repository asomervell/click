# Click website: implementation brief

Build the public website for Click (clickmcp.com) from the files in this folder. Start with the landing page.

## What is here

| File | What it is |
|---|---|
| `landing.html` | The landing page as a working reference. Open it in a browser. Match it. |
| `tokens.css` | Design tokens as CSS variables: colours, spacing, borders, hard shadows, fonts. Dark ("CRT") is the default; `data-theme="light"` switches to "Paper". |
| `components.css` | Component styles. Classes are prefixed `ck-`. |
| `components/*.html` | One reference page per component: Button, Badge, Input, KeyChip, Message, Terminal, Logo. |
| `COMPONENTS.md` | Usage notes for each component and for the hero scene. |
| `hero-campfire.png` | The hero picture: an animated PNG, 320 by 200, 40 frames. It needs no script. |
| `logos/` | The Buckle mark in four colourways, two lockups, the wordmark, and `favicon-16.svg`. |
| `BRAND.md` | The brand book: concept, voice, colour, type, logo rules. Read it before writing any copy. |

## How to implement

1. Load `tokens.css` then `components.css` on every page. Fonts (Press Start 2P, IBM Plex Mono) load from Google Fonts via `tokens.css`.
2. Reproduce `landing.html` in the site's own framework. Keep the markup structure and class names; keep every value as a `var(--token)`, never a raw hex or pixel value.
3. The hero is a full-bleed `<img src="hero-campfire.png">` behind the copy with `object-fit: cover; object-position: 60% 100%; image-rendering: pixelated`, inside a section with `data-theme="dark"`. Do not smooth, blur, recolour or overlay it.
4. Use `logos/buckle-magenta.svg` (or inline the SVG from `components/Logo.html` with `fill="currentColor"`) in the nav, and `logos/favicon-16.svg` as the favicon.
5. Make the "Copy" control in the "Tell your agent" box copy the sentence to the clipboard.

## Rules that are easy to break

- The product is called **Click**, never ClickMCP. The joining credential is a **key**. "Token" is only ever used for payment.
- Copy on the landing page is final as written in `landing.html`. Do not add taglines, small labels above headlines, or small print under buttons.
- Colours are black, white, magenta, and the magenta ramp. Cyan exists but is used at most once per screen; the landing page currently uses none.
- Corners are square. Borders are 2px. Shadows are a hard 4px offset with no blur. Nothing eases or fades; motion is stepped.
- Headlines, buttons and labels are uppercase in Press Start 2P. Everything you read is sentence case in IBM Plex Mono.
- No mouse, cursor or pointer imagery anywhere.
- One hero picture per page, and the logo does not appear inside it.

## Not decided yet (ask before inventing)

- `clickmcp.com/start`, the Docs and GitHub links, and the tool and key names in the component examples (`click_create`, `clk_...`) are placeholders.
- The landing page is designed for desktop width. Below about 700px the three-column rows should stack and the hero copy should sit above the fire; that layout has not been designed.
- The Paper (light) theme is defined in tokens but has not been reviewed on real pages.
- Only the landing page is designed. Docs, sign-in and pricing pages do not exist yet.

## Done means

- The landing page matches `landing.html` side by side at 1280px wide.
- The hero animates, stays crisp (hard pixels) at every width, and the copy stays readable over it.
- No raw colour, spacing or font values in the site's CSS outside `tokens.css`.
- Lighthouse accessibility has no contrast failures on the landing page.
