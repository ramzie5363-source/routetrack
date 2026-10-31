/* RouteTrack – exporters: GPX, GeoJSON, KML, CSV, Shapefile (zip). Everything runs in the browser. */
(function (root) {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;

  function haversine(a, b) {
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function cumulative(coords) {
    const out = [0];
    for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversine(coords[i - 1], coords[i]));
    return out;
  }
  const SPEED = { drive: 50, bike: 15, walk: 5 }; // km/h fallback when no duration is known

  /** ISO timestamps per point, spread by distance. start: Date */
  function timestamps(route, start) {
    const cum = cumulative(route.coords), total = cum[cum.length - 1] || 1;
    const dur = route.duration || (total / 1000 / (SPEED[route.mode] || 40)) * 3600;
    return cum.map((d) => new Date(start.getTime() + (d / total) * dur * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  }

  const slug = (s) => (s || 'route').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 48) || 'route';
  const fx = (n) => Number(n).toFixed(6);

  /* ---------------- GPX ---------------- */
  function toGPX(route, opts) {
    opts = opts || {};
    const times = opts.start ? timestamps(route, opts.start) : null;
    const L = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="RouteTrack" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
      '  <metadata><name>' + esc(route.name) + '</name>' + (times ? '<time>' + times[0] + '</time>' : '') + '</metadata>'];
    (route.stops || []).forEach((s) => { if (isFinite(s.lat) && isFinite(s.lon)) L.push('  <wpt lat="' + fx(s.lat) + '" lon="' + fx(s.lon) + '"><name>' + esc(s.name) + '</name></wpt>'); });
    if (opts.asRoute) {
      L.push('  <rte><name>' + esc(route.name) + '</name>');
      route.coords.forEach((c) => L.push('    <rtept lat="' + fx(c[1]) + '" lon="' + fx(c[0]) + '"/>'));
      L.push('  </rte>');
    } else {
      L.push('  <trk><name>' + esc(route.name) + '</name><trkseg>');
      route.coords.forEach((c, i) => L.push('    <trkpt lat="' + fx(c[1]) + '" lon="' + fx(c[0]) + '">' + (times ? '<time>' + times[i] + '</time>' : '') + '</trkpt>'));
      L.push('  </trkseg></trk>');
    }
    L.push('</gpx>');
    return L.join('\n');
  }

  /* ---------------- GeoJSON ---------------- */
  function toGeoJSON(route) {
    const features = [{
      type: 'Feature',
      properties: { name: route.name, distance_m: Math.round(route.distance || 0), duration_s: route.duration ? Math.round(route.duration) : null, mode: route.mode, source: route.source },
      geometry: { type: 'LineString', coordinates: route.coords.map((c) => [+fx(c[0]), +fx(c[1])]) },
    }];
    (route.stops || []).forEach((s, i) => { if (isFinite(s.lat)) features.push({ type: 'Feature', properties: { name: s.name, seq: i + 1 }, geometry: { type: 'Point', coordinates: [+fx(s.lon), +fx(s.lat)] } }); });
    return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
  }

  /* ---------------- KML ---------------- */
  function toKML(route) {
    const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', '<Document>', '  <name>' + esc(route.name) + '</name>',
      '  <Style id="line"><LineStyle><color>ffdf6f2c</color><width>4</width></LineStyle></Style>'];
    (route.stops || []).forEach((s) => { if (isFinite(s.lat)) L.push('  <Placemark><name>' + esc(s.name) + '</name><Point><coordinates>' + fx(s.lon) + ',' + fx(s.lat) + ',0</coordinates></Point></Placemark>'); });
    L.push('  <Placemark><name>' + esc(route.name) + '</name><styleUrl>#line</styleUrl><LineString><tessellate>1</tessellate><coordinates>');
    L.push(route.coords.map((c) => fx(c[0]) + ',' + fx(c[1]) + ',0').join(' '));
    L.push('  </coordinates></LineString></Placemark>', '</Document>', '</kml>');
    return L.join('\n');
  }

  /* ---------------- CSV ---------------- */
  function toCSV(route, opts) {
    opts = opts || {};
    const cum = cumulative(route.coords), times = opts.start ? timestamps(route, opts.start) : null;
    const rows = ['seq,longitude,latitude,distance_m' + (times ? ',time_utc' : '')];
    route.coords.forEach((c, i) => rows.push([i + 1, fx(c[0]), fx(c[1]), cum[i].toFixed(1)].concat(times ? [times[i]] : []).join(',')));
    return rows.join('\n');
  }

  /* ---------------- Shapefile ---------------- */
  const PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

  function shpHeader(dv, lenBytes, type, bbox) {
    dv.setInt32(0, 9994, false);
    dv.setInt32(24, lenBytes / 2, false);
    dv.setInt32(28, 1000, true);
    dv.setInt32(32, type, true);
    bbox.forEach((v, i) => dv.setFloat64(36 + 8 * i, v, true));
  }
  const bboxOf = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];

  function shpLine(coords) {
    const n = coords.length, content = 44 + 4 + 16 * n, total = 100 + 8 + content;
    const shp = new DataView(new ArrayBuffer(total)), shx = new DataView(new ArrayBuffer(108));
    const bb = bboxOf(coords);
    shpHeader(shp, total, 3, bb); shpHeader(shx, 108, 3, bb);
    shp.setInt32(100, 1, false); shp.setInt32(104, content / 2, false);
    let o = 108;
    shp.setInt32(o, 3, true); o += 4;
    bb.forEach((v) => { shp.setFloat64(o, v, true); o += 8; });
    shp.setInt32(o, 1, true); o += 4; shp.setInt32(o, n, true); o += 4; shp.setInt32(o, 0, true); o += 4;
    coords.forEach((c) => { shp.setFloat64(o, c[0], true); shp.setFloat64(o + 8, c[1], true); o += 16; });
    shx.setInt32(100, 50, false); shx.setInt32(104, content / 2, false);
    return { shp: shp.buffer, shx: shx.buffer };
  }

  function shpPoints(pts) {
    const n = pts.length, total = 100 + 28 * n;
    const shp = new DataView(new ArrayBuffer(total)), shx = new DataView(new ArrayBuffer(100 + 8 * n));
    const bb = bboxOf(pts);
    shpHeader(shp, total, 1, bb); shpHeader(shx, 100 + 8 * n, 1, bb);
    pts.forEach((p, i) => {
      const o = 100 + 28 * i;
      shp.setInt32(o, i + 1, false); shp.setInt32(o + 4, 10, false);
      shp.setInt32(o + 8, 1, true); shp.setFloat64(o + 12, p[0], true); shp.setFloat64(o + 20, p[1], true);
      shx.setInt32(100 + 8 * i, (100 + 28 * i) / 2, false); shx.setInt32(104 + 8 * i, 10, false);
    });
    return { shp: shp.buffer, shx: shx.buffer };
  }

  /** fields: [{name,type:'C'|'N',len,dec}], rows: arrays of values */
  function dbf(fields, rows) {
    const enc = new TextEncoder();
    const headerLen = 32 + 32 * fields.length + 1;
    const recLen = 1 + fields.reduce((a, f) => a + f.len, 0);
    const buf = new ArrayBuffer(headerLen + recLen * rows.length + 1), dv = new DataView(buf), u8 = new Uint8Array(buf);
    const d = new Date();
    dv.setUint8(0, 3); dv.setUint8(1, d.getFullYear() - 1900); dv.setUint8(2, d.getMonth() + 1); dv.setUint8(3, d.getDate());
    dv.setUint32(4, rows.length, true); dv.setUint16(8, headerLen, true); dv.setUint16(10, recLen, true);
    fields.forEach((f, i) => {
      const o = 32 + 32 * i;
      enc.encode(f.name).slice(0, 10).forEach((b, k) => { u8[o + k] = b; });
      u8[o + 11] = f.type.charCodeAt(0); u8[o + 16] = f.len; u8[o + 17] = f.dec || 0;
    });
    u8[32 + 32 * fields.length] = 0x0d;
    rows.forEach((r, ri) => {
      let o = headerLen + ri * recLen;
      u8[o++] = 0x20;
      fields.forEach((f, i) => {
        let bytes;
        if (f.type === 'N') bytes = enc.encode((r[i] == null ? '' : Number(r[i]).toFixed(f.dec || 0)).padStart(f.len, ' ').slice(-f.len));
        else bytes = enc.encode(String(r[i] == null ? '' : r[i]));
        for (let k = 0; k < f.len; k++) u8[o + k] = k < bytes.length ? bytes[k] : 0x20;
        o += f.len;
      });
    });
    u8[buf.byteLength - 1] = 0x1a;
    return buf;
  }

  /** Returns { 'name.shp': ArrayBuffer, … } ready to zip */
  function shapefileFiles(route) {
    const files = {};
    const add = (base, g, d) => {
      files[base + '.shp'] = g.shp; files[base + '.shx'] = g.shx; files[base + '.dbf'] = d;
      files[base + '.prj'] = new TextEncoder().encode(PRJ); files[base + '.cpg'] = new TextEncoder().encode('UTF-8');
    };
    add('route_line', shpLine(route.coords), dbf(
      [{ name: 'NAME', type: 'C', len: 80 }, { name: 'DIST_KM', type: 'N', len: 12, dec: 3 }, { name: 'DUR_MIN', type: 'N', len: 10, dec: 1 }, { name: 'MODE', type: 'C', len: 12 }, { name: 'SOURCE', type: 'C', len: 24 }],
      [[route.name, (route.distance || 0) / 1000, route.duration ? route.duration / 60 : null, route.mode || '', route.source || '']]));
    const stops = (route.stops || []).filter((s) => isFinite(s.lat) && isFinite(s.lon));
    if (stops.length) add('route_stops', shpPoints(stops.map((s) => [s.lon, s.lat])), dbf(
      [{ name: 'SEQ', type: 'N', len: 4 }, { name: 'NAME', type: 'C', len: 80 }, { name: 'LON', type: 'N', len: 14, dec: 6 }, { name: 'LAT', type: 'N', len: 14, dec: 6 }],
      stops.map((s, i) => [i + 1, s.name, s.lon, s.lat])));
    return files;
  }

  async function toShapefileZip(route) {
    const zip = new JSZip(); // global from CDN (or injected in tests)
    const f = shapefileFiles(route);
    Object.keys(f).forEach((k) => zip.file(k, f[k]));
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  async function toAllZip(route, opts) {
    const zip = new JSZip(), b = slug(route.name);
    zip.file(b + '.gpx', toGPX(route, opts));
    zip.file(b + '-route.gpx', toGPX(route, Object.assign({}, opts, { asRoute: true })));
    zip.file(b + '.geojson', toGeoJSON(route));
    zip.file(b + '.kml', toKML(route));
    zip.file(b + '.csv', toCSV(route, opts));
    const f = shapefileFiles(route);
    Object.keys(f).forEach((k) => zip.file('shapefile/' + k, f[k]));
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  const api = { toGPX, toGeoJSON, toKML, toCSV, toShapefileZip, toAllZip, shapefileFiles, cumulative, haversine, slug, timestamps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Exporters = api;
})(typeof window !== 'undefined' ? window : globalThis);
