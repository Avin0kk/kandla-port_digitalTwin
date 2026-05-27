const fs = require('fs');
const path = require('path');

const geojsonPath = path.join(__dirname, 'public', 'kandla_port.geojson');
const data = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));

let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

const processCoords = (coords) => {
  if (typeof coords[0] === 'number') {
    const lon = coords[0];
    const lat = coords[1];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  } else {
    coords.forEach(processCoords);
  }
};

data.features.forEach(f => {
  if (f.geometry && f.geometry.coordinates) {
    processCoords(f.geometry.coordinates);
  }
});

console.log('GeoJSON Bounds:');
console.log(`- Min Lat: ${minLat}`);
console.log(`- Max Lat: ${maxLat}`);
console.log(`- Min Lon: ${minLon}`);
console.log(`- Max Lon: ${maxLon}`);
console.log(`- Center Lat: ${(minLat + maxLat) / 2}`);
console.log(`- Center Lon: ${(minLon + maxLon) / 2}`);
