# RouteTrack

Turn a Google Maps route into **GPX, Shapefile (.zip), GeoJSON, KML or CSV**.
Static site – runs entirely in the browser, no build step, no server.

## Host on GitHub Pages
1. Create a repo (e.g. `routetrack`) and upload all files in this folder to the root.
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Open `https://<your-username>.github.io/routetrack/` after a minute.

## How routes are built
- **Google Maps link / typed stops** → stops are located (Nominatim) and routed with OpenStreetMap routing (OSRM). Close to Google's line, not always identical.
- **Optional Google API key** (Routes API enabled) → geometry comes from Google. Key is sent only to Google; saved in your browser only if "Remember" is ticked. Restrict the key to your Pages domain in Google Cloud Console.
- **Upload file** → KML/KMZ (e.g. Google My Maps export), GPX, GeoJSON converted directly, no routing needed.
- Short `maps.app.goo.gl` links can't be expanded by a web page; paste the long address-bar URL instead.

## Files
`index.html` `style.css` `app.js` (UI/routing) `parsers.js` (links & files) `exporters.js` (GPX/SHP/GeoJSON/KML/CSV)

Public OSM demo servers (Nominatim, OSRM) are for light use. For heavy use, add an API key or self-host.

## Map preview
Default basemap is CARTO (free, attribution shown). OpenStreetMap and Esri satellite are in the layer switcher (top-right of the map). OpenStreetMap's own tile server blocks pages opened from a local file; it works once hosted on GitHub Pages.
