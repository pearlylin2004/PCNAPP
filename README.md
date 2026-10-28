# PCN Finder

A website for getting around Singapore on the Park Connector Network (PCN).

- **Directions:** pick a start and destination (search, your location, or click the map) and it
  plans a route that uses park connectors and park paths as much as possible. Where there's no
  PCN, it gives road directions to the next park connector.
- Choose cycling or walking (cycling skips paths where bikes aren't allowed, like stairs), and how
  strongly to prefer the PCN over a shorter road route.
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
| Map tiles and place search | [OneMap](https://www.onemap.gov.sg/), Singapore Land Authority |
| Road directions | [routing.openstreetmap.de](https://routing.openstreetmap.de/) (FOSSGIS), © OpenStreetMap contributors |

The road directions server is a free community service meant for light use. If the app gets
real traffic, switch to OneMap's routing API (needs a free account) or host your own.

To refresh the path data (needs [Go](https://go.dev/)):

```
go run scripts/build-data.go
```
