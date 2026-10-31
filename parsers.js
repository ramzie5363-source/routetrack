/* RouteTrack – input parsers (Google Maps links, typed stops, KML/GPX/GeoJSON files) */
(function (root) {
  'use strict';

  const SHORT_MSG =
    'Short links (maps.app.goo.gl) can’t be opened from a web page. Open the link in your browser first, then copy the full address from the address bar (it starts with google.com/maps/dir/…) and paste that here.';

  function parseCoord(s) {
    const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(s || '');
    if (!m) return null;
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function stopFrom(q) {
    q = (q || '').trim();
    const c = parseCoord(q);
    return c ? { query: q, name: c.lat.toFixed(5) + ', ' + c.lon.toFixed(5), lat: c.lat, lon: c.lon } : { query: q, name: q };
  }

  const safeDecode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s.replace(/\+/g, ' '); } };
  const MODE_WORDS = { driving: 'drive', walking: 'walk', bicycling: 'bike', transit: 'transit' };
  const MODE_CODES = { 0: 'drive', 1: 'bike', 2: 'walk', 3: 'transit' };

  /** Google Maps directions URL -> { stops:[{query,name,lat?,lon?}], mode } */
  function parseGoogleLink(raw) {
    raw = (raw || '').trim();
    if (!raw) throw new Error('Paste a Google Maps directions link first.');
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    let u;
    try { u = new URL(raw); } catch (e) { throw new Error('That doesn’t look like a valid link.'); }
    const host = u.hostname.toLowerCase();
    if (host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'g.co') throw new Error(SHORT_MSG);
    if (!/(^|\.)google\.[a-z.]+$/.test(host)) throw new Error('This doesn’t look like a Google Maps link.');

    const sp = u.searchParams;
    let stops = [], mode = null;

    if (sp.get('destination')) {                       // ?api=1&origin=…&destination=…&waypoints=a|b
      const w = (sp.get('waypoints') || '').split('|').filter(Boolean);
      [sp.get('origin'), ...w, sp.get('destination')].filter(Boolean).forEach((q) => stops.push(stopFrom(q)));
      mode = MODE_WORDS[(sp.get('travelmode') || '').toLowerCase()] || null;
    } else if (sp.get('daddr')) {                      // legacy ?saddr=…&daddr=a+to:b
      const parts = [sp.get('saddr'), ...sp.get('daddr').split(/\s+to:/i)].filter(Boolean);
      parts.forEach((q) => stops.push(stopFrom(q)));
    } else {
      const segs = u.pathname.split('/').filter((s) => s !== '');
      const i = segs.indexOf('dir');
      if (i < 0) throw new Error('This link has no directions in it. In Google Maps choose “Directions”, enter your stops, then copy the address bar.');
      for (let k = i + 1; k < segs.length; k++) {
        if (segs[k].startsWith('@') || segs[k].startsWith('data=')) break;
        const t = safeDecode(segs[k]).trim();
        if (t) stops.push(stopFrom(t));
      }
      const data = safeDecode(u.pathname);
      const pairs = [];
      const re = /!2m2!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g;
      let m;
      while ((m = re.exec(data))) pairs.push({ lon: +m[1], lat: +m[2] });
      if (pairs.length === stops.length) stops.forEach((s, j) => { s.lat = pairs[j].lat; s.lon = pairs[j].lon; });
      const mm = /!3e(\d)/.exec(data);
      if (mm) mode = MODE_CODES[mm[1]] || null;
    }
    if (stops.length < 2) throw new Error('Need at least a start and an end point in the link.');
    return { stops, mode };
  }

  /** One stop per line: address or "lat, lon" */
  function parseStopLines(text) {
    const stops = (text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(stopFrom);
    if (stops.length < 2) throw new Error('Enter at least two stops (start and end), one per line.');
    return stops;
  }

  /* ---------- spatial files ---------- */
  const num = (v) => parseFloat(v);
  const kids = (el, tag) => Array.from(el.getElementsByTagName(tag));

  function parseKmlCoords(txt) {
    return (txt || '').trim().split(/\s+/).map((t) => t.split(',').map(num)).filter((a) => a.length >= 2 && isFinite(a[0]) && isFinite(a[1])).map((a) => [a[0], a[1]]);
  }

  function parseSpatialFile(name, text) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    let coords = [], stops = [], title = name.replace(/\.[^.]+$/, '');

    if (ext === 'geojson' || ext === 'json') {
      const gj = JSON.parse(text);
      const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ type: 'Feature', geometry: gj, properties: {} }];
      feats.forEach((f) => {
        const g = f.geometry; if (!g) return;
        if (g.type === 'LineString') coords.push(...g.coordinates.map((c) => [c[0], c[1]]));
        else if (g.type === 'MultiLineString') g.coordinates.forEach((l) => coords.push(...l.map((c) => [c[0], c[1]])));
        else if (g.type === 'Point') stops.push({ name: (f.properties && (f.properties.name || f.properties.NAME)) || 'Stop', lon: g.coordinates[0], lat: g.coordinates[1] });
      });
    } else if (ext === 'kml' || ext === 'gpx') {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not read this file – is it valid ' + ext.toUpperCase() + '?');
      if (ext === 'kml') {
        kids(doc, 'Placemark').forEach((pm) => {
          const nm = (pm.getElementsByTagName('name')[0] || {}).textContent || '';
          kids(pm, 'LineString').forEach((ls) => coords.push(...parseKmlCoords((ls.getElementsByTagName('coordinates')[0] || {}).textContent)));
          kids(pm, 'gx:coord').forEach((c) => { const a = c.textContent.trim().split(/\s+/).map(num); if (a.length >= 2) coords.push([a[0], a[1]]); });
          kids(pm, 'Point').forEach((pt) => {
            const c = parseKmlCoords((pt.getElementsByTagName('coordinates')[0] || {}).textContent)[0];
            if (c) stops.push({ name: nm.trim() || 'Stop', lon: c[0], lat: c[1] });
          });
        });
        const dn = doc.getElementsByTagName('name')[0];
        if (dn && dn.textContent.trim()) title = dn.textContent.trim();
      } else {
        const pts = (tag) => kids(doc, tag).map((p) => [num(p.getAttribute('lon')), num(p.getAttribute('lat'))]);
        coords = pts('trkpt'); if (!coords.length) coords = pts('rtept');
        kids(doc, 'wpt').forEach((w) => stops.push({ name: ((w.getElementsByTagName('name')[0] || {}).textContent || 'Stop').trim(), lon: num(w.getAttribute('lon')), lat: num(w.getAttribute('lat')) }));
        const tn = doc.querySelector('trk > name, rte > name'); if (tn && tn.textContent.trim()) title = tn.textContent.trim();
      }
    } else {
      throw new Error('Unsupported file type “.' + ext + '”. Use KML, KMZ, GPX or GeoJSON.');
    }
    coords = coords.filter((c) => isFinite(c[0]) && isFinite(c[1]));
    if (coords.length < 2) throw new Error('No line (route/track) found in this file.');
    return { name: title, coords, stops };
  }

  const api = { parseCoord, parseGoogleLink, parseStopLines, parseSpatialFile, SHORT_MSG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Parsers = api;
})(typeof window !== 'undefined' ? window : globalThis);
