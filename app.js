// PCN Finder: plan a walk or ride across Singapore that uses the Park Connector Network
// as much as possible, with road directions for the stretches between park connectors.
// PCN data comes from data/pcn.js (window.PCN_DATA); route finding lives in graph.js.

const LOOP_COLOURS = {
  'Central Urban Loop': '#e53935',
  'Urban Central Loop': '#e53935', // same loop, spelled differently in the source data
  'Eastern Coastal Loop': '#1e88e5',
  'North Eastern Riverine Loop': '#8e24aa',
  'Northern Explorer Loop': '#43a047',
  'Southern Ridges Loop': '#fb8c00',
  'Western Adventure Loop': '#00897b',
};
const DEFAULT_COLOUR = '#607d8b';
const SPEED_KMH = { bike: 15, foot: 5 };
const SHORT_HOP = 40; // m: road gaps shorter than this are drawn straight, without directions

const $ = (id) => document.getElementById(id);

const map = L.map('map').setView([1.3521, 103.8198], 12);

// OneMap is Singapore's official basemap (Singapore Land Authority).
L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png', {
  minZoom: 11,
  maxZoom: 19,
  attribution: '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:20px;width:20px;vertical-align:middle"> ' +
    '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener">OneMap</a> &copy; contributors | ' +
    '<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener">Singapore Land Authority</a>',
}).addTo(map);
map.setMaxBounds([[1.15, 103.55], [1.50, 104.10]]);

// ---------- Formatting helpers ----------

const formatDistance = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

function formatTime(metres, mode) {
  const mins = Math.max(1, Math.round(metres / 1000 / SPEED_KMH[mode] * 60));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const toLngLat = ([lat, lng]) => [lng, lat];
const toLatLngs = (coords) => coords.map(([lng, lat]) => [lat, lng]);

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------- Tabs ----------

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${btn.dataset.tab}`; });
  };
});

// ---------- Path network layer ----------
// All NParks paths: park connectors in dark green, paths inside parks in light green.

const renderer = L.canvas({ tolerance: 6 }); // canvas copes with 20,000+ lines much better than SVG
let networkOpacity = 0.9;
const colourFor = (loop) => LOOP_COLOURS[loop] || DEFAULT_COLOUR;
const baseStyle = (f) => (f.properties.pc
  ? { color: '#2e7d32', weight: 3, opacity: networkOpacity }
  : { color: '#8bc34a', weight: 2, opacity: networkOpacity * 0.8 });
const highlightStyle = { color: '#ffeb3b', weight: 8, opacity: 1 };

const pathsByName = {}; // path / park name -> [leaflet layers]

const network = L.geoJSON(window.TRACKS_DATA, {
  renderer,
  style: baseStyle,
  onEachFeature(feature, layer) {
    const { name, pc, bike } = feature.properties;
    layer.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      const kind = pc ? 'Park connector' : 'Park path';
      openPointPopup(e.latlng, name || kind, `${name ? `${kind} · ` : ''}${bike ? 'Cycling allowed' : 'Walking only'}`);
    });
    if (name) (pathsByName[name] ||= []).push(layer);
  },
}).addTo(map);

function setNetworkFaded(faded) {
  networkOpacity = faded ? 0.35 : 0.9;
  network.setStyle(baseStyle);
}

// The named PCN loops, shown as coloured overlays from the Explore tab.
const layersByLoop = {}; // loop name -> L.LayerGroup
L.geoJSON(window.PCN_DATA, {
  renderer,
  interactive: false,
  style: (f) => ({ color: colourFor(f.properties.PCN_LOOP), weight: 5, opacity: 0.9 }),
  onEachFeature(feature, layer) {
    const loop = feature.properties.PCN_LOOP || 'Other';
    (layersByLoop[loop] ||= L.layerGroup()).addLayer(layer);
  },
});

// ---------- Toilets and water points ----------

const AMENITY_TYPES = {
  toilet: { icon: '🚻', label: 'Toilet' },
  water: { icon: '💧', label: 'Water point' },
};
const AMENITY_MIN_ZOOM = 14; // hidden when zoomed further out, or the map gets crowded
const NEAR_ROUTE = 150;      // m: how far off the route a stop can be and still be listed
const STOP_SPACING = 500;    // m: skip stops of the same type closer than this along the route

const amenityIcon = (type, onRoute) => L.divIcon({
  className: `amenity-icon${onRoute ? ' on-route' : ''}`,
  html: AMENITY_TYPES[type].icon,
  iconSize: onRoute ? [28, 28] : [22, 22],
});
const amenityName = (a) => a.name || AMENITY_TYPES[a.type].label;
const amenityDetails = (a) => [a.info, `Source: ${a.src}`].filter(Boolean).join(' · ');
const showAmenity = (type) => $(`show-${type}`).checked;

function openAmenity(a) {
  openPointPopup(L.latLng(a.lat, a.lng), amenityName(a), amenityDetails(a));
}

const amenityGroups = { toilet: L.layerGroup(), water: L.layerGroup() };
for (const a of window.AMENITIES) {
  L.marker([a.lat, a.lng], { icon: amenityIcon(a.type), title: AMENITY_TYPES[a.type].label, keyboard: false })
    .on('click', () => openAmenity(a))
    .addTo(amenityGroups[a.type]);
}

function updateAmenities() {
  for (const [type, group] of Object.entries(amenityGroups)) {
    const visible = showAmenity(type) && map.getZoom() >= AMENITY_MIN_ZOOM;
    if (visible && !map.hasLayer(group)) map.addLayer(group);
    if (!visible && map.hasLayer(group)) map.removeLayer(group);
  }
}
map.on('zoomend', updateAmenities);
updateAmenities();

// ---------- Saved and pinned places ----------
// Kept in this browser's localStorage, so they survive closing the page but stay on this device.

const SAVED_KEY = 'pcnFinder.savedPlaces';
const SAME_PLACE = 15; // m: a spot this close to a saved place counts as already saved

let savedPlaces = loadSaved(); // [{ id, name, latlng: [lat, lng], pinned }]

function loadSaved() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_KEY));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function storeSaved() {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(savedPlaces));
  } catch {
    // Storage blocked (e.g. private browsing): places still work until the page is closed.
  }
}

const sortedSaved = () => [...savedPlaces].sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name));
const findSaved = (latlng) => savedPlaces.find((p) => PCNGraph.distance(toLngLat(p.latlng), toLngLat(latlng)) < SAME_PLACE);

function savePlace(suggestedName, latlng) {
  const name = prompt('Name this place', suggestedName.startsWith('Pin at') ? '' : suggestedName);
  if (!name || !name.trim()) return;
  savedPlaces.push({ id: Date.now().toString(36), name: name.trim(), latlng, pinned: false });
  updateSaved();
}

function updateSaved() {
  storeSaved();
  renderSaved();
  drawPins();
}

const pinLayer = L.layerGroup().addTo(map);
function drawPins() {
  pinLayer.clearLayers();
  for (const p of savedPlaces.filter((s) => s.pinned)) {
    L.marker(p.latlng, {
      icon: L.divIcon({ className: 'pin-icon', html: '📌', iconSize: [24, 24], iconAnchor: [6, 22] }),
      title: p.name,
      zIndexOffset: 500,
    })
      .bindTooltip(p.name, { permanent: true, direction: 'top', offset: [6, -20], className: 'pin-label' })
      .on('click', () => openPointPopup(L.latLng(p.latlng), p.name, 'Pinned place'))
      .addTo(pinLayer);
  }
}

function renderSaved() {
  const list = $('saved-list');
  list.innerHTML = '';
  $('saved-count').textContent = savedPlaces.length || '';
  if (!savedPlaces.length) {
    list.appendChild(el('li', 'empty', 'No saved places yet.'));
    return;
  }
  for (const p of sortedSaved()) {
    const li = el('li');
    const button = (className, text, title, onclick) => {
      const b = el('button', className, text);
      b.title = title;
      b.onclick = onclick;
      li.appendChild(b);
    };
    button(`pin-btn${p.pinned ? ' on' : ''}`, '📌', p.pinned ? 'Unpin from the map' : 'Pin on the map', () => {
      p.pinned = !p.pinned;
      updateSaved();
    });
    button('saved-name', p.name, 'Show on the map', () => {
      map.setView(p.latlng, Math.max(map.getZoom(), 16));
      openPointPopup(L.latLng(p.latlng), p.name, p.pinned ? 'Pinned place' : 'Saved place');
    });
    button('small-btn', 'From', 'Start from here', () => setPlace('from', { label: p.name, latlng: p.latlng }));
    button('small-btn', 'To', 'Go here', () => setPlace('to', { label: p.name, latlng: p.latlng }));
    button('small-btn', '✏️', 'Rename', () => {
      const name = prompt('Rename this place', p.name);
      if (name && name.trim()) {
        p.name = name.trim();
        updateSaved();
      }
    });
    button('small-btn', '✕', 'Delete', () => {
      if (!confirm(`Delete "${p.name}"?`)) return;
      savedPlaces = savedPlaces.filter((s) => s !== p);
      updateSaved();
    });
    list.appendChild(li);
  }
}

renderSaved();
drawPins();

// ---------- Choosing start and destination ----------

const places = { from: null, to: null }; // { label, latlng: [lat, lng] }
const placeMarkers = { from: null, to: null };
const MARKER_COLOURS = { from: '#2e7d32', to: '#d32f2f' };

function setPlace(which, place) {
  places[which] = place;
  $(which).value = place ? place.label : '';
  $(`${which}-list`).innerHTML = '';
  if (placeMarkers[which]) placeMarkers[which].remove();
  placeMarkers[which] = place && L.circleMarker(place.latlng, {
    radius: 9, color: '#fff', weight: 3, fillColor: MARKER_COLOURS[which], fillOpacity: 1,
  }).addTo(map).bindTooltip(place.label).on('click', () => openPointPopup(L.latLng(place.latlng), place.label));
  if (places.from && places.to) planRoute();
  else if (place) map.panTo(place.latlng);
}

// Popup on the map with "Start here" / "Go here" buttons. `name` and `sub` are optional.
function openPointPopup(latlng, name, sub) {
  const box = el('div');
  if (name) {
    const title = el('div', 'popup-title');
    title.append(el('strong', null, name));
    if (sub) title.append(el('br'), sub);
    box.appendChild(title);
  }
  const btns = el('div', 'popup-btns');
  const label = name || `Pin at ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  for (const [which, text] of [['from', 'Start here'], ['to', 'Go here']]) {
    const b = el('button', null, text);
    b.onclick = () => {
      map.closePopup();
      setPlace(which, { label, latlng: [latlng.lat, latlng.lng] });
    };
    btns.appendChild(b);
  }
  const saved = findSaved([latlng.lat, latlng.lng]);
  const save = el('button', null, saved ? '★ Saved' : '⭐ Save');
  save.disabled = Boolean(saved);
  save.onclick = () => {
    map.closePopup();
    savePlace(name || '', [latlng.lat, latlng.lng]);
  };
  btns.appendChild(save);
  box.appendChild(btns);
  L.popup().setLatLng(latlng).setContent(box).openOn(map);
}

map.on('click', (e) => {
  clearHighlight();
  openPointPopup(e.latlng);
});

// Place search using OneMap (no API key needed for search).
async function searchPlaces(query) {
  const url = 'https://www.onemap.gov.sg/api/common/elastic/search?returnGeom=Y&getAddrDetails=Y&pageNum=1&searchVal=' +
    encodeURIComponent(query);
  const data = await (await fetch(url)).json();
  return (data.results || []).slice(0, 6).map((r) => ({
    label: titleCase(r.SEARCHVAL),
    detail: r.ADDRESS && r.ADDRESS !== r.SEARCHVAL ? titleCase(r.ADDRESS) : '',
    latlng: [Number(r.LATITUDE), Number(r.LONGITUDE)],
  }));
}

function setupPlaceInput(which) {
  const input = $(which), list = $(`${which}-list`);
  let timer, latest = 0;

  // Saved places matching the text come first, before OneMap results.
  const savedMatches = (q) => sortedSaved()
    .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
    .map((p) => ({ label: p.name, detail: p.pinned ? 'Pinned place' : 'Saved place', latlng: p.latlng, saved: true }));

  const show = (results) => {
    list.innerHTML = '';
    for (const place of results) {
      const li = el('li', null, `${place.saved ? '⭐ ' : ''}${place.label}`);
      if (place.detail) li.appendChild(el('small', null, place.detail));
      li.onmousedown = (e) => e.preventDefault(); // keep focus so the blur handler doesn't hide the list first
      li.onclick = () => setPlace(which, place);
      list.appendChild(li);
    }
  };

  input.addEventListener('focus', () => { if (!input.value.trim()) show(savedMatches('')); });
  input.addEventListener('blur', () => { list.innerHTML = ''; });
  input.addEventListener('input', () => {
    places[which] = null;
    clearTimeout(timer);
    const q = input.value.trim();
    const mine = savedMatches(q);
    show(mine);
    if (q.length < 2) return;
    timer = setTimeout(async () => {
      const request = ++latest;
      let results;
      try { results = await searchPlaces(q); } catch { results = []; }
      if (request !== latest) return; // a newer search has started
      show(mine.concat(results));
      if (!list.children.length) list.appendChild(el('li', null, 'No places found'));
    }, 300);
  });
}
setupPlaceInput('from');
setupPlaceInput('to');

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('your browser does not support location')); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve([coords.latitude, coords.longitude]),
      reject,
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

$('use-location').onclick = async () => {
  $('route-status').textContent = 'Finding you…';
  try {
    setPlace('from', { label: 'My location', latlng: await getLocation() });
    if (!places.to) $('route-status').textContent = '';
  } catch (err) {
    $('route-status').textContent = `Couldn't get your location (${err.message}).`;
  }
};

$('swap').onclick = () => {
  const { from, to } = places;
  places.from = null; // avoid planning twice
  setPlace('to', from);
  setPlace('from', to);
};

$('mode').onchange = $('pref').onchange = () => planRoute();

// ---------- Road directions for the gaps between PCNs ----------

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

// One OSRM step -> a human-readable instruction (or null to skip it).
function describeStep(step) {
  const { type, modifier, bearing_after: bearing, exit } = step.maneuver;
  const name = step.name ? ` onto ${step.name}` : '';
  const dist = step.distance >= 10 ? ` · ${formatDistance(step.distance)}` : '';
  if (type === 'arrive') return null;
  if (type === 'depart') return `Head ${COMPASS[Math.round(bearing / 45) % 8]}${step.name ? ` on ${step.name}` : ''}${dist}`;
  if (type === 'roundabout' || type === 'rotary') return `At the roundabout, take exit ${exit || 1}${name}${dist}`;
  const turn = {
    left: 'Turn left', right: 'Turn right', 'slight left': 'Keep slightly left', 'slight right': 'Keep slightly right',
    'sharp left': 'Turn sharp left', 'sharp right': 'Turn sharp right', uturn: 'Make a U-turn', straight: 'Continue straight',
  }[modifier] || 'Continue';
  return `${turn}${name}${dist}`;
}

// Fill a road leg with a real path and directions from routing.openstreetmap.de.
async function fillRoadLeg(leg, mode) {
  const straight = PCNGraph.distance(leg.from, leg.to);
  leg.coords = [leg.from, leg.to];
  leg.steps = [];
  leg.dist = straight;
  if (straight < SHORT_HOP) { leg.short = true; return; }
  const profile = mode === 'foot' ? 'routed-foot' : 'routed-bike';
  const url = `https://routing.openstreetmap.de/${profile}/route/v1/driving/` +
    `${leg.from.join(',')};${leg.to.join(',')}?overview=full&geometries=geojson&steps=true`;
  try {
    const data = await (await fetch(url)).json();
    const r = data.routes[0];
    leg.coords = [leg.from, ...r.geometry.coordinates, leg.to];
    leg.dist = r.distance;
    leg.steps = r.legs[0].steps.map(describeStep).filter(Boolean);
  } catch {
    leg.approx = true; // routing service unavailable: keep the straight line
    leg.dist = straight * 1.3;
  }
}

// ---------- Planning and drawing the route ----------

const routeLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
let planCount = 0;
let currentLegs = null;

async function planRoute() {
  const { from, to } = places;
  if (!from || !to) return;
  const plan = ++planCount;
  const mode = $('mode').value;
  $('route-status').textContent = 'Working out the best route…';
  $('summary').innerHTML = '';
  $('itinerary').innerHTML = '';
  $('stops').hidden = true;

  await new Promise((r) => setTimeout(r, 20)); // let the status message show before the heavy work
  const legs = PCNGraph.route(toLngLat(from.latlng), toLngLat(to.latlng), Number($('pref').value), mode);
  await Promise.all(legs.filter((l) => l.kind === 'road').map((l) => fillRoadLeg(l, mode)));
  if (plan !== planCount) return; // the user changed something in the meantime

  $('route-status').textContent = legs.some((l) => l.approx)
    ? "Couldn't reach the road directions service, so some road sections are shown as straight lines."
    : '';
  drawRoute(legs);
  renderItinerary(legs, mode);
  currentLegs = legs;
  renderStops(legs);
  $('clear-route').hidden = false;
}

// Toilets and water points near the route, in the order you reach them.
function renderStops(legs) {
  stopLayer.clearLayers();
  const list = $('stops-list');
  list.innerHTML = '';

  const line = legs.flatMap((l) => l.coords);
  const bounds = L.latLngBounds(toLatLngs(line)).pad(0.05);
  const lastAt = {};
  const stops = window.AMENITIES
    .filter((a) => showAmenity(a.type) && bounds.contains([a.lat, a.lng]))
    .map((a) => ({ a, ...PCNGraph.locateAlong(line, [a.lng, a.lat]) }))
    .filter((s) => s.d <= NEAR_ROUTE)
    .sort((x, y) => x.at - y.at)
    .filter((s) => {
      if (s.at - (lastAt[s.a.type] ?? -Infinity) < STOP_SPACING) return false;
      lastAt[s.a.type] = s.at;
      return true;
    });

  if (!stops.length && (showAmenity('toilet') || showAmenity('water'))) {
    list.appendChild(el('li', null, `None within ${NEAR_ROUTE} m of this route.`));
  }
  for (const { a, d, at } of stops) {
    const li = el('li');
    const text = el('div', null, amenityName(a));
    text.appendChild(el('small', null, d < 20 ? 'On the route' : `${formatDistance(d)} off the route`));
    li.append(el('span', null, AMENITY_TYPES[a.type].icon), text, el('span', 'at', `at ${formatDistance(at)}`));
    li.onclick = () => {
      map.setView([a.lat, a.lng], 17);
      openAmenity(a);
    };
    list.appendChild(li);
    L.marker([a.lat, a.lng], { icon: amenityIcon(a.type, true), title: AMENITY_TYPES[a.type].label, zIndexOffset: 1000 })
      .on('click', () => openAmenity(a))
      .addTo(stopLayer);
  }
  $('stops').hidden = !list.children.length;
}

$('show-toilet').onchange = $('show-water').onchange = () => {
  updateAmenities();
  if (currentLegs) renderStops(currentLegs);
};

function drawRoute(legs) {
  routeLayer.clearLayers();
  setNetworkFaded(true);
  for (const leg of legs) {
    const latlngs = toLatLngs(leg.coords);
    if (leg.kind === 'path') {
      L.polyline(latlngs, { color: '#fff', weight: 11, opacity: 1, interactive: false }).addTo(routeLayer);
      L.polyline(latlngs, { color: '#1b5e20', weight: 7, opacity: 1, interactive: false }).addTo(routeLayer);
    } else {
      L.polyline(latlngs, { color: '#1565c0', weight: 5, opacity: 0.9, dashArray: '2 9', interactive: false }).addTo(routeLayer);
    }
  }
  Object.values(placeMarkers).forEach((m) => m && m.bringToFront());
  map.fitBounds(L.featureGroup(routeLayer.getLayers()).getBounds(), { padding: [40, 40] });
}

function renderItinerary(legs, mode) {
  const total = legs.reduce((s, l) => s + l.dist, 0);
  const onPaths = legs.filter((l) => l.kind === 'path').reduce((s, l) => s + l.dist, 0);
  const pct = total ? Math.round(onPaths / total * 100) : 0;

  const summary = $('summary');
  summary.appendChild(el('div', 'big', `${formatTime(total, mode)} · ${formatDistance(total)}`));
  summary.appendChild(el('small', null, `${pct}% on park connectors & park paths (${formatDistance(onPaths)})`));
  const bar = el('div', 'bar');
  const fill = el('span');
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);
  summary.appendChild(bar);

  const list = $('itinerary');
  const verb = mode === 'foot' ? 'Walk' : 'Cycle';
  const addItem = (className, icon, text, sub, coords) => {
    const li = el('li', className);
    li.appendChild(el('span', 'icon', icon));
    li.appendChild(document.createTextNode(text));
    if (sub) li.appendChild(el('small', null, sub));
    if (coords) li.onclick = (e) => {
      if (e.target.closest('details')) return;
      map.fitBounds(L.latLngBounds(toLatLngs(coords)), { padding: [60, 60], maxZoom: 18 });
    };
    list.appendChild(li);
    return li;
  };

  addItem('', '🟢', places.from.label);
  legs.forEach((leg, i) => {
    if (leg.kind === 'path') {
      const kind = leg.pc ? 'Park connector' : 'Park path';
      addItem('pcn', '🌳', leg.name ? `Follow ${leg.name}` : `Follow the ${kind.toLowerCase()}`,
        `${formatDistance(leg.dist)} · ${kind}`, leg.coords);
      return;
    }
    if (leg.short) return; // just a few steps across to the next path
    const next = legs.slice(i + 1).find((l) => l.kind === 'path');
    const target = next ? (next.name ? `the start of ${next.name}` : 'the next park connector') : places.to.label;
    const li = addItem('road', mode === 'foot' ? '🚶' : '🚲', `${verb} to ${target}`,
      `${formatDistance(leg.dist)} on roads / paths${leg.approx ? ' (approximate)' : ''}`, leg.coords);
    if (leg.steps.length) {
      const details = el('details');
      details.appendChild(el('summary', null, `${leg.steps.length} directions`));
      const ol = el('ol');
      leg.steps.forEach((s) => ol.appendChild(el('li', null, s)));
      details.appendChild(ol);
      li.appendChild(details);
    }
  });
  addItem('', '🏁', places.to.label);
}

$('clear-route').onclick = () => {
  planCount++;
  currentLegs = null;
  routeLayer.clearLayers();
  stopLayer.clearLayers();
  $('stops').hidden = true;
  setNetworkFaded(false);
  setPlace('from', null);
  setPlace('to', null);
  $('summary').innerHTML = '';
  $('itinerary').innerHTML = '';
  $('route-status').textContent = '';
  $('clear-route').hidden = true;
};

// ---------- Explore tab: highlight a park connector or park ----------

let highlighted = [];
function clearHighlight() {
  highlighted.forEach((l) => l.setStyle(baseStyle(l.feature)));
  highlighted = [];
}

function showPark(name) {
  clearHighlight();
  highlighted = pathsByName[name] || [];
  highlighted.forEach((l) => { l.setStyle(highlightStyle); l.bringToFront(); });
  if (!highlighted.length) return;
  const bounds = L.featureGroup(highlighted).getBounds();
  map.fitBounds(bounds, { padding: [40, 40] });
  openPointPopup(bounds.getCenter(), name, highlighted[0].feature.properties.pc ? 'Park connector' : 'Park');
}

const parkNames = Object.keys(pathsByName).sort();
$('search').addEventListener('input', () => {
  const q = $('search').value.trim().toLowerCase();
  const results = $('results');
  results.innerHTML = '';
  if (!q) return;
  for (const name of parkNames.filter((n) => n.toLowerCase().includes(q)).slice(0, 30)) {
    const li = el('li', null, name);
    li.onclick = () => showPark(name);
    results.appendChild(li);
  }
});

// ---------- Explore tab: loop list (toggle loops on/off) ----------

for (const loop of Object.keys(layersByLoop).sort()) {
  const group = layersByLoop[loop];
  const li = el('li');
  const swatch = el('span', 'swatch');
  swatch.style.background = colourFor(loop);
  li.append(swatch, loop, el('span', 'count', String(group.getLayers().length)));
  li.title = 'Click to show / hide on the map';
  li.classList.add('off');
  li.onclick = () => {
    if (map.hasLayer(group)) { map.removeLayer(group); li.classList.add('off'); }
    else { map.addLayer(group); li.classList.remove('off'); }
  };
  $('loops').appendChild(li);
}

// ---------- Explore tab: nearest PCN to the user ----------

let youMarker;
$('locate').onclick = async () => {
  $('nearest').textContent = 'Finding you…';
  try {
    const here = await getLocation();
    const best = PCNGraph.nearestPCN(toLngLat(here));
    if (youMarker) youMarker.remove();
    youMarker = L.circleMarker(here, { radius: 8, color: '#1565c0', fillOpacity: 0.9 }).addTo(map).bindTooltip('You are here');
    showPark(best.name);
    map.fitBounds(L.latLngBounds([here, [best.pt[1], best.pt[0]]]), { padding: [60, 60], maxZoom: 17 });
    $('nearest').textContent = `Nearest park connector: ${best.name || 'unnamed'}, about ${formatDistance(best.d)} away (straight line).`;
  } catch (err) {
    $('nearest').textContent = `Couldn't get your location (${err.message}).`;
  }
};
