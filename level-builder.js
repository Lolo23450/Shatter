import * as THREE from 'three';

const CHAPTER_LEVEL_NAMES = [
    ["THE ATRIUM","THE CORRIDOR","THE SHAFTS","THE PENTHOUSE","THE WELL",
    "THE TOWER","THE TUNNEL","THE LEDGES", "THE CROSSING", "THE ROTUNDA"],
    ["THE SPIRAL", "THE INTERLOCK", "THE VAULT", "THE PRESS", "THE GALE",
    "THE DROP", "THE AQUEDUCT", "THE BRIDGE", "THE GAUNTLET", "THE CATHEDRAL"],
    ["THE GATES", "THE LAUNCHPAD", "THE DEPTHS", "THE SCALE", "THE MECHANISM",
    "THE ASCENT", "THE OVERHANG", "THE COMPANION", "THE BREACH", "THE ZENITH"]
];

const LEVEL_NAMES = CHAPTER_LEVEL_NAMES.flat();

const CHAPTERS = [
    { 
        id: 0, name: 'CH 1', title: 'THE FUNDAMENTALS',
        chip: '#a0c8ff', chipBorder: 'rgba(160,200,255,0.4)', chipShadow: '0 0 8px rgba(160,200,255,0.5)',
        env: {
            fog: 0xcadbf0, density: 0.0014, // slightly brighter fog to match lights
            hemi: 0x8b9cc2, ground: 0x4c5468, // lifted ambient bounce
            sun: 0xffd0b0, sunInt: 8.5, sunPos: [20, 35, -40], // sunInt increased from 6.5 -> 8.5
            fill: 0xa0b8d0, fillInt: 1.8, sky: 0xffffff, // fillInt increased from 1.2 -> 1.8
            skyStops: ['#040810', '#15243d', '#6c566a', '#d68962', '#e9ceb3', '#8da4b8']
        }
    },
    { 
        id: 1, name: 'CH 2', title: 'THE ARCHIVE',
        // Chip colors updated to Aurora Green
        chip: '#4ade80', 
        chipBorder: 'rgba(74, 222, 128, 0.4)', 
        chipShadow: '0 0 12px rgba(34, 197, 94, 0.5)',
        env: {
            // Deep midnight blue-black fog for high-contrast auroras
            fog: 0x050914, 
            density: 0.002, 

            // Cool, ambient night light
            hemi: 0x1a2b45, 
            ground: 0x020408, 

            // The "Sun" is now a cold, bright Cyan (simulating a moon or auroral burst)
            sun: 0x7df9ff, 
            sunInt: 1.5, 
            sunPos: [50, 25, -20], 

            // Fill light provides a subtle violet-teal shift to the shadows
            fill: 0x7df9ff, 
            fillInt: 0.5, 
            sky: 0x0a1525, 

            // SkyStops: Deep Space -> Midnight Blue -> Aurora Teal -> Horizon Void
            skyStops: [
                '#01030a', // Zenith (Nearly black)
                '#050c18', // Deep Night Blue
                '#0c1a2b', // Atmospheric Navy
                '#103040', // Deep Teal transition
                '#154a40', // Aurora glow base (Faint Greenish tint)
                '#050914'  // Horizon (Back to deep fog color)
            ]
        },
    },
    { 
        id: 2, name: 'CH 3', title: 'THE CITADEL',
        chip: '#ff5080', chipBorder: 'rgba(255,80,128,0.4)', chipShadow: '0 0 8px rgba(255,80,128,0.5)',
        env: {
            fog: 0x120f14, // Much darker base haze
            density: 0.007, // Thicker but darker
            hemi: 0x08080a, // Near-black ambient light
            ground: 0x020202, 
            sun: 0xffccaa, // The peach sun remains for contrast
            sunPos: [50, 10, -10],
            sunInt: 0.5,
            fill: 0x120f14, 
            fillInt: 0.15, // Shadows are now nearly pitch black
            sky: 0x000000,
            skyStops: [
                '#000000', '#120f14', '#3b2a2a', '#ffccaa', '#2d242f', '#000000'
            ]
        }
    },
];

class LevelBuilder {
    constructor(id, name) {
        this.id = id; this.name = name;
        this.bounds = { x: 15, y: 30, z: 15 };
        this.spawn = new THREE.Vector3(0, 2, -5);
        this.exit = new THREE.Vector3(0, 2, 5);

        this.blocks = []; this.holograms = []; this.winds = [];
        this.cutscene = 'flyover';
        this.flyCamStart = new THREE.Vector3(10, 15, 10);
        this.flyCamLook = new THREE.Vector3(0, 5, 0);

        this.additives = []; this.subtractives = []; this.customRules = [];
        // Destruction zones: array of { cx, cy, cz, innerRadius, outerRadius }
        this.destructionZones = [];
        // Water: { y, color, distortionScale, alpha }
        this.waterY = undefined;
        this.waterOptions = {};
        this.ropes = [];
        this.plates = [];
        this.doors = [];
        this.fields = []; // <--- ADD THIS
        this.logic = [];  // <--- ADD THIS
    }

    // Add a heavy pressure plate (activates on specific channel)
    addPlate(x, y, z, channel = 1) {
        this.plates.push({ x, y, z, channel });
        return this;
    }

    // Replace the old addDoor method with this:
    addDoor(x, y, z, config = {}) {
        this.doors.push({ 
            x, y, z, 
            channel: config.channel || 1, 
            dir: config.dir || 'left', 
            width: config.width || 3, 
            height: config.height || 3, 
            moveDist: config.moveDist || 2.8,
            normal: config.normal // <--- CRITICAL: Pass the normal!
        });
        return this;
    }

    addAeroFilter(x, y, z, channel, w = 3, h = 3, normal = null) {
        this.fields = this.fields || [];
        this.fields.push({ type: 'aero', x, y, z, channel, w, h, normal }); // Store normal
        return this;
    }

    addOneWayField(x, y, z, channel, inverted = false, w = 3, h = 3, normal = null) {
        this.fields = this.fields || [];
        this.fields.push({ type: 'oneway', x, y, z, channel, inverted, w, h, normal }); // Store normal
        return this;
    }

    addLogicGate(outputCh, type, operands) {
        this.logic = this.logic || [];
        // Ensure operands is always an array
        const ops = Array.isArray(operands) ? operands : [operands];
        this.logic.push({ ch: outputCh, type, operands: ops });
        return this;
    }

    // Add a physics rope
    addRope(x1, y1, z1, x2, y2, z2, segments = 10) {
        this.ropes.push({ p1: {x:x1, y:y1, z:z1}, p2: {x:x2, y:y2, z:z2}, segments });
        return this;
    }

    setBounds(x, y, z) { this.bounds = { x, y, z }; return this; }
    setSpawn(x, y, z) { this.spawn.set(x, y, z); return this; }
    setExit(x, y, z) { this.exit.set(x, y, z); return this; }
    setCutscene(type) { this.cutscene = type; return this; }

    addEntity(type, x, y, z, options = {}) { this.blocks.push({ type, pos: new THREE.Vector3(x, y, z), ...options }); return this; }
    addHologram(text, x, y, z) { this.holograms.push({ text, pos: new THREE.Vector3(x, y, z) }); return this; }
    addWind(px, py, pz, sx, sy, sz, dx, dy, dz, strength = 15) { 
        this.winds.push({ pos: new THREE.Vector3(px, py, pz), size: new THREE.Vector3(sx, sy, sz), dir: new THREE.Vector3(dx, dy, dz).normalize(), strength }); return this; 
    }

    // Add a spherical destruction/rubble zone at (cx,cy,cz) with given radii
    addDestructionZone(cx, cy, cz, innerRadius = 6, outerRadius = 10) {
        this.destructionZones.push({ cx, cy, cz, innerRadius, outerRadius });
        return this;
    }

    // Add a default top-center destruction hole (backwards compat helper)
    addTopHole(radiusMult = 1.0) {
        const cy = this.bounds.y * 0.82;
        return this.addDestructionZone(0, cy, 0, 8 * radiusMult, 14 * radiusMult);
    }

    // Add water at a given world Y level
    setWater(y, options = {}) {
        this.waterY = y;
        this.waterOptions = { color: 0x0044aa, distortionScale: 2.5, alpha: 0.88, ...options };
        return this;
    }

    addLight(x, y, z, color = 0xffffff, intensity = 3.0, radius = 8.0) {
        if (!this.lights) this.lights = [];
        this.lights.push({ x, y, z, color, intensity, radius });
        return this;
    }

    addPlatform(minX, maxX, minY, maxY, minZ, maxZ) { this.additives.push((x, y, z) => x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ); return this; }
    addVoid(minX, maxX, minY, maxY, minZ, maxZ) { this.subtractives.push((x, y, z) => x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ); return this; }
    addCustomLogic(func) { this.customRules.push(func); return this; }

    evaluateSolid(x, y, z) {
        for (let carve of this.subtractives) { if (carve(x, y, z)) return false; }
        for (let shape of this.additives) { if (shape(x, y, z)) return true; }
        for (let rule of this.customRules) { if (rule(x, y, z)) return true; }
        return y <= 0; // Default floor
    }
    build() { 
        return { 
            name: this.name, bounds: this.bounds, spawn: this.spawn, exit: this.exit, 
            blocks: this.blocks, holograms: this.holograms, winds: this.winds, 
            lights: this.lights || [], cutscene: this.cutscene, 
            flyCamStart: this.flyCamStart, flyCamLook: this.flyCamLook, 
            destructionZones: this.destructionZones, waterY: this.waterY, 
            waterOptions: this.waterOptions, ropes: this.ropes, 
            plates: this.plates, doors: this.doors, 
            fields: this.fields, // <--- ADD THIS
            logic: this.logic,   // <--- ADD THIS
            isSolid: (x, y, z) => this.evaluateSolid(x, y, z) 
        }; 
    }        
}

export { CHAPTER_LEVEL_NAMES, LEVEL_NAMES, CHAPTERS, LevelBuilder };