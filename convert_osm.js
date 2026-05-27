const fs = require('fs');
const path = require('path');
const osmtogeojson = require('osmtogeojson');
const { DOMParser } = require('@xmldom/xmldom');

console.log('Starting OSM to GeoJSON conversion...');

const osmFilePath = path.join(__dirname, 'map.osm');
const geojsonOutputPath = path.join(__dirname, 'public', 'kandla_port.geojson');

if (!fs.existsSync(osmFilePath)) {
  console.error(`Error: OSM file not found at ${osmFilePath}`);
  process.exit(1);
}

console.log(`Reading OSM file from ${osmFilePath} (${(fs.statSync(osmFilePath).size / (1024 * 1024)).toFixed(2)} MB)...`);
const osmXmlString = fs.readFileSync(osmFilePath, 'utf-8');

console.log('Parsing XML string into DOM...');
const dom = new DOMParser().parseFromString(osmXmlString, 'text/xml');

console.log('Converting OSM DOM to GeoJSON...');
const geojson = osmtogeojson(dom);

console.log('GeoJSON successfully generated. Analyzing features...');
const features = geojson.features || [];
console.log(`Total GeoJSON Features: ${features.length}`);

// Count and categorize features
const counts = {
  buildings: 0,
  highways: 0,
  waterways: 0,
  piers: 0,
  other: 0
};

features.forEach(f => {
  const p = f.properties || {};
  if (p.building) {
    counts.buildings++;
  } else if (p.highway) {
    counts.highways++;
  } else if (p.waterway || p.natural === 'water' || p.water) {
    counts.waterways++;
  } else if (p.man_made === 'pier' || p.man_made === 'wharf' || p.man_made === 'quay' || p.harbour) {
    counts.piers++;
  } else {
    counts.other++;
  }
});

console.log('\nFeature Breakdown:');
console.log(`- Buildings: ${counts.buildings}`);
console.log(`- Highways / Roads: ${counts.highways}`);
console.log(`- Waterways / Water bodies: ${counts.waterways}`);
console.log(`- Piers / Wharves / Harbour areas: ${counts.piers}`);
console.log(`- Other structures: ${counts.other}\n`);

// Save the GeoJSON output
console.log(`Writing GeoJSON to ${geojsonOutputPath}...`);
fs.writeFileSync(geojsonOutputPath, JSON.stringify(geojson, null, 2), 'utf-8');
console.log(`Conversion completed successfully! Output file size: ${(fs.statSync(geojsonOutputPath).size / (1024 * 1024)).toFixed(2)} MB`);
