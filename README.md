# Kandla Port 3D Interactive Map

A high-performance 3D spatial visualization of Kandla Port generated dynamically from OpenStreetMap data.

---

## 🛠️ Tech Stack

* **Angular (v18+):** Built using Standalone Components and reactive Signals for a modern UI.
* **Three.js:** Powers WebGL rendering, lighting, materials, and 3D shapes.
* **OrbitControls:** Handles smooth camera movements, panning, and rotation.
* **GeoJSON:** Holds all geographic vector shape coordinates.
* **Node.js:** Converts XML map data into JSON format.

---

## ⚙️ How It Works

* **Data Conversion:** `convert_osm.js` converts raw OpenStreetMap XML (`map.osm`) into standard GeoJSON (`kandla_port.geojson`).
* **Dynamic Centering:** Computes the centroid of buildings and berths to center the WebGL scene origin at `(0, 0, 0)`.
* **GPS Projection:** Web Mercator formulas project Lat/Lon boundaries into scale-accurate 3D coordinate space.
* **Coastline & Land Mass:** Coastline segments are chained end-to-end to form the green land terrain at `Z = 0.0`.
* **Creek & Water:** A large water plane at `Z = -2.0` renders seamlessly through the custom-shaped coastline cutout.
* **Piers & Wharves:** Dark concrete berths sit in the water at `Z = -4.0` and rise to connect with the land.
* **Roads & Buildings:** Buildings are extruded proportionally and asphalt roads trace coordinate paths above the ground level.
* **Wetlands & Salt Ponds:** Translucent mudflats and turquoise salt evaporation ponds are rendered exactly as present in the data.
* **Z-Fighting Prevention:** A strict vertical depth hierarchy (Water at `-2.0`, Land at `0.0`, Roads at `0.6`) eliminates screen flickering.
* **Camera Safety Clamping:** OrbitControls target and polar angles are clamped to prevent the camera from going below ground.
* **High Performance (60 FPS):** Dynamic point-light shadows are disabled to maximize framerate and remove flickering.

---

## 🚀 Running the Application

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Development Server
```bash
npm start
```
*Navigate to `http://localhost:4200/` in your browser.*
