# PCN Finder

A website for getting around Singapore on the Park Connector Network (PCN).

- **Directions:** pick a start and destination (search, your location, or click the map) and it
  plans a route that uses park connectors and park paths as much as possible. Where there's no
  PCN, it gives road directions to the next park connector.
- Choose cycling, running or walking (cycling skips paths where bikes aren't allowed, like stairs),
  and how strongly to prefer the PCN over a shorter road route.
- **Time estimate:** moving time (your running pace, e.g. `6:00` /km, or a typical cycling/walking
  speed) plus an average wait at every traffic light on the route (40 s by default, adjustable).
  Pace and wait are remembered in the browser.
- **Toilets and water points** show on the map when zoomed in, and each route lists the ones within
  150 m of it, with how far into the trip you reach them.
- **Saved places:** save any spot from its map popup (⭐ Save), use it as a start or destination,
  rename or delete it, and 📌 pin it so it always shows on the map. Saved places live in the
  browser's local storage, so they stay on that device.
- **Explore:** search a park connector or park, find the PCN nearest to you, and show the named PCN loops.

## Running it

Double-click `index.html`. It needs an internet connection for the map, place search and road directions.

## How routing works

`graph.js` turns every NParks path into a graph. Path distance costs normally, and distance
off the network costs more (the "Prefer PCN" setting). Dead ends in the network are linked to
nearby paths by straight-line hops. The cheapest route is found with Dijkstra's algorithm.
`app.js` then asks a road router for real directions for each off-network stretch.

## Data and services

| What | Source |
|------|--------|
| All NParks paths (park connectors + park paths), `data/tracks.js` | [NParks Tracks](https://data.gov.sg/collections/1488/view), data.gov.sg |
| PCN loops, `data/pcn.js` | [Park Connector Loop](https://data.gov.sg/datasets/d_a69ef89737379f231d2ae93fd1c5707f/view), data.gov.sg |
| Toilets and drinking water, `data/amenities.js` | [NParks Park Facilities](https://data.gov.sg/collections/1495/view) + [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL) |
| Traffic lights, `data/signals.js` | [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL), signal points within 30 m merged into one junction |
| Map tiles and place search | [OneMap](https://www.onemap.gov.sg/), Singapore Land Authority |
| Road directions | [routing.openstreetmap.de](https://routing.openstreetmap.de/) (FOSSGIS), © OpenStreetMap contributors |

The road directions server is a free community service meant for light use. If the app gets
real traffic, switch to OneMap's routing API (needs a free account) or host your own.

To refresh the path data (needs [Go](https://go.dev/)):

```
go run scripts/build-data.go
```
