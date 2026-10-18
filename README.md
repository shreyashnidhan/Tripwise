# TripWise: Smart Travel Planner

> **Go beyond the expected.** Explore destinations, check the weather, and build a day-by-day itinerary with a budget, all in one place.

**Track:** Full-Stack Development
**Event:** AWS Student Builder Group, VIT Chennai: Web Development Recruitment Task (Round 1)

| | |
|---|---|
| **Live demo** | https://tripwise-itinerary-maker.onrender.com |
| **Source code** | https://github.com/shreyashnidhan/Tripwise |

---

## Project overview

Planning a trip usually means searching several websites. TripWise brings it into one app:

1. **Discover** countries from a real external API (Wikidata) in a responsive card grid or on a world map.
2. **Search, filter and sort** by country or capital, region and population size, sorted by name, population or area.
3. **Open a destination** to see its photo, description, capital, region, population, area, coordinates and current weather.
4. **Build an itinerary:** add destinations, set the trip length (1 to 14 days) and start date, and place states or places of each country on specific days.
5. **Allocate a budget:** set a country budget, give each place its own budget, and watch a progress bar show what is left or over.
6. **Keep it saved:** the itinerary is stored in a database, so it is still there after a refresh.

The app shows clear **loading**, **empty** and **error** states, and validates every request on the server.

## Features 

| Requirement | Implementation |
|---|---|
| Destination discovery from a real API | Wikidata SPARQL through the backend; descriptions and photos from Wikipedia and Unsplash |
| Search, filtering and sorting | Search box, region filter, population-size filter, three sort options, grid and map views |
| Destination details | Details popup with photo, description, facts and live weather, plus an Add to trip button |
| Itinerary management | Add, view and remove destinations; per-country states on specific days; notes on each place |
| Saving itinerary data | SQLite database, linked to the browser by a random client ID |
| Feedback and error handling | Loading skeletons, "no results" and "empty trip" states, error messages with retry, server-side validation |
| Clear and usable experience | Responsive on desktop and mobile, keyboard-accessible controls, reduced-motion support |

## Technologies used

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS and vanilla JavaScript, Leaflet maps, Manrope and DM Sans fonts, 8-point spacing system |
| Backend | Node.js 22 and Express (REST API, validation, error handling, response caching) |
| Database | SQLite through Node's built-in `node:sqlite` module (no native packages to compile) |
| Hosting | Render (web service), code on GitHub |

## API details

All external APIs are called from the backend, so no key is ever exposed in the browser.

| API | Used for | Key needed |
|---|---|---|
| [Wikidata SPARQL](https://query.wikidata.org) | Destination data: sovereign states with capital, region, population, area, coordinates and flag; states and provinces of a country | No |
| [Wikipedia REST](https://en.wikipedia.org/api/rest_v1/) | Destination description; photo fallback | No |
| [Unsplash](https://unsplash.com/developers) | Destination photos, shown with photographer credit | Optional (`UNSPLASH_ACCESS_KEY`) |
| [Open-Meteo](https://open-meteo.com) | Current temperature and wind in the details view | No |
| OpenStreetMap tiles with Leaflet | Map on the Explore and My Trip pages | No |

If Wikidata cannot be reached, the server serves a small bundled list (`data/fallback.csv`) so the app keeps working. Unsplash demo keys are limited to 50 requests per hour, so photo lookups are cached and fall back to Wikipedia photos.

## Setup and run instructions

**Requirements:** Node.js 22 or newer.

```bash
git clone https://github.com/shreyashnidhan/Tripwise.git
cd Tripwise
npm install
cp .env.example .env     # optional: add your UNSPLASH_ACCESS_KEY
npm start                # opens on http://localhost:3000
```

On Windows PowerShell, use `copy .env.example .env` instead of `cp`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the server listens on (set automatically by most hosts) |
| `DB_PATH` | `tripwise.db` | Location of the SQLite database file |
| `UNSPLASH_ACCESS_KEY` | empty | Optional photo key; without it, Wikipedia photos are used |

Never commit `.env`. It is listed in `.gitignore`.

## Database configuration

TripWise uses a single SQLite file at `DB_PATH`. The tables are created automatically on the first start, so there is nothing to install or migrate.

| Table | Columns |
|---|---|
| `trip` | client, name, start_date, num_days |
| `itinerary` | id, client, code, name, capital, region, flag, day_number, sort_order, notes, budget, added_at |
| `stops` | id, client, code (country), name (state or place), day_number, sort_order, notes, budget |

Each browser generates a random ID and sends it in the `x-client-id` header, so every visitor sees only their own trip. No account is needed.

**Hosting note:** SQLite is a file, so it needs a disk that survives restarts. On hosts with temporary storage (for example Render's free plan), saved trips can be lost when the service restarts or redeploys. For permanent storage, attach a persistent disk and point `DB_PATH` at it, for example `/var/data/tripwise.db`.

## REST API

All itinerary, trip and stops requests need the header `x-client-id: <8 to 64 letters, digits, - or _>`. Errors return JSON like `{"error": "message"}` with a 400, 404, 409 or 502 status.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/destinations?q=&region=&size=&sort=&order=` | Search, filter and sort. `size` is `small`, `medium` or `large`; `sort` is `name`, `population` or `area`; `order` is `asc` or `desc` |
| GET | `/api/destinations/:code` | Details for one country, for example `/api/destinations/JPN` |
| GET | `/api/destinations/:code/regions` | States or provinces of a country |
| GET | `/api/photo?q=Japan` | Photo URL with credit |
| GET | `/api/itinerary` | List saved places |
| POST | `/api/itinerary` | Add a country: `{"code":"JPN"}` |
| PATCH | `/api/itinerary/:code` | Update `day_number`, `notes` or `budget` |
| DELETE | `/api/itinerary/:code` | Remove a country (and its states) |
| POST | `/api/itinerary/:code/move` | Reorder within a day: `{"direction":"up"}` or `"down"` |
| GET / PATCH | `/api/trip` | Trip `name`, `start_date` and `num_days` (1 to 14) |
| POST | `/api/stops` | Add a state or place to a day: `{"code":"IND","name":"Kerala","day_number":2}` |
| PATCH | `/api/stops/:id` | Change `day_number`, `budget` or `notes` |
| DELETE | `/api/stops/:id` | Remove a state or place |

### Example requests and responses

**Search destinations**

```
GET /api/destinations?q=ital&sort=population&order=desc
```
```json
{
  "total": 1,
  "regions": ["Africa", "Americas", "Asia", "Europe", "Oceania"],
  "results": [
    { "code": "ITA", "name": "Italy", "capital": "Rome", "region": "Europe", "population": 59000000, "area": 301340, "flag": "https://flagcdn.com/it.svg", "latlng": [41.9, 12.5] }
  ]
}
```

**Add a country to the trip**

```
POST /api/itinerary
x-client-id: 3f9a1c2e-7b44-4d0e-9a51-0c6b2d8e1f77

{ "code": "ITA" }
```
```json
{ "id": 1, "code": "ITA", "name": "Italy", "capital": "Rome", "region": "Europe", "flag": "https://flagcdn.com/it.svg", "added_at": "2026-10-18 10:15:00" }
```

**Add a state to a day**

```
POST /api/stops
{ "code": "IND", "name": "Kerala", "day_number": 2 }
```
```json
{
  "trip": { "name": "My Trip", "start_date": null, "num_days": 3 },
  "items": [ { "code": "IND", "name": "India", "budget": 0 } ],
  "stops": [ { "id": 1, "code": "IND", "name": "Kerala", "day_number": 2, "notes": "", "budget": 0 } ]
}
```

**Common errors**

| Status | Meaning | Example body |
|---|---|---|
| 400 | Invalid input | `{"error":"Day must be between 1 and 3"}` |
| 404 | Record not found | `{"error":"Place not found"}` |
| 409 | Duplicate | `{"error":"Italy is already in your trip"}` |

## Project structure

```
Tripwise/
├── server.js          Express server, API routes, SQLite
├── package.json
├── .env.example       Environment variable template
├── data/fallback.csv  Offline destination list
└── public/            Frontend (index.html, logos, favicon)
```

## Deployment (Render)

1. Push the repository to GitHub and make it public.
2. On Render, create a Web Service from the repository.
3. Build command: `npm install`. Start command: `npm start`.
4. Set `NODE_VERSION` to `22`. Optionally set `UNSPLASH_ACCESS_KEY`.
5. For saved trips that survive restarts, use a paid instance with a disk and set `DB_PATH` to a path on that disk.

## Credits

- Country data: [Wikidata](https://www.wikidata.org) (CC0)
- Descriptions and fallback photos: [Wikipedia](https://www.wikipedia.org)
- Photography: [Unsplash](https://unsplash.com) and the photographers credited in the app
- Weather: [Open-Meteo](https://open-meteo.com)
- Maps: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, rendered with [Leaflet](https://leafletjs.com)


Built by **Shreyash Nidhan** for the AWS Student Builder Group, VIT Chennai.
