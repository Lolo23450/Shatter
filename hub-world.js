import * as THREE from 'three'; import { LevelBuilder } from
'./level-builder.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS //
//─────────────────────────────────────────────────────────────────────────────

export const HUB_LEVEL_INDEX = 'HUB';

// ─────────────────────────────────────────────────────────────────────────────
// GATE DEFINITIONS (Fixed Linear Progression & Coordinates) //
// ─────────────────────────────────────────────────────────────────────────────

export const HUB_GATES = [ /* ── CHAPTER 1 ── The Fundamentals (North sector) */
{ id: '0_0', ch: 0, gate: 0, levels: [0, 1, 2], pos: { x: -5, y: 1, z: -9 },
name: 'GATE Ⅰ', subtitle: 'THE FUNDAMENTALS', color: 0xa0c8ff, hue: 0.60,
requiresCubes: [], reward: 'blue' }, { id: '0_1', ch: 0, gate: 1, levels:
[3, 4, 5], pos: { x: 0, y: 1, z: -11 }, name: 'GATE Ⅱ', subtitle: 'THE FUNDAMENTALS',
 color: 0xa0c8ff, hue: 0.58, requiresCubes: ['blue'], reward:
'green' }, { id: '0_2', ch: 0, gate: 2, levels: [6, 7, 8], pos: { x: 5, y: 1, z:
-9 }, name: 'GATE Ⅲ', subtitle: 'THE FUNDAMENTALS', color: 0xa0c8ff, hue: 0.56,
requiresCubes: ['green'], reward: 'red' }, { id: '0_3', ch: 0, gate: 3, levels:
[9], pos: { x: 0, y: 5, z: -17 }, name: 'GATE Ⅳ', subtitle: 'THE FUNDAMENTALS',
color: 0xa0c8ff, hue: 0.55, requiresCubes: ['red'], reward: 'yellow' },

/* ── CHAPTER 2 ── The Archive (East sector) */
{
    id: '1_0', ch: 1, gate: 0, levels: [0, 1, 2],
    pos: { x: 9, y: 1, z: -5 }, name: 'GATE Ⅴ', subtitle: 'THE ARCHIVE',
    color: 0x4ade80, hue: 0.37, requiresCubes: ['yellow'], reward: 'cyan'
},
{
    id: '1_1', ch: 1, gate: 1, levels: [3, 4, 5],
    pos: { x: 11, y: 1, z: 0 }, name: 'GATE Ⅵ', subtitle: 'THE ARCHIVE',
    color: 0x4ade80, hue: 0.39, requiresCubes: ['cyan'], reward: 'gray'
},
{
    id: '1_2', ch: 1, gate: 2, levels: [6, 7, 8],
    pos: { x: 9, y: 1, z: 5 }, name: 'GATE Ⅶ', subtitle: 'THE ARCHIVE',
    color: 0x4ade80, hue: 0.41, requiresCubes: ['gray'], reward: null
},
{
    id: '1_3', ch: 1, gate: 3, levels: [9],
    pos: { x: 17, y: 5, z: 0 }, name: 'GATE Ⅷ', subtitle: 'THE ARCHIVE',
    color: 0x4ade80, hue: 0.42, requiresCubes: ['gray'], reward: null
},

/* ── CHAPTER 3 ── The Citadel (West sector) */
{
    id: '2_0', ch: 2, gate: 0, levels: [0, 1, 2],
    pos: { x: -9, y: 1, z: 5 }, name: 'GATE Ⅸ', subtitle: 'THE CITADEL',
    color: 0xff5080, hue: 0.95, requiresCubes: ['gray'], reward: null
},
{
    id: '2_1', ch: 2, gate: 1, levels: [3, 4, 5],
    pos: { x: -11, y: 1, z: 0 }, name: 'GATE Ⅹ', subtitle: 'THE CITADEL',
    color: 0xff5080, hue: 0.97, requiresCubes: ['gray'], reward: null
},
{
    id: '2_2', ch: 2, gate: 2, levels: [6, 7, 8],
    pos: { x: -9, y: 1, z: -5 }, name: 'GATE Ⅺ', subtitle: 'THE CITADEL',
    color: 0xff5080, hue: 0.99, requiresCubes: ['gray'], reward: null
},
{
    id: '2_3', ch: 2, gate: 3, levels: [9],
    pos: { x: -17, y: 5, z: 0 }, name: 'GATE Ⅻ', subtitle: 'THE CITADEL',
    color: 0xff5080, hue: 0.02, requiresCubes: ['gray'], reward: null
},

];

export const GATE_BY_ID = Object.fromEntries(HUB_GATES.map(g => [g.id, g]));

export function defaultHubProgress() { return { unlockedCubes: [],
completedLevels: {}, clearedGates: [], returnGateId: null, returnChapter: 0,
returnLevel: 0, }; }

// ─────────────────────────────────────────────────────────────────────────────
// HUB TERRAIN PARAMS (Fixed Bridge Connections) //
// ─────────────────────────────────────────────────────────────────────────────

export function getHubWorldParams() { const builder = new
LevelBuilder(HUB_LEVEL_INDEX, 'THE NEXUS');

builder.setBounds(21, 16, 21)
       .setSpawn(0, 4, 0)
       .setExit(0, 600, 0)
       .setCutscene('flyover')
       .setWater(0.6, { color: 0x002233, distortionScale: 1.5, alpha: 0.85 });

builder.flyCamStart.set(0, 18, 20);
builder.flyCamLook.set(0, 3, 0);

builder.addCustomLogic((x, y, z) => {
    const r = Math.sqrt(x * x + z * z);
    
    // Outer enclosing temple wall
    if (r > 20) return y <= 15;

    let floorY = 1; // Default outer ring height

    // Central Spawn Dais
    if (r <= 2.5) floorY = 3;
    else if (r <= 3) floorY = 2;

    // Circular Moat with Properly Aligned Bridges
    if (r > 3 && r < 7) {
        floorY = 0; // Drops below the water line
        
        // Fixed: Bridges now radiate perfectly from the center
        if (Math.abs(x) <= 2 && z < 0) floorY = 1; // North Bridge
        if (Math.abs(z) <= 2 && x > 0) floorY = 1; // East Bridge
        if (Math.abs(z) <= 2 && x < 0) floorY = 1; // West Bridge
    }

    // North High Platform (Gate IV)
    if (Math.abs(x) <= 4 && z <= -12 && z >= -20) {
        let py = 5;
        if (z > -14) py = 5 - Math.floor(z + 14); // Stairs
        if (py > floorY) floorY = Math.min(py, 5);
    }

    // East High Platform (Gate VIII)
    if (x >= 12 && x <= 20 && Math.abs(z) <= 4) {
        let py = 5;
        if (x < 14) py = 5 - Math.floor(14 - x); // Stairs
        if (py > floorY) floorY = Math.min(py, 5);
    }

    // West High Platform (Gate XII)
    if (x <= -12 && x >= -20 && Math.abs(z) <= 4) {
        let py = 5;
        if (x > -14) py = 5 - Math.floor(x + 14); // Stairs
        if (py > floorY) floorY = Math.min(py, 5);
    }

    // Majestic Perimeter Columns
    if (r >= 18 && r <= 20) {
        const angle = Math.atan2(z, x);
        if (Math.abs(Math.sin(angle * 6)) > 0.9 && y <= 12) return true;
    }

    return y <= floorY;
});

builder
    .addLight(  0,  6,   0, 0xffeedd, 3.5, 14)   // Atrium center
    .addLight(  0,  6, -11, 0xa0c8ff, 4.0, 14)   // Ch1 North
    .addLight( 11,  6,   0, 0x4ade80, 4.0, 14)   // Ch2 East
    .addLight(-11,  6,   0, 0xff5080, 4.0, 14);  // Ch3 West

return builder.build();

}

// ─────────────────────────────────────────────────────────────────────────────
// SCENE GEOMETRY HELPERS //
// ─────────────────────────────────────────────────────────────────────────────

function createRuinColumn(scene, pos, height, breakRatio = 0.6, mat) { const
group = new THREE.Group(); const colMat = mat || new
THREE.MeshStandardMaterial({ color: 0x8a8a82, roughness: 0.9, metalness: 0.05
});

const baseDrumGeo = new THREE.CylinderGeometry(0.8, 0.9, 0.6, 8);
group.add(Object.assign(new THREE.Mesh(baseDrumGeo, colMat), { castShadow: true, receiveShadow: true }));

const breakY = height * breakRatio;
const shaftGeo = new THREE.CylinderGeometry(0.55, 0.65, breakY, 8);
const shaft = new THREE.Mesh(shaftGeo, colMat);
shaft.position.y = breakY * 0.5 + 0.3;
shaft.castShadow = true;
group.add(shaft);

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

function createRubbleField(scene, center, count, radius, mat) { const group =
new THREE.Group(); const rubMat = mat || new THREE.MeshStandardMaterial({
color: 0x7a7a72, roughness: 1.0 });

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
    mesh.rotation.set((Math.random() - 0.5) * 0.8, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
}
scene.add(group);
return group;

}

function createGatePortal(scene, gate, locked, createCrystalStructure) { const
group = new THREE.Group(); const col = new THREE.Color(gate.color); const pos =
gate.pos;

const crystalMesh = createCrystalStructure(
    new THREE.Vector3(pos.x, pos.y, pos.z),
    2.8, 5, 4, gate.hue, 0.06,
    {
        mainHeightMin: 4, mainHeightMax: 10, sideHeightMin: 1, sideHeightMax: 4,
        thicknessMin: 0.25, thicknessMax: 0.50, depthVariance: 0.3, tiltMain: 0.12, tiltSide: 0.55
    }
);
crystalMesh.position.set(pos.x, pos.y - 0.5, pos.z);
crystalMesh.userData.hubPortal = true;
scene.add(crystalMesh);

const ringGeo  = new THREE.TorusGeometry(2.4, 0.12, 8, 32);
const ringMat  = new THREE.MeshPhysicalMaterial({
    color: col, emissive: col, emissiveIntensity: locked ? 0.3 : 1.8,
    transparent: true, opacity: locked ? 0.35 : 0.85, metalness: 0.4, roughness: 0.1,
});
const ringMesh = new THREE.Mesh(ringGeo, ringMat);
ringMesh.position.set(pos.x, pos.y + 3.0, pos.z);

// Auto-orient rings toward center of rotunda (0,0)
const angleToCenter = Math.atan2(0 - pos.x, 0 - pos.z);
ringMesh.rotation.y = angleToCenter;
scene.add(ringMesh);

const planeMat = new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: locked ? 0.0 : 0.12,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
});
const planeGeo  = new THREE.CircleGeometry(2.28, 32);
const planeMesh = new THREE.Mesh(planeGeo, planeMat);
planeMesh.position.copy(ringMesh.position);
planeMesh.rotation.y = angleToCenter;
scene.add(planeMesh);

const canvas = document.createElement('canvas');
canvas.width = 512; canvas.height = 128;
const ctx = canvas.getContext('2d');
ctx.clearRect(0, 0, 512, 128);
ctx.font = 'bold 42px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = `#${col.getHexString()}`;
ctx.fillText(gate.name, 256, 52);
ctx.font = '22px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillText(gate.subtitle, 256, 88);
if (locked) {
    ctx.font = 'bold 18px monospace'; ctx.fillStyle = 'rgba(255,100,100,0.9)'; ctx.fillText('— LOCKED —', 256, 114);
}
const plateTex = new THREE.CanvasTexture(canvas);
const plateMat = new THREE.SpriteMaterial({ map: plateTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
const plateSp = new THREE.Sprite(plateMat);
plateSp.scale.set(4, 1, 1);
plateSp.position.set(pos.x, pos.y + 6.2, pos.z);
scene.add(plateSp);

const light = new THREE.PointLight(gate.color, locked ? 0.8 : 3.5, 14);
light.position.set(pos.x, pos.y + 3.0, pos.z);
scene.add(light);

return { group, crystalMesh, ringMesh, planeMesh, plateSp, plateTex, ringMat, planeMat, plateMat, light, locked, gate };

}

// ─────────────────────────────────────────────────────────────────────────────
// HUB WORLD RUNTIME //
// ─────────────────────────────────────────────────────────────────────────────

export class HubWorldRuntime { constructor() { this.portals = [];
this.decorObjects = []; this.active = false; this._hudEl = null; this._hudGateId
= null; this.progress = defaultHubProgress(); }

init(scene, createCrystalStructure, progress, callbacks) {
    this.scene = scene;
    this.progress = progress || defaultHubProgress();
    this._onEnterGate = callbacks.onEnterGate;

    // this._buildDecor(scene, createCrystalStructure);
    this._buildPortals(scene, createCrystalStructure);
    this._buildHUD();
    this.active = true;
}

_buildDecor(scene, createCrystalStructure) {
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8a8a82, roughness: 0.9, metalness: 0.05 });
    const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x6e6e68, roughness: 1.0 });

    const northCrystals = createCrystalStructure(new THREE.Vector3(0, -10, -27), 25, 15, 6, 0.62, 0.15,
        { mainHeightMin: 20, mainHeightMax: 50, sideHeightMin: 5, sideHeightMax: 18, thicknessMin: 2.5, thicknessMax: 5, depthVariance: 6, tiltMain: 0.15, tiltSide: 0.5 });
    const eastCrystals = createCrystalStructure(new THREE.Vector3(27, -10, 0), 20, 12, 5, 0.38, 0.08,
        { mainHeightMin: 15, mainHeightMax: 40, sideHeightMin: 4, sideHeightMax: 14, thicknessMin: 2, thicknessMax: 4.5, depthVariance: 4, tiltMain: 0.15, tiltSide: 0.6 });
    const westCrystals = createCrystalStructure(new THREE.Vector3(-27, -10, 0), 25, 14, 5, 0.96, 0.06,
        { mainHeightMin: 18, mainHeightMax: 45, sideHeightMin: 5, sideHeightMax: 16, thicknessMin: 2, thicknessMax: 5, depthVariance: 5, tiltMain: 0.15, tiltSide: 0.6 });
    const centreCrystals = createCrystalStructure(new THREE.Vector3(0, -3, 0), 6, 6, 3, 0.08, 0.12,
        { mainHeightMin: 2, mainHeightMax: 5, sideHeightMin: 0.8, sideHeightMax: 2.0, thicknessMin: 0.2, thicknessMax: 0.4, depthVariance: 0.5, tiltMain: 0.1, tiltSide: 0.5 });

    [northCrystals, eastCrystals, westCrystals, centreCrystals].forEach(c => { c.userData.hubDecor = true; scene.add(c); this.decorObjects.push(c); });

    // Flanking Pillars for the Grand Stairs
    const columnPos = [
        { x: -3, y: 1, z: -9 }, { x: 3, y: 1, z: -9 }, // North stairs
        { x: 9, y: 1, z: -3 },  { x: 9, y: 1, z: 3 },  // East stairs
        { x: -9, y: 1, z: -3 }, { x: -9, y: 1, z: 3 }  // West stairs
    ];
    columnPos.forEach((p, i) => {
        const col = createRuinColumn(scene, p, 5 + (i % 2) * 2, 0.45 + (i % 2) * 0.25, stoneMat);
        this.decorObjects.push(col);
    });

    // Small rubble piles
    [{ x: 11, y: 1, z: -11 }, { x: -11, y: 1, z: -11 }, { x: 0, y: 1, z: 13 }].forEach(p => {
        const rb = createRubbleField(scene, new THREE.Vector3(p.x, p.y, p.z), 10, 5, rubbleMat);
        this.decorObjects.push(rb);
    });
}

_buildPortals(scene, createCrystalStructure) {
    HUB_GATES.forEach(gate => {
        const locked = !this._isGateUnlocked(gate);
        const portal = createGatePortal(scene, gate, locked, createCrystalStructure);
        portal.phaseOffset = Math.random() * Math.PI * 2;
        this.portals.push(portal);
    });
}

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

_isGateUnlocked(gate) {
    if (gate.id === '0_0') return true;
    return gate.requiresCubes.every(c => this.progress.unlockedCubes.includes(c));
}

getGateForLevel(ch, lvlIndex) {
    return HUB_GATES.find(g => g.ch === ch && g.levels.includes(lvlIndex)) || null;
}

onLevelComplete(ch, lvlIndex) {
    const gate = this.getGateForLevel(ch, lvlIndex);
    if (!gate) return false;

    const key = `${gate.id}_${gate.levels.indexOf(lvlIndex)}`;
    this.progress.completedLevels[key] = true;

    // Fixed: Gracefully handle variable length level arrays like [9] without indexing out of bounds
    const allClear = gate.levels.every((l, i) => {
        return this.progress.completedLevels[`${gate.id}_${i}`];
    });

    if (allClear && !this.progress.clearedGates.includes(gate.id)) {
        this.progress.clearedGates.push(gate.id);
        if (gate.reward) this.progress.unlockedCubes = [...new Set([...this.progress.unlockedCubes, gate.reward])];
        this._refreshPortalLock(gate.id);
    }
    return true;
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

update(playerPos, elapsedTime) {
    if (!this.active) return;

    const PROXIMITY = 5.5;
    const AUTO_ENTER = 2.8;
    let closestDist = Infinity;
    let closestPortal = null;

    this.portals.forEach(portal => {
        const gp = portal.gate.pos;
        const dx = playerPos.x - gp.x;
        const dz = playerPos.z - gp.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < closestDist) { closestDist = dist; closestPortal = portal; }

        const t = elapsedTime + portal.phaseOffset;
        if (!portal.locked) {
            portal.ringMat.emissiveIntensity = 1.4 + Math.sin(t * 2.2) * 0.5;
            portal.planeMat.opacity = 0.08 + Math.sin(t * 1.8) * 0.05;
            portal.light.intensity = 3.2 + Math.sin(t * 2.5) * 0.8;
        } else {
            portal.ringMat.emissiveIntensity = 0.2 + Math.sin(t * 0.8) * 0.1;
        }
    });

    if (closestPortal && closestDist < PROXIMITY) {
        const gate = closestPortal.gate;
        const locked = closestPortal.locked;
        const col = '#' + new THREE.Color(gate.color).getHexString();

        if (this._hudGateId !== gate.id) {
            this._hudGateId = gate.id;
            const lockTxt = locked ? `<span style="color:#ff6060">LOCKED — Earn: ${gate.requiresCubes.join(', ')}</span>` : `<span style="color:${col}">[ E ] ENTER GATE</span>`;
            this._hudEl.innerHTML = `
                <div style="color:${col};font-size:16px;letter-spacing:4px;margin-bottom:4px">${gate.name}</div>
                <div style="font-size:11px;color:rgba(255,255,255,0.55);margin-bottom:6px">${gate.subtitle}</div>
                <div>${lockTxt}</div>`;
        }
        this._hudEl.style.display = 'block';
        this._hudEl.style.opacity = Math.min(1, (PROXIMITY - closestDist) / 2.0).toString();

        if (closestDist < AUTO_ENTER && !locked && this._onEnterGate) {
            this._onEnterGate(gate.id, gate.ch, gate.levels[0]);
        }
    } else {
        this._hudEl.style.display = 'none';
        this._hudGateId = null;
    }
}

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

const HUB_SAVE_KEY = 'shatter_hub_progress';

export function saveHubProgress(progress) { try {
localStorage.setItem(HUB_SAVE_KEY, JSON.stringify(progress)); } catch (e) { } }

export function loadHubProgress() { try { const raw =
localStorage.getItem(HUB_SAVE_KEY); if (!raw) return defaultHubProgress();
return { ...defaultHubProgress(), ...JSON.parse(raw) }; } catch (e) { return
defaultHubProgress(); } }

export function clearHubProgress() { localStorage.removeItem(HUB_SAVE_KEY); }

export function getLevelSelectStatus(ch, lvlIndex, hubRuntime) { if
(!hubRuntime) return { locked: false, gateId: null }; const gate =
HUB_GATES.find(g => g.ch === ch && g.levels.includes(lvlIndex)); if (!gate)
return { locked: true, gateId: null }; const locked =
!hubRuntime._isGateUnlocked(gate); return { locked, gateId: gate.id, gateName:
gate.name, gateColor: gate.color }; }