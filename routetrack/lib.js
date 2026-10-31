/* RouteTrack core: link parsing + spatial exporters. Works in the browser (window.RT) and Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- helpers ---------- */
  const COORD_RE = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

  function parseCoord(str) {
    const m = COORD_RE.exec(String(str));
    if (!m) return null;
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function defaultName(i, n) {
    return i === 0 ? 'Start' : i === n - 1 ? 'End' : 'Via ' + i;
  }

  function mkStop(label, i, n, pair) {
    const c = parseCoord(label);
    if (c) return { name: defaultName(i, n), lat: c.lat, lon: c.lon };
    if (pair) return { name: label, lat: pair.lat, lon: pair.lon };
    return { name: label, lat: null, lon: null };
  }

  function dec(seg) {
    try { return decodeURIComponent(seg.replace(/\+/g, ' ')).trim(); }
    catch (e) { return seg.replace(/\+/g, ' ').trim(); }
  }

  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'route';
  }

  function esc(s) {
    return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  }

  function haversine(a, b) { // [lon, lat] in degrees -> metres
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* ---------- input parsing ---------- */
  function parseGoogleUrl(raw) {
    let url;
    try { url = new URL(raw); } catch (e) { throw new Error('That does not look like a valid link.'); }
    const host = url.hostname.toLowerCase();
    if (host === 'maps.app.goo.gl' || /(^|\.)goo\.gl$/.test(host)) {
      throw new Error('Short links (maps.app.goo.gl) cannot be opened from a browser app. Open the link in Google Maps, then copy the full address from the address bar.');
    }
    if (!/(^|\.)google\.[a-z.]+$/.test(host)) throw new Error('Please paste a Google Maps link.');

    const q = url.searchParams;
    const notes = [];
    let names = [], mode = null, data = '';

    if (q.get('origin') || q.get('destination')) { // Maps URLs API: ?api=1&origin=..&destination=..
      names = [q.get('origin'), ...(q.get('waypoints') || '').split('|').filter(Boolean), q.get('destination')]
        .filter(Boolean).map(s => s.trim());
      mode = { driving: 'driving', bicycling: 'cycling', walking: 'walking' }[(q.get('travelmode') || '').toLowerCase()] || null;
    } else {
      const p = url.pathname;
      const i = p.indexOf('/dir/');
      if (i < 0) throw new Error('This link has no directions. In Google Maps choose Directions, add your stops, then copy the link.');
      for (const seg of p.slice(i + 5).split('/')) {
        if (!seg) continue;
        if (seg.startsWith('data=')) { data = seg; continue; }
        if (seg.startsWith('@')) continue;
        names.push(dec(seg));
      }
    }
    if (names.length < 2) throw new Error('Found fewer than two stops in this link. Make sure both a start and a destination are set.');

    const m3 = /!3e(\d)/.exec(data);
    if (m3) {
      mode = { 0: 'driving', 1: 'cycling', 2: 'walking', 3: 'driving' }[m3[1]] || mode;
      if (m3[1] === '3') notes.push('Transit directions cannot be converted, so driving is used instead.');
    }

    const pairs = [...data.matchAll(/!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g)].map(m => ({ lon: +m[1], lat: +m[2] }));
    const usePairs = pairs.length === names.length;
    if (pairs.length && !usePairs) notes.push('Exact stop coordinates in the link did not match the stop list, so stops will be looked up by name.');

    return {
      stops: names.map((n, i) => mkStop(n, i, names.length, usePairs ? pairs[i] : null)),
      mode, notes
    };
  }

  function parseInput(text) {
    let t = String(text || '').trim();
    if (!t) throw new Error('Paste a Google Maps directions link or a list of stops first.');
    const first = t.split(/\s/)[0];
    if (/^(www\.)?google\.[a-z.]+\/maps/i.test(first) || /^maps\.app\.goo\.gl/i.test(first)) t = 'https://' + t;
    if (/^https?:\/\//i.test(t.split(/\s/)[0])) return parseGoogleUrl(t.split(/\s/)[0]);
    const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('Add at least two stops, one per line.');
    return { stops: lines.map((l, i) => mkStop(l, i, lines.length)), mode: null, notes: [] };
  }

  /* ---------- text exporters ---------- */
  const fmt = n => (+n).toFixed(6);

  function buildGPX(route, opts) {
    opts = opts || {};
    const wpts = opts.waypoints === false ? '' : route.stops.map(s =>
      `  <wpt lat="${fmt(s.lat)}" lon="${fmt(s.lon)}"><name>${esc(s.name || '')}</name></wpt>\n`).join('');
    const pts = route.coords.map(c => `      <trkpt lat="${fmt(c[1])}" lon="${fmt(c[0])}"></trkpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RouteTrack" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(route.name)}</name><time>${new Date().toISOString()}</time></metadata>
${wpts}  <trk>
    <name>${esc(route.name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
  }

  function buildKML(route) {
    const line = route.coords.map(c => `${fmt(c[0])},${fmt(c[1])},0`).join(' ');
    const marks = route.stops.map(s => `    <Placemark><name>${esc(s.name || '')}</name><Point><coordinates>${fmt(s.lon)},${fmt(s.lat)},0</coordinates></Point></Placemark>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(route.name)}</name>
    <Style id="route"><LineStyle><color>ffe06e2d</color><width>4</width></LineStyle></Style>
    <Placemark><name>${esc(route.name)}</name><styleUrl>#route</styleUrl><LineString><tessellate>1</tessellate><coordinates>${line}</coordinates></LineString></Placemark>
${marks}
  </Document>
</kml>
`;
  }

  function buildGeoJSON(route) {
    const r6 = n => Math.round(n * 1e6) / 1e6;
    return JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: route.name, mode: route.mode, distance_km: +(route.distance / 1000).toFixed(3), duration_min: +(route.duration / 60).toFixed(1) },
          geometry: { type: 'LineString', coordinates: route.coords.map(c => [r6(c[0]), r6(c[1])]) }
        },
        ...route.stops.map((s, i) => ({
          type: 'Feature',
          properties: { seq: i + 1, name: s.name || '' },
          geometry: { type: 'Point', coordinates: [r6(s.lon), r6(s.lat)] }
        }))
      ]
    }, null, 2);
  }

  function buildCSV(route) {
    let dist = 0;
    const rows = ['seq,latitude,longitude,distance_m'];
    route.coords.forEach((c, i) => {
      if (i) dist += haversine(route.coords[i - 1], c);
      rows.push(`${i + 1},${fmt(c[1])},${fmt(c[0])},${dist.toFixed(1)}`);
    });
    return rows.join('\n') + '\n';
  }

  /* ---------- Shapefile (ESRI) ---------- */
  const PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

  function shpHeader(lenWords, type, bbox) {
    const b = new Uint8Array(100), v = new DataView(b.buffer);
    v.setInt32(0, 9994, false);
    v.setInt32(24, lenWords, false);
    v.setInt32(28, 1000, true);
    v.setInt32(32, type, true);
    bbox.forEach((n, i) => v.setFloat64(36 + 8 * i, n, true));
    return b;
  }

  function assembleShp(type, contents, bbox) {
    let total = 100;
    contents.forEach(c => { total += 8 + c.byteLength; });
    const shp = new Uint8Array(total), shx = new Uint8Array(100 + 8 * contents.length);
    shp.set(shpHeader(total / 2, type, bbox), 0);
    shx.set(shpHeader(shx.length / 2, type, bbox), 0);
    const dv = new DataView(shp.buffer), xv = new DataView(shx.buffer);
    let off = 100;
    contents.forEach((c, i) => {
      dv.setInt32(off, i + 1, false);
      dv.setInt32(off + 4, c.byteLength / 2, false);
      shp.set(c, off + 8);
      xv.setInt32(100 + 8 * i, off / 2, false);
      xv.setInt32(104 + 8 * i, c.byteLength / 2, false);
      off += 8 + c.byteLength;
    });
    return { shp, shx };
  }

  function bboxOf(coords) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    coords.forEach(c => { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); });
    return [x0, y0, x1, y1, 0, 0, 0, 0];
  }

  function polylineContent(coords) {
    const n = coords.length, bb = bboxOf(coords);
    const out = new Uint8Array(48 + 16 * n), v = new DataView(out.buffer);
    v.setInt32(0, 3, true);
    for (let i = 0; i < 4; i++) v.setFloat64(4 + 8 * i, bb[i], true);
    v.setInt32(36, 1, true);   // NumParts
    v.setInt32(40, n, true);   // NumPoints
    v.setInt32(44, 0, true);   // Parts[0]
    coords.forEach((c, i) => { v.setFloat64(48 + 16 * i, c[0], true); v.setFloat64(56 + 16 * i, c[1], true); });
    return out;
  }

  function pointContent(c) {
    const out = new Uint8Array(20), v = new DataView(out.buffer);
    v.setInt32(0, 1, true);
    v.setFloat64(4, c[0], true);
    v.setFloat64(12, c[1], true);
    return out;
  }

  function fitUtf8(str, max, enc) {
    let s = String(str);
    while (enc.encode(s).length > max) s = s.slice(0, -1);
    return enc.encode(s);
  }

  function buildDbf(fields, rows) {
    const enc = new TextEncoder();
    const hdrLen = 32 + 32 * fields.length + 1;
    const recLen = 1 + fields.reduce((a, f) => a + f.len, 0);
    const out = new Uint8Array(hdrLen + recLen * rows.length + 1), v = new DataView(out.buffer);
    const d = new Date();
    out[0] = 3; out[1] = d.getFullYear() - 1900; out[2] = d.getMonth() + 1; out[3] = d.getDate();
    v.setUint32(4, rows.length, true);
    v.setUint16(8, hdrLen, true);
    v.setUint16(10, recLen, true);
    fields.forEach((f, i) => {
      const o = 32 + 32 * i;
      out.set(enc.encode(f.name).slice(0, 10), o);
      out[o + 11] = f.type.charCodeAt(0);
      out[o + 16] = f.len;
      out[o + 17] = f.dec || 0;
    });
    out[hdrLen - 1] = 0x0D;
    rows.forEach((row, r) => {
      let o = hdrLen + r * recLen;
      out[o++] = 0x20;
      fields.forEach((f, i) => {
        out.fill(0x20, o, o + f.len);
        if (f.type === 'N') {
          const val = row[i];
          const s = (val == null || isNaN(val)) ? '' : Number(val).toFixed(f.dec || 0);
          out.set(enc.encode(s.padStart(f.len, ' ').slice(-f.len)), o);
        } else {
          out.set(fitUtf8(row[i] == null ? '' : row[i], f.len, enc), o);
        }
        o += f.len;
      });
    });
    out[out.length - 1] = 0x1A;
    return out;
  }

  /** Returns { 'name_route.shp': Uint8Array, ... } for a line layer and a point layer. */
  function buildShapefile(route, base) {
    base = base || slugify(route.name);
    const enc = new TextEncoder();
    const files = {};
    const add = (suffix, ext, bytes) => { files[`${base}_${suffix}.${ext}`] = bytes; };

    const line = assembleShp(3, [polylineContent(route.coords)], bboxOf(route.coords));
    add('route', 'shp', line.shp);
    add('route', 'shx', line.shx);
    add('route', 'dbf', buildDbf(
      [{ name: 'NAME', type: 'C', len: 80 }, { name: 'MODE', type: 'C', len: 12 },
       { name: 'DIST_KM', type: 'N', len: 12, dec: 3 }, { name: 'DUR_MIN', type: 'N', len: 10, dec: 1 },
       { name: 'STOPS', type: 'N', len: 4, dec: 0 }],
      [[route.name, route.mode, route.distance / 1000, route.duration / 60, route.stops.length]]));

    const pc = route.stops.map(s => [s.lon, s.lat]);
    const pts = assembleShp(1, pc.map(pointContent), bboxOf(pc));
    add('stops', 'shp', pts.shp);
    add('stops', 'shx', pts.shx);
    add('stops', 'dbf', buildDbf(
      [{ name: 'SEQ', type: 'N', len: 4, dec: 0 }, { name: 'NAME', type: 'C', len: 80 },
       { name: 'LAT', type: 'N', len: 14, dec: 7 }, { name: 'LON', type: 'N', len: 14, dec: 7 }],
      route.stops.map((s, i) => [i + 1, s.name, s.lat, s.lon])));

    ['route', 'stops'].forEach(k => {
      add(k, 'prj', enc.encode(PRJ));
      add(k, 'cpg', enc.encode('UTF-8'));
    });
    return files;
  }

  return {
    parseCoord, parseInput, parseGoogleUrl, slugify, haversine,
    buildGPX, buildKML, buildGeoJSON, buildCSV, buildShapefile
  };
});
