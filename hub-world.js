// ═══════════════════════════════════════════════════════════════════════════
//  hub-world.js  —  THE NEXUS  Open-World Hub Level
//
//  Provides:
//    • HUB_LEVEL_INDEX      – sentinel used by getLevelParams / buildLevel
//    • HUB_GATES            – 12 gates (3 chapters × 4 gates × 3 levels each)
//    • getHubWorldParams()  – LevelBuilder config for hub terrain
//    • HubWorldRuntime      – per-session manager (portals, crystals, HUD)
//
//  Integration points in main.js listed at bottom of file.
// ═══════════════════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { LevelBuilder } from './level-builder.js';

// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const HUB_LEVEL_INDEX = 'HUB';

// Cube types a player can "master" by clearing a gate's 3 levels.
// In the hub these appear as glowing shard rewards that gate further chapters.
const CUBE_COLORS = {
    blue:       0x3388ff,
    green:      0x33ff99,
    red:        0xff3344,
    yellow:     0xffdd33,
    cyan:       0x33ffff,
    gray:       0xaaaaaa,
};

// ─────────────────────────────────────────────────────────────────────────────
//  GATE DEFINITIONS
//  id        – unique string, used as save key
//  ch        – which chapter (0/1/2)
//  gate      – gate index within chapter (0–3)
//  levels    – which campaign level indices inside that chapter
//  pos       – world-space centre of the gate arch
//  name      – display text on the portal
//  color     – portal / crystal hue
//  requiresCubes – which cube rewards must be earned before this gate opens
//  reward    – cube type granted after clearing ALL three levels
//  hue       – HSL hue (0–1) for crystal tint
// ─────────────────────────────────────────────────────────────────────────────

export const HUB_GATES = [
    // ── CHAPTER 1 ── The Fundamentals (North sector, blue daylight ruins)
    {
        id: '0_0', ch: 0, gate: 0, levels: [0, 1, 2],
        pos: { x: -8,  y: 0, z: -22 }, name: 'GATE Ⅰ',   subtitle: 'THE FUNDAMENTALS',
        color: 0xa0c8ff, hue: 0.60, requiresCubes: [],        reward: 'blue'
    },
    {
        id: '0_1', ch: 0, gate: 1, levels: [3, 4, 5],
        pos: { x: 10,  y: 0, z: -34 }, name: 'GATE Ⅱ',  subtitle: 'THE FUNDAMENTALS',
        color: 0xa0c8ff, hue: 0.58, requiresCubes: ['blue'],   reward: 'green'
    },
    {
        id: '0_2', ch: 0, gate: 2, levels: [6, 7, 8],
        pos: { x: -22, y: 0, z: -44 }, name: 'GATE Ⅲ', subtitle: 'THE FUNDAMENTALS',
        color: 0xa0c8ff, hue: 0.56, requiresCubes: ['blue'],   reward: 'red'
    },
    {
        id: '0_3', ch: 0, gate: 3, levels: [9, 0, 0],   // level 9 = finale, mirrors 0&0 for stub
        pos: { x: 5,   y: 5, z: -55 }, name: 'GATE Ⅳ',  subtitle: 'THE FUNDAMENTALS',
        color: 0xa0c8ff, hue: 0.55, requiresCubes: ['green', 'red'], reward: 'yellow'
    },

    // ── CHAPTER 2 ── The Archive (East sector, aurora green)
    {
        id: '1_0', ch: 1, gate: 0, levels: [0, 1, 2],
        pos: { x: 32,  y: 0, z: -14 }, name: 'GATE Ⅴ',  subtitle: 'THE ARCHIVE',
        color: 0x4ade80, hue: 0.37, requiresCubes: ['yellow'],  reward: 'cyan'
    },
    {
        id: '1_1', ch: 1, gate: 1, levels: [3, 4, 5],
        pos: { x: 44,  y: 0, z: 4   }, name: 'GATE Ⅵ',  subtitle: 'THE ARCHIVE',
        color: 0x4ade80, hue: 0.39, requiresCubes: ['cyan'],    reward: 'gray'
    },
    {
        id: '1_2', ch: 1, gate: 2, levels: [6, 7, 8],
        pos: { x: 40,  y: 0, z: 20  }, name: 'GATE Ⅶ', subtitle: 'THE ARCHIVE',
        color: 0x4ade80, hue: 0.41, requiresCubes: ['cyan'],    reward: null
    },
    {
        id: '1_3', ch: 1, gate: 3, levels: [9, 0, 0],
        pos: { x: 28,  y: 5, z: 32  }, name: 'GATE Ⅷ', subtitle: 'THE ARCHIVE',
        color: 0x4ade80, hue: 0.42, requiresCubes: ['gray'],    reward: null
    },

    // ── CHAPTER 3 ── The Citadel (South sector, dark crimson)
    {
        id: '2_0', ch: 2, gate: 0, levels: [0, 1, 2],
        pos: { x: -14, y: 0, z: 32  }, name: 'GATE Ⅸ',  subtitle: 'THE CITADEL',
        color: 0xff5080, hue: 0.95, requiresCubes: ['gray'],    reward: null
    },
    {
        id: '2_1', ch: 2, gate: 1, levels: [3, 4, 5],
        pos: { x: 4,   y: 0, z: 44  }, name: 'GATE Ⅹ',  subtitle: 'THE CITADEL',
        color: 0xff5080, hue: 0.97, requiresCubes: ['gray'],    reward: null
    },
    {
        id: '2_2', ch: 2, gate: 2, levels: [6, 7, 8],
        pos: { x: -28, y: 0, z: 48  }, name: 'GATE Ⅺ', subtitle: 'THE CITADEL',
        color: 0xff5080, hue: 0.99, requiresCubes: ['gray'],    reward: null
    },
    {
        id: '2_3', ch: 2, gate: 3, levels: [9, 0, 0],
        pos: { x: -10, y: 8, z: 58  }, name: 'GATE Ⅻ', subtitle: 'THE CITADEL',
        color: 0xff5080, hue: 0.02, requiresCubes: ['gray'],    reward: null
    },
];

// Map gateId → gate definition for O(1) lookup
export const GATE_BY_ID = Object.fromEntries(HUB_GATES.map(g => [g.id, g]));

// Default progress blob
export function defaultHubProgress() {
    return {
        unlockedCubes:    [],          // e.g. ['blue', 'green']
        completedLevels:  {},          // { '0_0_1': true }  key = gateId_levelSlot
        clearedGates:     [],          // gate IDs fully cleared
        returnGateId:     null,        // gate player was last in
        returnChapter:    0,
        returnLevel:      0,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  HUB TERRAIN PARAMS  (returned as a standard level params object)
// ─────────────────────────────────────────────────────────────────────────────

export function getHubWorldParams() {
    const builder = new LevelBuilder(HUB_LEVEL_INDEX, 'THE NEXUS');

    // Generous but not ruinously large bounds.
    // isSolid is mostly y≤0 with sparse structures, so iteration stays fast.
    builder.setBounds(50, 18, 50)
           .setSpawn(0, 2, 0)
           .setExit(0, 2, 0)   // exit unused in hub — transition is via gate portals
           .setCutscene('flyover');

    // Store flyover start/look directly (LevelBuilder already exposes these fields)
    builder.flyCamStart.set(0, 40, 60);
    builder.flyCamLook.set(0, 5, 0);

    // ── Terrain logic ──────────────────────────────────────────────────────
    builder.addCustomLogic((x, y, z) => {

        // Hard outer boundary ring (invisible kill-zone safety net)
        if (Math.abs(x) > 49 || Math.abs(z) > 49) return y <= 6;

        // Micro-noise for ground unevenness (pure integer math, no RNG calls)
        const gx = x | 0, gz = z | 0;
        const noiseVal = (
            Math.sin(gx * 0.22 + 1.3) * Math.cos(gz * 0.19 + 0.7) * 2.0 +
            Math.sin(gx * 0.41 - 0.9) * Math.cos(gz * 0.38 + 1.8) * 1.0
        );

        // Base floor
        if (y <= groundY) return true;

        // ── CENTRAL ATRIUM (spawn zone, kept clear) ────────────────────────
        const absX = Math.abs(x), absZ = Math.abs(z);
        if (absX <= 10 && absZ <= 10) {
            if (y <= 0) return true;
            // Low perimeter rubble parapet
            if ((absX >= 9 || absZ >= 9) && y <= 2 && (x % 3 !== 0 && z % 3 !== 0)) return true;
            return false;
        }

        // ── NORTH SECTOR — Ch1 ruins (z < −15) ────────────────────────────
        if (z < -15) {
            // Crumbling pillar grid
            const pillarX = Math.round(x / 7) * 7;
            const pillarZ = Math.round(z / 9) * 9;
            const pdx = x - pillarX, pdz = z - pillarZ;
            const dist = Math.sqrt(pdx * pdx + pdz * pdz);
            const pillarNoise = Math.abs(Math.sin(pillarX * 0.43 + pillarZ * 0.71));
            const pillarH = Math.floor(pillarNoise * 10 + 2);
            if (dist <= 1.2 && y <= pillarH) return true;

            // Broken horizontal lintels spanning between pillars (y=5)
            if (y === 5 && Math.abs(pdZ_cross(x, z)) < 0.8 && pillarNoise > 0.55) return true;

            // Raised platform near Gate III (z ≈ −44)
            if (x >= -28 && x <= -16 && z >= -48 && z <= -40 && y <= 6) return true;

            // Raised platform near Gate IV (z ≈ −55, elevated)
            if (x >= 0 && x <= 14 && z >= -60 && z <= -50 && y <= 10) return true;

            // Ramp leading to Gate IV platform
            if (x >= 0 && x <= 10 && z >= -50 && z <= -45) {
                const rampY = Math.floor((z + 50) * -1.5 + 1);
                if (y <= rampY) return true;
            }

            // Collapsed indoor corridor running north-south
            if (absX <= 4 && z < -10 && z > -50) {
                if (y <= 0) return true;                  // floor
                if ((absX >= 3) && y <= 4) return true;  // walls
                if (y === 5 && (x % 5 !== 0 || z % 7 !== 0)) return true;  // patchy roof
                return false;
            }
            return y <= 0;
        }

        // ── EAST SECTOR — Ch2 ruins (x > 18) ─────────────────────────────
        if (x > 18) {
            // Curved aqueduct-style wall sweeping around east
            const r = Math.sqrt(x * x + z * z);
            const a = Math.atan2(z, x);
            const wallR = 46 + Math.sin(a * 4) * 3;
            if (r > wallR - 2 && r < wallR && y <= 5 + Math.sin(a * 7) * 2) return true;

            // Terraced garden steps ascending toward Gate V (z ≈ −14)
            if (x >= 22 && x <= 36 && z >= -20 && z <= -8) {
                const stepY = Math.floor((x - 22) / 4);
                if (y <= stepY) return true;
            }

            // Sunken courtyard near Gate VI (z ≈ 4) — void pit for drama
            if (x >= 38 && x <= 50 && z >= -2 && z <= 10 && y <= 0) return false;

            // Bridges over the courtyard
            if (x >= 38 && x <= 50 && z === 4 && y === 1) return true;
            if (x >= 38 && x <= 50 && z === -2 && y === 1) return true;

            // Gate VIII elevated platform
            if (x >= 22 && x <= 36 && z >= 28 && z <= 38 && y <= 8) return true;

            return y <= 0;
        }

        // ── SOUTH SECTOR — Ch3 ruins (z > 18) ────────────────────────────
        if (z > 18) {
            // Massive fallen fortress columns
            const colX = Math.round(x / 11) * 11;
            const colZ = Math.round(z / 12) * 12;
            const cdx = x - colX, cdz = z - colZ;
            const cdist = Math.sqrt(cdx * cdx + cdz * cdz);
            const colNoise = Math.abs(Math.sin(colX * 0.31 + colZ * 0.57));
            if (cdist <= 2 && y <= Math.floor(colNoise * 12 + 3)) return true;

            // Heavy rubble mounds
            const moundNoise = Math.sin(x * 0.28 + 2.1) * Math.cos(z * 0.24 + 1.4);
            const moundY = moundNoise > 0.5 ? Math.floor((moundNoise - 0.5) * 12) : 0;
            if (y <= moundY) return true;

            // Southern elevated plateau near Gate XII (z ≈ 58)
            if (absX <= 16 && z >= 53 && y <= 12) return true;

            // Fortified gate wall across southern entrance
            if (z >= 28 && z <= 30 && y <= 6 && (x % 4 !== 0)) return true;

            return y <= 0;
        }

        // ── WEST SECTOR — gentle open cliffs (x < −18) ───────────────────
        if (x < -18) {
            const cliffNoise = Math.sin(x * 0.14 + z * 0.11) * 4;
            if (y <= Math.max(0, cliffNoise)) return true;
            // Lone standing arch
            if (x >= -26 && x <= -22 && Math.abs(z) <= 1 && y <= 8) {
                return !(Math.abs(x + 24) <= 1 && y >= 2 && y <= 6);  // arch opening
            }
            return y <= 0;
        }

        return y <= 0;
    });

    // Atmospheric lighting — warm centre, cool north, green east, red south
    builder
        .addLight(  0,  6,   0, 0xffeedd, 2.5, 22)   // atrium centre
        .addLight(-10,  4, -18, 0xa0c8ff, 3.0, 18)   // ch1 south entrance
        .addLight( 10,  4, -35, 0xa0c8ff, 2.8, 18)   // ch1 mid
        .addLight( -5,  8, -52, 0xddeeff, 2.5, 16)   // ch1 deep
        .addLight( 32,  5, -12, 0x4ade80, 3.5, 20)   // ch2 entry
        .addLight( 44,  5,   8, 0x4ade80, 3.0, 18)   // ch2 mid
        .addLight( 30,  8,  32, 0x4ade80, 2.5, 16)   // ch2 deep
        .addLight(-12,  5,  32, 0xff5080, 3.5, 20)   // ch3 entry
        .addLight(  4,  5,  44, 0xff5080, 3.0, 18)   // ch3 mid
        .addLight(-10, 10,  58, 0xff8080, 2.5, 16)   // ch3 deep
        .addLight( -2,  3,   6, 0xfff4e0, 1.8, 10);  // atrium floor glow

    return builder.build();
}

// helper: cross-corridor check (reused in pillar lintel logic)
function pdZ_cross(x, z) {
    return Math.sin(x * 0.9 + z * 0.7);
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW SCENE GEOMETRY HELPERS
//  (These call back into game helpers passed from main.js on init)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * createRuinColumn – a procedurally shattered stone column
 * Returns a THREE.Group added to `scene`.
 */
function createRuinColumn(scene, pos, height, breakRatio = 0.6, mat) {
    const group = new THREE.Group();
    const colMat = mat || new THREE.MeshStandardMaterial({ color: 0x8a8a82, roughness: 0.9, metalness: 0.05 });

    // Base drum
    const baseDrumGeo = new THREE.CylinderGeometry(0.8, 0.9, 0.6, 8);
    group.add(Object.assign(new THREE.Mesh(baseDrumGeo, colMat), { castShadow: true, receiveShadow: true }));

    // Column shaft in segments (easier to "break")
    const breakY = height * breakRatio;
    const shaftGeo = new THREE.CylinderGeometry(0.55, 0.65, breakY, 8);
    const shaft = new THREE.Mesh(shaftGeo, colMat);
    shaft.position.y = breakY * 0.5 + 0.3;
    shaft.castShadow = true;
    group.add(shaft);

    // Upper broken stub (random tilt)
    if (breakRatio < 1.0) {
        const stubH = height * (1 - breakRatio) * (0.3 + Math.random() * 0.5);
        const stubGeo = new THREE.CylinderGeometry(0, 0.55, stubH, 8);
        const stub = new THREE.Mesh(stubGeo, colMat);
        stub.position.y = breakY + 0.3;
        stub.rotation.z = (Math.random() - 0.5) * 0.4;
        stub.rotation.x = (Math.random() - 0.5) * 0.2;
        stub.castShadow = true;
        group.add(stub);
    }

    group.position.set(pos.x, pos.y, pos.z);
    scene.add(group);
    return group;
}

/**
 * createRubbleField – scatter low rubble chunks around a point
 */
function createRubbleField(scene, center, count, radius, mat) {
    const group = new THREE.Group();
    const rubMat = mat || new THREE.MeshStandardMaterial({ color: 0x7a7a72, roughness: 1.0 });

    for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * radius;
        const s = 0.15 + Math.random() * 0.55;
        const geo = new THREE.BoxGeometry(s * (0.5 + Math.random()), s * 0.4, s * (0.5 + Math.random()));
        const mesh = new THREE.Mesh(geo, rubMat);
        mesh.position.set(
            center.x + Math.cos(a) * d,
            center.y + s * 0.2,
            center.z + Math.sin(a) * d
        );
        mesh.rotation.set(
            (Math.random() - 0.5) * 0.8,
            Math.random() * Math.PI * 2,
            (Math.random() - 0.5) * 0.5
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
    }

    scene.add(group);
    return group;
}

/**
 * createGatePortal – a ring of crystals + hovering arch ring.
 * Returns { group, crystalMesh, ringMesh, light } for animation.
 */
function createGatePortal(scene, gate, locked, createCrystalStructure) {
    const group = new THREE.Group();
    const col = new THREE.Color(gate.color);
    const pos = gate.pos;

    // ── Crystal arch crown ─────────────────────────────────────────────────
    const crystalMesh = createCrystalStructure(
        new THREE.Vector3(pos.x, pos.y, pos.z),
        2.8,    // tight scatter
        5,      // 5 mini-clusters
        4,      // 4 crystals each
        gate.hue,
        0.06,   // narrow hue range — cohesive tint
        {
            mainHeightMin:  4,  mainHeightMax: 10,
            sideHeightMin:  1,  sideHeightMax:  4,
            thicknessMin: 0.25, thicknessMax: 0.50,
            depthVariance: 0.3,
            tiltMain: 0.12,
            tiltSide: 0.55,
        }
    );
    // Shift crystals to frame the arch sides, not the walkway centre
    crystalMesh.position.set(pos.x, pos.y - 0.5, pos.z);
    crystalMesh.userData.hubPortal = true;
    scene.add(crystalMesh);

    // ── Arch ring ─────────────────────────────────────────────────────────
    const ringGeo  = new THREE.TorusGeometry(2.4, 0.12, 8, 32);
    const ringMat  = new THREE.MeshPhysicalMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: locked ? 0.3 : 1.8,
        transparent: true,
        opacity: locked ? 0.35 : 0.85,
        metalness: 0.4,
        roughness: 0.1,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.set(pos.x, pos.y + 3.0, pos.z);
    ringMesh.rotation.y = Math.PI / 2;
    ringMesh.castShadow = false;
    scene.add(ringMesh);

    // ── Inner portal plane (shimmering face) ─────────────────────────────
    const planeMat = new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: locked ? 0.0 : 0.12,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    });
    const planeGeo  = new THREE.CircleGeometry(2.28, 32);
    const planeMesh = new THREE.Mesh(planeGeo, planeMat);
    planeMesh.position.set(pos.x, pos.y + 3.0, pos.z);
    planeMesh.rotation.y = Math.PI / 2;
    scene.add(planeMesh);

    // ── Gate nameplate hologram ────────────────────────────────────────────
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 128);
    ctx.font = 'bold 42px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = `#${col.getHexString()}`;
    ctx.fillText(gate.name, 256, 52);
    ctx.font = '22px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(gate.subtitle, 256, 88);
    if (locked) {
        ctx.font = 'bold 18px monospace';
        ctx.fillStyle = 'rgba(255,100,100,0.9)';
        ctx.fillText('— LOCKED —', 256, 114);
    }
    const plateTex = new THREE.CanvasTexture(canvas);
    const plateMat = new THREE.SpriteMaterial({
        map: plateTex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const plateSp = new THREE.Sprite(plateMat);
    plateSp.scale.set(4, 1, 1);
    plateSp.position.set(pos.x, pos.y + 6.2, pos.z);
    scene.add(plateSp);

    // ── Point light ────────────────────────────────────────────────────────
    const light = new THREE.PointLight(gate.color, locked ? 0.8 : 3.5, 14);
    light.position.set(pos.x, pos.y + 3.0, pos.z);
    scene.add(light);

    return {
        group,
        crystalMesh,
        ringMesh,
        planeMesh,
        plateSp,
        plateTex,
        ringMat,
        planeMat,
        plateMat,
        light,
        locked,
        gate,
        baseEmissive: locked ? 0.3 : 1.8,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  HUB WORLD RUNTIME
//  Manages all in-scene hub objects and player-gate proximity each frame.
// ─────────────────────────────────────────────────────────────────────────────

export class HubWorldRuntime {
    constructor() {
        this.portals      = [];   // { gate, ringMesh, … }
        this.decorObjects = [];   // columns, rubble, crystal clusters
        this.active       = false;
        this._hudEl       = null;
        this._hudGateId   = null;
        this._nearGateId  = null;
        this.progress     = defaultHubProgress();

        // Callbacks wired from main.js on init()
        this._onEnterGate      = null;
        this._onReturnFromGate = null;
    }

    // ── init ──────────────────────────────────────────────────────────────
    // Call this right after buildLevel('HUB', …) finishes.
    //
    //   scene               – THREE.Scene
    //   createCrystalStructure – function from main.js
    //   progress            – hub progress blob from SaveSystem
    //   callbacks           – { onEnterGate, onReturnFromGate }
    //
    init(scene, createCrystalStructure, progress, callbacks) {
        this.scene    = scene;
        this.progress = progress || defaultHubProgress();
        this._onEnterGate      = callbacks.onEnterGate;
        this._onReturnFromGate = callbacks.onReturnFromGate;

        this._buildDecor(scene, createCrystalStructure);
        this._buildPortals(scene, createCrystalStructure);
        this._buildHUD();
        this.active = true;
    }

    // ── _buildDecor ───────────────────────────────────────────────────────
    _buildDecor(scene, createCrystalStructure) {
        const stoneMat  = new THREE.MeshStandardMaterial({ color: 0x8a8a82, roughness: 0.9, metalness: 0.05 });
        const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x6e6e68, roughness: 1.0 });

        // ── Atmospheric mega crystal clusters (background, far off) ───────

        // North crystal forest (blue-purple)
        const northCrystals = createCrystalStructure(
            new THREE.Vector3(0, -8, -80),
            30, 18, 6,
            0.62, 0.15,
            { mainHeightMin: 20, mainHeightMax: 55, sideHeightMin: 5, sideHeightMax: 18,
              thicknessMin: 2.5, thicknessMax: 5, depthVariance: 6, tiltMain: 0.18, tiltSide: 0.55 }
        );
        northCrystals.userData.hubDecor = true;
        scene.add(northCrystals);

        // East crystal spire ridge (emerald)
        const eastCrystals = createCrystalStructure(
            new THREE.Vector3(80, -5, 0),
            25, 14, 5,
            0.38, 0.08,
            { mainHeightMin: 15, mainHeightMax: 45, sideHeightMin: 4, sideHeightMax: 14,
              thicknessMin: 2, thicknessMax: 4.5, depthVariance: 4, tiltMain: 0.15, tiltSide: 0.6 }
        );
        eastCrystals.userData.hubDecor = true;
        scene.add(eastCrystals);

        // South crystal monoliths (crimson-rose)
        const southCrystals = createCrystalStructure(
            new THREE.Vector3(0, -6, 85),
            28, 16, 5,
            0.96, 0.06,
            { mainHeightMin: 18, mainHeightMax: 50, sideHeightMin: 5, sideHeightMax: 16,
              thicknessMin: 2, thicknessMax: 5, depthVariance: 5, tiltMain: 0.20, tiltSide: 0.65 }
        );
        southCrystals.userData.hubDecor = true;
        scene.add(southCrystals);

        // Central atrium accent crystals (warm white)
        const centreCrystals = createCrystalStructure(
            new THREE.Vector3(0, -1, 0),
            8, 6, 3,
            0.08, 0.12,
            { mainHeightMin: 2, mainHeightMax: 6, sideHeightMin: 0.8, sideHeightMax: 2.5,
              thicknessMin: 0.2, thicknessMax: 0.4, depthVariance: 0.5, tiltMain: 0.12, tiltSide: 0.6 }
        );
        centreCrystals.userData.hubDecor = true;
        scene.add(centreCrystals);

        this.decorObjects.push(northCrystals, eastCrystals, southCrystals, centreCrystals);

        // ── Scattered ruins decor ─────────────────────────────────────────

        // North sector: broken columns flanking corridor approach
        const northColPositions = [
            { x: -6, y: 0, z: -16 }, { x: 6,  y: 0, z: -16 },
            { x: -6, y: 0, z: -26 }, { x: 6,  y: 0, z: -26 },
            { x: -6, y: 0, z: -38 }, { x: 10, y: 0, z: -38 },
        ];
        northColPositions.forEach((p, i) => {
            const col = createRuinColumn(scene, p, 5 + (i % 3) * 2, 0.45 + (i % 2) * 0.25, stoneMat);
            this.decorObjects.push(col);
        });

        // East sector: toppled columns lying on ground
        [{ x: 28, y: 0, z: -8 }, { x: 38, y: 0, z: 6 }, { x: 42, y: 0, z: 22 }].forEach(p => {
            const rb = createRubbleField(scene, new THREE.Vector3(p.x, p.y, p.z), 8, 4, rubbleMat);
            this.decorObjects.push(rb);
        });

        // South sector: rubble mounds
        [{ x: -16, y: 0, z: 26 }, { x: 4, y: 0, z: 38 }, { x: -26, y: 0, z: 44 }].forEach(p => {
            const rb = createRubbleField(scene, new THREE.Vector3(p.x, p.y, p.z), 12, 6, rubbleMat);
            this.decorObjects.push(rb);
        });

        // Near-gate crystal accent clusters (small, each gate gets its own)
        HUB_GATES.forEach(gate => {
            const gp = gate.pos;
            const accent = createCrystalStructure(
                new THREE.Vector3(gp.x + 3, gp.y, gp.z - 3),
                1.5, 2, 3,
                gate.hue, 0.04,
                { mainHeightMin: 1.2, mainHeightMax: 2.8, sideHeightMin: 0.4, sideHeightMax: 1,
                  thicknessMin: 0.1, thicknessMax: 0.22, depthVariance: 0.2, tiltMain: 0.1, tiltSide: 0.5 }
            );
            accent.userData.hubDecor = true;
            scene.add(accent);
            this.decorObjects.push(accent);
        });
    }

    // ── _buildPortals ─────────────────────────────────────────────────────
    _buildPortals(scene, createCrystalStructure) {
        HUB_GATES.forEach(gate => {
            const locked = !this._isGateUnlocked(gate);
            const portal = createGatePortal(scene, gate, locked, createCrystalStructure);
            portal.phaseOffset = Math.random() * Math.PI * 2;
            this.portals.push(portal);
        });
    }

    // ── _buildHUD ─────────────────────────────────────────────────────────
    _buildHUD() {
        const existing = document.getElementById('hub-gate-hud');
        if (existing) existing.remove();

        const el = document.createElement('div');
        el.id = 'hub-gate-hud';
        el.style.cssText = `
            position: fixed; bottom: 120px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.65); border: 1px solid rgba(255,255,255,0.15);
            border-radius: 8px; padding: 10px 28px; pointer-events: none;
            font-family: monospace; color: #fff; letter-spacing: 3px; font-size: 13px;
            text-align: center; display: none; backdrop-filter: blur(6px);
            transition: opacity 0.25s ease;
        `;
        document.body.appendChild(el);
        this._hudEl = el;
    }

    // ── isGateUnlocked ────────────────────────────────────────────────────
    _isGateUnlocked(gate) {
        if (gate.id === '0_0') return true; // First gate always open
        const { requiresCubes } = gate;
        return requiresCubes.every(c => this.progress.unlockedCubes.includes(c));
    }

    // ── isLevelUnlocked ───────────────────────────────────────────────────
    // For populating the level-select list with lock status
    isLevelUnlocked(ch, lvlIndex) {
        const gate = HUB_GATES.find(g => g.ch === ch && g.levels.includes(lvlIndex));
        if (!gate) return false;
        return this._isGateUnlocked(gate);
    }

    getGateForLevel(ch, lvlIndex) {
        return HUB_GATES.find(g => g.ch === ch && g.levels.includes(lvlIndex)) || null;
    }

    // ── onLevelComplete ───────────────────────────────────────────────────
    // Call this from completeLevel() in main.js when the player is in a hub gate context.
    onLevelComplete(ch, lvlIndex) {
        const gate = this.getGateForLevel(ch, lvlIndex);
        if (!gate) return false;

        const key = `${gate.id}_${gate.levels.indexOf(lvlIndex)}`;
        this.progress.completedLevels[key] = true;

        // Check if entire gate is cleared
        const allClear = gate.levels.every((l, i) => {
            if (i === 0 || l < MAX_LEVEL_IDX) { // only real levels
                return this.progress.completedLevels[`${gate.id}_${i}`];
            }
            return true;
        });

        if (allClear && !this.progress.clearedGates.includes(gate.id)) {
            this.progress.clearedGates.push(gate.id);
            if (gate.reward) {
                this.progress.unlockedCubes = [...new Set([...this.progress.unlockedCubes, gate.reward])];
            }
            // Update portal visual to unlocked state
            this._refreshPortalLock(gate.id);
        }

        return true; // signal: save progress
    }

    _refreshPortalLock(gateId) {
        const portal = this.portals.find(p => p.gate.id === gateId);
        if (!portal) return;
        portal.locked = false;
        portal.ringMat.emissiveIntensity = 1.8;
        portal.ringMat.opacity = 0.85;
        portal.planeMat.opacity = 0.12;
        portal.light.intensity = 3.5;
    }

    // ── update ────────────────────────────────────────────────────────────
    // Call every frame from animate() when isHubWorld is true.
    //
    //   playerPos – THREE.Vector3  (world position)
    //   elapsedTime – number (seconds)
    //   onEnterGate – callback(gateId, ch, lvlIndex)
    //
    update(playerPos, elapsedTime) {
        if (!this.active) return;

        const PROXIMITY  = 5.5;   // metres — show HUD prompt
        const AUTO_ENTER = 2.8;   // metres — auto-enter gate
        let closestDist  = Infinity;
        let closestPortal = null;

        // Animate each portal + find closest
        this.portals.forEach(portal => {
            const gp = portal.gate.pos;
            const dx = playerPos.x - gp.x;
            const dz = playerPos.z - gp.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < closestDist) { closestDist = dist; closestPortal = portal; }

            const t = elapsedTime + portal.phaseOffset;

            // Ring pulse
            if (!portal.locked) {
                portal.ringMat.emissiveIntensity = 1.4 + Math.sin(t * 2.2) * 0.5;
                portal.planeMat.opacity = 0.08 + Math.sin(t * 1.8) * 0.05;
                portal.light.intensity  = 3.2 + Math.sin(t * 2.5) * 0.8;
            } else {
                portal.ringMat.emissiveIntensity = 0.2 + Math.sin(t * 0.8) * 0.1;
            }
            portal.ringMesh.rotation.z = t * 0.25;
        });

        // HUD logic
        if (closestPortal && closestDist < PROXIMITY) {
            const gate   = closestPortal.gate;
            const locked = closestPortal.locked;
            const col    = '#' + new THREE.Color(gate.color).getHexString();

            if (this._hudGateId !== gate.id) {
                this._hudGateId = gate.id;
                const lockTxt = locked
                    ? `<span style="color:#ff6060">LOCKED — Earn: ${gate.requiresCubes.join(', ')}</span>`
                    : `<span style="color:${col}">[ E ] ENTER GATE</span>`;
                this._hudEl.innerHTML = `
                    <div style="color:${col};font-size:16px;letter-spacing:4px;margin-bottom:4px">${gate.name}</div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.55);margin-bottom:6px">${gate.subtitle}</div>
                    <div>${lockTxt}</div>`;
            }
            this._hudEl.style.display = 'block';
            this._hudEl.style.opacity = Math.min(1, (PROXIMITY - closestDist) / 2.0).toString();

            // Auto-enter on very close approach
            if (closestDist < AUTO_ENTER && !locked && this._onEnterGate) {
                this._onEnterGate(gate.id, gate.ch, gate.levels[0]);
            }
        } else {
            this._hudEl.style.display = 'none';
            this._hudGateId = null;
        }
    }

    // ── dispose ───────────────────────────────────────────────────────────
    dispose() {
        this.active = false;
        this.portals.forEach(p => {
            [p.crystalMesh, p.ringMesh, p.planeMesh, p.plateSp].forEach(obj => {
                if (obj) {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) obj.material.dispose();
                    if (this.scene) this.scene.remove(obj);
                }
            });
            if (p.plateTex) p.plateTex.dispose();
            if (p.light && this.scene) this.scene.remove(p.light);
        });
        this.portals.length = 0;

        this.decorObjects.forEach(obj => {
            if (!obj) return;
            if (this.scene) this.scene.remove(obj);
            obj.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
            });
        });
        this.decorObjects.length = 0;

        if (this._hudEl) { this._hudEl.remove(); this._hudEl = null; }
    }
}

// Placeholder so the module doesn't crash if MAX_LEVEL_IDX isn't defined here
const MAX_LEVEL_IDX = 9;

// ─────────────────────────────────────────────────────────────────────────────
//  SAVE SYSTEM EXTENSION
//  Call these from SaveSystem.save() / SaveSystem.load() in main.js
// ─────────────────────────────────────────────────────────────────────────────

const HUB_SAVE_KEY = 'shatter_hub_progress';

export function saveHubProgress(progress) {
    try {
        localStorage.setItem(HUB_SAVE_KEY, JSON.stringify(progress));
    } catch (e) { /* storage full */ }
}

export function loadHubProgress() {
    try {
        const raw = localStorage.getItem(HUB_SAVE_KEY);
        if (!raw) return defaultHubProgress();
        return { ...defaultHubProgress(), ...JSON.parse(raw) };
    } catch (e) {
        return defaultHubProgress();
    }
}

export function clearHubProgress() {
    localStorage.removeItem(HUB_SAVE_KEY);
}

// ─────────────────────────────────────────────────────────────────────────────
//  LEVEL-SELECT LOCK HELPER
//  Call from populateLevelList() to get per-level status for a given chapter
// ─────────────────────────────────────────────────────────────────────────────

export function getLevelSelectStatus(ch, lvlIndex, hubRuntime) {
    // Fallback: if no hub runtime (first boot), use old logic
    if (!hubRuntime) return { locked: false, gateId: null };
    const gate = HUB_GATES.find(g => g.ch === ch && g.levels.includes(lvlIndex));
    if (!gate) return { locked: true, gateId: null };
    const locked = !hubRuntime._isGateUnlocked(gate);
    return { locked, gateId: gate.id, gateName: gate.name, gateColor: gate.color };
}