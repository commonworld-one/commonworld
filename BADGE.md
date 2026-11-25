# Commonworld Atlas badges

Verified uses the same overview visit date as the card: we visited the resource and prepared a description and matching screenshot. Actual trials have separate dates. It is not verification of every feature or payout. Closed badges mark retained history.

Stable SVG URLs end in /atlas/badge/<id>.svg and <id>-dark.svg. Existing URL embeds can update after deployment and cache revalidation. The generated Cache-Control is public, max-age=3600. Third-party caches may delay refresh. Downloaded copies do not update. No cache purge or immediate third-party refresh is promised.

Every published card in the [Commonworld Atlas](https://commonworld.one/atlas/) has a free status badge that the platform can show on its own site or README. Full page: **https://commonworld.one/atlas/badge/**

[![Commonworld Atlas badge](https://commonworld.one/atlas/badge/kradleverse.svg)](https://commonworld.one/atlas/platforms/kradleverse/)

Free. Never sold. Regenerated on catalogue rebuilds. The date matches the visit shown on the current overview.

## What it is

A plain SVG image served from `commonworld.one`: left *Commonworld Atlas*, right the status of one card. It links to the card with its facts and sources.

- Light backgrounds: `https://commonworld.one/atlas/badge/<id>.svg`
- Dark backgrounds: `https://commonworld.one/atlas/badge/<id>-dark.svg`

`<id>` is the card's permanent ID (its URL slug), taken from the card page or [platforms.json](https://commonworld.one/atlas/platforms.json). Never guess an ID. Each current entry's JSON (`/atlas/platforms/<id>.json`) lists `badge_svg`, `badge_svg_dark` and `badge_page`. Closed JSON omits these fields; stable closed badge URLs remain available by permanent ID.

## Statuses

| Badge text | Meaning |
| --- | --- |
| `Verified · YYYY-MM-DD` | The resource was visited and a description with matching screenshot was prepared; the date is that overview visit (UTC). Not a guarantee or a service trial. |
| `Listed` | Listed record, including a bounded source-check note; not an accepted overview or closure decision. |
| `Closed · history` | The platform is closed by an explicit catalogue decision; the card is kept as history. |

## How it updates

`atlas/site/build.py` regenerates every badge from the Atlas data on each build, without implying a new visit or test. URL embeds can load the rebuilt file after deployment and cache revalidation. Browsers and image proxies may delay refresh. Downloaded copies do not update.

## Rules

- Free for every published card; nobody has to ask for one.
- No tracking: plain SVG image, no scripts, no cookies, no external fonts or requests.
- Honest status: it shows the card status and the current overview visit date and links to the card with its sources.

## How to add it

Example for `kradleverse`. Current overview pages include an embed block with the same visit date.

HTML:

```html
<a href="https://commonworld.one/atlas/platforms/kradleverse/"><img src="https://commonworld.one/atlas/badge/kradleverse.svg" alt="Commonworld Atlas badge" height="20"></a>
```

Markdown:

```markdown
[![Commonworld Atlas badge](https://commonworld.one/atlas/badge/kradleverse.svg)](https://commonworld.one/atlas/platforms/kradleverse/)
```

Plain link: `https://commonworld.one/atlas/platforms/kradleverse/`

## Wrong status or date?

The badge only shows what the card says. To fix the card, [open a correction request](https://github.com/commonworld-one/commonworld/issues/new/choose) with the card's permanent ID and a link to a source that shows the right fact. When the card is corrected, the badge follows on the next build.
