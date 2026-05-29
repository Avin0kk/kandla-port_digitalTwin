import { 
  Component, 
  ElementRef, 
  ViewChild, 
  OnInit, 
  AfterViewInit, 
  OnDestroy, 
  signal, 
  WritableSignal 
} from '@angular/core';
import { CommonModule, KeyValuePipe } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

interface ViewportLayers {
  water: boolean;
  piers: boolean;
  buildings: boolean;
  roads: boolean;
  ships: boolean;
}

@Component({
  selector: 'app-map-3d',
  standalone: true,
  imports: [CommonModule, KeyValuePipe],
  templateUrl: './map-3d.html',
  styleUrl: './map-3d.css'
})
export class Map3dComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('canvasContainer', { static: true }) canvasContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('tooltip', { static: true }) tooltipRef!: ElementRef<HTMLDivElement>;

  // Angular UI Signals
  loading = signal<boolean>(true);
  dashboardVisible = signal<boolean>(true);
  isDarkMode = signal<boolean>(true); // Dynamic Light/Dark Mode
  layers: ViewportLayers = {
    water: true,
    piers: true,
    buildings: true,
    roads: true,
    ships: true
  };
  currentView = signal<string>('docks');
  autoRotate = signal<boolean>(false);
  selectedObject = signal<THREE.Object3D | null>(null);
  selectedObjectProperties = signal<any | null>(null);

  // Three.js Core Objects
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private clock = new THREE.Clock();
  private animationFrameId?: number;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  // Scene Grouping
  private mapGroup = new THREE.Group();
  private waterGroup = new THREE.Group();
  private piersGroup = new THREE.Group();
  private buildingsGroup = new THREE.Group();
  private roadsGroup = new THREE.Group();
  private shipsGroup = new THREE.Group();

  // Map Scaling and Offset
  private centerLat = 23.011; // Fallback center
  private centerLon = 70.220; // Fallback center
  private scaleFactor = 1.0;

  // Interactivity and Animation Tracking
  private interactiveObjects: THREE.Object3D[] = [];
  private hoveredObject: THREE.Object3D | null = null;
  private animatedShips: Array<{ mesh: THREE.Group; speed: number; direction: number; rangeY: [number, number] }> = [];
  private waterMaterial!: THREE.MeshStandardMaterial;
  private roadMaterial!: THREE.MeshStandardMaterial;
  private landMesh!: THREE.Mesh; // Store reference to update land texture dynamically

  // Restore States for Raycaster Hover/Select
  private originalMaterials = new Map<string, THREE.Material | THREE.Material[]>();
  private highlightedObject: THREE.Object3D | null = null;

  // Live Port twin states
  private pierCounter = 0;
  private pulsingBeacons: THREE.Mesh[] = [];

  ngOnInit() {
    // Initial hooks if needed
  }

  ngAfterViewInit() {
    this.initThree();
    this.loadGeoJSON();
    
    // Wire up events
    window.addEventListener('resize', this.onWindowResize.bind(this));
    this.renderer.domElement.addEventListener('click', this.onCanvasClick.bind(this));
    this.renderer.domElement.addEventListener('mousemove', this.onCanvasMouseMove.bind(this));
  }

  ngOnDestroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    
    window.removeEventListener('resize', this.onWindowResize.bind(this));
    if (this.renderer) {
      this.renderer.domElement.removeEventListener('click', this.onCanvasClick.bind(this));
      this.renderer.domElement.removeEventListener('mousemove', this.onCanvasMouseMove.bind(this));
      this.renderer.dispose();
    }
    this.controls.dispose();
    this.pulsingBeacons = [];
  }

  // --- 1. INITIALIZE THREE.JS ---
  private initThree() {
    const container = this.canvasContainer.nativeElement;
    
    const isDark = this.isDarkMode();
    const skyColor = isDark ? 0x0a0f24 : 0xe0f2fe;

    // Scene creation
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(skyColor);
    // Fog for depth
    this.scene.fog = new THREE.FogExp2(skyColor, 0.00018);

    // Camera creation
    this.camera = new THREE.PerspectiveCamera(
      45, 
      container.clientWidth / container.clientHeight, 
      1, 
      10000
    );
    // Position camera at a nice diagonal viewing angle
    this.camera.position.set(0, -900, 750);

    // Renderer setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false; // Disable shadow maps to completely stop light flickering and maximize FPS
    container.appendChild(this.renderer.domElement);

    // Set camera up-vector to Z-axis (height) so OrbitControls rotates upright relative to our ground XY plane
    this.camera.up.set(0, 0, 1);

    // Orbit Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.screenSpacePanning = true; // Makes camera panning extremely simple and natural
    this.controls.maxPolarAngle = Math.PI / 2.05; // Restrict camera vertical angle to slightly above horizon (never goes below ground)
    this.controls.minDistance = 50;
    this.controls.maxDistance = 2500;
    this.controls.target.set(0, 0, 0);

    // Add Scene groups
    this.scene.add(this.mapGroup);
    this.mapGroup.add(this.waterGroup);
    this.mapGroup.add(this.piersGroup);
    this.mapGroup.add(this.buildingsGroup);
    this.mapGroup.add(this.roadsGroup);
    this.mapGroup.add(this.shipsGroup);

    // Lights
    this.setupLights();

    // Start animation loop
    this.animate();
  }

  private setupLights() {
    const isDark = this.isDarkMode();

    // Warm daylight or tech studio ambient light
    const ambientLight = new THREE.AmbientLight(isDark ? 0x3b82f6 : 0xffffff, isDark ? 0.45 : 1.1);
    this.scene.add(ambientLight);

    // Main Directional Light (Sun light)
    const dirLight = new THREE.DirectionalLight(isDark ? 0x8ab4f8 : 0xfffbeb, isDark ? 0.65 : 1.2);
    dirLight.position.set(500, 800, 600);
    dirLight.castShadow = false; // Disable directional light shadow maps to stop camera movement flickering and double FPS
    this.scene.add(dirLight);

    // Soft fill light from opposite angle to soften shadows
    const fillLight = new THREE.DirectionalLight(isDark ? 0x1e293b : 0xffffff, isDark ? 0.2 : 0.35);
    fillLight.position.set(-800, -500, 200);
    fillLight.castShadow = false;
    this.scene.add(fillLight);

    // Add a few animated glowing beacon point lights near the harbor coordinates
    this.createHarborLight(150, 50, 0xef4444); // Red beacon
    this.createHarborLight(-250, 200, 0x10b981); // Green beacon
    this.createHarborLight(400, -350, 0x00f0ff); // Cyan beacon
  }

  private createHarborLight(x: number, y: number, color: number) {
    const beacon = new THREE.Group();
    beacon.position.set(x, y, 0);

    // Small physical pole
    const poleGeo = new THREE.CylinderGeometry(1.5, 2, 20, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.8 });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.z = 10;
    pole.rotation.x = Math.PI / 2;
    beacon.add(pole);

    // Glowing bulb
    const bulbGeo = new THREE.SphereGeometry(3, 16, 16);
    const bulbMat = new THREE.MeshBasicMaterial({ color: color });
    const bulb = new THREE.Mesh(bulbGeo, bulbMat);
    bulb.position.z = 21;
    beacon.add(bulb);

    // Actual point light
    const light = new THREE.PointLight(color, 2.5, 150, 0.5);
    light.position.z = 21;
    light.castShadow = false; // Disabled shadow casting to eliminate severe lag and blue-green flickering shadows
    beacon.add(light);

    this.scene.add(beacon);
  }

  private createTerrain() {
    // 1. Giant Water Plane covering the entire background sea/creek channel
    const waterPlaneGeo = new THREE.PlaneGeometry(80000, 80000);
    const waterPlane = new THREE.Mesh(waterPlaneGeo, this.waterMaterial);
    waterPlane.position.set(0, 0, -10.0); // Place at base water level Z = -10.0 to prevent Z-fighting with linear waterways
    waterPlane.receiveShadow = false; // Disable shadow receiving on water to prevent shadow acne flickering
    this.scene.add(waterPlane);
  }

  // --- 2. GPS COORDINATE PROJECTION ---
  private project(lat: number, lon: number): THREE.Vector2 {
    const r = 6378137; // Earth's radius in meters
    const f = Math.PI / 180;
    
    // Web Mercator approximation relative to port center
    const x = r * lon * f * Math.cos(this.centerLat * f);
    const y = r * lat * f;
    
    const centerX = r * this.centerLon * f * Math.cos(this.centerLat * f);
    const centerY = r * this.centerLat * f;
    
    // Scale and flip Y for WebGL coordinates
    return new THREE.Vector2((x - centerX) * this.scaleFactor, (y - centerY) * this.scaleFactor);
  }

  // --- 3. LOAD AND PARSE GEOJSON ---
  private loadGeoJSON() {
    fetch('/kandla_port.geojson')
      .then(response => {
        if (!response.ok) {
          throw new Error('Network response was not ok');
        }
        return response.json();
      })
      .then(data => {
        this.processGeoJSON(data);
        this.loading.set(false);
      })
      .catch(error => {
        console.error('Failed to load GeoJSON data:', error);
        this.loading.set(false);
      });
  }

  private processGeoJSON(geojson: any) {
    const features = geojson.features || [];
    if (features.length === 0) return;

    // 1. Calculate dynamic center using ONLY buildings and piers to avoid far-away road outliers
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    
    features.forEach((feature: any) => {
      const geom = feature.geometry;
      const props = feature.properties || {};
      if (!geom) return;

      // Only center on buildings and piers to keep the origin exactly at the port!
      if (props.building || props.man_made === 'pier' || props.man_made === 'wharf' || props.man_made === 'quay' || props.harbour) {
        const processCoords = (coords: any) => {
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
        processCoords(geom.coordinates);
      }
    });

    if (minLat !== Infinity) {
      this.centerLat = (minLat + maxLat) / 2;
      this.centerLon = (minLon + maxLon) / 2;
      console.log(`Dynamic Port Centroid: Lat=${this.centerLat.toFixed(5)}, Lon=${this.centerLon.toFixed(5)}`);
    } else {
      this.centerLat = 23.011;
      this.centerLon = 70.220;
    }

    // 2. Pre-define our premium theme materials
    this.setupThemeMaterials();

    // Base ground and sea terrain (pre-requisite materials are setup)
    this.createTerrain();

    // 2b. Build exact land shape based on GeoJSON coastline features connected end-to-end
    const segments: THREE.Vector2[][] = [];
    features.forEach((feature: any) => {
      const geom = feature.geometry;
      const props = feature.properties || {};
      if (geom && props.natural === 'coastline') {
        if (geom.type === 'LineString') {
          const pts = geom.coordinates.map((c: any) => this.project(c[1], c[0]));
          segments.push(pts);
        } else if (geom.type === 'MultiLineString') {
          geom.coordinates.forEach((line: any) => {
            const pts = line.map((c: any) => this.project(c[1], c[0]));
            segments.push(pts);
          });
        }
      }
    });

    let uniquePoints: THREE.Vector2[] = [];
    if (segments.length > 0) {
      // Dynamically chain segments end-to-end to trace the continuous coastline
      const currentChain = [...segments[0]];
      const remaining = segments.slice(1);
      
      while (remaining.length > 0) {
        let bestIdx = -1;
        let bestDistance = Infinity;
        let reverseBest = false;
        const currentEnd = currentChain[currentChain.length - 1];
        
        for (let i = 0; i < remaining.length; i++) {
          const seg = remaining[i];
          const startPt = seg[0];
          const endPt = seg[seg.length - 1];
          
          const d1 = currentEnd.distanceTo(startPt);
          if (d1 < bestDistance) {
            bestDistance = d1;
            bestIdx = i;
            reverseBest = false;
          }
          
          const d2 = currentEnd.distanceTo(endPt);
          if (d2 < bestDistance) {
            bestDistance = d2;
            bestIdx = i;
            reverseBest = true;
          }
        }
        
        if (bestIdx !== -1 && bestDistance < 5000) {
          const nextSeg = remaining.splice(bestIdx, 1)[0];
          if (reverseBest) {
            nextSeg.reverse();
          }
          currentChain.push(...nextSeg);
        } else {
          break;
        }
      }
      
      // Remove any duplicate consecutive points in the chain
      currentChain.forEach(pt => {
        if (uniquePoints.length === 0 || uniquePoints[uniquePoints.length - 1].distanceTo(pt) > 0.1) {
          uniquePoints.push(pt);
        }
      });
    }

    if (uniquePoints.length > 1) {
      const landShape = new THREE.Shape();
      // Start at the South-West end of the coastline
      landShape.moveTo(uniquePoints[0].x, uniquePoints[0].y);
      // Follow the coastline to the South-East end
      for (let i = 1; i < uniquePoints.length; i++) {
        landShape.lineTo(uniquePoints[i].x, uniquePoints[i].y);
      }
      
      // Wrap around the North and West boundaries to form the land mass on the correct side
      landShape.lineTo(40000, uniquePoints[uniquePoints.length - 1].y);
      landShape.lineTo(40000, 40000);
      landShape.lineTo(-40000, 40000);
      landShape.lineTo(-40000, -40000);
      landShape.closePath();

      const isDark = this.isDarkMode();
      const landTexture = isDark ? this.createDarkLandTexture() : this.createLightLandTexture();
      const landMat = new THREE.MeshStandardMaterial({
        map: landTexture,
        roughness: 0.95,
        metalness: 0.05,
        flatShading: true
      });
      const landGeo = new THREE.ShapeGeometry(landShape);
      const landMesh = new THREE.Mesh(landGeo, landMat);
      landMesh.position.z = 0.0; // Place at land level
      landMesh.receiveShadow = false; // Disabled shadow receiving on land to completely prevent shadow acne/flickering
      this.landMesh = landMesh; // Store reference to update land texture dynamically
      this.scene.add(landMesh);
    } else {
      // Fallback to simple land plane if no coastline found
      const isDark = this.isDarkMode();
      const landPlaneGeo = new THREE.PlaneGeometry(40000, 40000);
      const landTexture = isDark ? this.createDarkLandTexture() : this.createLightLandTexture();
      const landMat = new THREE.MeshStandardMaterial({
        map: landTexture,
        roughness: 0.95,
        metalness: 0.05,
        flatShading: true
      });
      const landMesh = new THREE.Mesh(landPlaneGeo, landMat);
      landMesh.position.z = 0.0; // Place at land level Z = 0
      landMesh.receiveShadow = false; // Disabled shadow receiving on land to completely prevent shadow acne/flickering
      this.landMesh = landMesh; // Store reference to update land texture dynamically
      this.scene.add(landMesh);
    }

    // 3. Render Features
    features.forEach((feature: any) => {
      const geom = feature.geometry;
      const props = feature.properties || {};
      if (!geom) return;

      if (props.building) {
        this.renderBuilding(geom, props);
      } else if (props.highway) {
        this.renderRoad(geom, props);
      } else if (props.waterway || props.natural === 'water' || props.water) {
        this.renderWater(geom, props);
      } else if (props.man_made === 'pier' || props.man_made === 'wharf' || props.man_made === 'quay' || props.harbour) {
        this.renderPier(geom, props);
      } else if (props.natural === 'wetland' || props.landuse === 'salt_pond') {
        this.renderWetland(geom, props);
      }
    });

    // Adjust camera to look nicely at the center of the rendered objects
    this.setCameraView('docks');
    
    // Apply initial light/dark theme to all loaded meshes
    this.applyTheme();
  }

  // --- 4. PRE-DEFINE STYLED MATERIALS (THEME SYSTEM) ---
  private setupThemeMaterials() {
    const isDark = this.isDarkMode();
    
    // Create animated water procedural texture based on initial theme
    const waterTexture = isDark ? this.createDarkWaterTexture() : this.createLightWaterTexture();

    // Water material
    this.waterMaterial = new THREE.MeshStandardMaterial({
      map: waterTexture,
      color: isDark ? 0x0f172a : 0xa5d3f7,
      roughness: isDark ? 0.3 : 0.45,
      metalness: isDark ? 0.8 : 0.6,
      transparent: true,
      opacity: isDark ? 0.95 : 0.88,
      flatShading: false
    });

    // Create road procedural texture based on initial theme
    const roadTexture = isDark ? this.createDarkRoadTexture() : this.createLightRoadTexture();
    this.roadMaterial = new THREE.MeshStandardMaterial({
      map: roadTexture,
      roughness: 0.8,
      metalness: 0.1,
      flatShading: false
    });

    // Docks/Piers Concrete material (updated in applyTheme)
    const pierMat = new THREE.MeshStandardMaterial({
      color: isDark ? 0x1e293b : 0xcbd5e1,
      roughness: 0.8,
      metalness: 0.15
    });
    this.piersGroup.userData = { material: pierMat };
  }

  // --- 5. RENDER GEOMETRY BUILDERS ---

  private renderBuilding(geom: any, props: any) {
    if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return;
    
    // Create shapes
    const shapes: THREE.Shape[] = [];
    if (geom.type === 'Polygon') {
      shapes.push(this.createShapeFromPolygon(geom.coordinates));
    } else {
      geom.coordinates.forEach((polyCoords: any) => {
        shapes.push(this.createShapeFromPolygon(polyCoords));
      });
    }

    // Determine building height
    const levels = parseInt(props['building:levels'] || props['levels'] || '1', 10);
    const height = Math.max(12, levels * 10 + (Math.random() * 8)); // Multiplied to look majestic in 3D scene

    // Build extruded geometry
    const extrudeSettings = {
      steps: 1,
      depth: height,
      bevelEnabled: true,
      bevelThickness: 1,
      bevelSize: 0.5,
      bevelSegments: 2
    };

    shapes.forEach(shape => {
      try {
        const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        
        // Realistic warm brick/concrete architectural brown material
        const mat = new THREE.MeshStandardMaterial({
          color: 0x8b5a2b, // warm architectural brown
          roughness: 0.6,
          metalness: 0.1,
          transparent: false,
          opacity: 1.0,
          emissive: 0x3d2314,
          emissiveIntensity: 0.05
        });

        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        
        // Save OSM properties for interactive raycasting
        mesh.userData = { 
          properties: {
            name: props.name || 'Port Warehouse / Office',
            type: 'Port Building',
            levels: levels,
            height: `${Math.round(height / 3)}m`,
            building: props.building,
            ...props
          },
          originalMaterial: mat
        };

        // Architectural black-brown subtle edge wireframe outline
        const edges = new THREE.EdgesGeometry(geo);
        const lineMat = new THREE.LineBasicMaterial({ 
          color: 0x4a2e1b, 
          linewidth: 1.0,
          transparent: true,
          opacity: 0.4
        });
        const wireframe = new THREE.LineSegments(edges, lineMat);
        mesh.add(wireframe);

        this.buildingsGroup.add(mesh);
        this.interactiveObjects.push(mesh);
      } catch (err) {
        // Suppress trivial self-intersection geometry errors from raw OSM data
      }
    });
  }

  private renderPier(geom: any, props: any) {
    if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return;

    const shapes: THREE.Shape[] = [];
    if (geom.type === 'Polygon') {
      shapes.push(this.createShapeFromPolygon(geom.coordinates));
    } else {
      geom.coordinates.forEach((polyCoords: any) => {
        shapes.push(this.createShapeFromPolygon(polyCoords));
      });
    }

    // Extrude piers deep into the water and above land level Z
    const extrudeSettings = {
      steps: 1,
      depth: 14.5, // 14.5 meters tall berths (reaches from Z = -12.0 to 2.5)
      bevelEnabled: false
    };

    shapes.forEach(shape => {
      try {
        const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        const isDark = this.isDarkMode();
        const mat = new THREE.MeshStandardMaterial({
          color: isDark ? 0x1e293b : 0xcbd5e1, // Concrete color based on initial theme
          roughness: 0.85,
          metalness: 0.25
        });
        
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = -12.0; // Place deep at sea level base
        mesh.receiveShadow = false; // Disable shadow maps to stop camera movement flickering
        mesh.castShadow = false;

        // Dynamic vessel mooring and stand status allocation
        this.pierCounter++;
        let status = 'Available';
        let statusColor = 0x10b981; // Green
        let shipName = '';
        let carrier = '';
        let cargo = '';
        let statusText = 'Available for Mooring';
        let isOccupied = false;
        let isDelayed = false;

        // Custom Demo Data Fields for Arrival/Departure times & Next ship
        let arrivalTime = 'N/A';
        let departureTime = 'N/A';
        let nextShip = 'MV Ocean Rider';
        let nextArrival = '2026-05-27 18:30 (ETA)';
        let nextDeparture = '2026-05-29 06:00';

        if (this.pierCounter % 3 === 1) {
          status = 'Occupied';
          statusColor = 0xef4444; // Red
          shipName = this.pierCounter === 1 ? 'MV Kandla Express' : 'MV Gujarat Monarch';
          carrier = this.pierCounter === 1 ? 'Maersk Line' : 'COSCO Shipping';
          cargo = this.pierCounter === 1 ? 'Containers (Dry)' : 'Bulk Iron Ore';
          statusText = 'Occupied (On Schedule)';
          isOccupied = true;
          
          arrivalTime = this.pierCounter === 1 ? '2026-05-27 05:15 (ATA)' : '2026-05-26 23:45 (ATA)';
          departureTime = this.pierCounter === 1 ? '2026-05-28 22:00 (ETD)' : '2026-05-28 10:30 (ETD)';
          nextShip = this.pierCounter === 1 ? 'MT Liquid Gold' : 'MV Desert Storm';
          nextArrival = this.pierCounter === 1 ? '2026-05-29 02:30 (ETA)' : '2026-05-28 18:00 (ETA)';
          nextDeparture = this.pierCounter === 1 ? '2026-05-30 14:00' : '2026-05-30 02:00';
        } else if (this.pierCounter % 3 === 2) {
          status = 'Delayed';
          statusColor = 0xf59e0b; // Orange
          shipName = this.pierCounter === 2 ? 'SS Deendayal' : 'MT Narmada';
          carrier = this.pierCounter === 2 ? 'MSC Cargo' : 'Adani Shipping';
          cargo = this.pierCounter === 2 ? 'Crude Oil (Liquid)' : 'Liquefied Natural Gas';
          statusText = 'Occupied (Delayed 3.5h)';
          isOccupied = true;
          isDelayed = true;

          arrivalTime = this.pierCounter === 2 ? '2026-05-27 11:30 (ATA - Delayed)' : '2026-05-27 14:15 (ATA - Delayed)';
          departureTime = this.pierCounter === 2 ? '2026-05-29 14:00 (ETD - Rescheduled)' : '2026-05-29 18:45 (ETD - Rescheduled)';
          nextShip = this.pierCounter === 2 ? 'MV Desert Storm' : 'MV Kandla Express';
          nextArrival = this.pierCounter === 2 ? '2026-05-29 18:00 (ETA - Awaiting Berth)' : '2026-05-30 01:15 (ETA - Awaiting Berth)';
          nextDeparture = this.pierCounter === 2 ? '2026-05-31 06:00' : '2026-05-31 12:30';
        }

        mesh.userData = {
          properties: {
            'Berth Name': props.name || `Cargo Berth Stand #${this.pierCounter}`,
            'Type': 'Shipping Berth',
            'Status': statusText,
            'Current Vessel': isOccupied ? shipName : 'None (Available)',
            'Actual Arrival': isOccupied ? arrivalTime : 'N/A',
            'Estimated Departure': isOccupied ? departureTime : 'N/A',
            'Next Scheduled Vessel': nextShip,
            'Next Vessel ETA': nextArrival,
            'Operator': props.operator || 'Deendayal Port Authority'
          },
          originalMaterial: mat
        };

        // Add a neon outline in deep blue/purple for styling
        const edges = new THREE.EdgesGeometry(geo);
        const lineMat = new THREE.LineBasicMaterial({ color: 0x4f46e5, opacity: 0.6, transparent: true });
        const outline = new THREE.LineSegments(edges, lineMat);
        mesh.add(outline);

        this.piersGroup.add(mesh);
        this.interactiveObjects.push(mesh);

        // Compute pier bounding box center for placing stands and status lights
        geo.computeBoundingBox();
        const bbox = geo.boundingBox!;
        const center = new THREE.Vector3();
        bbox.getCenter(center);

        // Render the rectangular Box of the Ship Stand (mooring boundary in water, offset to the East)
        const standWidth = 40;
        const standLength = 160;
        const standGeo = new THREE.BoxGeometry(standWidth, standLength, 1);
        const standMat = new THREE.MeshStandardMaterial({
          color: statusColor,
          roughness: 0.5,
          metalness: 0.1,
          transparent: true,
          opacity: 0.15,
          emissive: statusColor,
          emissiveIntensity: 0.15
        });
        const standMesh = new THREE.Mesh(standGeo, standMat);
        standMesh.position.set(center.x + 55, center.y, -9.9); // offset East into the water channel and placed slightly above the water plane
        standMesh.receiveShadow = false; // Disable to prevent flickering
        this.piersGroup.add(standMesh);

        // Add neon outline to the stand boundary box
        const standEdges = new THREE.EdgesGeometry(standGeo);
        const standLineMat = new THREE.LineBasicMaterial({ color: statusColor, transparent: true, opacity: 0.5 });
        const standOutline = new THREE.LineSegments(standEdges, standLineMat);
        standMesh.add(standOutline);

        // Signify stand status in interactive tooltip
        standMesh.userData = {
          properties: {
            'Stand Name': `Berth Stand #${this.pierCounter}`,
            'Type': 'Vessel Mooring Stand',
            'Mooring Status': statusText,
            'Current Vessel': isOccupied ? shipName : 'None (Available)',
            'Actual Arrival': isOccupied ? arrivalTime : 'N/A',
            'Estimated Departure': isOccupied ? departureTime : 'N/A',
            'Next Ship Scheduled': nextShip,
            'Next Ship ETA': nextArrival
          }
        };
        this.interactiveObjects.push(standMesh);

        // Place status indicator beacon pole on the pier
        const beaconGroup = new THREE.Group();
        beaconGroup.position.set(center.x, center.y, 2.5); // sitting exactly on top of the pier top Z level (2.5)

        const beaconPoleGeo = new THREE.CylinderGeometry(0.8, 0.8, 8, 8);
        const beaconPoleMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.8 });
        const beaconPole = new THREE.Mesh(beaconPoleGeo, beaconPoleMat);
        beaconPole.rotation.x = Math.PI / 2;
        beaconPole.position.z = 4;
        beaconGroup.add(beaconPole);

        const beaconBulbGeo = new THREE.SphereGeometry(2, 16, 16);
        const beaconBulbMat = new THREE.MeshBasicMaterial({ color: statusColor });
        const beaconBulb = new THREE.Mesh(beaconBulbGeo, beaconBulbMat);
        beaconBulb.position.z = 9;
        beaconGroup.add(beaconBulb);

        this.piersGroup.add(beaconGroup);

        if (isDelayed) {
          this.pulsingBeacons.push(beaconBulb);
        }

        // If the stand is occupied, spawn the cargo ship
        if (isOccupied) {
          const hullColor = isDelayed ? 0x5a1e1e : 0x1e293b; // red-tinted hull for delayed, slate-blue for on-time
          const containerColor = isDelayed ? 0xd97706 : 0x059669;
          const shipMesh = this.createCargoShipMesh(hullColor, containerColor);
          
          shipMesh.position.set(center.x + 55, center.y, -8.0); // sit inside the stand box in the water (Z = -8.0)
          
          shipMesh.userData = {
            properties: {
              'Vessel Name': shipName,
              'Carrier Company': carrier,
              'Cargo Type': cargo,
              'Berth Location': props.name || `Berth Stand #${this.pierCounter}`,
              'Mooring Status': statusText,
              'Actual Arrival': arrivalTime,
              'Estimated Departure': departureTime,
              'Next Port Call': 'Mundra Port (INMUN)',
              'Operating Agent': 'Kandla Marine Services Ltd'
            }
          };

          this.shipsGroup.add(shipMesh);
          this.interactiveObjects.push(shipMesh);
        }
      } catch (err) {}
    });
  }

  private renderWater(geom: any, props: any) {
    if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
      // Render linear water features like tidal channels exactly as paths
      const paths: THREE.Vector2[][] = [];
      if (geom.type === 'LineString') {
        paths.push(this.createPathFromCoords(geom.coordinates));
      } else {
        geom.coordinates.forEach((lineCoords: any) => {
          paths.push(this.createPathFromCoords(lineCoords));
        });
      }

      paths.forEach(points => {
        if (points.length < 2) return;
        
        const width = 25.0; // wide channel width
        const vertices: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];

        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          let dir = new THREE.Vector2();

          if (i === 0) {
            dir.copy(points[i + 1]).sub(p).normalize();
          } else if (i === points.length - 1) {
            dir.copy(p).sub(points[i - 1]).normalize();
          } else {
            const dirPrev = new THREE.Vector2().copy(p).sub(points[i - 1]).normalize();
            const dirNext = new THREE.Vector2().copy(points[i + 1]).sub(p).normalize();
            dir.copy(dirPrev).add(dirNext).normalize();
          }

          const normal = new THREE.Vector2(-dir.y, dir.x).normalize();
          const left = new THREE.Vector2().copy(p).addScaledVector(normal, width / 2);
          const right = new THREE.Vector2().copy(p).addScaledVector(normal, -width / 2);

          vertices.push(left.x, left.y, -8.0); // Raised slightly above base sea plane at -10.0
          vertices.push(right.x, right.y, -8.0);
          
          uvs.push(0, i / points.length);
          uvs.push(1, i / points.length);

          if (i < points.length - 1) {
            const currLeft = i * 2;
            const currRight = i * 2 + 1;
            const nextLeft = (i + 1) * 2;
            const nextRight = (i + 1) * 2 + 1;

            indices.push(currLeft, currRight, nextLeft);
            indices.push(currRight, nextRight, nextLeft);
          }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(indices);
        geo.computeVertexNormals();

        const mesh = new THREE.Mesh(geo, this.waterMaterial);
        mesh.receiveShadow = false; // Disable to prevent shadow flickering
        this.waterGroup.add(mesh);
      });
      return;
    }

    if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return;

    const shapes: THREE.Shape[] = [];
    if (geom.type === 'Polygon') {
      shapes.push(this.createShapeFromPolygon(geom.coordinates));
    } else {
      geom.coordinates.forEach((polyCoords: any) => {
        shapes.push(this.createShapeFromPolygon(polyCoords));
      });
    }

    shapes.forEach(shape => {
      try {
        const geo = new THREE.ShapeGeometry(shape);
        const mesh = new THREE.Mesh(geo, this.waterMaterial);
        mesh.position.z = -8.0; // Place slightly above base water level Z = -10.0 to prevent Z-fighting
        mesh.receiveShadow = false; // Disable to prevent shadow flickering
        
        mesh.userData = {
          properties: {
            name: props.name || 'Kandla Creek shipping channel',
            type: 'Harbor Waterway',
            natural: props.natural || 'water',
            ...props
          }
        };

        this.waterGroup.add(mesh);
      } catch (err) {}
    });
  }

  private renderWetland(geom: any, props: any) {
    if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return;

    const shapes: THREE.Shape[] = [];
    if (geom.type === 'Polygon') {
      shapes.push(this.createShapeFromPolygon(geom.coordinates));
    } else {
      geom.coordinates.forEach((polyCoords: any) => {
        shapes.push(this.createShapeFromPolygon(polyCoords));
      });
    }

    const color = props.landuse === 'salt_pond' ? 0xccfbf1 : 0x166534; // light turquoise for salt pond, dark forest green for wetland
    const opacity = props.landuse === 'salt_pond' ? 0.75 : 0.6;
    const mat = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.9,
      metalness: 0.1,
      transparent: true,
      opacity: opacity
    });

    shapes.forEach(shape => {
      try {
        const geo = new THREE.ShapeGeometry(shape);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = 0.2; // Slightly above ground (0.0) but below roads (1.0) to prevent Z-fighting
        mesh.receiveShadow = false; // Disable to prevent shadow flickering
        
        mesh.userData = {
          properties: {
            name: props.name || (props.landuse === 'salt_pond' ? 'Salt Evaporation Pond' : 'Kandla Mudflats & Wetland'),
            type: props.landuse === 'salt_pond' ? 'Salt Pond' : 'Wetland / Mudflat',
            ...props
          }
        };

        this.scene.add(mesh);
        this.interactiveObjects.push(mesh);
      } catch (err) {}
    });
  }

  private renderLandPolygon(geom: any, props: any) {
    if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return;

    const shapes: THREE.Shape[] = [];
    if (geom.type === 'Polygon') {
      shapes.push(this.createShapeFromPolygon(geom.coordinates));
    } else {
      geom.coordinates.forEach((polyCoords: any) => {
        shapes.push(this.createShapeFromPolygon(polyCoords));
      });
    }

    const isDark = this.isDarkMode();
    const landTexture = isDark ? this.createDarkLandTexture() : this.createLightLandTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: landTexture,
      roughness: 0.95,
      metalness: 0.05,
      flatShading: true
    });

    shapes.forEach(shape => {
      try {
        const geo = new THREE.ShapeGeometry(shape);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.z = 0.0; // Place at land level (above water at -8.0)
        mesh.receiveShadow = false; // Disable to completely prevent shadow acne/flickering
        
        mesh.userData = {
          properties: {
            name: props.name || 'Land Cover',
            type: props.landuse ? `Landuse: ${props.landuse}` : 'Land Terrain',
            ...props
          }
        };

        this.scene.add(mesh);
      } catch (err) {}
    });
  }

  private renderRoad(geom: any, props: any) {
    if (geom.type !== 'LineString' && geom.type !== 'MultiLineString') return;

    const paths: THREE.Vector2[][] = [];
    if (geom.type === 'LineString') {
      paths.push(this.createPathFromCoords(geom.coordinates));
    } else {
      geom.coordinates.forEach((lineCoords: any) => {
        paths.push(this.createPathFromCoords(lineCoords));
      });
    }

    paths.forEach(points => {
      if (points.length < 2) return;

      // Determine road width based on highway class
      let width = 4.5;
      if (props.highway === 'motorway' || props.highway === 'trunk' || props.highway === 'primary') {
        width = 12.0;
      } else if (props.highway === 'secondary' || props.highway === 'tertiary') {
        width = 8.0;
      } else if (props.railway) {
        width = 3.5;
      }

      const vertices: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      // Pre-calculate accumulated distances along the path for UV V-coordinate mapping
      let accumDist = 0;
      const distances: number[] = [0];
      for (let i = 1; i < points.length; i++) {
        accumDist += points[i].distanceTo(points[i - 1]);
        distances.push(accumDist);
      }

      // Generate left and right vertices along the road path
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        let dir = new THREE.Vector2();

        if (i === 0) {
          dir.copy(points[i + 1]).sub(p).normalize();
        } else if (i === points.length - 1) {
          dir.copy(p).sub(points[i - 1]).normalize();
        } else {
          // Average direction of incoming and outgoing segments
          const dirPrev = new THREE.Vector2().copy(p).sub(points[i - 1]).normalize();
          const dirNext = new THREE.Vector2().copy(points[i + 1]).sub(p).normalize();
          dir.copy(dirPrev).add(dirNext).normalize();
        }

        const normal = new THREE.Vector2(-dir.y, dir.x).normalize();
        const left = new THREE.Vector2().copy(p).addScaledVector(normal, width / 2);
        const right = new THREE.Vector2().copy(p).addScaledVector(normal, -width / 2);

        // Z-coordinate slightly above terrain at 0.6 so they overlap cleanly without z-fighting
        // Z-coordinate slightly above terrain at 1.0 (roads) or 1.05 (railways) so they overlap cleanly without z-fighting
        const roadZ = props.railway ? 1.05 : 1.0;
        vertices.push(left.x, left.y, roadZ);
        vertices.push(right.x, right.y, roadZ);

        // Map UVs: U = 0 (left) and 1 (right). V repeats every 30 units of distance
        const v = distances[i] / 30.0;
        uvs.push(0, v);
        uvs.push(1, v);

        // Build quad indices
        if (i < points.length - 1) {
          const currLeft = i * 2;
          const currRight = i * 2 + 1;
          const nextLeft = (i + 1) * 2;
          const nextRight = (i + 1) * 2 + 1;

          indices.push(currLeft, currRight, nextLeft);
          indices.push(currRight, nextRight, nextLeft);
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, this.roadMaterial);
      mesh.receiveShadow = false; // Disable to completely prevent shadow acne/flickering
      
      mesh.userData = {
        properties: {
          name: props.name || 'Port Corridor Road',
          type: props.highway ? 'Road' : 'Railway',
          highway: props.highway,
          railway: props.railway,
          ...props
        }
      };

      this.roadsGroup.add(mesh);
    });
  }

  // --- 6. GEOMETRY GENERATOR HELPERS ---
  private createShapeFromPolygon(coordinates: number[][][]): THREE.Shape {
    const shape = new THREE.Shape();
    
    // Outer shell
    const outer = coordinates[0];
    if (outer.length < 3) return shape;
    
    const start = this.project(outer[0][1], outer[0][0]);
    shape.moveTo(start.x, start.y);
    
    for (let i = 1; i < outer.length; i++) {
      const pt = this.project(outer[i][1], outer[i][0]);
      shape.lineTo(pt.x, pt.y);
    }
    shape.closePath();
    
    // Parse inner holes
    for (let h = 1; h < coordinates.length; h++) {
      const holeCoords = coordinates[h];
      if (holeCoords.length < 3) continue;
      
      const holePath = new THREE.Path();
      const hStart = this.project(holeCoords[0][1], holeCoords[0][0]);
      holePath.moveTo(hStart.x, hStart.y);
      
      for (let i = 1; i < holeCoords.length; i++) {
        const pt = this.project(holeCoords[i][1], holeCoords[i][0]);
        holePath.lineTo(pt.x, pt.y);
      }
      holePath.closePath();
      shape.holes.push(holePath);
    }
    
    return shape;
  }

  private createPathFromCoords(coordinates: number[][]): THREE.Vector2[] {
    const points: THREE.Vector2[] = [];
    coordinates.forEach(coord => {
      points.push(this.project(coord[1], coord[0]));
    });
    return points;
  }

  // --- 7. SPAWN AND ANIMATE CUSTOM CARGO SHIPS ---
  private spawnCargoShips() {
    // Disabled - Ships are not live data
  }

  private createCargoShipMesh(hullColor: number, containerColor: number): THREE.Group {
    const ship = new THREE.Group();

    // 1. Lower Hull (Red bottom)
    const lowerHullGeo = new THREE.BoxGeometry(20, 95, 6);
    const redMat = new THREE.MeshStandardMaterial({ color: 0x991b1b, roughness: 0.7 });
    const lowerHull = new THREE.Mesh(lowerHullGeo, redMat);
    lowerHull.position.z = -1;
    lowerHull.castShadow = true;
    lowerHull.receiveShadow = true;
    ship.add(lowerHull);

    // 2. Main Deck/Hull
    const mainHullGeo = new THREE.BoxGeometry(20, 90, 8);
    const hullMat = new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.6 });
    const mainHull = new THREE.Mesh(mainHullGeo, hullMat);
    mainHull.position.z = 4;
    mainHull.castShadow = true;
    mainHull.receiveShadow = true;
    ship.add(mainHull);

    // Bow (Pointy front)
    const bowGeo = new THREE.ConeGeometry(10, 16, 4);
    const bow = new THREE.Mesh(bowGeo, hullMat);
    bow.position.set(0, 50, 4);
    bow.rotation.x = Math.PI / 2;
    bow.rotation.y = Math.PI / 4;
    bow.scale.set(1.4, 1.4, 0.8);
    bow.castShadow = true;
    ship.add(bow);

    // Stern (Rounded back)
    const sternGeo = new THREE.CylinderGeometry(10, 10, 8, 8, 1, false, 0, Math.PI);
    const stern = new THREE.Mesh(sternGeo, hullMat);
    stern.position.set(0, -45, 4);
    stern.rotation.z = Math.PI;
    stern.castShadow = true;
    ship.add(stern);

    // 3. Bridge/Cabin (Superstructure at the stern)
    const cabinGroup = new THREE.Group();
    cabinGroup.position.set(0, -32, 11);

    const cabinBaseGeo = new THREE.BoxGeometry(16, 12, 6);
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4 });
    const cabinBase = new THREE.Mesh(cabinBaseGeo, whiteMat);
    cabinBase.castShadow = true;
    cabinGroup.add(cabinBase);

    // Upper bridge deck with glass windows
    const bridgeGeo = new THREE.BoxGeometry(18, 8, 4);
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.1, metalness: 0.9 });
    const bridge = new THREE.Mesh(bridgeGeo, glassMat);
    bridge.position.z = 4;
    cabinGroup.add(bridge);

    // Bridge roof
    const roofGeo = new THREE.BoxGeometry(19, 9, 1);
    const roof = new THREE.Mesh(roofGeo, whiteMat);
    roof.position.z = 6;
    cabinGroup.add(roof);

    // Radar Mast
    const mastGeo = new THREE.CylinderGeometry(0.5, 0.5, 8, 4);
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x475569 });
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(0, 0, 9);
    mast.rotation.x = Math.PI / 2;
    cabinGroup.add(mast);

    ship.add(cabinGroup);

    // 4. Stacks of Containers (Middle deck)
    const containersGroup = new THREE.Group();
    containersGroup.position.set(0, 10, 9);

    // Stack container boxes procedurally
    const colors = [containerColor, 0x1e3a8a, 0x15803d, 0xb45309, 0x6b21a8];
    
    // Grid: columns (X), rows (Y), tiers (Z)
    for (let xOffset of [-5, 0, 5]) {
      for (let yOffset = -25; yOffset <= 25; yOffset += 12) {
        const heightMultiplier = Math.floor(Math.random() * 3) + 1; // Stack 1 to 3 containers high
        
        for (let zOffset = 0; zOffset < heightMultiplier; zOffset++) {
          const col = colors[(Math.abs(xOffset + yOffset + zOffset)) % colors.length];
          const containerGeo = new THREE.BoxGeometry(4.5, 10.5, 4.5);
          const containerMat = new THREE.MeshStandardMaterial({ 
            color: col, 
            roughness: 0.7, 
            metalness: 0.3 
          });
          
          const box = new THREE.Mesh(containerGeo, containerMat);
          box.position.set(xOffset, yOffset, zOffset * 4.8);
          box.castShadow = true;
          box.receiveShadow = true;
          containersGroup.add(box);
        }
      }
    }

    ship.add(containersGroup);

    // Scale ship slightly to look proportional in the channel
    ship.scale.set(1.5, 1.5, 1.5);
    return ship;
  }

  // --- 8. ANIMATION LOOP ---
  private animate() {
    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
    
    const delta = this.clock.getDelta();
    const elapsedTime = this.clock.getElapsedTime();

    // 1. Update controls
    if (this.controls.target.z < 2.0) {
      this.controls.target.z = 2.0;
    }
    this.controls.update();

    // Pulse delayed stand beacons dynamically
    this.pulsingBeacons.forEach(bulb => {
      const scale = 1.0 + Math.sin(elapsedTime * 4.0) * 0.15;
      bulb.scale.set(scale, scale, scale);
    });

    // 2. Animate Water Ripples & Texture Offset
    if (this.waterMaterial) {
      // Animate wave texture coordinates for active moving ripple effect
      if (this.waterMaterial.map) {
        this.waterMaterial.map.offset.y = elapsedTime * 0.03;
        this.waterMaterial.map.offset.x = Math.sin(elapsedTime * 0.5) * 0.015;
      }
    }

    // 3. Render Scene
    this.renderer.render(this.scene, this.camera);
  }

  // --- 9. VIEWPORT INTERACTIVITY & CONTROLS ---

  toggleLayer(layerName: keyof ViewportLayers) {
    this.layers[layerName] = !this.layers[layerName];
    
    // Toggle visible layers in ThreeJS Groups
    switch (layerName) {
      case 'water':
        this.waterGroup.visible = this.layers.water;
        break;
      case 'piers':
        this.piersGroup.visible = this.layers.piers;
        break;
      case 'buildings':
        this.buildingsGroup.visible = this.layers.buildings;
        break;
      case 'roads':
        this.roadsGroup.visible = this.layers.roads;
        break;
      case 'ships':
        this.shipsGroup.visible = this.layers.ships;
        break;
    }
  }

  setCameraView(viewName: string) {
    this.currentView.set(viewName);
    
    // Disable active rotation during presets
    this.controls.autoRotate = false;
    this.autoRotate.set(false);

    // Smooth transition coords (normally we could LERP, but setting positions directly is robust)
    if (viewName === 'docks') {
      // Zoom close to main shipping terminal
      this.camera.position.set(-150, -500, 300);
      this.controls.target.set(-150, 0, 0);
    } else if (viewName === 'overview') {
      // Distant birds eye overview
      this.camera.position.set(0, -1100, 1100);
      this.controls.target.set(0, 0, 0);
    }
    
    this.controls.update();
  }

  toggleAutoRotate() {
    const active = !this.autoRotate();
    this.autoRotate.set(active);
    this.controls.autoRotate = active;
    this.controls.autoRotateSpeed = 1.0;
  }

  toggleDashboard() {
    this.dashboardVisible.set(!this.dashboardVisible());
  }

  clearSelection() {
    this.selectedObject.set(null);
    this.selectedObjectProperties.set(null);

    // Restore original highlight material
    if (this.highlightedObject) {
      const orig = this.originalMaterials.get(this.highlightedObject.uuid);
      if (orig) {
        (this.highlightedObject as THREE.Mesh).material = orig;
      }
      this.highlightedObject = null;
    }
  }

  private selectObject(object: THREE.Object3D) {
    this.clearSelection();

    this.selectedObject.set(object);
    this.selectedObjectProperties.set(object.userData['properties']);
    this.highlightedObject = object;

    // Apply glowing Neon highlight material
    const mesh = object as THREE.Mesh;
    
    // Store original if not already stored
    if (!this.originalMaterials.has(mesh.uuid)) {
      this.originalMaterials.set(mesh.uuid, mesh.material);
    }

    const highlightMat = new THREE.MeshStandardMaterial({
      color: 0xff007f, // Neon Pink
      roughness: 0.1,
      metalness: 0.8,
      emissive: 0xff007f,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.85
    });

    mesh.material = highlightMat;
  }

  // --- 10. EVENTS AND HANDLERS ---

  private onWindowResize() {
    const container = this.canvasContainer.nativeElement;
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  private onCanvasClick(event: MouseEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.interactiveObjects, true);

    if (intersects.length > 0) {
      let rootObj: THREE.Object3D | null = intersects[0].object;
      
      // Climb up hierarchy to find parent with tags
      while (rootObj && !rootObj.userData['properties']) {
        rootObj = rootObj.parent;
      }

      if (rootObj) {
        this.selectObject(rootObj);
        return;
      }
    }
    
    // Clicked empty ground
    this.clearSelection();
  }

  private onCanvasMouseMove(event: MouseEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.interactiveObjects, true);

    const tooltip = this.tooltipRef.nativeElement;

    if (intersects.length > 0) {
      let rootObj: THREE.Object3D | null = intersects[0].object;
      while (rootObj && !rootObj.userData['properties']) {
        rootObj = rootObj.parent;
      }

      if (rootObj) {
        this.hoveredObject = rootObj;
        const name = rootObj.userData['properties'].name || 'Port Object';
        const type = rootObj.userData['properties'].type || 'Feature';
        
        // Show tooltip
        tooltip.innerHTML = `<strong>${name}</strong><br/>${type}`;
        tooltip.style.left = `${event.clientX}px`;
        tooltip.style.top = `${event.clientY}px`;
        tooltip.style.opacity = '1';
        document.body.style.cursor = 'pointer';
        return;
      }
    }

    this.hoveredObject = null;
    tooltip.style.opacity = '0';
    document.body.style.cursor = 'default';
  }

  // --- 11. PROCEDURAL TEXTURES GENERATORS ---
  private createLightLandTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f4f1ea'; // Beautiful pale warm cream matching the reference image exactly
    ctx.fillRect(0, 0, 256, 256);
    
    // Elegant light texture noise
    for (let i = 0; i < 4000; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const size = Math.random() * 1.2 + 0.4;
      ctx.fillStyle = 'rgba(230, 226, 218, 0.5)';
      ctx.fillRect(x, y, size, size);
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(60, 60);
    return texture;
  }

  private createDarkLandTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0a0f24'; // Gorgeous deep space navy blue ground
    ctx.fillRect(0, 0, 256, 256);
    
    // Tech-style dark dots
    for (let i = 0; i < 5000; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const size = Math.random() * 1.5;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.4)';
      ctx.fillRect(x, y, size, size);
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(60, 60);
    return texture;
  }

  private createLightWaterTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#a5d3f7'; // Soft sky blue sea matching the screenshot exactly
    ctx.fillRect(0, 0, 256, 256);
    
    // Soft white wave overlays
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    for (let y = 10; y < 250; y += 20) {
      ctx.beginPath();
      for (let x = 0; x <= 256; x += 16) {
        const offset = Math.sin((x / 20) + (y / 15)) * 3.0;
        if (x === 0) ctx.moveTo(x, y + offset);
        else ctx.lineTo(x, y + offset);
      }
      ctx.stroke();
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(12, 12);
    return texture;
  }

  private createDarkWaterTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0f172a'; // Deep dark navy sea
    ctx.fillRect(0, 0, 256, 256);
    
    // Shimmering blue wave active ripples
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
    ctx.lineWidth = 2.0;
    for (let y = 8; y < 250; y += 16) {
      ctx.beginPath();
      for (let x = 0; x <= 256; x += 12) {
        const offset = Math.sin((x / 25) + (y / 12)) * 4.0;
        if (x === 0) ctx.moveTo(x, y + offset);
        else ctx.lineTo(x, y + offset);
      }
      ctx.stroke();
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(12, 12);
    return texture;
  }

  private createLightRoadTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    
    // Solid, high-contrast steel blue road matching screenshot
    ctx.fillStyle = '#4b6f96'; 
    ctx.fillRect(0, 0, 64, 128);
    
    // Elegant darker borders
    ctx.fillStyle = '#375270';
    ctx.fillRect(0, 0, 2, 128);
    ctx.fillRect(62, 0, 2, 128);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }

  private createDarkRoadTexture(): THREE.Texture {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    
    // Tech-style charcoal black base
    ctx.fillStyle = '#111520'; 
    ctx.fillRect(0, 0, 64, 128);
    
    // Glowing neon cyan borders for extreme dark mode visibility
    ctx.fillStyle = '#00f0ff'; 
    ctx.fillRect(0, 0, 3, 128);
    ctx.fillRect(61, 0, 3, 128);
    
    // Bright white dashed center lane lines
    ctx.fillStyle = '#ffffff';
    for (let y = 8; y < 128; y += 32) {
      ctx.fillRect(30, y, 4, 16);
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }

  // --- 12. DYNAMIC LIGHT/DARK THEME TOGGLE ENGINE ---
  toggleTheme() {
    this.isDarkMode.set(!this.isDarkMode());
    this.applyTheme();
  }

  private applyTheme() {
    const isDark = this.isDarkMode();
    
    // 1. Update sky background & fog colors
    const skyColor = isDark ? 0x0a0f24 : 0xe0f2fe;
    this.scene.background = new THREE.Color(skyColor);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.setHex(skyColor);
    }
    
    // 2. Traversal update for all standard lighting intensities & hues
    this.scene.traverse((child) => {
      if (child instanceof THREE.AmbientLight) {
        child.color.setHex(isDark ? 0x3b82f6 : 0xffffff); // tech blue-tinted in dark mode, pure white daylight in light mode
        child.intensity = isDark ? 0.45 : 1.1;
      }
      if (child instanceof THREE.DirectionalLight) {
        // Position checked to discriminate between main sun and opposite fill light
        if (child.position.y > 0) { // Main Sun
          child.color.setHex(isDark ? 0x8ab4f8 : 0xfffbeb); // warm-cream in light, steel-blue in dark mode
          child.intensity = isDark ? 0.65 : 1.2;
        } else { // Soft fill
          child.color.setHex(isDark ? 0x1e293b : 0xffffff);
          child.intensity = isDark ? 0.2 : 0.35;
        }
      }
    });
    
    // 3. Dynamic land mesh mapping
    if (this.landMesh) {
      const landTexture = isDark ? this.createDarkLandTexture() : this.createLightLandTexture();
      if (this.landMesh.material instanceof THREE.MeshStandardMaterial) {
        this.landMesh.material.map = landTexture;
        this.landMesh.material.color.setHex(0xffffff); // reset color filters
        this.landMesh.material.needsUpdate = true;
      }
    }
    
    // 4. Dynamic water material properties
    if (this.waterMaterial) {
      const waterTexture = isDark ? this.createDarkWaterTexture() : this.createLightWaterTexture();
      this.waterMaterial.map = waterTexture;
      this.waterMaterial.color.setHex(isDark ? 0x0f172a : 0xa5d3f7); // Deep sea in dark mode, pastel blue sky reflection in light mode
      this.waterMaterial.roughness = isDark ? 0.3 : 0.45;
      this.waterMaterial.metalness = isDark ? 0.8 : 0.6;
      this.waterMaterial.opacity = isDark ? 0.95 : 0.88;
      this.waterMaterial.needsUpdate = true;
    }
    
    // 5. Dynamic road material properties
    if (this.roadMaterial) {
      const roadTexture = isDark ? this.createDarkRoadTexture() : this.createLightRoadTexture();
      this.roadMaterial.map = roadTexture;
      this.roadMaterial.needsUpdate = true;
    }
    
    // 6. Docks/Berths concrete styling
    this.piersGroup.traverse((child) => {
      if (child instanceof THREE.Mesh && child.userData['properties'] && child.userData['properties']['Type'] === 'Shipping Berth') {
        const mat = child.material as THREE.MeshStandardMaterial;
        mat.color.setHex(isDark ? 0x1e293b : 0xcbd5e1); // Concrete colors
        mat.needsUpdate = true;
      }
    });
    
    // 7. Architectural buildings styling
    this.buildingsGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshStandardMaterial;
        mat.color.setHex(isDark ? 0x1e293b : 0xd1c7bd); // Dark blocks vs soft architectural beige
        mat.emissive.setHex(isDark ? 0x0c4a6e : 0x000000); // Glowing office windows in dark mode, disabled in light
        mat.emissiveIntensity = isDark ? 0.35 : 0.0;
        mat.needsUpdate = true;
        
        // Update structural wireframe outlines
        child.children.forEach(c => {
          if (c instanceof THREE.LineSegments && c.material instanceof THREE.LineBasicMaterial) {
            c.material.color.setHex(isDark ? 0x00f0ff : 0x8a7b6e); // Neon cyan outlines in dark, soft brown in light mode
            c.material.opacity = isDark ? 0.7 : 0.3;
            c.material.needsUpdate = true;
          }
        });
      }
    });
  }
}
