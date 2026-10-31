/* RouteTrack – UI + routing. Static, no backend. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const state = { tab: 'link', file: null, route: null, map: null, layer: null };

  /* ---------- small helpers ---------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 100000 ? 0 : 1) + ' km' : Math.round(m) + ' m');
  const fmtDur = (s) => { const m = Math.round(s / 60); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'; };

  function showAlert(msg, info) {
    const a = $('#alert');
    a.textContent = msg; a.hidden = !msg; a.classList.toggle('info', !!info);
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function fetchJSON(url, opts, what) {
    let res;
    try { res = await fetch(url, opts); } catch (e) { throw new Error('Could not reach ' + what + '. Check your internet connection and try again.'); }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && j.error.message) || j.message || ''; } catch (e) { /* ignore */ }
      throw new Error(what + ' returned an error (' + res.status + ')' + (detail ? ': ' + detail : '.'));
    }
    return res.json();
  }

  /* ---------- geocoding + routing ---------- */
  async function geocode(stop) {
    if (isFinite(stop.lat) && isFinite(stop.lon)) return stop;
    const j = await fetchJSON('https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=en&q=' + encodeURIComponent(stop.query), { headers: { Accept: 'application/json' } }, 'the address search (Nominatim)');
    if (!j.length) throw new Error('Could not find “' + stop.query + '”. Try a more specific address or use coordinates (lat, lon).');
    return Object.assign({}, stop, { lat: +j[0].lat, lon: +j[0].lon });
  }

  const OSRM = {
    drive: 'https://router.project-osrm.org/route/v1/driving/',
    walk: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/',
    bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/',
  };

  async function osrmRoute(stops, mode, progress) {
    const out = [];
    for (let i = 0; i < stops.length; i++) {
      const needs = !(isFinite(stops[i].lat) && isFinite(stops[i].lon));
      if (needs) { progress('Locating stop ' + (i + 1) + ' of ' + stops.length + '…'); if (i) await sleep(1100); }
      out.push(await geocode(stops[i]));
    }
    progress('Calculating route…');
    const path = out.map((s) => s.lon.toFixed(6) + ',' + s.lat.toFixed(6)).join(';');
    const j = await fetchJSON(OSRM[mode] + path + '?overview=full&geometries=geojson&steps=false', null, 'the OpenStreetMap routing service');
    if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error('No route could be found between these stops for this travel mode.');
    const r = j.routes[0];
    return { coords: r.geometry.coordinates.map((c) => [c[0], c[1]]), distance: r.distance, duration: r.duration, stops: out, source: 'OpenStreetMap (OSRM)' };
  }

  async function googleRoute(stops, mode, key, progress) {
    progress('Asking Google…');
    const wp = (s) => (isFinite(s.lat) && isFinite(s.lon) ? { location: { latLng: { latitude: s.lat, longitude: s.lon } } } : { address: s.query });
    const body = {
      origin: wp(stops[0]), destination: wp(stops[stops.length - 1]),
      intermediates: stops.slice(1, -1).map(wp),
      travelMode: { drive: 'DRIVE', walk: 'WALK', bike: 'BICYCLE' }[mode], polylineEncoding: 'GEO_JSON_LINESTRING',
    };
    if (mode === 'drive') body.routingPreference = 'TRAFFIC_UNAWARE';
    const j = await fetchJSON('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.geoJsonLinestring,routes.legs.startLocation,routes.legs.endLocation' },
      body: JSON.stringify(body),
    }, 'Google Routes API');
    const r = j.routes && j.routes[0];
    if (!r || !r.polyline) throw new Error('Google returned no route for these stops.');
    const ll = (o) => ({ lat: o.latLng.latitude, lon: o.latLng.longitude });
    const legs = r.legs || [];
    const pts = legs.length ? [ll(legs[0].startLocation)].concat(legs.map((l) => ll(l.endLocation))) : [];
    const resolved = stops.map((s, i) => (isFinite(s.lat) ? s : Object.assign({}, s, pts[i] || {})));
    return {
      coords: r.polyline.geoJsonLinestring.coordinates.map((c) => [c[0], c[1]]),
      distance: r.distanceMeters, duration: parseFloat(r.duration), stops: resolved, source: 'Google Routes API',
    };
  }

  /* ---------- main action ---------- */
  async function readFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'kmz') {
      const zip = await JSZip.loadAsync(file);
      const entry = Object.keys(zip.files).find((n) => /\.kml$/i.test(n));
      if (!entry) throw new Error('This KMZ has no KML inside.');
      return window.Parsers.parseSpatialFile('route.kml', await zip.files[entry].async('string')); // name replaced below
    }
    return window.Parsers.parseSpatialFile(file.name, await file.text());
  }

  async function run() {
    const btn = $('#go');
    showAlert('');
    const progress = (t) => { btn.textContent = t; };
    btn.disabled = true;
    try {
      let route, mode = $('#mode').value;
      if (state.tab === 'file') {
        if (!state.file) throw new Error('Choose a file first.');
        progress('Reading file…');
        const f = await readFile(state.file);
        let dist = 0; const cum = Exporters.cumulative(f.coords); dist = cum[cum.length - 1];
        route = { name: f.name === 'route' ? state.file.name.replace(/\.[^.]+$/, '') : f.name, coords: f.coords, stops: f.stops, distance: dist, duration: null, source: 'Imported file' };
      } else {
        let stops, notice = '';
        if (state.tab === 'link') {
          const p = Parsers.parseGoogleLink($('#link').value);
          stops = p.stops;
          if (p.mode === 'transit') notice = 'Transit routes can’t be exported as a line, so driving was used instead.';
          if (p.mode && p.mode !== 'transit' && !state.modeTouched) { $('#mode').value = mode = p.mode; }
        } else {
          stops = Parsers.parseStopLines($('#stops').value);
        }
        if (stops.length > 27) throw new Error('Too many stops – the limit is 27 (start, end and 25 in between).');
        const key = $('#apikey').value.trim();
        const r = key ? await googleRoute(stops, mode, key, progress) : await osrmRoute(stops, mode, progress);
        const first = r.stops[0].name, last = r.stops[r.stops.length - 1].name;
        route = Object.assign(r, { name: $('#rname').value.trim() || (first + ' to ' + last).slice(0, 80) });
        route.mode = mode;
        if (notice) showAlert(notice, true);
        if (key && $('#rememberKey').checked) store.set('rt_key', key);
      }
      route.mode = route.mode || mode;
      setRoute(route);
    } catch (e) {
      showAlert(e.message || String(e));
    } finally {
      btn.disabled = false; btn.textContent = 'Get route';
    }
  }

  /* ---------- preview ---------- */
  function ensureMap() {
    if (state.map) return;
    state.map = L.map('map', { scrollWheelZoom: false }).setView([3.14, 101.69], 6);
    const osmAttr = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    const base = {
      'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr }),
      'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Tiles © Esri' }),
    };
    base['OpenStreetMap'].addTo(state.map);
    L.control.layers(base, null, { position: 'topright' }).addTo(state.map);
  }

  function setRoute(route) {
    state.route = route;
    ensureMap();
    if (state.layer) state.layer.remove();
    const g = L.featureGroup().addTo(state.map);
    L.polyline(route.coords.map((c) => [c[1], c[0]]), { color: '#2c6fdf', weight: 5, opacity: .9 }).addTo(g);
    const stops = (route.stops || []).filter((s) => isFinite(s.lat));
    stops.forEach((s, i) => {
      const cls = i === 0 ? 'a' : i === stops.length - 1 ? 'z' : '';
      L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: '<div class="pin ' + cls + '">' + (i + 1) + '</div>', iconSize: [24, 24], iconAnchor: [12, 12] }) }).bindTooltip(s.name).addTo(g);
    });
    state.layer = g;
    state.map.invalidateSize();
    state.map.fitBounds(g.getBounds().pad(.12));

    const stat = (b, s) => '<div class="stat"><b>' + b + '</b><span>' + s + '</span></div>';
    $('#stats').innerHTML = stat(fmtKm(route.distance || 0), 'Distance') + stat(route.duration ? fmtDur(route.duration) : '–', 'Duration') +
      stat(route.coords.length.toLocaleString(), 'Track points') + stat(stops.length, 'Stops');
    const pill = $('#status'); pill.textContent = 'Route ready · ' + fmtKm(route.distance || 0); pill.classList.add('ok');
    $$('[data-fmt]').forEach((b) => { b.disabled = false; });
    $('#all').disabled = false;
    $('#blockPreview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---------- export ---------- */
  function timeOpt() {
    if (!$('#useTime').checked || !$('#startTime').value) return {};
    const d = new Date($('#startTime').value); // datetime-local is parsed as local time
    return isNaN(d) ? {} : { start: d };
  }

  async function exportAs(fmt) {
    const r = state.route; if (!r) return;
    const base = Exporters.slug(r.name), t = timeOpt();
    const text = (s, ext, mime) => download(new Blob([s], { type: mime }), base + ext);
    if (fmt === 'gpx') text(Exporters.toGPX(r, t), '.gpx', 'application/gpx+xml');
    else if (fmt === 'gpxr') text(Exporters.toGPX(r, Object.assign({ asRoute: true }, t)), '-route.gpx', 'application/gpx+xml');
    else if (fmt === 'geojson') text(Exporters.toGeoJSON(r), '.geojson', 'application/geo+json');
    else if (fmt === 'kml') text(Exporters.toKML(r), '.kml', 'application/vnd.google-earth.kml+xml');
    else if (fmt === 'csv') text(Exporters.toCSV(r, t), '.csv', 'text/csv');
    else if (fmt === 'shp') download(await Exporters.toShapefileZip(r), base + '-shapefile.zip');
    else if (fmt === 'all') download(await Exporters.toAllZip(r, t), base + '-all-formats.zip');
  }

  /* ---------- wiring ---------- */
  function init() {
    // tabs
    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      state.tab = t.dataset.tab;
      $$('.tab').forEach((x) => { const on = x === t; x.classList.toggle('on', on); x.setAttribute('aria-selected', on); });
      ['link', 'stops', 'file'].forEach((k) => { $('#pane-' + k).hidden = k !== state.tab; });
      $('#routeOpts').hidden = state.tab === 'file';
      showAlert('');
    }));
    $('#mode').addEventListener('change', () => { state.modeTouched = true; });

    // file input + drag/drop
    const drop = $('#drop'), input = $('#file');
    const pick = (f) => { if (!f) return; state.file = f; drop.querySelector('strong').textContent = f.name; showAlert(''); };
    input.addEventListener('change', () => pick(input.files[0]));
    ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (ev) => pick(ev.dataTransfer.files[0]));

    // saved key
    const k = store.get('rt_key');
    if (k) { $('#apikey').value = k; $('#rememberKey').checked = true; }
    $('#rememberKey').addEventListener('change', (e) => { if (!e.target.checked) store.del('rt_key'); });

    // default timestamp = now (local)
    const n = new Date(); n.setMinutes(n.getMinutes() - n.getTimezoneOffset(), 0);
    $('#startTime').value = n.toISOString().slice(0, 16);

    $('#go').addEventListener('click', run);
    ['#link'].forEach((s) => $(s).addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); }));
    $$('[data-fmt]').forEach((b) => b.addEventListener('click', () => exportAs(b.dataset.fmt)));
    $('#all').addEventListener('click', () => exportAs('all'));
  }
  init();
  window.__rt = { setRoute, state }; // handy for debugging
})();
