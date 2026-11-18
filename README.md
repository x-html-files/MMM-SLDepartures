# MMM-SLDepartures

[![CI](https://github.com/knutsoza/MMM-SLDepartures/actions/workflows/ci.yml/badge.svg)](https://github.com/knutsoza/MMM-SLDepartures/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Realtime Stockholm public transport departures on your [MagicMirror²](https://magicmirror.builders)
wall display. Commuter trains, metro, buses, trams and ferries — **no API key, no account, no
monthly anything.**

```
43  Uppsala C       16:49  NOW
41  Märsta          17:04  14 min
40  Kungsängen   !  17:19  29 min
43  Uppsala C       17:34  44 min
```

Line, destination, departure time and time remaining. `!` marks a disruption, with the message on
hover; a delayed time is highlighted and a cancelled one struck through.

## Why this exists

The established SL modules — `MMM-SL`, `MMM-SL-PublicTransport` — target SL's
*Realtidsinformation 4* API. That API required a Trafiklab key and has since been **retired**, so
those modules no longer work. This one targets the current
[SL Transport API](https://www.trafiklab.se/api/trafiklab-apis/sl/transport/)
(`transport.integration.sl.se`), which needs no key at all.

It shows both **absolute clock times** and a countdown. The countdown uses the expected departure
time when available, updates locally between polls, displays `NOW` below one minute and is blank
at 60 minutes or more. It is also blank for cancelled, past or unparseable departures. Minutes are
rounded down, so 59 minutes 59 seconds is shown as `59 min`.

Beyond that: realtime where SL provides it (the `expected` time, falling back to the timetable),
filtering by direction, transport mode and line, and disruption flags with the routine station noise
filtered out.

## Install

No runtime dependencies and no build step. The `devDependencies` exist only for the tests and
linter.

```bash
cd ~/MagicMirror/modules
```

```bash
git clone https://github.com/knutsoza/MMM-SLDepartures.git
```

Then restart MagicMirror (`pm2 restart magicmirror`, or however you run it).

To update later:

```bash
cd ~/MagicMirror/modules/MMM-SLDepartures && git pull
```

## Configuration

Add to the `modules` array in `config/config.js`:

```js
{
  module: "MMM-SLDepartures",
  position: "bottom_right",
  config: {
    siteId: 9001,              // T-Centralen
    directionCode: 2,          // check yours — see below
    transportModes: ["TRAIN"],
    maxDepartures: 6
  }
}
```

### Options

Every option, what it does, and when you would actually change it.

| Option | Type | Default | What it does |
|---|---|---|---|
| `siteId` | number | `9001` | Which stop to show. A "site" is a whole place, not a platform. See *[Finding your stop](#finding-your-stop)* — and note one place can have more than one id. |
| `directionCode` | number \| null | `2` | Which way the service is heading: `1` or `2`. **The option people get wrong** — which number means "toward town" differs by station. `null` shows both. |
| `transportModes` | string[] | `["TRAIN"]` | Keep only these modes: `TRAIN`, `METRO`, `BUS`, `TRAM`, `SHIP`. Empty means all — read *[A site is a place, not a platform](#a-site-is-a-place-not-a-platform)* before emptying it. |
| `lines` | string[] | `[]` | Keep only these line designations, e.g. `["43"]`. Useful when a platform serves several lines but you only ever catch one. |
| `maxDepartures` | number | `6` | How many rows to render. An **upper bound, not a promise** — see *[You may get fewer rows than you asked for](#you-may-get-fewer-rows-than-you-asked-for)*. |
| `forecast` | number \| null | `null` | Minutes to look ahead. `null` uses SL's own default of 60. Raising it helps less than you would expect. |
| `updateInterval` | number | `60000` | Poll interval in milliseconds. Please don't go below ~30 s — this is a free, unauthenticated API shared by everyone. |
| `showDeviations` | boolean | `true` | Show a `!` against disrupted departures, with the message on hover. |
| `minDeviationImportance` | number | `3` | Lowest SL `importance_level` worth showing. SL files broken lifts and escalator works at low importance; the default keeps those off your wall. Lower it to see everything. |
| `showCancelled` | boolean | `true` | Keep cancelled departures visible, struck through. Usually right: a train silently vanishing looks exactly like one that already left. `false` hides them. |
| `showLineNumber` | boolean | `true` | Show the line designation column, e.g. `43`. |
| `showDestination` | boolean | `true` | Show the destination column, e.g. `Uppsala C`. |
| `header` | string | `""` | Module header text. Empty means no header. |

## Two things that will catch you out

Both are properties of the SL API rather than of this module, and both look like your configuration
is broken when it isn't.

### A site is a place, not a platform

One site id covers *everything* at that location — the railway platforms, the metro below, and the
bus stands outside. And `direction_code` is assigned per **line**, not per compass direction, so the
same number means different things for different services at the same stop.

At T-Centralen, `direction_code: 2` covers all of this:

| Mode | Lines | Heading for |
|---|---|---|
| `TRAIN` | 40, 41, 43 | Uppsala C, Märsta, Kungsängen — **what you asked for** ✅ |
| `BUS` | 65, 69 | Centralen, Hornsberg — a city bus, not your train ❌ |
| `METRO` | 13, 14, 17, 18, 19 | Skarpnäck, Fruängen, Hagsätra — also not your train ❌ |

Filter on direction alone and all of them land in what you thought was a commuter-rail list. Setting
`transportModes` is what makes the filter correct.

This is covered by a regression test (`dropping the transportModes filter is what lets buses in`),
asserted against a real captured response in `tests/` — so if SL changes the shape of this data, the
test says so rather than the wall quietly filling with the wrong vehicles.

### You may get fewer rows than you asked for

`maxDepartures: 6` can still show three, and that is usually the API rather than your config.

SL limits how many departures it returns **per transport mode**, and the limit scales with how busy
the stop is. Widening the window does not lift it. Measured 2026-08-16:

| Stop | Request | Total | of which `TRAIN` | Span |
|---|---|---|---|---|
| T-Centralen (9001) | `forecast=60` | 68 | 16 | 14:08 – 15:09 |
| T-Centralen (9001) | `forecast=240` | 72 | **18** | 14:07 – 15:36 |
| A quiet suburban stop | `forecast=60` | 18 | 6 | 12:41 – 13:34 |
| A quiet suburban stop | `forecast=240` | 24 | **6** | 12:41 – 14:04 |

At the hub, four extra hours bought two more trains. At the quiet stop it bought **none** — six more
departures appeared and every one was a bus, while `TRAIN` stayed pinned at 6.

Those trains then split across **both directions**, so a one-direction filter leaves about three.
Raising `forecast` is worth a try, but don't expect it to rescue a short list at a quiet stop.

## Finding your stop

Two commands. The first finds your site id; the second tells you which direction code means "toward
town" *at your stop*, which is the only reliable way to know.

### Your site id

```bash
curl -s "https://transport.integration.sl.se/v1/sites?expand=false" | grep -i "your stop name"
```

A few for reference, verified against the API on 2026-08-16:

| Site | id |
|---|---|
| T-Centralen | `9001` |
| Stockholm City | `1080` |
| Odenplan | `9117` |
| Södertälje centrum | `9527` |
| Slussen | `9192` **and** `9208` |

Slussen is the cautionary one: a single place can expose **more than one site id**, covering
different parts of the interchange. Look yours up rather than assuming, and if departures look oddly
incomplete, check whether your stop has a second id.

### Your direction code

`direction_code` is always `1` or `2`, and which one means "toward town" differs from station to
station. Do not copy someone else's value — check yours:

```bash
curl -s "https://transport.integration.sl.se/v1/sites/9001/departures" | grep -oE '"direction":"[^"]*"' | sort -u
```

Then match the `direction` and `destination` names against the code:

```bash
curl -s "https://transport.integration.sl.se/v1/sites/9001/departures" \
  | python3 -c "import json,sys; [print(d['direction_code'], d['line']['transport_mode'], d['line']['designation'], '->', d['destination']) for d in json.load(sys.stdin)['departures']]" | sort -u
```

For T-Centralen, the commuter-train rows come out as:

| `direction_code` | Mode | Lines | Goes to | Meaning |
|---|---|---|---|---|
| `2` | TRAIN | 40, 41, 43 | Uppsala C, Märsta, Kungsängen | northbound / westbound |
| `1` | TRAIN | 40, 41, 43 | Nynäshamn, Södertälje centrum, Västerhaninge | southbound |

Note the same line numbers appear under both codes — which is the point. The code is a property of
the line's *route*, not of the station, so there is no shortcut: run the command for your own stop.

## When something goes wrong

On a network error, timeout or non-200 response, the module keeps the last successful departures
and displays **⚠ Data may be outdated**. Cached departure times can change or be cancelled while
the connection is down; do not treat them as live information. Countdowns continue updating each
second without making API requests, and cached departures disappear as their times pass. If no
successful response has been received, or no cached departures remain, a `—` is shown instead.
The warning disappears when a request succeeds. The cache is in memory and is lost when the helper
restarts.

For HTTP 429 responses, polling waits at least until the API's `Retry-After` time when supplied;
otherwise it waits at least one minute. Increase `updateInterval` if rate limits persist.

Fetching happens server-side in `node_helper.js`, both because the API sends no CORS headers and so
that one request serves every attached browser rather than one per screen.

## Development

### Local browser preview

With Node.js 20 or newer, run `npm run preview` and open
<http://127.0.0.1:8080/>. This runs the actual module and its node helper
without installing MagicMirror or copying anything to a Raspberry Pi. The server
listens only on your computer and fetches live SL departures. For an offline
preview, open <http://127.0.0.1:8080/?fixture=1>; its captured times are **not
current**, and the fixture only represents T-Centralen.

To see normal, delayed and cancelled departures and countdown states side by side, use the
[simulated disruptions preview](http://127.0.0.1:8080/?demo=1). These are fake,
preformatted rows, not live data; they bypass the site and departure filters so
the examples are always visible. You can edit the sample rows in
[preview/preview.js](preview/preview.js). Display options such as column and
deviation visibility still apply. The [cached data sample](http://127.0.0.1:8080/?demo=1&stale=1)
shows the warning and expiration behavior after a simulated API error.

Edit the overrides at the top of [preview/preview.js](preview/preview.js) to
match your MagicMirror configuration. Refresh the browser after editing the
module, styles or preview configuration; restart the server after editing the
node helper or its libraries. The preview approximates MagicMirror's styling
and APIs, so check the final appearance in MagicMirror too. Stop the server with
Ctrl+C. Set `PORT` before starting it if port 8080 is already in use.

### Tests and lint

```bash
npm test
```

```bash
npm run lint
```

Tests run against a real captured API response (`tests/fixture-tcentralen.json`), so they need
no network and cannot be broken by SL having a bad day. CI runs them on Node 20 and 24.

Use the npm scripts rather than calling `node --test` directly — the portable invocation is fussier
than it looks, and [`CLAUDE.md`](CLAUDE.md) explains why.

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by Storstockholms Lokaltrafik (SL) or Trafiklab. Departure data
© SL, via the open Trafiklab platform.
