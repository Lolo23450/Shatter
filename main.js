// =============================================================================
// SHATTER — CORE ENGINE & PROCEDURAL VEGETATION SUBSYSTEM
// PART 1 OF 6: IMPORTS, CONSTANTS, TEXTURE GENERATORS, CORE MATERIALS & AUDIO
// =============================================================================

import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as CANNON from 'cannon-es';
import { CHAPTER_LEVEL_NAMES, LEVEL_NAMES, CHAPTERS, LevelBuilder } from './level-builder.js';
import { OptimizedSSRPass } from './OptimizedSSRPass.js';

// --- PSEUDO-RANDOM NUMBER GENERATION & VECTOR MATH UTILS ---
function distSq(v1, v2) {
    const dx = v1.x - v2.x;
    const dy = v1.y - v2.y;
    const dz = v1.z - v2.z;
    return dx * dx + dy * dy + dz * dz;
}

function splitmix32(a) {
    return function() {
        a |= 0;
        a = (a + 0x9e3779b9) | 0;
        let t = a ^ (a >>> 16);
        t = Math.imul(t, 0x21f0aaad);
        t = t ^ (t >>> 15);
        t = Math.imul(t, 0x735a2d97);
        return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
    };
}

let rng = splitmix32(5);

function _makeRng(seed) {
    let s = seed | 0;
    return function() {
        s = (Math.imul(s, 1664525) + 1013904223) | 0;
        return ((s >>> 0) / 4294967296);
    };
}

// --- GLOBAL RUNTIME STATE & PROGRESSION ---
let currentLevel = 0;
let isTransitioning = true;
let isCutscene = false;
let cutsceneType = '';
let cutsceneTimer = 0;
let cutsceneDuration = 0;
const activeWinds = [];

let fromMainMenu = false;
let isPreviewMode = false;
let previewAngle = 0;
let previewDistance = 4;
let previewTargetLvl = 0;
let previewDebounce = null;

let isEditorMode = false;
let isPlayingCustom = false;
let isTabSelectorOpen = false;
let editorTool = 'wall';
let isFlyMode = false;
let fillStartCorner = null;
let selectedEditorObject = null;
let selectedEditorObjectType = null;
let redStartScale = 1.0;
let editorChannel = 1;
let editorDoorDir = 'left';
let editorDoorWidth = 3.0;
let editorDoorHeight = 3.0;
let editorDoorMoveDist = 2.8;
let editorFieldInverted = false;
let isMouseDown = false;
let _editorPhysicsDirty = false;

let lightColor = 0xffffff;
let lightIntensity = 3.0;
let lightRadius = 8.0;

const customSolidBlocks = new Set();
const customEntities = new Map();
const customDestruction = [];
let customSpawn = { x: 0, y: 2, z: 0 };
let customExit = { x: 0, y: 5, z: -8 };
const customLights = [];
const customFields = [];
const customPlates = [];
const customDoors = [];
const customDecorations = [];
const _activeDecorationMeshes = [];
let autoDecorations = [];
let customWaterY = undefined;

let customLevels = JSON.parse(localStorage.getItem('shatter_custom_levels')) || Array(99).fill(null);
let currentCustomSlot = -1;
let isViewingCustomLevels = false;

let isPaused = true;
let volBGM = 0.5;
let volSFX = 0.5;
let volDyn = 0.5;
let gfx = {
    res: 0.75,
    shadows: 2,
    bloom: 1,
    ssao: 1,
    fxaa: 1,
    ssr: 0,
    particles: 2,
    volumetrics: 2,
    vegetationDensity: 2
};
let volAdv = { density: 0.003, radius: 25, brightness: 0.35 };
let _prevShadowType = -1;

let activeChapter = 0;
let chaptersUnlocked = [true, false, false];

// --- THREE.JS SCENE, CAMERAS & RENDERER SETUP ---
const scene = new THREE.Scene();
const morningHorizon = new THREE.Color(0xc8d8e8);
scene.background = morningHorizon;
scene.fog = new THREE.FogExp2(0xc0d0de, 0.0012);

const overlay = document.getElementById('fade-overlay');
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 850);
const cutsceneCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 850);

// Camera Layer 1: Decals (visible to rendering, ignored by SSAO depth/normal pass)
// Camera Layer 2: Dense Procedural Foliage (Grass, Ferns, Bush Canopies)
camera.layers.enable(1);
camera.layers.enable(2);
cutsceneCamera.layers.enable(1);
cutsceneCamera.layers.enable(2);

const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
document.body.appendChild(renderer.domElement);

const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileCubemapShader();

const cubeRenderTarget = new THREE.WebGLCubeRenderTarget(512, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    type: THREE.HalfFloatType
});
const cubeCamera = new THREE.CubeCamera(0.1, 200, cubeRenderTarget);

const controls = new PointerLockControls(camera, document.body);
controls.addEventListener('lock', () => {
    isPaused = false;
    const blocker = document.getElementById('blocker');
    if (blocker) blocker.style.display = 'none';
});
controls.addEventListener('unlock', () => {
    if (isTabSelectorOpen) return;
    isPaused = true;
    if (!isPreviewMode && !isMontageCutscene) {
        const blocker = document.getElementById('blocker');
        if (blocker) blocker.style.display = 'flex';
    }
});

function requestPointerLockSafe() {
    if (document.pointerLockElement === controls.domElement) return;
    let armed = false;
    const armClickRetry = () => {
        if (armed) return;
        armed = true;
        const blockerEl = document.getElementById('blocker');
        const retry = () => {
            if (blockerEl) blockerEl.removeEventListener('click', retry);
            document.removeEventListener('click', retry);
            tryLock();
        };
        if (blockerEl) blockerEl.addEventListener('click', retry, { once: true });
        document.addEventListener('click', retry, { once: true });
    };

    const tryLock = () => {
        try {
            const maybePromise = controls.lock();
            if (maybePromise && typeof maybePromise.catch === 'function') {
                maybePromise.catch(() => armClickRetry());
            }
        } catch (err) {
            armClickRetry();
        }
    };
    tryLock();
}

const btnPlay = document.getElementById('btn-play');
if (btnPlay) {
    btnPlay.addEventListener('click', () => {
        AudioSys.init();
        const mm = document.getElementById('main-menu');
        if (mm) {
            mm.style.opacity = '0';
            mm.style.display = 'none';
        }
        isTransitioning = false;
        buildLevel(currentLevel, false);
        setTimeout(() => requestPointerLockSafe(), 100);
    });
}

// --- PHYSICS SYSTEM INITIALIZATION ---
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -19, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 4;
world.solver.tolerance = 0.04;
world.allowSleep = true;
world.sleepTimeLimit = 0.5;

const CG_STATIC = 1;
const CG_DYNAMIC = 2;
const CG_ROPE = 4;
const CG_PLAYER = 8;
const CG_AERO_FIELD = 16;

const defaultMat = new CANNON.Material('default');
const playerMat = new CANNON.Material('player');
world.addContactMaterial(new CANNON.ContactMaterial(defaultMat, defaultMat, { friction: 0.5, restitution: 0.1 }));
world.addContactMaterial(new CANNON.ContactMaterial(playerMat, defaultMat, {
    friction: 0.0,
    restitution: 0.0,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 4
}));

const playerHRadius = 0.36;
const playerHalfH = 0.78;
const playerBody = new CANNON.Body({
    mass: 60,
    material: playerMat,
    position: new CANNON.Vec3(0, 0, 0),
    fixedRotation: true,
    linearDamping: 0.0,
    collisionFilterGroup: CG_PLAYER,
    collisionFilterMask: CG_STATIC | CG_DYNAMIC | CG_ROPE,
    allowSleep: false
});
playerBody.addShape(new CANNON.Cylinder(playerHRadius, playerHRadius, playerHalfH * 2, 8));
playerBody.addShape(new CANNON.Sphere(playerHRadius * 0.9), new CANNON.Vec3(0, -playerHalfH + playerHRadius * 0.9, 0));
playerBody.addShape(new CANNON.Sphere(playerHRadius * 0.85), new CANNON.Vec3(0, playerHalfH - playerHRadius * 0.85, 0));
world.addBody(playerBody);

// =============================================================================
// PLAYER COLLISION & BOUNCE BLOCK LISTENER
// =============================================================================

function triggerPlayerBounce(blueBlock, impactVel = 0) {
    // Punchy, momentum-preserving launch force
    const bounceForce = Math.max(10.0, 15.0 + impactVel * 0.15);
    playerBody.velocity.y = Math.min(32.0, bounceForce);
    
    // Critical: Lift player slightly off the contact plane so the physics solver
    // does not cancel the upward velocity on the next step
    playerBody.position.y += 0.12;
    
    // Clear ground state & coyote timer so jump inputs don't override the launch
    coyoteTimer = 0;
    wasGrounded = false;

    if (blueBlock && blueBlock.mat) {
        blueBlock.mat.emissiveIntensity = 3.5;
        setTimeout(() => {
            if (blueBlock && blueBlock.mat) blueBlock.mat.emissiveIntensity = 0.7;
        }, 320);
    }
    AudioSys.triggerBlueBounce();
}

playerBody.addEventListener("collide", (e) => {
    if (grabbedBlock && grabbedBlock.body === e.body) return;

    for (let i = 0; i < interactiveBlocks.length; i++) {
        const blk = interactiveBlocks[i];
        if (blk.body === e.body && blk.type === 'blue') {
            const contact = e.contact;
            let impactVel = contact ? Math.abs(contact.getImpactVelocityAlongNormal()) : 0;

            // Check if player is on top of or landing down onto the bounce block
            const isAbove = (playerBody.position.y > blk.body.position.y + 0.4);
            let normalY = 0;
            if (contact) {
                normalY = (contact.bi === playerBody) ? -contact.ni.y : contact.ni.y;
            }

            if (isAbove || normalY > 0.4) {
                triggerPlayerBounce(blk, impactVel);
            }
            break;
        }
    }
});

// =============================================================================
// CORE LEVEL ENTITY TRACKING & EDITOR COLLIDER ARRAYS
// =============================================================================

const levelBodies = [];
const levelMeshes = [];
const levelLights = [];
const levelConstraints = [];
const dynamicSyncList = [];
let interactiveBlocks = [];
let interactiveTargets = [];
const meshToBlock = new Map();
const levelGeometries = [];
const levelMaterials = [];

let currentGoal = null;
let currentGreenBlock = null;
let exitMesh = null;
let currentParams = null;
let grabbedBlock = null;

const RED_SCALE_MIN = 0.3;
const RED_SCALE_MAX = 3.5;
let rKeyTimer = 0;
let isRKeyDown = false;

let pendingBounce = false;
let pendingBounceBlock = null;
let pendingBounceVelocity = 0;
let waterMesh = null;
let waveTime = 0;

let coyoteTimer = 0;
let wasGrounded = false;
const COYOTE_TIME = 0.15;
let smoothCamY = 0;

let isMontageCutscene = false;
let expandAnimData = [];
let expandAnimActive = false;
let expandAnimTime = 0;

// --- EDITOR GEOMETRIES, GHOSTS & COLLIDERS ---
const MAX_EDITOR_BLOCKS = 15000;
const editorInstancedMeshes = {};
const editorSceneGroup = new THREE.Group();
scene.add(editorSceneGroup);

const CHANNEL_COLORS = [
    0x000000, // 0 (unused)
    0xff3344, // 1: Red
    0x3388ff, // 2: Blue
    0x33ff99, // 3: Green
    0xffdd33, // 4: Yellow
    0xff88ff, // 5: Pink
    0x00ffff, // 6: Cyan
    0xffaa00, // 7: Orange
    0x9966ff, // 8: Purple
    0xffffff  // 9: White
];

const TOOL_COLORS = {
    'wall': 0x454545, 'fill': 0x00ff88, 'blue': 0x3388ff, 'red': 0xff3344, 'green': 0x33ff99, 
    'bomb': 0xffaa00, 'spawn': 0xffffff, 'exit': 0xffff00, 'gray': 0xaaaaaa,
    'yellow': 0xffdd33, 'big_yellow': 0xffaa33, 'big_gray': 0x888888,
    'light': 0xffee44, 'plate': 0xc27a3e, 'door': 0x66ccff,
    'water': 0x0055ff, 'logic': 0x9966ff, 'aero': 0x00ffff, 'oneway': 0xffaa00,
    'decor_debris':        0x7a7a7a,
    'decor_wall_1x1_a':    0x6a6a6a,
    'decor_wall_1x1_b':    0x6a6a6a,
    'decor_wall_1x1_c':    0x6a6a6a,
    'decor_wall_2x2':      0x5a5a5a,
    'decor_rubble':        0x8a7266,
    'decor_shattered':     0xb8a898,
    'decor_pillar':        0x9ea1a0,
    'decor_vine_hanging':  0x2f5a2a,
    'decor_foliage_clump': 0x3c6b34
};

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
for (const [tool, color] of Object.entries(TOOL_COLORS)) {
    const mat = new THREE.MeshLambertMaterial({ 
        color: color, 
        transparent: false, 
        opacity: 1.0, 
        depthWrite: true,
        emissive: color,
        emissiveIntensity: 0.15
    });
    const im = new THREE.InstancedMesh(boxGeo, mat, MAX_EDITOR_BLOCKS);
    im.count = 0;
    im.castShadow = true;
    im.receiveShadow = true;
    editorInstancedMeshes[tool] = im;
    editorSceneGroup.add(im);
}

// Floor plane for editor build mode
const editorFloorGeo = new THREE.PlaneGeometry(120, 120);
editorFloorGeo.rotateX(-Math.PI / 2);
const editorFloor = new THREE.Mesh(editorFloorGeo, new THREE.MeshBasicMaterial({ visible: false }));
editorFloor.position.y = -0.5;
editorSceneGroup.add(editorFloor);

const editorGrid = new THREE.GridHelper(50, 50, 0xffffff, 0x444444);
editorGrid.position.y = -0.5;
editorGrid.material.opacity = 0.25;
editorGrid.material.transparent = true;
editorSceneGroup.add(editorGrid);

const editorWaterGeo = new THREE.PlaneGeometry(200, 200);
editorWaterGeo.rotateX(-Math.PI / 2);
const editorWaterPlane = new THREE.Mesh(editorWaterGeo, new THREE.MeshBasicMaterial({ 
    color: 0x0055ff, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide 
}));
editorWaterPlane.visible = false;
editorSceneGroup.add(editorWaterPlane);

editorSceneGroup.visible = false;

// Dynamic ghost cursor
const ghostGeo = new THREE.BoxGeometry(1.02, 1.02, 1.02);
const ghostMat = new THREE.MeshBasicMaterial({ 
    color: 0x44ffaa, transparent: true, opacity: 0.25, 
    blending: THREE.AdditiveBlending, depthWrite: false 
});
const ghostMesh = new THREE.Mesh(ghostGeo, ghostMat);

const edgesGeo = new THREE.EdgesGeometry(ghostGeo);
const edgesMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending });
const ghostEdges = new THREE.LineSegments(edgesGeo, edgesMat);
ghostMesh.add(ghostEdges);
ghostMesh.visible = false;
scene.add(ghostMesh);

const editorPreviewLight = new THREE.PointLight(0xffffff, 0, 10);
editorPreviewLight.castShadow = false;
scene.add(editorPreviewLight);

const editorPhysicsFloor = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Plane(),
    material: defaultMat,
    collisionFilterGroup: CG_STATIC,
    collisionFilterMask: CG_PLAYER | CG_DYNAMIC
});
editorPhysicsFloor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
editorPhysicsFloor.position.set(0, -0.5, 0);

const globalTiltThree = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.0, 0.0, 0.0));

const editorStaticBody = new CANNON.Body({
    mass: 0,
    material: defaultMat,
    collisionFilterGroup: CG_STATIC,
    collisionFilterMask: CG_PLAYER | CG_DYNAMIC
});
editorStaticBody.quaternion.set(globalTiltThree.x, globalTiltThree.y, globalTiltThree.z, globalTiltThree.w);

// --- PHYSICAL BLOCKS AND COLLIDERS DEFINITION ---
const PHYSICAL_BLOCK_TYPES = new Set(['blue', 'green', 'red', 'yellow', 'big_yellow', 'cyan', 'gray', 'big_gray']);

const baseBlockMat = {
    roughness: 0.15,
    metalness: 0.15,
    envMapIntensity: 7.5,
    transparent: true,
    opacity: 0.45,
    thickness: 0.5,
    side: THREE.DoubleSide
};

const blockConfigs = {
    blue: {
        mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0x3388ff, emissive: 0x001166, attenuationColor: new THREE.Color(0x6699ff) }),
        geo: new RoundedBoxGeometry(1.5, 1.5, 1.5, 4, 0.18),
        extents: new CANNON.Vec3(0.75, 0.75, 0.75),
        mass: 50
    },
    green: {
        mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0x33ff99, emissive: 0x003311, attenuationColor: new THREE.Color(0x44ffaa) }),
        geo: new RoundedBoxGeometry(1.0, 1.0, 1.0, 4, 0.12),
        extents: new CANNON.Vec3(0.5, 0.5, 0.5),
        mass: 30
    },
    red: {
        mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0xff3344, emissive: 0x440008, attenuationColor: new THREE.Color(0xff6677) }),
        geo: new RoundedBoxGeometry(1.0, 1.0, 1.0, 4, 0.12),
        extents: new CANNON.Vec3(0.5, 0.5, 0.5),
        mass: 35
    },
    yellow: {
        mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0xffdd33, emissive: 0x332200, attenuationColor: new THREE.Color(0xffee88) }),
        geo: new RoundedBoxGeometry(1.0, 1.0, 1.0, 4, 0.12),
        extents: new CANNON.Vec3(0.5, 0.5, 0.5),
        mass: 40
    },
    big_yellow: {
        mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0xffdd33, emissive: 0x332200, attenuationColor: new THREE.Color(0xffee88) }),
        geo: new RoundedBoxGeometry(2.5, 1.0, 2.5, 4, 0.12),
        extents: new CANNON.Vec3(1.3, 0.5, 1.3),
        mass: 50
    },
    cyan: {
        mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0x33ffff, emissive: 0x002233, attenuationColor: new THREE.Color(0x66ffff) }),
        geo: new RoundedBoxGeometry(1.0, 1.0, 1.0, 4, 0.12),
        extents: new CANNON.Vec3(0.5, 0.5, 0.5),
        mass: 30
    },
    gray: {
        mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, opacity: 0.65, color: 0xaaaaaa, emissive: 0x111111, attenuationColor: new THREE.Color(0xcccccc) }),
        geo: new RoundedBoxGeometry(1.0, 1.0, 1.0, 4, 0.12),
        extents: new CANNON.Vec3(0.5, 0.5, 0.5),
        mass: 30
    },
    big_gray: {
        mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, opacity: 0.65, color: 0x999999, emissive: 0x111111, attenuationColor: new THREE.Color(0xbbbbbb) }),
        geo: new RoundedBoxGeometry(1.5, 1.5, 1.5, 4, 0.18),
        extents: new CANNON.Vec3(0.75, 0.75, 0.75),
        mass: 80
    }
};

const shapes = {
    '1x1x1': new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)),
    '2x1x2': new CANNON.Box(new CANNON.Vec3(1.0, 0.5, 1.0)),
    '2x2x1': new CANNON.Box(new CANNON.Vec3(1.0, 1.0, 0.5)),
    '1x2x2': new CANNON.Box(new CANNON.Vec3(0.5, 1.0, 1.0))
};

// --- PRE-ALLOCATED MATH DATA STRUCTURES ---
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _pPos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _vMid = new THREE.Vector3();
const _vL1 = new THREE.Vector3();
const _vL2 = new THREE.Vector3();
const _vLook = new THREE.Vector3();
const _cannonV1 = new CANNON.Vec3();
const _cannonImpulse = new CANNON.Vec3();
const _cannonImpulse2 = new CANNON.Vec3();
const _windRayDir = new CANNON.Vec3();
const _windRayDest = new CANNON.Vec3();
const _buoyForceV = new CANNON.Vec3();
const _worldPosVec = new THREE.Vector3();
const targetVel = new THREE.Vector3();
const fwd = new THREE.Vector3();
const rgt = new THREE.Vector3();
const rayStart = new CANNON.Vec3();
const rayEnd = new CANNON.Vec3();
const getSpaceAxes = [new CANNON.Vec3(1, 0, 0), new CANNON.Vec3(0, 1, 0), new CANNON.Vec3(0, 0, 1)];

const MAX_VOL_LIGHTS = 16;
const _lightSortArray = new Array(64).fill(null).map(() => ({ light: null, dist: 0 }));
const pointPosUniformArray = new Float32Array(MAX_VOL_LIGHTS * 3);
const pointColUniformArray = new Float32Array(MAX_VOL_LIGHTS * 3);

// =============================================================================
// GRAPHICS PIPELINE, PRESETS & SETTINGS CONTROLLERS
// =============================================================================

function setupToggleRow(rowId, hiddenSelectId) {
    const row = document.getElementById(rowId);
    const sel = document.getElementById(hiddenSelectId);
    if (!row || !sel) return;
    row.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            row.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            sel.value = btn.dataset.val;
            applyGraphics();
        });
    });
}
setupToggleRow('toggle-volumetrics', 'set-volumetrics');
setupToggleRow('toggle-bloom',       'set-bloom');
setupToggleRow('toggle-ssao',        'set-ssao');
setupToggleRow('toggle-fxaa',        'set-fxaa');
setupToggleRow('toggle-ssr',         'set-ssr');

function syncToggleFromGfx() {
    function syncRow(rowId, val) {
        const row = document.getElementById(rowId);
        if (!row) return;
        row.querySelectorAll('.toggle-btn').forEach(b => {
            b.classList.toggle('active', parseInt(b.dataset.val, 10) === val);
        });
    }
    syncRow('toggle-volumetrics', gfx.volumetrics);
    syncRow('toggle-bloom',       gfx.bloom);
    syncRow('toggle-ssao',        gfx.ssao);
    syncRow('toggle-fxaa',        gfx.fxaa);
    syncRow('toggle-ssr',         gfx.ssr);
}

const GFX_PRESETS = {
    potato: { res: 0.5,  shadows: 0, bloom: 0, ssao: 0, fxaa: 0, ssr: 0, particles: 0, volumetrics: 0 },
    low:    { res: 0.5,  shadows: 1, bloom: 0, ssao: 0, fxaa: 1, ssr: 0, particles: 1, volumetrics: 0 },
    medium: { res: 0.75, shadows: 2, bloom: 1, ssao: 1, fxaa: 1, ssr: 0, particles: 2, volumetrics: 2 },
    high:   { res: 1.0,  shadows: 3, bloom: 1, ssao: 1, fxaa: 1, ssr: 0, particles: 2, volumetrics: 2 },
    ultra:  { res: 1.0,  shadows: 4, bloom: 1, ssao: 1, fxaa: 1, ssr: 0, particles: 2, volumetrics: 2 }
};

document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const preset = GFX_PRESETS[btn.dataset.preset];
        if (!preset) return;
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.getElementById('set-res').value         = preset.res;
        document.getElementById('set-shadows').value     = preset.shadows;
        document.getElementById('set-particles').value   = preset.particles;
        document.getElementById('set-volumetrics').value = preset.volumetrics;
        document.getElementById('set-bloom').value       = preset.bloom;
        document.getElementById('set-ssao').value        = preset.ssao;
        document.getElementById('set-fxaa').value        = preset.fxaa;
        document.getElementById('set-ssr').value         = preset.ssr;

        Object.assign(gfx, preset);
        syncToggleFromGfx();
        applyGraphics();
    });
});

const sensSlider = document.getElementById('sensitivity-slider');
const sensVal = document.getElementById('sens-val');
if (sensSlider && sensVal) {
    sensSlider.addEventListener('input', e => {
        controls.pointerSpeed = parseFloat(e.target.value);
        sensVal.innerText = parseFloat(e.target.value).toFixed(1);
    });
}

const bgmSlider = document.getElementById('bgm-slider');
const bgmVal = document.getElementById('bgm-val');
if (bgmSlider && bgmVal) {
    bgmSlider.addEventListener('input', e => {
        volBGM = parseFloat(e.target.value);
        if (AudioSys.bgmGain) AudioSys.bgmGain.gain.value = 0.25 * volBGM;
        bgmVal.innerText = Math.round(volBGM * 100) + '%';
    });
}

const dynSlider = document.getElementById('dyn-slider');
const dynVal = document.getElementById('dyn-val');
if (dynSlider && dynVal) {
    dynSlider.addEventListener('input', e => {
        volDyn = parseFloat(e.target.value);
        dynVal.innerText = Math.round(volDyn * 100) + '%';
    });
}

const sfxSlider = document.getElementById('sfx-slider');
const sfxVal = document.getElementById('sfx-val');
if (sfxSlider && sfxVal) {
    sfxSlider.addEventListener('input', e => {
        volSFX = parseFloat(e.target.value);
        sfxVal.innerText = Math.round(volSFX * 100) + '%';
    });
}

const _applyVolAdv = () => {
    if (volumetricPass) {
        volumetricPass.material.uniforms.scattering.value    = volAdv.density;
        volumetricPass.material.uniforms.volRadiusSq.value   = volAdv.radius * volAdv.radius;
        volumetricPass.material.uniforms.volBrightness.value = volAdv.brightness;
    }
    SaveSystem.save();
};

document.getElementById('vol-density')?.addEventListener('input', e => {
    volAdv.density = parseFloat(e.target.value);
    document.getElementById('vol-density-val').textContent = volAdv.density.toFixed(4);
    _applyVolAdv();
});
document.getElementById('vol-radius')?.addEventListener('input', e => {
    volAdv.radius = parseFloat(e.target.value);
    document.getElementById('vol-radius-val').textContent = volAdv.radius;
    _applyVolAdv();
});
document.getElementById('vol-brightness')?.addEventListener('input', e => {
    volAdv.brightness = parseFloat(e.target.value);
    document.getElementById('vol-brightness-val').textContent = volAdv.brightness.toFixed(2);
    _applyVolAdv();
});

function applyGraphics() {
    const resEl = document.getElementById('set-res');
    if (resEl) gfx.res = parseFloat(resEl.value) || 0.75;
    const shadEl = document.getElementById('set-shadows');
    if (shadEl) gfx.shadows = parseInt(shadEl.value, 10);
    const blmEl = document.getElementById('set-bloom');
    if (blmEl) gfx.bloom = parseInt(blmEl.value, 10);
    const ssaoEl = document.getElementById('set-ssao');
    if (ssaoEl) gfx.ssao = parseInt(ssaoEl.value, 10);
    const fxaaEl = document.getElementById('set-fxaa');
    if (fxaaEl) gfx.fxaa = parseInt(fxaaEl.value, 10);
    const ssrEl = document.getElementById('set-ssr');
    if (ssrEl) gfx.ssr = parseInt(ssrEl.value, 10);
    const partEl = document.getElementById('set-particles');
    if (partEl) gfx.particles = parseInt(partEl.value, 10);
    const volEl = document.getElementById('set-volumetrics');
    if (volEl) gfx.volumetrics = parseInt(volEl.value, 10);

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(dpr * gfx.res);
    renderer.setSize(window.innerWidth, window.innerHeight);

    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(window.innerWidth, window.innerHeight);

    const rendererSize = renderer.getSize(new THREE.Vector2());
    depthCaptureTarget.setSize(rendererSize.x, rendererSize.y);

    if (gfx.shadows === 0) {
        renderer.shadowMap.enabled = false;
        if (sunLight) sunLight.castShadow = false;
    } else {
        renderer.shadowMap.enabled = true;
        if (sunLight) {
            sunLight.castShadow = true;
            switch (gfx.shadows) {
                case 1:
                    sunLight.shadow.mapSize.set(512, 512);
                    renderer.shadowMap.type = THREE.BasicShadowMap;
                    sunLight.shadow.bias = -0.005;
                    break;
                case 2:
                    sunLight.shadow.mapSize.set(1024, 1024);
                    renderer.shadowMap.type = THREE.PCFShadowMap;
                    sunLight.shadow.bias = -0.001;
                    break;
                case 3:
                    sunLight.shadow.mapSize.set(2048, 2048);
                    renderer.shadowMap.type = THREE.PCFShadowMap;
                    sunLight.shadow.bias = -0.0005;
                    break;
                case 4:
                    sunLight.shadow.mapSize.set(4096, 4096);
                    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
                    sunLight.shadow.bias = -0.0001;
                    break;
            }
            if (sunLight.shadow.map) {
                sunLight.shadow.map.dispose();
                sunLight.shadow.map = null;
            }
        }
    }

    if (_prevShadowType !== renderer.shadowMap.type) {
        _prevShadowType = renderer.shadowMap.type;
        scene.traverse((child) => {
            if (child.isMesh) child.material.needsUpdate = true;
        });
    }

    if (bloomPass) bloomPass.enabled = (gfx.bloom === 1);
    if (ssaoPass) ssaoPass.enabled = (gfx.ssao === 1);
    if (smaaPass) smaaPass.enabled = (gfx.fxaa === 1);
    if (ssrPass) ssrPass.enabled = (gfx.ssr === 1);
    if (volumetricPass) volumetricPass.enabled = (gfx.volumetrics === 2);

    const volAdvSection = document.getElementById('vol-adv-section');
    if (volAdvSection) volAdvSection.classList.toggle('visible', gfx.volumetrics === 2);

    if (volumetricPass) {
        volumetricPass.material.uniforms.scattering.value    = volAdv.density;
        volumetricPass.material.uniforms.volRadiusSq.value   = volAdv.radius * volAdv.radius;
        volumetricPass.material.uniforms.volBrightness.value = volAdv.brightness;
    }

    if (dustMesh) {
        if (gfx.particles === 0) dustMesh.visible = false;
        else {
            dustMesh.visible = true;
            dustMat.opacity = (gfx.particles === 1) ? 0.15 : 0.35;
        }
    }
    SaveSystem.save(); 
}

// Settings Dialog DOM hooks
const btnSettings = document.getElementById('btn-show-settings');
const btnLevels = document.getElementById('btn-show-levels');
const btnHideSettings = document.getElementById('btn-hide-settings');
const instDiv = document.getElementById('instructions');
const settingsDiv = document.getElementById('settings-panel');
const btnResume = document.getElementById('btn-resume');

if (btnResume) {
    btnResume.addEventListener('click', (e) => {
        e.stopPropagation();
        requestPointerLockSafe();
    });
}

function openSettings(e) {
    e.stopPropagation();
    if (instDiv) instDiv.style.display = 'none';
    if (settingsDiv) settingsDiv.style.display = 'flex';
    const mm = document.getElementById('main-menu');
    if (mm && mm.style.display !== 'none') {
        document.getElementById('blocker').style.display = 'flex';
        mm.style.display = 'none';
    }
}
if (btnSettings) btnSettings.addEventListener('click', openSettings);

if (btnHideSettings) {
    btnHideSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        applyGraphics();
        if (settingsDiv) settingsDiv.style.display = 'none';
        if (fromMainMenu) {
            fromMainMenu = false;
            document.getElementById('blocker').style.display = 'none';
            const mm = document.getElementById('main-menu');
            if (mm) { mm.style.display = 'flex'; mm.style.opacity = '1'; }
        } else if (!AudioSys.ctx) {
            document.getElementById('blocker').style.display = 'none';
            const mm = document.getElementById('main-menu');
            if (mm) mm.style.display = 'flex';
        } else {
            if (instDiv) instDiv.style.display = 'flex';
        }
    });
}

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.settings-content').forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        const targetEl = document.getElementById(e.target.dataset.target);
        if (targetEl) targetEl.classList.add('active');
    });
});

const btnReset = document.getElementById('btn-reset-data');
const confirmPopup = document.getElementById('confirm-popup');
const btnConfirmReset = document.getElementById('btn-confirm-reset');
const btnCancelReset = document.getElementById('btn-cancel-reset');

if (btnReset && confirmPopup) {
    btnReset.addEventListener('click', (e) => { e.stopPropagation(); confirmPopup.style.display = 'flex'; });
    btnCancelReset?.addEventListener('click', (e) => { e.stopPropagation(); confirmPopup.style.display = 'none'; });
    btnConfirmReset?.addEventListener('click', (e) => {
        localStorage.removeItem(SaveSystem.key);
        window.location.reload();
    });
}

if (btnLevels) {
    btnLevels.addEventListener('click', (e) => {
        fromMainMenu = false;
        e.stopPropagation(); 
        document.getElementById('blocker').style.display = 'none';
        isViewingCustomLevels = false;
        const customBtn = document.getElementById('btn-custom-levels');
        if (customBtn) {
            customBtn.innerText = "USER LEVELS";
            customBtn.classList.remove('is-user');
        }

        if (isEditorMode || isPlayingCustom) {
            isEditorMode = false;
            isPlayingCustom = false;
            editorSceneGroup.visible = false;
            ghostMesh.visible = false;
            world.removeBody(editorPhysicsFloor);
            world.removeBody(editorStaticBody);
            customSolidBlocks.clear();
            customEntities.clear();
            customDestruction.length = 0;
            updateEditorVisuals();
        }

        rebuildChapterButtons();
        populateLevelList(); 
        document.getElementById('preview-title').innerText = getLevelName(currentLevel);
        isPreviewMode = true; 
        document.getElementById('level-select-overlay').style.display = 'flex'; 
        document.getElementById('level-select-overlay').style.opacity = '1';
        buildLevel(currentLevel, true);
    });
}

document.getElementById('level-select-back')?.addEventListener('click', () => {
    document.getElementById('level-select-overlay').style.display = 'none';
    isPreviewMode = false;
    if (fromMainMenu) {
        fromMainMenu = false;
        const mm = document.getElementById('main-menu');
        if (mm) { mm.style.display = 'flex'; mm.style.opacity = '1'; }
    } else {
        buildLevel(currentLevel, false);
        document.getElementById('blocker').style.display = 'flex';
    }
});

document.getElementById('level-select-watch-cutscene')?.addEventListener('click', () => {
    document.getElementById('level-select-overlay').style.display = 'none'; 
    isPreviewMode = false;
    if (fromMainMenu) {
        fromMainMenu = false;
        const mm = document.getElementById('main-menu');
        if (mm) { mm.style.display = 'flex'; mm.style.opacity = '1'; }
    }
    showEndingSequence();
});

document.getElementById('btn-custom-levels')?.addEventListener('click', () => {
    isViewingCustomLevels = !isViewingCustomLevels;
    const btn = document.getElementById('btn-custom-levels');
    if (isViewingCustomLevels) {
        btn.innerText = "CAMPAIGN";
        btn.classList.add('is-user');
    } else {
        btn.innerText = "USER LEVELS";
        btn.classList.remove('is-user');
    }
    const editBtn = document.getElementById('btn-edit-level');
    if (editBtn) editBtn.style.display = isViewingCustomLevels ? 'none' : 'inline-block';
    rebuildChapterButtons();
    populateLevelList();
});

// =============================================================================
// LEVEL EDITOR SUBSYSTEM, CODE SERIALIZER & LOGIC VISUALIZER
// =============================================================================

function hexToCSS(hex) {
    return '#' + hex.toString(16).padStart(6, '0');
}

function setEditorTool(tool) {
    editorTool = tool;
    const disp = document.getElementById('editor-tool-display');
    if (disp) disp.innerText = "TOOL: " + tool.toUpperCase().replace('_', ' ');
    const toolColor = (tool === 'light') ? lightColor : (TOOL_COLORS[tool] || 0x44ffaa);
    ghostMesh.material.color.setHex(toolColor);

    document.querySelectorAll('.ts-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.tool === tool);
        el.classList.remove('hovered');
    });
}

const EDITOR_TOOLS_LIST = [
    { tool: 'wall',       label: 'Wall',      key: '1', category: 'build' },
    { tool: 'fill',       label: 'Box Fill',  key: 'B', category: 'build' },
    { tool: 'water',      label: 'Water',     key: '-', category: 'build' },
    { tool: 'blue',       label: 'Blue (Bounce)', key: '2', category: 'items' },
    { tool: 'red',        label: 'Red (Scale)',  key: '3', category: 'items' },
    { tool: 'green',      label: 'Green (Goal)', key: '4', category: 'items' },
    { tool: 'yellow',     label: 'Yellow (Phys)', key: '5', category: 'items' },
    { tool: 'gray',       label: 'Gray (Block)', key: '0', category: 'items' },
    { tool: 'big_gray',   label: 'Lg Gray',   key: '-', category: 'items' },
    { tool: 'big_yellow', label: 'Lg Yellow', key: '9', category: 'items' },
    { tool: 'bomb',       label: 'Destruction', key: '6', category: 'logic' },
    { tool: 'plate',      label: 'Plate',     key: '-', category: 'logic' },
    { tool: 'door',       label: 'Door',      key: '-', category: 'logic' },
    { tool: 'logic',      label: 'Logic Gate', key: 'L', category: 'logic' },
    { tool: 'aero',       label: 'Aero Filter', key: '-', category: 'logic' },
    { tool: 'oneway',     label: 'One-Way',    key: '-', category: 'logic' },
    { tool: 'spawn',      label: 'Spawn',     key: '7', category: 'util' },
    { tool: 'exit',       label: 'Exit',      key: '8', category: 'util' },
    { tool: 'light',      label: 'Light',     key: '-', category: 'util' },
    { tool: 'decor_debris',        label: 'Debris',         key: '-', category: 'decor' },
    { tool: 'decor_wall_1x1_a',    label: 'Rubble A',       key: '-', category: 'decor' },
    { tool: 'decor_wall_1x1_b',    label: 'Rubble B',       key: '-', category: 'decor' },
    { tool: 'decor_wall_1x1_c',    label: 'Rubble C',       key: '-', category: 'decor' },
    { tool: 'decor_wall_2x2',      label: 'Compound Rubble',key: '-', category: 'decor' },
    { tool: 'decor_rubble',        label: 'Rock Cluster',   key: '-', category: 'decor' },
    { tool: 'decor_shattered',     label: 'Slab Fracture',  key: '-', category: 'decor' },
    { tool: 'decor_pillar',        label: 'Pillar Stub',    key: '-', category: 'decor' },
    { tool: 'decor_vine_hanging',  label: 'Ceiling Vine',   key: '-', category: 'decor' },
    { tool: 'decor_foliage_clump', label: 'Wild Grass',     key: '-', category: 'decor' }
];

let activeCategory = 'build';

function buildToolSelector() {
    const hud = document.getElementById('tool-selector-hud');
    const grid = document.getElementById('tool-selector-grid');
    if (!hud || !grid) return;

    let tabBar = hud.querySelector('.ts-tab-bar');
    if (!tabBar) {
        tabBar = document.createElement('div');
        tabBar.className = 'ts-tab-bar';
        tabBar.style.cssText = `display: flex; justify-content: center; gap: 8px; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.1);`;
        hud.insertBefore(tabBar, grid);
    }

    const categories = {
        'build': { label: 'STRUCTURE', icon: '🧱' },
        'items': { label: 'OBJECTS',   icon: '📦' },
        'logic': { label: 'CIRCUITS',  icon: '⚡' },
        'util':  { label: 'UTILITY',   icon: '🛠️' },
        'decor': { label: 'VEGETATION',icon: '🌿' }
    };

    tabBar.innerHTML = '';
    Object.entries(categories).forEach(([key, info]) => {
        const tabBtn = document.createElement('div');
        const isActive = (activeCategory === key);
        tabBtn.style.cssText = `
            padding: 6px 12px; font-size: 10px; letter-spacing: 2px; cursor: pointer; border-radius: 4px; transition: all 0.2s;
            color: ${isActive ? '#fff' : 'rgba(255,255,255,0.4)'};
            background: ${isActive ? 'rgba(255,255,255,0.15)' : 'transparent'};
            border: 1px solid ${isActive ? 'rgba(255,255,255,0.2)' : 'transparent'};
        `;
        tabBtn.innerHTML = `<span style="margin-right:4px">${info.icon}</span> ${info.label}`;
        tabBtn.onclick = (e) => {
            e.stopPropagation();
            activeCategory = key;
            buildToolSelector();
        };
        tabBar.appendChild(tabBtn);
    });

    grid.innerHTML = '';
    EDITOR_TOOLS_LIST.filter(t => t.category === activeCategory).forEach((toolObj) => {
        const item = document.createElement('div');
        const isSelected = (toolObj.tool === editorTool);
        item.className = 'ts-item' + (isSelected ? ' selected' : '');
        item.dataset.tool = toolObj.tool;

        item.innerHTML = `
            <div class="ts-swatch" style="background:${hexToCSS(TOOL_COLORS[toolObj.tool] || 0xffffff)}; width:36px; height:36px; border-radius:4px; box-shadow:0 0 8px rgba(0,0,0,0.5);"></div>
            <div class="ts-name" style="font-size:9px; margin-top:6px; font-weight:700;">${toolObj.label.toUpperCase()}</div>
            <div class="ts-key" style="font-size:8px; opacity:0.4;">${toolObj.key !== '-' ? '['+toolObj.key+']' : ''}</div>
        `;

        item.onmouseenter = () => {
            document.querySelectorAll('.ts-item').forEach(el => el.classList.remove('hovered'));
            item.classList.add('hovered');
            updateParamsPanel(toolObj.tool, false);
        };

        item.onclick = (e) => {
            e.stopPropagation();
            setEditorTool(toolObj.tool);
            buildToolSelector();
            updateParamsPanel(toolObj.tool, true);
            closeToolSelector();
        };
        grid.appendChild(item);
    });
}
buildToolSelector();

function openToolSelector() {
    isTabSelectorOpen = true;
    const currentToolData = EDITOR_TOOLS_LIST.find(t => t.tool === editorTool);
    if (currentToolData) activeCategory = currentToolData.category;
    buildToolSelector();
    document.getElementById('tool-selector-hud').classList.add('visible');
    updateParamsPanel(editorTool, true);
    controls.unlock();
}

function closeToolSelector() {
    const selected = document.querySelector('.ts-item.selected');
    const hovered = document.querySelector('.ts-item.hovered');
    const toApply = selected || hovered;
    if (toApply) setEditorTool(toApply.dataset.tool);
    isTabSelectorOpen = false;
    document.getElementById('tool-selector-hud').classList.remove('visible');
    document.getElementById('tool-params-panel').classList.remove('visible');
    isPaused = false;
    document.getElementById('blocker').style.display = 'none';
    requestPointerLockSafe();
}

const TOOLS_WITH_PARAMS = new Set(['red', 'light', 'plate', 'door', 'logic', 'aero', 'oneway']);
const LIGHT_COLOR_PRESETS = [
    { hex: 0xffffff, label: 'White' },
    { hex: 0xfff5cc, label: 'Warm' },
    { hex: 0xffddaa, label: 'Candle' },
    { hex: 0xaaddff, label: 'Cool' },
    { hex: 0x6699ff, label: 'Blue' },
    { hex: 0xff4444, label: 'Red' },
    { hex: 0x44ffaa, label: 'Teal' },
    { hex: 0xffaa00, label: 'Amber' }
];

(function initLightPresets() {
    const container = document.getElementById('light-presets');
    if (!container) return;
    LIGHT_COLOR_PRESETS.forEach(({ hex, label }) => {
        const sw = document.createElement('div');
        sw.className = 'lp-swatch' + (hex === lightColor ? ' active' : '');
        sw.style.background = hexToCSS(hex);
        sw.title = label;
        sw.addEventListener('click', (e) => {
            e.stopPropagation();
            lightColor = hex;
            document.querySelectorAll('.lp-swatch').forEach(s => s.classList.remove('active'));
            sw.classList.add('active');
            const picker = document.getElementById('tp-light-color-pick');
            if (picker) picker.value = hexToCSS(hex);
            if (editorTool === 'light') ghostMesh.material.color.setHex(hex);
            if (selectedEditorObject && selectedEditorObjectType === 'light') {
                selectedEditorObject.color = hex;
                updateEditorVisuals();
            }
        });
        container.appendChild(sw);
    });
})();

document.getElementById('tp-light-color-pick')?.addEventListener('input', e => {
    const hex = parseInt(e.target.value.replace('#', ''), 16);
    lightColor = hex;
    document.querySelectorAll('.lp-swatch').forEach(s => s.classList.remove('active'));
    if (editorTool === 'light') ghostMesh.material.color.setHex(hex);
    if (selectedEditorObject && selectedEditorObjectType === 'light') {
        selectedEditorObject.color = hex;
        updateEditorVisuals();
    }
});

document.getElementById('tp-light-intensity')?.addEventListener('input', e => {
    lightIntensity = parseFloat(e.target.value);
    document.getElementById('tp-light-intensity-val').textContent = lightIntensity.toFixed(1);
    if (selectedEditorObject && selectedEditorObjectType === 'light') {
        selectedEditorObject.intensity = lightIntensity;
        updateEditorVisuals();
    }
});

document.getElementById('tp-light-radius')?.addEventListener('input', e => {
    lightRadius = parseFloat(e.target.value);
    document.getElementById('tp-light-radius-val').textContent = lightRadius.toFixed(1);
    if (selectedEditorObject && selectedEditorObjectType === 'light') {
        selectedEditorObject.radius = lightRadius;
        updateEditorVisuals();
    }
});

document.getElementById('tp-red-scale')?.addEventListener('input', e => {
    redStartScale = parseFloat(e.target.value);
    document.getElementById('tp-red-scale-val').textContent = redStartScale.toFixed(1);
    if (editorTool === 'red') ghostMesh.scale.setScalar(redStartScale);
    if (selectedEditorObject && selectedEditorObjectType === 'red') {
        selectedEditorObject.startScale = redStartScale;
        updateEditorVisuals();
    }
});

document.getElementById('tp-plate-ch')?.addEventListener('input', e => {
    editorChannel = parseInt(e.target.value, 10);
    document.getElementById('tp-plate-ch-val').textContent = editorChannel;
    if (selectedEditorObject && selectedEditorObjectType === 'plate') selectedEditorObject.channel = editorChannel;
    updateLogicVisualizer();
});

document.getElementById('tp-door-ch')?.addEventListener('input', e => {
    editorChannel = parseInt(e.target.value, 10);
    document.getElementById('tp-door-ch-val').textContent = editorChannel;
    if (selectedEditorObject && selectedEditorObjectType === 'door') selectedEditorObject.channel = editorChannel;
    updateLogicVisualizer();
});

document.getElementById('tp-door-w')?.addEventListener('input', e => {
    editorDoorWidth = parseFloat(e.target.value);
    document.getElementById('tp-door-w-val').textContent = editorDoorWidth.toFixed(1);
    if (editorTool === 'door') ghostMesh.scale.set(editorDoorWidth, editorDoorHeight, 0.2);
    if (selectedEditorObject && selectedEditorObjectType === 'door') {
        selectedEditorObject.width = editorDoorWidth;
        updateEditorVisuals();
    }
});

document.getElementById('tp-door-h')?.addEventListener('input', e => {
    editorDoorHeight = parseFloat(e.target.value);
    document.getElementById('tp-door-h-val').textContent = editorDoorHeight.toFixed(1);
    if (editorTool === 'door') ghostMesh.scale.set(editorDoorWidth, editorDoorHeight, 0.2);
    if (selectedEditorObject && selectedEditorObjectType === 'door') {
        selectedEditorObject.height = editorDoorHeight;
        updateEditorVisuals();
    }
});

document.getElementById('tp-door-dist')?.addEventListener('input', e => {
    editorDoorMoveDist = parseFloat(e.target.value);
    document.getElementById('tp-door-dist-val').textContent = editorDoorMoveDist.toFixed(1);
    if (selectedEditorObject && selectedEditorObjectType === 'door') selectedEditorObject.moveDist = editorDoorMoveDist;
});

document.querySelectorAll('#toggle-door-dir .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#toggle-door-dir .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        editorDoorDir = btn.dataset.dir;
        if (selectedEditorObject && selectedEditorObjectType === 'door') selectedEditorObject.dir = editorDoorDir;
    });
});

document.getElementById('tp-aero-ch')?.addEventListener('input', e => {
    editorChannel = parseInt(e.target.value, 10);
    document.getElementById('tp-aero-ch-val').textContent = editorChannel;
    if (selectedEditorObject && selectedEditorObjectType === 'aero') selectedEditorObject.channel = editorChannel;
    updateLogicVisualizer();
});

document.getElementById('tp-oneway-ch')?.addEventListener('input', e => {
    editorChannel = parseInt(e.target.value, 10);
    document.getElementById('tp-oneway-ch-val').textContent = editorChannel;
    if (selectedEditorObject && selectedEditorObjectType === 'oneway') selectedEditorObject.channel = editorChannel;
    updateLogicVisualizer();
});

document.querySelectorAll('#toggle-oneway-inv .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#toggle-oneway-inv .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        editorFieldInverted = (btn.dataset.inv === 'true');
        if (selectedEditorObject && selectedEditorObjectType === 'oneway') {
            selectedEditorObject.inverted = editorFieldInverted;
            updateEditorVisuals();
        }
    });
});

let selectedLogicChannel = 1;
document.getElementById('tp-logic-out')?.addEventListener('input', e => {
    selectedLogicChannel = parseInt(e.target.value, 10);
    document.getElementById('tp-logic-out-val').textContent = selectedLogicChannel;
    const cfg = logicNodes.configs[selectedLogicChannel] || { type: 'NONE', source: selectedLogicChannel };
    updateLogicUIFromConfig(cfg);
});

document.querySelectorAll('#toggle-logic-type .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#toggle-logic-type .toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        saveCurrentLogicStep();
    });
});

document.getElementById('tp-logic-a')?.addEventListener('input', e => {
    document.getElementById('tp-logic-a-val').textContent = e.target.value;
    saveCurrentLogicStep();
});
document.getElementById('tp-logic-b')?.addEventListener('input', e => {
    document.getElementById('tp-logic-b-val').textContent = e.target.value;
    saveCurrentLogicStep();
});

function saveCurrentLogicStep() {
    const activeTypeBtn = document.querySelector('#toggle-logic-type .toggle-btn.active');
    const type = activeTypeBtn ? activeTypeBtn.dataset.type : 'NONE';
    const srcA = parseInt(document.getElementById('tp-logic-a').value, 10);
    const srcB = parseInt(document.getElementById('tp-logic-b').value, 10);

    if (type === 'NONE') {
        delete logicNodes.configs[selectedLogicChannel];
    } else {
        logicNodes.configs[selectedLogicChannel] = { type, source: srcA, sources: [srcA, srcB] };
    }

    const inputsRow = document.getElementById('logic-inputs-row');
    if (inputsRow) inputsRow.style.display = (type === 'NONE') ? 'none' : 'block';
    const rowB = document.getElementById('logic-b-row');
    if (rowB) rowB.style.display = (type === 'AND' || type === 'OR' || type === 'XOR') ? 'grid' : 'none';
    updateLogicVisualizer();
}

function updateLogicUIFromConfig(cfg) {
    document.querySelectorAll('#toggle-logic-type .toggle-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.type === cfg.type);
    });
    const slA = document.getElementById('tp-logic-a');
    if (slA) { slA.value = cfg.source || 1; document.getElementById('tp-logic-a-val').textContent = slA.value; }
    const slB = document.getElementById('tp-logic-b');
    if (slB) { slB.value = (cfg.sources ? cfg.sources[1] : 2); document.getElementById('tp-logic-b-val').textContent = slB.value; }
    saveCurrentLogicStep();
}

function updateParamsPanel(tool) {
    const panel = document.getElementById('tool-params-panel');
    const dot   = document.getElementById('tp-dot');
    const title = document.getElementById('tp-title');
    if (!panel) return;

    if (!TOOLS_WITH_PARAMS.has(tool)) {
        panel.classList.remove('visible');
        return;
    }

    panel.classList.add('visible');
    const color = TOOL_COLORS[tool] || 0xffffff;
    if (dot) { dot.style.background = hexToCSS(color); dot.style.color = hexToCSS(color); }

    document.querySelectorAll('.tp-section').forEach(s => s.classList.remove('visible'));
    const sec = document.getElementById('tp-section-' + tool);
    if (sec) sec.classList.add('visible');

    if (tool === 'red') {
        if (title) title.textContent = 'RED CUBE — PARAMETERS';
        document.getElementById('tp-red-scale').value = redStartScale;
        document.getElementById('tp-red-scale-val').textContent = redStartScale.toFixed(1);
    } else if (tool === 'light') {
        if (title) title.textContent = 'LIGHT — PARAMETERS';
        document.getElementById('tp-light-intensity').value = lightIntensity;
        document.getElementById('tp-light-intensity-val').textContent = lightIntensity.toFixed(1);
        document.getElementById('tp-light-radius').value = lightRadius;
        document.getElementById('tp-light-radius-val').textContent = lightRadius.toFixed(1);
    } else if (tool === 'plate') {
        if (title) title.textContent = 'PRESSURE PLATE — LINKING';
        document.getElementById('tp-plate-ch').value = editorChannel;
        document.getElementById('tp-plate-ch-val').textContent = editorChannel;
    } else if (tool === 'door') {
        if (title) title.textContent = 'GLASS GATE — LINKING';
        document.getElementById('tp-door-ch').value = editorChannel;
        document.getElementById('tp-door-ch-val').textContent = editorChannel;
        document.getElementById('tp-door-w').value = editorDoorWidth;
        document.getElementById('tp-door-w-val').textContent = editorDoorWidth.toFixed(1);
        document.getElementById('tp-door-h').value = editorDoorHeight;
        document.getElementById('tp-door-h-val').textContent = editorDoorHeight.toFixed(1);
        document.getElementById('tp-door-dist').value = editorDoorMoveDist;
        document.getElementById('tp-door-dist-val').textContent = editorDoorMoveDist.toFixed(1);
        ghostMesh.scale.set(editorDoorWidth, editorDoorHeight, 0.2);
    } else if (tool === 'logic') {
        if (title) title.textContent = 'CIRCUIT LOGIC — WIRING';
        const cfg = logicNodes.configs[selectedLogicChannel] || { type: 'NONE' };
        updateLogicUIFromConfig(cfg);
    } else if (tool === 'aero') {
        if (title) title.textContent = 'AERO FILTER — LINKING';
        document.getElementById('tp-aero-ch').value = editorChannel;
        document.getElementById('tp-aero-ch-val').textContent = editorChannel;
    } else if (tool === 'oneway') {
        if (title) title.textContent = 'ONE-WAY FIELD — CONFIG';
        document.getElementById('tp-oneway-ch').value = editorChannel;
        document.getElementById('tp-oneway-ch-val').textContent = editorChannel;
    }
}

function updateEditorVisuals(forcePhysicsRebuild = false) {
    for (const key in editorInstancedMeshes) editorInstancedMeshes[key].count = 0;

    const placeInstance = (x, y, z, tool, scale = 1) => {
        const im = editorInstancedMeshes[tool];
        if (im && im.count < MAX_EDITOR_BLOCKS) {
            dummy.position.set(x, y, z);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.setScalar(scale);
            dummy.updateMatrix();
            im.setMatrixAt(im.count++, dummy.matrix);
        }
    };

    customSolidBlocks.forEach(k => {
        const [x, y, z] = k.split(',').map(Number);
        placeInstance(x, y, z, 'wall');
    });
    customEntities.forEach(ent => placeInstance(ent.x, ent.y, ent.z, ent.type));
    customDestruction.forEach(b => placeInstance(b.cx, b.cy, b.cz, 'bomb'));
    customPlates.forEach(p => placeInstance(p.x, p.y, p.z, 'plate', 0.8));
    customDoors.forEach(d => placeInstance(d.x, d.y, d.z, 'door', 1.0));
    customFields.forEach(f => placeInstance(f.x, f.y, f.z, f.type, 1.0));
    customDecorations.forEach(d => placeInstance(d.x, d.y, d.z, d.type, 0.75));
    placeInstance(customSpawn.x, customSpawn.y, customSpawn.z, 'spawn');
    placeInstance(customExit.x, customExit.y, customExit.z, 'exit');

    for (const key in editorInstancedMeshes) {
        editorInstancedMeshes[key].instanceMatrix.needsUpdate = true;
    }

    if (isMouseDown && !forcePhysicsRebuild) {
        _editorPhysicsDirty = true;
    } else {
        _editorPhysicsDirty = false;
        world.removeBody(editorStaticBody);
        editorStaticBody.shapes.length = 0;
        editorStaticBody.shapeOffsets.length = 0;
        editorStaticBody.shapeOrientations.length = 0;
        const standardBox = new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5));
        customSolidBlocks.forEach(key => {
            const [x, y, z] = key.split(',').map(Number);
            editorStaticBody.addShape(standardBox, new CANNON.Vec3(x, y, z));
        });
        customEntities.forEach(ent => {
            let ext = blockConfigs[ent.type]?.extents || new CANNON.Vec3(0.5, 0.5, 0.5);
            editorStaticBody.addShape(new CANNON.Box(ext), new CANNON.Vec3(ent.x, ent.y, ent.z));
        });
        if (isEditorMode) world.addBody(editorStaticBody);
    }
    updateLogicVisualizer();
}

const logicVisualizerGroup = new THREE.Group();
scene.add(logicVisualizerGroup);

function updateLogicVisualizer() {
    while (logicVisualizerGroup.children.length > 0) {
        const obj = logicVisualizerGroup.children[0];
        obj.geometry.dispose();
        logicVisualizerGroup.remove(obj);
    }
    if (!isEditorMode || isPlayingCustom) return;

    const channels = Array.from({ length: 10 }, () => ({ sources: [], targets: [] }));
    customPlates.forEach(p => {
        channels[p.channel].sources.push(new THREE.Vector3(p.x, p.y + 0.5, p.z).applyQuaternion(globalTiltThree));
    });
    customDoors.forEach(d => {
        channels[d.channel].targets.push(new THREE.Vector3(d.x, d.y, d.z).applyQuaternion(globalTiltThree));
    });
    customFields.forEach(f => {
        channels[f.channel].targets.push(new THREE.Vector3(f.x, f.y, f.z).applyQuaternion(globalTiltThree));
    });

    channels.forEach((ch, index) => {
        if (ch.sources.length === 0 || ch.targets.length === 0) return;
        const color = CHANNEL_COLORS[index];
        const mat = new THREE.LineBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        ch.sources.forEach(srcPos => {
            ch.targets.forEach(tgtPos => {
                const geo = new THREE.BufferGeometry().setFromPoints([srcPos, tgtPos]);
                const line = new THREE.Line(geo, mat);
                line.userData.phase = Math.random() * Math.PI * 2;
                logicVisualizerGroup.add(line);
            });
        });
    });
}

function loadCustomLevelToEditor(slotIndex) {
    currentCustomSlot = slotIndex;
    const data = slotIndex >= 0 ? customLevels[slotIndex] : null;

    document.getElementById('level-select-overlay').style.display = 'none';
    document.getElementById('editor-hud').style.display = 'flex';

    isPreviewMode = false;
    isEditorMode = true;
    isPlayingCustom = false;
    editorSceneGroup.visible = true;

    customSolidBlocks.clear();
    customEntities.clear();
    customDestruction.length = 0;
    customLights.length = 0;
    customPlates.length = 0;
    customDoors.length = 0;
    customFields.length = 0;
    customDecorations.length = 0;

    if (data) { 
        customSpawn = data.spawn || { x: 0, y: 2, z: 0 };
        customExit = data.exit || { x: 0, y: 5, z: -8 };
        customWaterY = data.waterY;
        if (data.solids) data.solids.forEach(k => customSolidBlocks.add(k));
        if (data.entities) data.entities.forEach(([k, v]) => customEntities.set(k, v));
        if (data.destruction) customDestruction = data.destruction;
        if (data.lights) customLights = data.lights;
        if (data.plates) customPlates = data.plates;
        if (data.doors) customDoors = data.doors;
        if (data.fields) customFields = data.fields;
        if (data.decorations) customDecorations = data.decorations;
    } else {
        customSpawn = { x: 0, y: 2, z: 0 };
        customExit = { x: 0, y: 5, z: -8 };
        customWaterY = undefined;
    }

    logicNodes.configs = {};
    if (data && data.logic) logicNodes.configs = JSON.parse(JSON.stringify(data.logic));

    updateEditorVisuals();
    clearCurrentLevel();
    world.addBody(editorPhysicsFloor);

    playerBody.position.set(customSpawn.x, Math.max(customSpawn.y + 2, 4), customSpawn.z);
    playerBody.velocity.set(0, 0, 0);
    setTimeout(() => requestPointerLockSafe(), 100);
}

function buildEditorLevelBuilder(name = "CUSTOM PLAYTEST") {
    const builder = new LevelBuilder(999, name)
        .setBounds(15, 20, 15)
        .setSpawn(customSpawn.x, customSpawn.y, customSpawn.z)
        .setExit(customExit.x, customExit.y, customExit.z)
        .setCutscene(null);

    if (customWaterY !== undefined) builder.setWater(customWaterY);

    customSolidBlocks.forEach(key => {
        const [x, y, z] = key.split(',').map(Number);
        builder.addSolid(x, y, z);
    });

    customEntities.forEach(ent => {
        if (PHYSICAL_BLOCK_TYPES.has(ent.type)) {
            const opts = {};
            if (ent.type === 'red' && ent.startScale !== undefined) opts.startScale = ent.startScale;
            builder.addEntity(ent.type, ent.x, ent.y, ent.z, opts);
        }
    });

    customDestruction.forEach(bomb => builder.addDestructionZone(bomb.cx, bomb.cy, bomb.cz, 4, 7));
    customLights.forEach(l => builder.addLight(l.x, l.y, l.z, l.color, l.intensity, l.radius));
    customPlates.forEach(p => builder.addPlate(p.x, p.y, p.z, p.channel));
    customDoors.forEach(d => builder.addDoor(d.x, d.y, d.z, d));

    customFields.forEach(f => {
        if (f.type === 'aero') builder.addAeroFilter(f.x, f.y, f.z, f.channel, f.w, f.h, f.normal);
        if (f.type === 'oneway') builder.addOneWayField(f.x, f.y, f.z, f.channel, f.inverted, f.w, f.h, f.normal);
    });

    for (let ch in logicNodes.configs) {
        const l = logicNodes.configs[ch];
        builder.addLogicGate(parseInt(ch, 10), l.type, l.operands || l.sources);
    }
    return builder;
}

function serializeLevelBuilderCode(builder) {
    let bX = 5, bY = 5, bZ = 5;
    builder.solids.forEach(key => {
        const [x, y, z] = key.split(',').map(Number);
        bX = Math.max(bX, Math.abs(x) + 1);
        bY = Math.max(bY, y + 2);
        bZ = Math.max(bZ, Math.abs(z) + 1);
    });

    let out = `return builder.setBounds(${bX}, ${bY}, ${bZ})\n`;
    out += `    .setSpawn(${builder.spawn.x}, ${builder.spawn.y}, ${builder.spawn.z})\n`;
    out += `    .setExit(${builder.exit.x}, ${builder.exit.y}, ${builder.exit.z})\n`;

    builder.blocks.forEach(ent => {
        if (ent.type === 'red' && ent.startScale !== undefined && ent.startScale !== 1.0) {
            out += `    .addEntity('${ent.type}', ${ent.pos.x}, ${ent.pos.y}, ${ent.pos.z}, { startScale: ${ent.startScale} })\n`;
        } else {
            out += `    .addEntity('${ent.type}', ${ent.pos.x}, ${ent.pos.y}, ${ent.pos.z})\n`;
        }
    });

    builder.destructionZones.forEach(z => {
        out += `    .addDestructionZone(${z.cx}, ${z.cy}, ${z.cz}, 4, 7)\n`;
    });

    (builder.lights || []).forEach(light => {
        const hexStr = '0x' + light.color.toString(16).padStart(6, '0');
        out += `    .addLight(${light.x}, ${light.y}, ${light.z}, ${hexStr}, ${light.intensity}, ${light.radius})\n`;
    });

    builder.plates.forEach(p => { out += `    .addPlate(${p.x}, ${p.y}, ${p.z}, ${p.channel})\n`; });
    builder.doors.forEach(d => {
        out += `    .addDoor(${d.x}, ${d.y}, ${d.z}, { channel: ${d.channel}, dir: '${d.dir}', width: ${d.width}, height: ${d.height}, moveDist: ${d.moveDist} })\n`;
    });

    builder.fields.forEach(f => {
        if (f.type === 'aero') out += `    .addAeroFilter(${f.x}, ${f.y}, ${f.z}, ${f.channel}, ${f.w}, ${f.h})\n`;
        if (f.type === 'oneway') out += `    .addOneWayField(${f.x}, ${f.y}, ${f.z}, ${f.channel}, ${f.inverted}, ${f.w}, ${f.h})\n`;
    });

    builder.logic.forEach(l => {
        out += `    .addLogicGate(${l.ch}, '${l.type}', ${JSON.stringify(l.operands)})\n`;
    });

    if (builder.waterY !== undefined) out += `    .setWater(${builder.waterY})\n`;

    const arrStr = JSON.stringify(Array.from(builder.solids));
    out += `    .addCustomLogic((() => {\n`;
    out += `        const solids = new Set(${arrStr});\n`;
    out += `        return (x, y, z) => solids.has(x + ',' + y + ',' + z);\n`;
    out += `    })()).build();`;
    return out;
}

function exportLevelCode() {
    const builder = buildEditorLevelBuilder("CUSTOM LEVEL");
    const out = serializeLevelBuilderCode(builder);
    navigator.clipboard.writeText(out).then(() => {
        const scaleHud = document.getElementById('scale-hud');
        scaleHud.textContent = "LEVEL CODE COPIED TO CLIPBOARD";
        scaleHud.style.opacity = '1';
        clearTimeout(scaleHudTimeout);
        scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 2500);
    }).catch(err => console.error("Clipboard error:", err));
}

document.getElementById('btn-edit-level')?.addEventListener('click', () => {
    if (typeof previewTargetLvl === 'string' && previewTargetLvl.startsWith('CUSTOM_')) {
        loadCustomLevelToEditor(parseInt(previewTargetLvl.replace('CUSTOM_', ''), 10));
        return;
    }
    currentCustomSlot = -1;
    document.getElementById('level-select-overlay').style.display = 'none';

    isPreviewMode = false;
    isEditorMode = true;
    isPlayingCustom = false;
    editorSceneGroup.visible = true;

    customSolidBlocks.clear();
    customEntities.clear();
    customDestruction.length = 0;
    customLights.length = 0;
    customPlates.length = 0;
    customDoors.length = 0;
    customFields.length = 0;
    customWaterY = undefined;

    const params = getLevelParams(previewTargetLvl);
    customSpawn = { x: Math.round(params.spawn.x), y: Math.round(params.spawn.y), z: Math.round(params.spawn.z) };
    customExit = { x: Math.round(params.exit.x), y: Math.round(params.exit.y), z: Math.round(params.exit.z) };
    const b = params.bounds;
    for (let x = -b.x; x <= b.x; x++) {
        for (let y = 0; y <= b.y; y++) {
            for (let z = -b.z; z <= b.z; z++) {
                if (params.isSolid(x, y, z)) customSolidBlocks.add(`${x},${y},${z}`);
            }
        }
    }
    params.blocks.forEach(blk => {
        const key = `${Math.round(blk.pos.x)},${Math.round(blk.pos.y)},${Math.round(blk.pos.z)}`;
        const ent = { type: blk.type, x: Math.round(blk.pos.x), y: Math.round(blk.pos.y), z: Math.round(blk.pos.z) };
        if (blk.type === 'red' && blk.startScale !== undefined) ent.startScale = blk.startScale;
        customEntities.set(key, ent);
    });

    (params.destructionZones || []).forEach(z => customDestruction.push({ cx: z.cx, cy: z.cy, cz: z.cz }));
    (params.lights || []).forEach(l => customLights.push({ x: l.x, y: l.y, z: l.z, color: l.color, intensity: l.intensity, radius: l.radius }));
    (params.plates || []).forEach(p => customPlates.push({ x: p.x, y: p.y, z: p.z, channel: p.channel }));
    (params.doors || []).forEach(d => customDoors.push({ ...d }));
    (params.fields || []).forEach(f => customFields.push({ ...f }));
    if (params.waterY !== undefined) customWaterY = params.waterY;

    logicNodes.configs = {};
    (params.logic || []).forEach(l => {
        logicNodes.configs[l.ch] = { type: l.type, operands: l.operands };
    });

    updateEditorVisuals();
    clearCurrentLevel();
    world.addBody(editorPhysicsFloor);
    playerBody.position.set(0, 4, 0);
    playerBody.velocity.set(0, 0, 0);
    setTimeout(() => requestPointerLockSafe(), 100);
});

function getLevelParams(lvl) {
    if (typeof lvl === 'string' && lvl.startsWith('CUSTOM_')) {
        const slot = parseInt(lvl.replace('CUSTOM_', ''), 10);
        const data = customLevels[slot];
        const builder = new LevelBuilder(999, `SLOT ${slot + 1}`);
        if (!data) return builder.build(); 

        builder.setBounds(15, 20, 15)
            .setSpawn(data.spawn.x, data.spawn.y, data.spawn.z)
            .setExit(data.exit.x, data.exit.y, data.exit.z)
            .setCutscene(null);

        if (data.waterY !== undefined) builder.setWater(data.waterY);

        const solidSet = new Set(data.solids || []);
        builder.addCustomLogic((x, y, z) => solidSet.has(`${x},${y},${z}`));

        if (data.entities) data.entities.forEach(([k, ent]) => {
            const opts = ent.startScale !== undefined ? { startScale: ent.startScale } : {};
            builder.addEntity(ent.type, ent.x, ent.y, ent.z, opts);
        });

        if (data.destruction) data.destruction.forEach(b => builder.addDestructionZone(b.cx, b.cy, b.cz, 4, 7));
        if (data.lights) data.lights.forEach(l => builder.addLight(l.x, l.y, l.z, l.color, l.intensity, l.radius));
        if (data.plates) data.plates.forEach(p => builder.addPlate(p.x, p.y, p.z, p.channel));
        if (data.doors) data.doors.forEach(d => builder.addDoor(d.x, d.y, d.z, d));

        if (data.fields) data.fields.forEach(f => {
            if (f.type === 'aero') builder.addAeroFilter(f.x, f.y, f.z, f.channel, f.w, f.h, f.normal);
            if (f.type === 'oneway') builder.addOneWayField(f.x, f.y, f.z, f.channel, f.inverted, f.w, f.h, f.normal);
        });

        if (data.logic) {
            for (let ch in data.logic) {
                const l = data.logic[ch];
                const ops = l.operands || l.sources || [];
                builder.addLogicGate(parseInt(ch, 10), l.type, ops);
            }
        }
        return builder.build();
    }

    if (lvl === 'CUSTOM') {
        return buildEditorLevelBuilder("CUSTOM PLAYTEST").build();
    }

    switch (activeChapter) {
        case 1:  return getLevelParamsV2(lvl);
        case 2:  return getLevelParamsV3(lvl);
        default: return getLevelParamsV1(lvl);
    }
}

// =============================================================================
// BALANCED PROCEDURAL CONCRETE, STONE & MOSS TEXTURE PIPELINE
// =============================================================================

function _createNoise2D(seed = 1337) {
    let s = seed | 0;
    const rng = () => {
        s = Math.imul(s, 1664525) + 1013904223 | 0;
        return ((s >>> 0) / 4294967296);
    };

    const perm = new Uint8Array(512);
    const gradX = new Float32Array(256);
    const gradY = new Float32Array(256);

    for (let i = 0; i < 256; i++) {
        const a = rng() * Math.PI * 2;
        gradX[i] = Math.cos(a);
        gradY[i] = Math.sin(a);
        perm[i] = i;
    }
    for (let i = 255; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

    return (x, y) => {
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);
        const u = fade(xf);
        const v = fade(yf);

        const p00 = perm[X + perm[Y]];
        const p10 = perm[X + 1 + perm[Y]];
        const p01 = perm[X + perm[Y + 1]];
        const p11 = perm[X + 1 + perm[Y + 1]];

        const dot00 = gradX[p00] * xf + gradY[p00] * yf;
        const dot10 = gradX[p10] * (xf - 1) + gradY[p10] * yf;
        const dot01 = gradX[p01] * xf + gradY[p01] * (yf - 1);
        const dot11 = gradX[p11] * (xf - 1) + gradY[p11] * (yf - 1);

        const x1 = dot00 + u * (dot10 - dot00);
        const x2 = dot01 + u * (dot11 - dot01);
        return x1 + v * (x2 - x1);
    };
}


// =============================================================================
// NORMAL & CAVITY-AO 3x3 SOBEL KERNEL
// =============================================================================

function _computeNormalsAndAOFromHeight(heightMap, S, normalStrength = 4.0) {
    const normalData = new Uint8ClampedArray(S * S * 4);
    const aoData = new Uint8ClampedArray(S * S * 4);

    const getH = (x, y) => {
        const u = (x + S) % S;
        const v = (y + S) % S;
        return heightMap[v * S + u];
    };

    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const idx = (y * S + x) * 4;

            // 3x3 Sobel Operator
            const tl = getH(x - 1, y - 1);
            const t  = getH(x,     y - 1);
            const tr = getH(x + 1, y - 1);
            const l  = getH(x - 1, y);
            const r  = getH(x + 1, y);
            const bl = getH(x - 1, y + 1);
            const b  = getH(x,     y + 1);
            const br = getH(x + 1, y + 1);

            const dx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
            const dy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);

            const nx = -dx * normalStrength;
            const ny = -dy * normalStrength;
            const nz = 1.0;

            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            normalData[idx + 0] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
            normalData[idx + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
            normalData[idx + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
            normalData[idx + 3] = 255;

            // Curvature / Cavity AO in crevices and cracks
            const centerH = getH(x, y);
            const avgNeighbor = (tl + t + tr + l + r + bl + b + br) * 0.125;
            const curvature = Math.max(0.0, Math.min(1.0, 0.5 + (centerH - avgNeighbor) * 3.5));
            const aoVal = Math.round(Math.pow(curvature, 1.4) * 255);

            aoData[idx + 0] = aoVal;
            aoData[idx + 1] = aoVal;
            aoData[idx + 2] = aoVal;
            aoData[idx + 3] = 255;
        }
    }

    return { normalData, aoData };
}

// ── 1. MONOLITHIC ROUGH ROCK SLAB (STEPPED LEVELS & SUBTLE TACTILE DEPTH) ─────
function createConcreteTextures() {
    const S = 512;
    const shelfNoise  = _createNoise2D(101);
    const macroNoise  = _createNoise2D(202);
    const chiselNoise = _createNoise2D(303);
    const grainNoise  = _createNoise2D(404);
    const colorNoise  = _createNoise2D(505);

    const makeCtx = () => {
        const c = document.createElement('canvas');
        c.width = c.height = S;
        return { c, ctx: c.getContext('2d') };
    };

    const { c: aC, ctx: a } = makeCtx();
    const { c: hC, ctx: h } = makeCtx();
    const { c: rC, ctx: r } = makeCtx();

    const aData = a.createImageData(S, S);
    const rData = r.createImageData(S, S);
    const heightArr = new Float32Array(S * S);

    // ── GENERATE ONE CONTINUOUS MONOLITHIC ROCK FACE WITH TIERED LEVELS ──────
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const idx = (y * S + x) * 4;
            const pIdx = y * S + x;

            // 1. Broad Continuous Geological Undulation (One massive stone face)
            const nMacro = macroNoise(x * 0.008, y * 0.008) * 0.40;
            const nShelf = shelfNoise(x * 0.020, y * 0.020) * 0.25;
            const baseElevation = clamp01(0.50 + nMacro + nShelf);

            // 2. Depth Irregularities in Stepped Levels (Natural stone cleavage plateaus)
            const numLevels = 3.0; // 3 subtle stepped height shelves
            const steppedVal = Math.floor(baseElevation * numLevels);
            const levelFrac  = (baseElevation * numLevels) - steppedVal;
            // Soft transition between geological shelves
            const tieredLevel = (steppedVal + smoothstep(0.25, 0.75, levelFrac)) / numLevels;

            // 3. Rough Micro-Texture (Chiseled stone tooth & fine mineral sand)
            const nChisel = Math.abs(chiselNoise(x * 0.045, y * 0.045)) * 0.08;
            const nGrain  = grainNoise(x * 0.160, y * 0.160) * 0.05;

            // Height Map: Subtle, unified elevation with tiered shelves (0.55 to 0.88 range)
            const finalHeight = clamp01(0.55 + tieredLevel * 0.25 - nChisel + nGrain);
            heightArr[pIdx] = finalHeight;

            // 4. Subdued, Natural Stone Albedo (Single stone slab with soft mineral shifts)
            const cShift = colorNoise(x * 0.012, y * 0.012) * 10.0;
            
            // Higher shelves catch slightly more light; lower steps sit in subtle shade
            const levelShade = (tieredLevel - 0.5) * 16.0;
            const baseLum = clamp255(196.0 + levelShade + cShift + (nGrain * 18.0) - (nChisel * 20.0));

            // Neutral warm architectural stone palette (subtle limestone/granite tone)
            aData.data[idx + 0] = clamp255(baseLum * 0.99);
            aData.data[idx + 1] = clamp255(baseLum * 1.00);
            aData.data[idx + 2] = clamp255(baseLum * 0.96);
            aData.data[idx + 3] = 255;

            // 5. Tactile Roughness: Uniform matte stone finish with micro-tooth
            const roughVal = clamp255(190.0 + nGrain * 30.0 + (1.0 - tieredLevel) * 15.0);
            rData.data[idx + 0] = roughVal;
            rData.data[idx + 1] = roughVal;
            rData.data[idx + 2] = roughVal;
            rData.data[idx + 3] = 255;
        }
    }

    function clamp01(v) { return Math.max(0.0, Math.min(1.0, v)); }
    function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
    function smoothstep(e0, e1, x) {
        const t = Math.max(0.0, Math.min(1.0, (x - e0) / (e1 - e0)));
        return t * t * (3.0 - 2.0 * t);
    }

    a.putImageData(aData, 0, 0);
    r.putImageData(rData, 0, 0);

    const hData = h.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
        hData.data[i * 4 + 0] = clamp255(heightArr[i] * 255);
        hData.data[i * 4 + 1] = hData.data[i * 4 + 0];
        hData.data[i * 4 + 2] = hData.data[i * 4 + 0];
        hData.data[i * 4 + 3] = 255;
    }
    h.putImageData(hData, 0, 0);

    // Calibrated normal strength (3.2) for subtle stepped shelves and tactile tooth
    const { normalData, aoData } = _computeNormalsAndAOFromHeight(heightArr, S, 3.2);

    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = normalCanvas.height = S;
    normalCanvas.getContext('2d').putImageData(new ImageData(normalData, S, S), 0, 0);

    const aoCanvas = document.createElement('canvas');
    aoCanvas.width = aoCanvas.height = S;
    aoCanvas.getContext('2d').putImageData(new ImageData(aoData, S, S), 0, 0);

    const makeTex = (canvas, srgb = false) => {
        const t = new THREE.CanvasTexture(canvas);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = 4;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        return t;
    };

    return {
        albedo: makeTex(aC, true),
        normal: makeTex(normalCanvas),
        ao: makeTex(aoCanvas),
        roughness: makeTex(rC),
        height: makeTex(hC)
    };
}

// ── 2. SEAMLESS FLOOR PAVERS ───────────────────────────────────────────────
function createFloorTextures() {
    const S = 512;
    const noise2D = _createNoise2D(88);

    const makeCtx = () => {
        const c = document.createElement('canvas');
        c.width = c.height = S;
        return { c, ctx: c.getContext('2d') };
    };

    const { c: aC, ctx: a } = makeCtx();
    const { c: hC, ctx: h } = makeCtx();
    const { c: rC, ctx: r } = makeCtx();

    const aData = a.createImageData(S, S);
    const hData = h.createImageData(S, S);
    const rData = r.createImageData(S, S);
    const heightArr = new Float32Array(S * S);

    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const idx = (y * S + x) * 4;
            const n1 = noise2D(x * 0.02, y * 0.02) * 5.0;

            const hVal = 0.90 + n1 * 0.01;
            heightArr[y * S + x] = hVal;

            let lum = Math.round(222 + n1);
            lum = Math.max(0, Math.min(255, lum));

            aData.data[idx + 0] = Math.round(lum * 0.98);
            aData.data[idx + 1] = Math.round(lum * 1.00);
            aData.data[idx + 2] = Math.round(lum * 0.99);
            aData.data[idx + 3] = 255;

            rData.data[idx + 0] = 145;
            rData.data[idx + 1] = 145;
            rData.data[idx + 2] = 145;
            rData.data[idx + 3] = 255;
        }
    }

    a.putImageData(aData, 0, 0);
    r.putImageData(rData, 0, 0);

    const { normalData, aoData } = _computeNormalsAndAOFromHeight(heightArr, S, 2.0);

    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = normalCanvas.height = S;
    normalCanvas.getContext('2d').putImageData(new ImageData(normalData, S, S), 0, 0);

    const aoCanvas = document.createElement('canvas');
    aoCanvas.width = aoCanvas.height = S;
    aoCanvas.getContext('2d').putImageData(new ImageData(aoData, S, S), 0, 0);

    const makeTex = (canvas, srgb = false) => {
        const t = new THREE.CanvasTexture(canvas);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = 4;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        return t;
    };

    return {
        albedo: makeTex(aC, true),
        normal: makeTex(normalCanvas),
        ao: makeTex(aoCanvas),
        roughness: makeTex(rC),
        height: makeTex(hC)
    };
}

// ── 3. SEAMLESS FULL-GREEN MOSS ────────────────────────────────────────────
function createMossTextures() {
    const S = 512;
    const noise2D = _createNoise2D(777);

    const makeCtx = () => {
        const c = document.createElement('canvas');
        c.width = c.height = S;
        return { c, ctx: c.getContext('2d') };
    };

    const { c: aC, ctx: a } = makeCtx();
    const { c: hC, ctx: h } = makeCtx();
    const { c: rC, ctx: r } = makeCtx();

    const aData = a.createImageData(S, S);
    const rData = r.createImageData(S, S);
    const heightArr = new Float32Array(S * S);

    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const idx = (y * S + x) * 4;
            const n1 = noise2D(x * 0.03, y * 0.03) * 0.5 + 0.5;

            heightArr[y * S + x] = 0.90 + n1 * 0.02;

            const mossLum = n1 * 0.85;
            aData.data[idx + 0] = Math.round(35 + mossLum * 35);
            aData.data[idx + 1] = Math.round(95 + mossLum * 75);
            aData.data[idx + 2] = Math.round(25 + mossLum * 30);
            aData.data[idx + 3] = 255;

            rData.data[idx + 0] = 245;
            rData.data[idx + 1] = 245;
            rData.data[idx + 2] = 245;
            rData.data[idx + 3] = 255;
        }
    }

    a.putImageData(aData, 0, 0);
    r.putImageData(rData, 0, 0);

    const { normalData, aoData } = _computeNormalsAndAOFromHeight(heightArr, S, 2.0);

    const normalCanvas = document.createElement('canvas');
    normalCanvas.width = normalCanvas.height = S;
    normalCanvas.getContext('2d').putImageData(new ImageData(normalData, S, S), 0, 0);

    const aoCanvas = document.createElement('canvas');
    aoCanvas.width = aoCanvas.height = S;
    aoCanvas.getContext('2d').putImageData(new ImageData(aoData, S, S), 0, 0);

    const makeTex = (canvas, srgb = false) => {
        const t = new THREE.CanvasTexture(canvas);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = 4;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        return t;
    };

    return {
        albedo: makeTex(aC, true),
        normal: makeTex(normalCanvas),
        ao: makeTex(aoCanvas),
        roughness: makeTex(rC),
        height: makeTex(hC)
    };
}

// =============================================================================
// SHATTER — TACTILE ARCHITECTURAL CONCRETE WITH ORGANIC ROUNDED STONE BORDERS
// =============================================================================

function applyTriplanar(material, options = {}) {
    const rawScale = options.scale !== undefined ? options.scale : 2.5;
    const scale = rawScale * 0.25; // Megalithic stone scale

    const crackIntensity = options.crackIntensity !== undefined 
        ? options.crackIntensity 
        : (options.vineIntensity !== undefined ? options.vineIntensity : 0.65);
    const crackScale = options.crackScale !== undefined ? options.crackScale : 1.0;

    material.userData.triScale = { value: scale };
    material.userData.uCrackIntensity = { value: crackIntensity };
    material.userData.uCrackScale = { value: crackScale };

    material.onBeforeCompile = (shader) => {
        shader.uniforms.uTriScale = material.userData.triScale;
        shader.uniforms.uCrackIntensity = material.userData.uCrackIntensity;
        shader.uniforms.uCrackScale = material.userData.uCrackScale;

        // ── 1. VERTEX SHADER ─────────────────────────────────────────────────
        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `#include <common>
            varying vec3 vTriWorldPos;
            varying vec3 vTriWorldNormal;
            varying vec2 vTriUV;
            `
        );

        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            vTriUV = uv;
            `
        );

        shader.vertexShader = shader.vertexShader.replace(
            '#include <worldpos_vertex>',
            `#include <worldpos_vertex>
            vTriWorldPos = worldPosition.xyz;
            vec3 rawWNorm = mat3(modelMatrix) * objectNormal;
            float rawWLen = length(rawWNorm);
            vTriWorldNormal = rawWLen > 0.0001 ? (rawWNorm / rawWLen) : vec3(0.0, 1.0, 0.0);
            `
        );

        // ── 2. FRAGMENT SHADER: ROUNDED STONE BORDERS & MEGALITH SHADING ─────
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            `#include <common>
            varying vec3 vTriWorldPos;
            varying vec3 vTriWorldNormal;
            varying vec2 vTriUV;
            uniform float uTriScale;
            uniform float uCrackIntensity;
            uniform float uCrackScale;

            // Algebraic triplanar blending
            vec4 triplanarSample(sampler2D pMap, vec3 pPos, vec3 pNormal, float pScale) {
                vec3 n2 = pNormal * pNormal;
                vec3 blending = n2 * n2;
                float bSum = blending.x + blending.y + blending.z;
                blending /= max(bSum, 0.00001);

                vec3 p = pPos * pScale;
                vec4 x = texture2D(pMap, p.zy);
                vec4 y = texture2D(pMap, p.xz);
                vec4 z = texture2D(pMap, p.xy);
                return x * blending.x + y * blending.y + z * blending.z;
            }

            vec3 triplanarNormal(sampler2D nMap, vec3 pPos, vec3 pNormal, float pScale, float nScale) {
                vec3 n2 = pNormal * pNormal;
                vec3 blending = n2 * n2;
                float bSum = blending.x + blending.y + blending.z;
                blending /= max(bSum, 0.00001);

                vec3 p = pPos * pScale;
                vec3 tX = texture2D(nMap, p.zy).xyz * 2.0 - 1.0;
                vec3 tY = texture2D(nMap, p.xz).xyz * 2.0 - 1.0;
                vec3 tZ = texture2D(nMap, p.xy).xyz * 2.0 - 1.0;

                tX.xy *= nScale;
                tY.xy *= nScale;
                tZ.xy *= nScale;

                vec3 worldX = vec3(0.0, tX.y, tX.x);
                vec3 worldY = vec3(tY.x, 0.0, tY.y);
                vec3 worldZ = vec3(tZ.x, tZ.y, 0.0);

                vec3 worldNorm = pNormal + (worldX * blending.x + worldY * blending.y + worldZ * blending.z);
                float wLen = length(worldNorm);
                worldNorm = wLen > 0.0001 ? (worldNorm / wLen) : pNormal;

                vec3 viewNorm = mat3(viewMatrix) * worldNorm;
                float vLen = length(viewNorm);
                return vLen > 0.0001 ? (viewNorm / vLen) : vec3(0.0, 0.0, 1.0);
            }

            float cleanHash2D(vec2 p) {
                vec2 q = fract(p * vec2(0.1031, 0.1030));
                q += dot(q, q.yx + 33.33);
                return fract((q.x + q.y) * q.x);
            }

            float smoothMacroNoise(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                vec2 u = f * f * (3.0 - 2.0 * f);
                return mix(
                    mix(cleanHash2D(i + vec2(0.0, 0.0)), cleanHash2D(i + vec2(1.0, 0.0)), u.x),
                    mix(cleanHash2D(i + vec2(0.0, 1.0)), cleanHash2D(i + vec2(1.0, 1.0)), u.x),
                    u.y
                );
            }

            float triFold(float x) {
                return abs(fract(x) - 0.5);
            }

            vec2 triFold2(vec2 p) {
                return abs(fract(p) - 0.5);
            }

            // Natural shear warp
            vec2 naturalShearWarp(vec2 p) {
                vec2 t1 = triFold2(p * 0.95 + triFold2(p.yx * 0.65) * 1.2) - 0.25;
                return t1 * 0.55;
            }

            float evaluateSparseFracturePlane(vec2 uv, float seedOffset) {
                float presence = smoothMacroNoise(uv * 0.22 + seedOffset * 0.7);
                float clusterMask = smoothstep(0.60, 0.80, presence);
                if (clusterMask <= 0.001) return 0.0;

                vec2 p = uv * (0.35 * uCrackScale);
                vec2 wp = p + naturalShearWarp(p + seedOffset);

                float mainFault = triFold(wp.x * 0.50 + wp.y * 0.25 + seedOffset);
                float branchFault = triFold(wp.y * 0.55 - wp.x * 0.35 + 0.38) + 0.12;
                float crackDist = min(mainFault, branchFault);

                float fissureMask = 1.0 - smoothstep(0.0, 0.0065, crackDist);
                return fissureMask * clusterMask;
            }

            float evaluateSparseFractureTriplanar(vec3 p, vec3 n) {
                vec3 n2 = n * n;
                vec3 w = n2 * n2;
                float bSum = w.x + w.y + w.z;
                w /= max(bSum, 0.00001);

                float cX = evaluateSparseFracturePlane(p.zy, 0.45);
                float cY = evaluateSparseFracturePlane(p.xz, 1.85);
                float cZ = evaluateSparseFracturePlane(p.xy, 3.15);

                return clamp((cX * w.x + cY * w.y + cZ * w.z) * uCrackIntensity, 0.0, 1.0);
            }

            // ── EVALUATES 3D ROUNDED STONE BORDER DEPTH WITH NOISE WARPING ──
            float evaluateOrganicBorderDepth(vec2 uv, vec3 worldP, vec3 worldN, out float outEdgeDist) {
                // 1. 2D Rounded-Box SDF (Rounds square 90° corners into smooth circular arcs)
                vec2 pBox = abs(uv - 0.5);
                float rCorner = 0.085; // 8.5% corner rounding radius
                vec2 qBox = pBox - vec2(0.5 - rCorner);
                float cornerDist = length(max(qBox, 0.0)) + min(max(qBox.x, qBox.y), 0.0) - rCorner;
                float baseD = -cornerDist; // Positive inside block face, 0 at the rounded edge

                // 2. Modulate Edge Seam with Stone Formation Noise ("Same Noise")
                vec3 absN = abs(worldN);
                vec2 faceCoord = (absN.x > 0.5) ? worldP.zy : ((absN.y > 0.5) ? worldP.xz : worldP.xy);

                vec2 stoneWarp = naturalShearWarp(faceCoord * (uTriScale * 1.6) + 0.5);
                float borderDisplacement = (stoneWarp.x + stoneWarp.y) * 0.022;
                float macroUndulation = (smoothMacroNoise(faceCoord * (uTriScale * 0.75) + 1.2) - 0.5) * 0.018;

                // Seam undulates organically around bulging rock contours
                float edgeD = baseD + borderDisplacement + macroUndulation;
                outEdgeDist = edgeD;

                // 3. Smooth Bullnose / Pillowed Stone Cross-Section
                // Soft rounded quarter-circle drop from 4.8cm down to 0.8cm
                float bevelT = clamp((edgeD - 0.008) / 0.040, 0.0, 1.0);
                float roundArc = sqrt(max(0.0, 1.0 - (1.0 - bevelT) * (1.0 - bevelT)));
                float roundDepth = -(1.0 - roundArc) * 0.024; // 2.4cm smooth rounded shoulder

                // Recessed joint trench
                float jointDepth = -(1.0 - smoothstep(0.001, 0.008, edgeD)) * 0.020;

                return roundDepth + jointDepth;
            }`
        );

        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `
            #ifdef USE_MAP
                vec4 sampledColor = triplanarSample(map, vTriWorldPos, vTriWorldNormal, uTriScale);
                diffuseColor *= sampledColor;
            #endif

            // 1. Hairline cracks
            if (uCrackIntensity > 0.01) {
                float hairlineMask = evaluateSparseFractureTriplanar(vTriWorldPos, vTriWorldNormal);
                if (hairlineMask > 0.005) {
                    vec3 crackTone = diffuseColor.rgb * 0.68;
                    diffuseColor.rgb = mix(diffuseColor.rgb, crackTone, hairlineMask * 0.38);
                }
            }

            // 2. Rounded Stone Block Edge Shading (Curves naturally around the rock formations)
            float organicEdgeDist = 0.0;
            float edgeDepthH = evaluateOrganicBorderDepth(vTriUV, vTriWorldPos, vTriWorldNormal, organicEdgeDist);

            float innerSeam = smoothstep(0.001, 0.010, organicEdgeDist);
            float outerRound = smoothstep(0.008, 0.048, organicEdgeDist);

            // Soft pillowed block edge shadow
            float blockEdgeAO = mix(0.40, 1.0, innerSeam * 0.65 + outerRound * 0.35);
            diffuseColor.rgb *= blockEdgeAO;

            // Highlight along the curved stone shoulder
            float roundLip = smoothstep(0.020, 0.040, organicEdgeDist) * (1.0 - smoothstep(0.040, 0.060, organicEdgeDist));
            diffuseColor.rgb += vec3(0.038, 0.035, 0.030) * roundLip;
            `
        );

        // ── 3. SMOOTH 3D ROUNDED BULLNOSE NORMALS ─────────────────────────────
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <normal_fragment_maps>',
            `
            #ifdef USE_NORMALMAP
                normal = triplanarNormal(normalMap, vTriWorldPos, vTriWorldNormal, uTriScale, normalScale.x);
            #endif

            // Continuous curved normals for the rounded pillowed stone edge
            if (abs(edgeDepthH) > 0.0003) {
                float dh_dx = dFdx(edgeDepthH);
                float dh_dy = dFdy(edgeDepthH);
                vec3 dPdx = dFdx(vViewPosition);
                vec3 dPdy = dFdy(vViewPosition);
                vec3 r1 = cross(dPdy, normal);
                vec3 r2 = cross(normal, dPdx);
                float det = dot(dPdx, r1);
                if (abs(det) > 1e-5) {
                    vec3 edgeGrad = (r1 * dh_dx + r2 * dh_dy) / det;
                    // Smooth 12.0 multiplier for continuous rounded specular roll
                    vec3 beveledNormal = normal - edgeGrad * 12.0;
                    float bLen = length(beveledNormal);
                    if (bLen > 0.0001) {
                        normal = beveledNormal / bLen;
                    }
                }
            }
            `
        );

        // ── 4. ROUGHNESS: RECESSED JOINT ACCUMULATION ─────────────────────────
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <roughnessmap_fragment>',
            `
            float roughnessFactor = roughness;

            #ifdef USE_ROUGHNESSMAP
                float triRough = triplanarSample(roughnessMap, vTriWorldPos, vTriWorldNormal, uTriScale).g;
                roughnessFactor *= triRough;
            #endif

            if (organicEdgeDist < 0.012) {
                roughnessFactor = mix(0.96, roughnessFactor, smoothstep(0.001, 0.012, organicEdgeDist));
            }
            `
        );
    };
}

// --- BASE GEOMETRIES & FRACTURED MESH BUILDERS ---
function _deformGeometry(geometry, rngFn, intensity, minSize = 0.3) {
    const box = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim < minSize) return;

    const scaleDist = Math.min(1.0, maxDim / 2.0);
    const effectiveIntensity = intensity * scaleDist;

    geometry.computeVertexNormals();
    const pos = geometry.attributes.position;
    const norm = geometry.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
        const push = (rngFn() - 0.5) * effectiveIntensity;
        pos.setXYZ(
            i,
            pos.getX(i) + norm.getX(i) * push,
            pos.getY(i) + norm.getY(i) * push,
            pos.getZ(i) + norm.getZ(i) * push
        );
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
}

function _buildBrokenChunkGeometry(baseW, baseH, baseD, seed) {
    const rngLocal = _makeRng(seed);
    const geos = [];
    const mainGeo = new THREE.BoxGeometry(baseW * 0.85, baseH * 0.85, baseD * 0.85, 3, 3, 3);
    _deformGeometry(mainGeo, rngLocal, Math.min(baseW, baseH, baseD) * 0.14);
    mainGeo.translate((rngLocal() - 0.5) * baseW * 0.08, (rngLocal() - 0.5) * baseH * 0.08, (rngLocal() - 0.5) * baseD * 0.08);
    geos.push(mainGeo);

    const chunkCount = 3;
    for (let i = 0; i < chunkCount; i++) {
        const cw = baseW * (0.24 + rngLocal() * 0.18);
        const ch = baseH * (0.2 + rngLocal() * 0.18);
        const cd = baseD * (0.22 + rngLocal() * 0.18);
        const cg = new THREE.BoxGeometry(cw, ch, cd, 2, 2, 2);
        _deformGeometry(cg, rngLocal, Math.min(cw, ch, cd) * 0.25);
        cg.rotateY(rngLocal() * Math.PI * 2);
        cg.translate(
            (rngLocal() - 0.5) * baseW * 0.7,
            -baseH * 0.5 + ch * 0.5 + rngLocal() * baseH * 0.2,
            (rngLocal() - 0.5) * baseD * 0.7
        );
        geos.push(cg);
    }
    const merged = BufferGeometryUtils.mergeGeometries(geos, false);
    merged.computeVertexNormals();
    return merged;
}

const g1x1 = new THREE.BoxGeometry(1, 1, 1);
const g2x1x2 = new THREE.BoxGeometry(2, 1, 2);
const g2x2x1 = new THREE.BoxGeometry(2, 2, 1);
const g1x2x2 = new THREE.BoxGeometry(1, 2, 2);

const gBroken1x1   = _buildBrokenChunkGeometry(1, 1, 1, 90210);
const gBroken2x1x2 = _buildBrokenChunkGeometry(2, 1, 2, 90211);
const gBroken2x2x1 = _buildBrokenChunkGeometry(2, 2, 1, 90212);
const gBroken1x2x2 = _buildBrokenChunkGeometry(1, 2, 2, 90213);

const concreteTexs = createConcreteTextures();
const floorTexs = createFloorTextures();
const mossTexs = createMossTextures();

// ── Floor: Smooth, non-reflective honed paver finish ────────────────────────
const floorMaterial = new THREE.MeshStandardMaterial({
    map: floorTexs.albedo,
    normalMap: floorTexs.normal,
    roughnessMap: floorTexs.roughness,
    aoMap: floorTexs.ao,
    roughness: 0.70,        // Matte stone finish (no glare)
    metalness: 0.0,         // Zero metalness
    envMapIntensity: 0.10,  // Soft, subdued ambient bounce
    normalScale: new THREE.Vector2(1.2, 1.2)
});
applyTriplanar(floorMaterial, { scale: 2.5, vineIntensity: 0.30, vineWidth: 0.075, vineDensity: 0.70 });

// ── Walls: Deep matte Portland concrete ────────────────────────────────────
const wallMaterial = new THREE.MeshStandardMaterial({
    map: concreteTexs.albedo,
    normalMap: concreteTexs.normal,
    roughnessMap: concreteTexs.roughness,
    aoMap: concreteTexs.ao,
    roughness: 0.80,        // Fully matte stone
    metalness: 0.0,
    envMapIntensity: 0.10,  // Zero gloss
    normalScale: new THREE.Vector2(1.5, 1.5)
});
applyTriplanar(wallMaterial, { scale: 2.5, vineIntensity: 1.0, vineWidth: 0.085, vineDensity: 0.75 });

// ── Broken Rubble ─────────────────────────────────────────────────────────
const brokenMaterial = new THREE.MeshStandardMaterial({
    map: concreteTexs.albedo,
    normalMap: concreteTexs.normal,
    roughnessMap: concreteTexs.roughness,
    color: 0x6e726e,
    roughness: 0.88,
    metalness: 0.0,
    envMapIntensity: 0.08,
    normalScale: new THREE.Vector2(1.8, 1.8)
});
applyTriplanar(brokenMaterial, { scale: 2.5, vineIntensity: 1.2, vineWidth: 0.088, vineDensity: 0.80 });

// ── Mossy Stone: Velvety non-reflective full green ─────────────────────────
const mossyMaterial = new THREE.MeshStandardMaterial({
    map: mossTexs.albedo,
    normalMap: mossTexs.normal,
    roughnessMap: mossTexs.roughness,
    aoMap: mossTexs.ao,
    color: 0x4f823a,
    roughness: 0.98,        // Ultra-matte velvet
    metalness: 0.0,
    envMapIntensity: 0.05,
    normalScale: new THREE.Vector2(1.8, 1.8)
});
applyTriplanar(mossyMaterial, { scale: 2.5, vineIntensity: 1.4, vineWidth: 0.090, vineDensity: 0.85 });

// ── Scorched Stone: Charred ash (no vines) ─────────────────────────────────
const scorchedMaterial = new THREE.MeshStandardMaterial({
    map: concreteTexs.albedo,
    normalMap: concreteTexs.normal,
    color: 0x161412,
    emissive: 0x2e0c03,
    emissiveIntensity: 0.15,
    roughness: 0.85,
    metalness: 0.0,
    envMapIntensity: 0.05,
    normalScale: new THREE.Vector2(1.8, 1.8)
});
applyTriplanar(scorchedMaterial, { scale: 2.5, vineIntensity: 0.0 });

const baseEmissiveMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffeedd,
    emissiveIntensity: 3.0,
    toneMapped: false
});

const meshes = {
    'wall1x1x1': new THREE.InstancedMesh(g1x1, wallMaterial, 5000),
    'wall2x1x2': new THREE.InstancedMesh(g2x1x2, wallMaterial, 2000),
    'wall2x2x1': new THREE.InstancedMesh(g2x2x1, wallMaterial, 2000),
    'wall1x2x2': new THREE.InstancedMesh(g1x2x2, wallMaterial, 2000),
    'broken1x1x1': new THREE.InstancedMesh(gBroken1x1, brokenMaterial, 3000),
    'broken2x1x2': new THREE.InstancedMesh(gBroken2x1x2, brokenMaterial, 1000),
    'broken2x2x1': new THREE.InstancedMesh(gBroken2x2x1, brokenMaterial, 1000),
    'broken1x2x2': new THREE.InstancedMesh(gBroken1x2x2, brokenMaterial, 1000),
    'mossy1x1x1': new THREE.InstancedMesh(g1x1, mossyMaterial, 1500),
    'mossy2x1x2': new THREE.InstancedMesh(g2x1x2, mossyMaterial, 500),
    'mossy2x2x1': new THREE.InstancedMesh(g2x2x1, mossyMaterial, 500),
    'mossy1x2x2': new THREE.InstancedMesh(g1x2x2, mossyMaterial, 500),
    'scorched1x1x1': new THREE.InstancedMesh(g1x1, scorchedMaterial, 1500),
    'scorched2x1x2': new THREE.InstancedMesh(g2x1x2, scorchedMaterial, 500),
    'scorched2x2x1': new THREE.InstancedMesh(g2x2x1, scorchedMaterial, 500),
    'scorched1x2x2': new THREE.InstancedMesh(g1x2x2, scorchedMaterial, 500),
    'floor1x1x1': new THREE.InstancedMesh(g1x1, floorMaterial, 3000),
    'floor2x1x2': new THREE.InstancedMesh(g2x1x2, floorMaterial, 1000),
    'floor2x2x1': new THREE.InstancedMesh(g2x2x1, floorMaterial, 1000),
    'floor1x2x2': new THREE.InstancedMesh(g1x2x2, floorMaterial, 1000),
    'light': new THREE.InstancedMesh(g1x1, baseEmissiveMaterial, 200)
};

const counts = {
    'wall1x1x1': 0, 'wall2x1x2': 0, 'wall2x2x1': 0, 'wall1x2x2': 0,
    'broken1x1x1': 0, 'broken2x1x2': 0, 'broken2x2x1': 0, 'broken1x2x2': 0,
    'mossy1x1x1': 0, 'mossy2x1x2': 0, 'mossy2x2x1': 0, 'mossy1x2x2': 0,
    'scorched1x1x1': 0, 'scorched2x1x2': 0, 'scorched2x2x1': 0, 'scorched1x2x2': 0,
    'floor1x1x1': 0, 'floor2x1x2': 0, 'floor2x2x1': 0, 'floor1x2x2': 0,
    'light': 0
};

const maxCounts = {};
for (const k in meshes) {
    meshes[k].castShadow = true;
    meshes[k].receiveShadow = true;
    meshes[k].frustumCulled = true;
    maxCounts[k] = meshes[k].count;
    scene.add(meshes[k]);
}

const dummy = new THREE.Object3D();

// --- AUDIO SYNTHESIS SUBSYSTEM ---
const BGM_MELODY = [
    [0, 2, 2.5],
    [16, 3, 2.0],
    [32, 5, 3.0],
    [48, 4, 2.0],
    [64, 7, 3.5],
    [80, 6, 2.5],
    [96, 4, 2.0],
    [112, 5, 3.0]
];

const BGM_HARMONY = [
    [8, 0, 3.0],
    [40, 2, 3.0],
    [72, 3, 3.0],
    [104, 0, 3.0]
];

const BGM_BASS = [
    [0, 65.41, 0.8],
    [8, 65.41, 0.8],
    [16, 82.41, 0.8],
    [24, 82.41, 0.8],
    [32, 87.31, 0.8],
    [40, 87.31, 0.8],
    [48, 98.00, 0.8],
    [56, 98.00, 0.8],
    [64, 65.41, 0.8],
    [72, 65.41, 0.8],
    [80, 55.00, 0.8],
    [88, 55.00, 0.8],
    [96, 98.00, 0.8],
    [104, 98.00, 0.8],
    [112, 65.41, 0.8],
    [120, 65.41, 0.8]
];

const CHORD_MAP = {
    'C':  [0, 2, 3, 5, 7, 8],
    'G':  [1, 3, 4, 6, 8, 9],
    'Am': [0, 2, 4, 5, 7, 9],
    'Em': [2, 3, 5, 7, 8]
};

const PROGRESSION = [
    'C', 'G', 'Am', 'G', 'Am', 'Em', 'G', 'Am',
    'C', 'G', 'Em', 'G', 'Am', 'C', 'G', 'C'
];

const AudioSys = {
    ctx: null,
    masterGain: null,
    bgmGain: null,
    arpGain: null,
    blueGain: null,
    exitGain: null,
    textGain: null,
    focusElement: null,
    stepCount: 0,
    blueActiveUntil: 0,
    exitActiveUntil: 0,

    init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();

        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 1.0;

        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -3.0;
        this.limiter.connect(this.ctx.destination);
        this.masterGain.connect(this.limiter);

        this.bgmGain = this.ctx.createGain();
        this.bgmGain.connect(this.masterGain);

        this.arpGain = this.ctx.createGain();
        this.arpGain.connect(this.masterGain);

        this.blueGain = this.ctx.createGain();
        this.blueGain.connect(this.masterGain);

        this.exitGain = this.ctx.createGain();
        this.exitGain.connect(this.masterGain);

        this.textGain = this.ctx.createGain();
        this.textGain.gain.value = 1.0 * volSFX;
        this.textGain.connect(this.masterGain);

        this.reverbNode = this.ctx.createConvolver();
        this.reverbNode.buffer = this.createReverbBuffer(this.ctx, 2.5);
        this.reverbNode.connect(this.masterGain);

        this.arpGain.connect(this.reverbNode);
        this.bgmGain.connect(this.reverbNode);

        setInterval(() => this.seq(), 125);
    },

    seq() {
        if (!this.ctx || (isPaused && !isPreviewMode)) return;
        this.stepCount++;
        const t = this.ctx.currentTime;
        const s = this.stepCount;
        const beat = s % 128;

        const chordKey = PROGRESSION[Math.floor(beat / 8)];
        const safeIndices = CHORD_MAP[chordKey] || CHORD_MAP['C'];
        const penta = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25, 783.99, 880.00];

        if (volBGM > 0) {
            for (const [step, idx, dur] of BGM_MELODY) {
                if (beat === step) this.playTone(penta[idx], 'sine', dur, 0.08 * volBGM, this.bgmGain);
            }
            for (const [step, idx, dur] of BGM_HARMONY) {
                if (beat === step) this.playTone(penta[idx], 'triangle', dur, 0.025 * volBGM, this.bgmGain);
            }
            for (const [step, freq, dur] of BGM_BASS) {
                if (beat === step) this.playTone(freq, 'triangle', dur, 0.04 * volBGM, this.bgmGain);
            }
        }

        const targetArp = (this.focusElement ? 0.5 : 0.0) * volDyn;
        this.arpGain.gain.setTargetAtTime(targetArp, t, 0.2);

        if (this.focusElement && volDyn > 0) {
            const getChordNote = (offset = 0) => {
                const idx = (s + offset) % safeIndices.length;
                return penta[safeIndices[idx]];
            };

            switch (this.focusElement) {
                case 'blue':
                    this.playTone(getChordNote() * 2, 'sine', 0.2, 0.12 * volDyn, this.arpGain);
                    break;
                case 'green':
                    if (s % 2 === 0) {
                        this.playTone(getChordNote(), 'sine', 0.8, 0.15 * volDyn, this.arpGain);
                    }
                    break;
                case 'red':
                    if (s % 2 === 0) {
                        this.playTone(getChordNote(s % 3) / 2, 'sawtooth', 0.3, 0.04 * volDyn, this.arpGain);
                        this.playTone(getChordNote(s % 2) / 2, 'triangle', 0.3, 0.06 * volDyn, this.arpGain);
                    }
                    break;
                case 'yellow':
                    if (s % 4 === 1 || s % 4 === 3) {
                        this.playTone(getChordNote() * 1.5, 'square', 0.05, 0.05 * volDyn, this.arpGain);
                    }
                    break;
                case 'cyan':
                    if (s % 4 === 0) {
                        this.playFMTone(getChordNote() * 2, 2.14, 2, 0.6, 0.07 * volDyn, this.arpGain);
                    }
                    break;
            }
        }

        if (this.blueActiveUntil && t < this.blueActiveUntil && volDyn > 0) {
            const bIdx = safeIndices[s % safeIndices.length];
            this.playTone(penta[bIdx] * 2, 'sine', 0.15, 0.08 * volDyn, this.blueGain);
        }
        if (this.exitActiveUntil && t < this.exitActiveUntil && volDyn > 0) {
            const eIdx = safeIndices[s % safeIndices.length];
            this.playTone(penta[eIdx], 'sine', 0.4, 0.02 * volDyn, this.exitGain);
        }
    },

    playTone(freq, type, dur, vol, dest, startTime) {
        if (!this.ctx) return;
        const t = startTime !== undefined ? startTime : this.ctx.currentTime;
        const dst = dest || this.bgmGain;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = type;
        o.frequency.value = freq;
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, 0.05));
        o.connect(g);
        g.connect(dst);
        o.start(t);
        o.stop(t + Math.max(dur, 0.05));
    },

    playFMTone(carrierFreq, modRatio, modIndex, dur, vol, dest, startTime) {
        if (!this.ctx) return;
        const t = startTime !== undefined ? startTime : this.ctx.currentTime;
        const dst = dest || this.masterGain;
        const carrier = this.ctx.createOscillator();
        const modulator = this.ctx.createOscillator();
        const modGain = this.ctx.createGain();
        const g = this.ctx.createGain();
        carrier.type = 'sine';
        carrier.frequency.value = carrierFreq;
        modulator.type = 'sine';
        modulator.frequency.value = carrierFreq * modRatio;
        modGain.gain.setValueAtTime(carrierFreq * modIndex, t);
        modGain.gain.exponentialRampToValueAtTime(0.01, t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        modulator.connect(modGain);
        modGain.connect(carrier.frequency);
        carrier.connect(g);
        g.connect(dst);
        modulator.start(t);
        modulator.stop(t + dur);
        carrier.start(t);
        carrier.stop(t + dur);
    },

    createReverbBuffer(ctx, duration) {
        const sampleRate = ctx.sampleRate;
        const length = sampleRate * duration;
        const impulse = ctx.createBuffer(2, length, sampleRate);
        for (let i = 0; i < length; i++) {
            const decay = Math.pow(1 - i / length, 3.0);
            impulse.getChannelData(0)[i] = (Math.random() * 2 - 1) * decay;
            impulse.getChannelData(1)[i] = (Math.random() * 2 - 1) * decay;
        }
        return impulse;
    },

    grab() {
        if (!this.ctx || volSFX <= 0) return;
        const t = this.ctx.currentTime;
        this.playTone(440, 'sine', 0.15, 0.05 * volSFX, this.masterGain, t);
        this.playTone(880, 'sine', 0.15, 0.05 * volSFX, this.masterGain, t + 0.05);
    },
    drop() {
        if (!this.ctx || volSFX <= 0) return;
        const t = this.ctx.currentTime;
        this.playTone(880, 'sine', 0.15, 0.05 * volSFX, this.masterGain, t);
        this.playTone(440, 'sine', 0.15, 0.05 * volSFX, this.masterGain, t + 0.05);
    },
    playTextSound() {
        if (!this.ctx || volSFX <= 0) return;
        const t = this.ctx.currentTime;
        [440, 523.25, 659.25, 880, 1046.50, 1318.51].forEach((f, i) =>
            this.playTone(f, 'sine', 0.4, 0.08 * volSFX, this.textGain, t + i * 0.06)
        );
    },
    triggerBlueBounce() {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        this.blueGain.gain.cancelScheduledValues(t);
        this.blueGain.gain.setValueAtTime(0.6 * volDyn, t);
        this.blueGain.gain.exponentialRampToValueAtTime(0.001, t + 2.5);
        this.blueActiveUntil = t + 2.5;
    },
    triggerExitLayer() {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        this.exitGain.gain.cancelScheduledValues(t);
        this.exitGain.gain.setValueAtTime(0, t);
        this.exitGain.gain.linearRampToValueAtTime(0.03 * volDyn, t + 1.0);
        this.exitGain.gain.exponentialRampToValueAtTime(0.001, t + 4.5);
        this.exitActiveUntil = t + 4.5;
    },
    resize(delta) {
        if (!this.ctx || volSFX <= 0) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.value = delta > 0 ? 300 : 150;
        g.gain.setValueAtTime(0.05 * volSFX, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        o.connect(g);
        g.connect(this.masterGain);
        o.start(t);
        o.stop(t + 0.2);
    }
};

// --- PERSISTENCE AND SAVE SYSTEM ---
const SaveSystem = {
    key: 'shatter_player_data',
    save() {
        const data = {
            currentLevel,
            activeChapter,
            chaptersUnlocked,
            gfx,
            volAdv,
            volBGM,
            volSFX,
            volDyn,
            sensitivity: controls ? controls.pointerSpeed : 1.0
        };
        localStorage.setItem(this.key, JSON.stringify(data));
    },
    load() {
        const raw = localStorage.getItem(this.key);
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            if (data.currentLevel !== undefined) currentLevel = data.currentLevel;
            if (data.activeChapter !== undefined) activeChapter = data.activeChapter;
            if (data.chaptersUnlocked) chaptersUnlocked = data.chaptersUnlocked;
            if (data.gfx) Object.assign(gfx, data.gfx);
            if (data.volAdv) Object.assign(volAdv, data.volAdv);
            if (data.volBGM !== undefined) volBGM = data.volBGM;
            if (data.volSFX !== undefined) volSFX = data.volSFX;
            if (data.volDyn !== undefined) volDyn = data.volDyn;

            const bgmSl = document.getElementById('bgm-slider');
            const sfxSl = document.getElementById('sfx-slider');
            const dynSl = document.getElementById('dyn-slider');
            if (bgmSl) bgmSl.value = volBGM;
            if (sfxSl) sfxSl.value = volSFX;
            if (dynSl) dynSl.value = volDyn;

            const setRes = document.getElementById('set-res');
            const setShad = document.getElementById('set-shadows');
            const setVol = document.getElementById('set-volumetrics');
            const setBloom = document.getElementById('set-bloom');
            const setSSAO = document.getElementById('set-ssao');
            const setFXAA = document.getElementById('set-fxaa');
            const setSSR = document.getElementById('set-ssr');
            const setPart = document.getElementById('set-particles');

            if (setRes) setRes.value = gfx.res;
            if (setShad) setShad.value = gfx.shadows;
            if (setVol) setVol.value = gfx.volumetrics;
            if (setBloom) setBloom.value = gfx.bloom;
            if (setSSAO) setSSAO.value = gfx.ssao;
            if (setFXAA) setFXAA.value = gfx.fxaa;
            if (setSSR) setSSR.value = gfx.ssr;
            if (setPart) setPart.value = gfx.particles;

            const vd = document.getElementById('vol-density');
            const vdv = document.getElementById('vol-density-val');
            const vr = document.getElementById('vol-radius');
            const vrv = document.getElementById('vol-radius-val');
            const vb = document.getElementById('vol-brightness');
            const vbv = document.getElementById('vol-brightness-val');

            if (vd) vd.value = volAdv.density;
            if (vdv) vdv.textContent = volAdv.density.toFixed(4);
            if (vr) vr.value = volAdv.radius;
            if (vrv) vrv.textContent = volAdv.radius;
            if (vb) vb.value = volAdv.brightness;
            if (vbv) vbv.textContent = volAdv.brightness.toFixed(2);

            const sensSl = document.getElementById('sensitivity-slider');
            const sensV = document.getElementById('sens-val');
            if (data.sensitivity && sensSl && sensV) {
                sensSl.value = data.sensitivity;
                sensV.innerText = data.sensitivity.toFixed(2);
                if (controls) controls.pointerSpeed = data.sensitivity;
            }
            if (typeof syncToggleFromGfx === 'function') syncToggleFromGfx();
        } catch (e) {
            console.warn('Save data corrupted or outdated, using defaults.', e);
        }
    }
};

// =============================================================================
// SHATTER — CORE ENGINE & PROCEDURAL VEGETATION SUBSYSTEM
// PART 2 OF 6: ATMOSPHERE, SKY SYNTHESIS, POST-PROCESSING & WIND SIMULATION
// =============================================================================

// --- ATMOSPHERIC & CHAPTER ENVIRONMENT SWITCHER ---
function applyAtmosphere(chapterIdx) {
    const data = CHAPTERS[chapterIdx].env;

    // Fog & Background updates
    scene.fog.color.setHex(data.fog);
    scene.fog.density = data.density;
    morningHorizon.setHex(data.fog);

    // Dynamic Sky Map Cache Lookup & Generation
    if (skyMesh && skyMesh.material) {
        const cacheKey = data.skyStops.join('') + '_ch' + chapterIdx;
        if (!skyCache.has(cacheKey)) {
            skyCache.set(cacheKey, createSkyTexture(data.skyStops));
        }
        skyMesh.material.map = skyCache.get(cacheKey);
        skyMesh.material.needsUpdate = true;
    }

    // Directional Lighting & Solar Positions
    hemiLight.color.setHex(data.hemi);
    hemiLight.groundColor.setHex(data.ground);
    sunLight.color.setHex(data.sun);
    sunLight.intensity = data.sunInt;
    sunLight.position.set(data.sunPos[0], data.sunPos[1], data.sunPos[2]);
    sunLight.target.position.set(0, 0, 0);
    sunLight.target.updateMatrixWorld();

    // Secondary Fill Lighting
    fillLight.color.setHex(data.fill);
    fillLight.intensity = data.fillInt;
    fillLight.position.set(-data.sunPos[0], 8, -data.sunPos[2]);
}

function getLevelName(lvl) {
    const chapterNames = CHAPTER_LEVEL_NAMES[activeChapter] || CHAPTER_LEVEL_NAMES[0];
    return chapterNames[lvl] || `LEVEL ${lvl + 1}`;
}

// --- PROCEDURAL SKY & CELESTIAL CANVAS GENERATOR ---
const skyCache = new Map();

function createSkyTexture(stops) {
    const S = 2048;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true });

    const getNoise = (x, y, seed = 2024) => {
        const h = Math.imul(x, 1597334677) ^ Math.imul(y, 3812341205) ^ Math.imul(seed, 1351540027);
        return ((Math.imul(h ^ (h >>> 15), h | 1) >>> 0) / 4294967296);
    };

    let _s = 2024;
    const rng = () => {
        _s = Math.imul(1597334677, _s);
        _s = ((_s ^ (_s >>> 16)) * 1597334677) | 0;
        return (((_s ^ (_s >>> 16)) >>> 0) / 4294967296);
    };
    const setSeed = (val) => { _s = val | 0; };
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // Base Atmospheric Gradient
    const defaultStops = activeChapter === 2
        ? ['#020407', '#060910', '#0c1018', '#141020', '#1a0d1a', '#0e080e']
        : activeChapter === 1
        ? ['#010205', '#050914', '#0c152d', '#162340', '#243252', '#354568']
        : ['#040810', '#15243d', '#6c566a', '#d68962', '#e9ceb3', '#8da4b8'];
    const activeStops = stops || defaultStops;

    const bgGrad = ctx.createLinearGradient(0, 0, 0, S);
    activeStops.forEach((color, i) => {
        bgGrad.addColorStop(i / (activeStops.length - 1), color);
    });
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, S, S);

    // Anti-Banding Dither Pass
    const ditherData = ctx.getImageData(0, 0, S, S);
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const i = (y * S + x) * 4;
            const n = (getNoise(x % S, y) - 0.5) * 5.0;
            ditherData.data[i]     = clamp(ditherData.data[i]     + n, 0, 255);
            ditherData.data[i + 1] = clamp(ditherData.data[i + 1] + n, 0, 255);
            ditherData.data[i + 2] = clamp(ditherData.data[i + 2] + n, 0, 255);
        }
    }
    ctx.putImageData(ditherData, 0, 0);

    // Seamless Horizontal Toroidal Wrapping
    const wrapped = (fn, x, pad = 350) => {
        fn(x);
        if (x + pad > S) fn(x - S);
        if (x - pad < 0) fn(x + S);
    };

    // Soft Radial Celestial Blob
    const blob = (x, y, rx, ry, angle, r, g, b, alpha, blend = 'screen') => {
        if (alpha < 0.003 || rx < 0.5) return;
        ctx.save();
        ctx.globalCompositeOperation = blend;
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.scale(1, ry / Math.max(rx, 0.1));
        const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        gr.addColorStop(0,    `rgba(${r},${g},${b},${alpha})`);
        gr.addColorStop(0.42, `rgba(${r},${g},${b},${alpha * 0.40})`);
        gr.addColorStop(0.78, `rgba(${r},${g},${b},${alpha * 0.10})`);
        gr.addColorStop(1,    'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    };

    const blobW = (x, y, rx, ry, angle, r, g, b, alpha, blend = 'screen') =>
        wrapped((wx) => blob(wx, y, rx, ry, angle, r, g, b, alpha, blend), x, rx + 80);

    const cloudPuff = (cx, cy, radius, spreadY, r, g, b, aMin, aMax, bRxMin, bRxMax, ryFrac, count, blend = 'screen') => {
        for (let i = 0; i < count; i++) {
            const ang  = rng() * Math.PI * 2;
            const dist = Math.pow(rng(), 0.55) * radius;
            const px   = cx + Math.cos(ang) * dist;
            const py   = cy + Math.sin(ang) * dist * spreadY;
            const bRx  = bRxMin + rng() * (bRxMax - bRxMin);
            const bRy  = bRx * (ryFrac[0] + rng() * (ryFrac[1] - ryFrac[0]));
            const al   = aMin + rng() * (aMax - aMin);
            blobW(px, py, bRx, bRy, rng() * Math.PI, r, g, b, al, blend);
        }
    };

    // =========================================================================
    // BRANCH A: CHAPTER 3 — DEEP VOID COSMOLOGY
    // =========================================================================
    if (activeChapter === 2) {
        // Cosmic Tonal Washes
        const cosmicWashes = [
            { x: 0.15, y: 0.28, r: 680, cr: 12, cg: 8,  cb: 45, a: 0.22 },
            { x: 0.72, y: 0.60, r: 750, cr: 38, cg: 10, cb: 32, a: 0.18 },
            { x: 0.45, y: 0.82, r: 600, cr: 8,  cg: 28, cb: 55, a: 0.20 },
            { x: 0.88, y: 0.20, r: 520, cr: 30, cg: 8,  cb: 50, a: 0.16 },
            { x: 0.30, y: 0.60, r: 640, cr: 5,  cg: 18, cb: 35, a: 0.14 }
        ];
        cosmicWashes.forEach(w => {
            blobW(w.x * S, w.y * S, w.r, w.r * 0.7, rng() * Math.PI, w.cr, w.cg, w.cb, w.a, 'screen');
        });

        // Milky Way Core Structure
        const mwCurve = (t) =>
            S * 0.47
            + Math.sin(t * Math.PI * 1.8 + 0.45) * S * 0.135
            + Math.cos(t * Math.PI * 3.3 + 1.10) * S * 0.038;

        const mwPasses = [
            { n: 280, sxH: 650, syH: 310, rMin: 120, rMax: 450, aMin: 0.004, aMax: 0.010, pal: [[190, 210, 255], [225, 215, 255], [255, 228, 205]] },
            { n: 360, sxH: 300, syH: 155, rMin: 60,  rMax: 240, aMin: 0.009, aMax: 0.018, pal: [[255, 242, 215], [255, 224, 188], [212, 232, 255], [255, 215, 228]] },
            { n: 280, sxH: 130, syH: 68,  rMin: 30,  rMax: 130, aMin: 0.013, aMax: 0.030, pal: [[255, 250, 230], [255, 238, 210], [235, 244, 255]] }
        ];
        mwPasses.forEach(pass => {
            for (let i = 0; i < pass.n; i++) {
                const t = rng();
                const cy = mwCurve(t);
                const dx = (rng() - 0.5) * pass.sxH;
                const dy = (rng() - 0.5) * pass.syH;
                const rx = pass.rMin + rng() * (pass.rMax - pass.rMin);
                const ry = rx * (0.28 + rng() * 0.55);
                const al = pass.aMin + rng() * (pass.aMax - pass.aMin);
                const [cr, cg, cb] = pass.pal[Math.floor(rng() * pass.pal.length)];
                blobW(t * S + dx, cy + dy, rx, ry, rng() * Math.PI * 0.35, cr, cg, cb, al);
            }
        });

        // Procedural Emission Nebulae
        const NEBULA_TYPES = [
            { body: [[252, 55, 68], [242, 88, 58], [255, 115, 78]], outer: [[172, 28, 38], [195, 55, 38]], glow: [255, 95, 75] },
            { body: [[38, 205, 185], [55, 222, 195], [72, 195, 175]], outer: [[18, 142, 125], [28, 162, 135]], glow: [55, 215, 195] },
            { body: [[65, 125, 252], [85, 152, 252], [105, 172, 252]], outer: [[35, 75, 195], [48, 95, 205]], glow: [95, 155, 252] },
            { body: [[195, 55, 248], [175, 38, 215], [215, 75, 248]], outer: [[135, 28, 175], [155, 38, 195]], glow: [205, 75, 248] },
            { body: [[252, 155, 38], [248, 138, 55], [235, 168, 48]], outer: [[175, 88, 18], [195, 108, 28]], glow: [252, 165, 55] }
        ];

        const nebulae = Array.from({ length: 11 }, () => ({
            cx: rng() * S,
            cy: rng() * S,
            r: 160 + rng() * 360,
            rot: rng() * Math.PI * 2,
            type: NEBULA_TYPES[Math.floor(rng() * NEBULA_TYPES.length)],
            hasCore: rng() > 0.38
        }));

        nebulae.forEach(neb => {
            const { cx, cy, r, rot, type } = neb;
            for (let p = 0; p < 55; p++) {
                const a = rng() * Math.PI * 2;
                const d = Math.pow(rng(), 0.38) * r * 1.55;
                const px = cx + Math.cos(a + rot) * d;
                const py = cy + Math.sin(a + rot) * d * (0.38 + rng() * 0.38);
                const bRx = 55 + rng() * r * 0.75;
                const bRy = bRx * (0.22 + rng() * 0.62);
                const [cr, cg, cb] = type.outer[Math.floor(rng() * type.outer.length)];
                blobW(px, py, bRx, bRy, rng() * Math.PI, cr, cg, cb, 0.005 + rng() * 0.012);
            }

            for (let p = 0; p < 90; p++) {
                const a = rng() * Math.PI * 2;
                const d = Math.pow(rng(), 0.52) * r;
                const px = cx + Math.cos(a + rot) * d;
                const py = cy + Math.sin(a + rot) * d * (0.42 + rng() * 0.38);
                const bRx = 22 + rng() * r * 0.42;
                const bRy = bRx * (0.20 + rng() * 0.68);
                const [cr, cg, cb] = type.body[Math.floor(rng() * type.body.length)];
                blobW(px, py, bRx, bRy, rng() * Math.PI, cr, cg, cb, 0.008 + rng() * 0.018);
            }

            for (let p = 0; p < 28; p++) {
                const a = rng() * Math.PI * 2;
                const d = Math.pow(rng(), 0.72) * r * 0.65;
                const px = cx + Math.cos(a + rot) * d;
                const py = cy + Math.sin(a + rot) * d * 0.45;
                const bRx = 8 + rng() * r * 0.22;
                const bRy = bRx * (0.04 + rng() * 0.18);
                const [cr, cg, cb] = type.body[0];
                blobW(px, py, bRx, bRy, a + rot + (rng() - 0.5) * 0.6, cr, cg, cb, 0.016 + rng() * 0.028);
            }

            if (neb.hasCore) {
                const ox = cx + (rng() - 0.5) * r * 0.28;
                const oy = cy + (rng() - 0.5) * r * 0.18;
                const [cr, cg, cb] = type.glow;
                blobW(ox, oy, r * 0.14, r * 0.07, rng() * Math.PI, cr, cg, cb, 0.022 + rng() * 0.024);
                blobW(ox, oy, r * 0.028, r * 0.028, 0, 255, 255, 255, 0.55);
            }
        });

        // 3-Tier Multi-Layer Starfield
        for (let i = 0; i < 10000; i++) {
            const px = rng() * S, py = rng() * S;
            const r = 0.1 + rng() * 0.52;
            const al = 0.05 + rng() * 0.26;
            const col = rng() > 0.95 ? '235,240,255' : '255,255,255';
            ctx.fillStyle = `rgba(${col},${al})`;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();
        }
        for (let i = 0; i < 2200; i++) {
            const px = rng() * S, py = rng() * S;
            const r = 0.42 + rng() * 1.08;
            const al = 0.14 + rng() * 0.48;
            const t = rng();
            const col = t > 0.95 ? '255,245,235' : t > 0.90 ? '240,245,255' : '255,255,255';
            ctx.fillStyle = `rgba(${col},${al})`;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();
        }
        for (let i = 0; i < 320; i++) {
            const px = rng() * S, py = rng() * S;
            const r = 0.85 + rng() * 2.6;
            const al = 0.52 + rng() * 0.48;
            const t = rng();
            const [sr, sg, sb] = t > 0.9 ? [255, 250, 245] : t > 0.8 ? [245, 250, 255] : [255, 255, 255];
            ctx.fillStyle = `rgba(${sr},${sg},${sb},${al})`;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();
            if (r > 1.9) {
                const hg = ctx.createRadialGradient(px, py, 0, px, py, r * 4.8);
                hg.addColorStop(0, `rgba(${sr},${sg},${sb},0.10)`);
                hg.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = hg;
                ctx.beginPath();
                ctx.arc(px, py, r * 4.8, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Procedural Logarithmic Galaxies
        const drawGalaxy = (gx, gy, opts) => {
            const { scale = 1, rot = 0, tilt = 0.4, tR = 255, tG = 210, tB = 170, type = 'spiral', arms = 2 } = opts;
            ctx.save();
            ctx.translate(gx, gy);
            ctx.rotate(rot);

            const gBlob = (x, y, rx, ry, r, g, b, a, blend = 'screen') => {
                ctx.save();
                ctx.globalCompositeOperation = blend;
                const gr = ctx.createRadialGradient(x, y, 0, x, y, rx);
                gr.addColorStop(0, `rgba(${r},${g},${b},${a})`);
                gr.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = gr;
                ctx.beginPath();
                ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            };

            if (type === 'spiral') {
                gBlob(0, 0, 15 * scale, 15 * scale * tilt, 255, 230, 200, 0.6);
                gBlob(0, 0, 40 * scale, 40 * scale * tilt, tR, tG, tB, 0.15);

                for (let arm = 0; arm < arms; arm++) {
                    const armOffset = (arm / arms) * Math.PI * 2;
                    const steps = 120;
                    for (let j = 0; j < steps; j++) {
                        const t = j / steps;
                        const theta = t * 7.0 + armOffset;
                        const r = Math.pow(t, 0.7) * 90.0 * scale;
                        const px = Math.cos(theta) * r;
                        const py = Math.sin(theta) * r * tilt;
                        const size = (1.0 - t) * 25.0 * scale + 5.0;
                        gBlob(px, py, size, size, tR, tG, tB, 0.04 * (1.0 - t));

                        if (rng() > 0.92) {
                            const isPink = rng() > 0.4;
                            const kr = isPink ? 255 : 150;
                            const kg = isPink ? 150 : 200;
                            const kb = isPink ? 200 : 255;
                            gBlob(px + (rng() - 0.5) * 5, py + (rng() - 0.5) * 5, 4 * scale, 4 * scale, kr, kg, kb, 0.3);
                        }
                    }
                }
            }
            ctx.restore();
        };

        const TINTS = [
            [252, 212, 168], [202, 222, 252], [252, 188, 128], [172, 208, 252],
            [252, 218, 142], [222, 182, 252], [192, 252, 225], [252, 198, 198]
        ];
        for (let i = 0; i < 24; i++) {
            const gx = rng() * S, gy = rng() * S;
            const [tR, tG, tB] = TINTS[Math.floor(rng() * TINTS.length)];
            const opts = {
                scale: 0.28 + rng() * 2.65,
                rot: rng() * Math.PI * 2,
                tilt: 0.22 + rng() * 0.58,
                tR, tG, tB,
                type: 'spiral',
                arms: rng() > 0.42 ? 2 : 3
            };
            const galaxySeed = Math.floor(rng() * 1000000);
            wrapped((wx) => {
                setSeed(galaxySeed);
                drawGalaxy(wx, gy, opts);
            }, gx, 320);
        }

        [
            { x: 0.18, y: 0.22, r: 480, col: 'rgba(8,0,52,0.28)' },
            { x: 0.78, y: 0.62, r: 560, col: 'rgba(0,12,42,0.24)' },
            { x: 0.50, y: 0.50, r: 680, col: 'rgba(22,6,32,0.18)' },
            { x: 0.08, y: 0.82, r: 400, col: 'rgba(0,22,28,0.22)' }
        ].forEach(w => {
            wrapped((wx) => {
                ctx.globalCompositeOperation = 'multiply';
                const g = ctx.createRadialGradient(wx, w.y * S, 0, wx, w.y * S, w.r);
                g.addColorStop(0, w.col);
                g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(wx, w.y * S, w.r, 0, Math.PI * 2);
                ctx.fill();
            }, w.x * S, w.r);
        });
        ctx.globalCompositeOperation = 'screen';

    // =========================================================================
    // BRANCH B: CHAPTER 2 — STRATOSPHERIC TWILIGHT & AURORAE
    // =========================================================================
    } else if (activeChapter === 1) {
        const twilightWashes = [
            { x: 0.2, y: 0.6,  r: 600, cr: 40, cg: 90,  cb: 150, a: 0.15 },
            { x: 0.8, y: 0.65, r: 700, cr: 60, cg: 40, cb: 120, a: 0.12 },
            { x: 0.5, y: 0.7,  r: 800, cr: 50, cg: 120, cb: 180, a: 0.18 }
        ];
        twilightWashes.forEach(w => {
            blobW(w.x * S, w.y * S, w.r, w.r * 0.4, 0, w.cr, w.cg, w.cb, w.a, 'screen');
        });

        for (let i = 0; i < 4500; i++) {
            const px = rng() * S, py = rng() * S;
            const fade = Math.pow(Math.max(0, 1.0 - (py / S)), 1.5);
            const al = (0.05 + rng() * 0.45) * fade;
            if (al < 0.02) continue;
            const r = 0.2 + rng() * 0.9;
            const col = rng() > 0.85 ? '255,245,235' : '235,245,255';
            ctx.fillStyle = `rgba(${col},${al})`;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalCompositeOperation = 'screen';
        for (let p = 0; p < 3; p++) {
            const freq1 = Math.floor(2 + rng() * 2);
            const freq2 = Math.floor(3 + rng() * 3);
            const phase1 = rng() * Math.PI * 2;
            const phase2 = rng() * Math.PI * 2;
            const [cr, cg, cb] = p === 0 ? [55, 230, 160] : p === 1 ? [40, 160, 240] : [160, 60, 220];
            const baseY = S * (0.35 + p * 0.1);
            const amp = S * 0.08;
            const segments = 180;

            for (let i = 0; i < segments; i++) {
                const t = i / segments;
                const x = t * S;
                const wave = Math.sin(t * Math.PI * 2 * freq1 + phase1) +
                             Math.sin(t * Math.PI * 2 * freq2 + phase2) * 0.4;
                const y = baseY + wave * amp;
                const rx = (S / segments) * 1.5;
                const ry = 120 + rng() * 180;
                const al = 0.015 + rng() * 0.02;
                blobW(x, y, rx, ry, 0, cr, cg, cb, al, 'screen');
                if (rng() > 0.3) {
                    blobW(x, y + ry * 0.4, rx * 0.8, ry * 0.15, 0, cr, cg, cb, al * 1.5, 'screen');
                }
            }
        }

        const nlcY = S * 0.68;
        for (let i = 0; i < 220; i++) {
            const cx = rng() * S;
            const cy = nlcY + (rng() - 0.5) * S * 0.18;
            const rx = 60 + rng() * 300;
            const ry = rx * (0.008 + rng() * 0.022);
            const ang = (rng() - 0.5) * 0.08;
            const al = 0.012 + rng() * 0.025;
            const [cr, cg, cb] = rng() > 0.4 ? [180, 225, 255] : [220, 235, 255];
            blobW(cx, cy, rx, ry, ang, cr, cg, cb, al, 'screen');
        }

        const hGrad = ctx.createLinearGradient(0, S * 0.55, 0, S);
        hGrad.addColorStop(0, 'rgba(120,180,255,0)');
        hGrad.addColorStop(0.3, 'rgba(80,150,220,0.06)');
        hGrad.addColorStop(0.7, 'rgba(40,100,180,0.15)');
        hGrad.addColorStop(1, 'rgba(15,45,95,0.25)');
        ctx.fillStyle = hGrad;
        ctx.fillRect(0, S * 0.55, S, S * 0.45);

    // =========================================================================
    // BRANCH C: CHAPTER 1 — ATMOSPHERIC DAYLIGHT & CUMULUS
    // =========================================================================
    } else {
        for (let i = 0; i < 7; i++) {
            const hy = rng() * S * 0.38;
            const hx = rng() * S;
            const hr = 280 + rng() * 580;
            const al = 0.018 + rng() * 0.032;
            const t = rng();
            const [cr, cg, cb] = t > 0.58 ? [175, 198, 238] : t > 0.28 ? [218, 198, 238] : [238, 218, 208];
            blobW(hx, hy, hr, hr * 0.15, 0, cr, cg, cb, al, 'screen');
        }

        for (let i = 0; i < 445; i++) {
            const px = rng() * S;
            const py = rng() * S * 0.50;
            const fade = Math.pow(1.0 - py / (S * 0.50), 2.8);
            const al = fade * (0.06 + rng() * 0.52);
            if (al < 0.045) continue;
            const r = 0.28 + rng() * 1.05;
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = `rgba(222,235,255,${al})`;
            ctx.beginPath();
            ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fill();
        }

        const cirrusY = S * (0.28 + rng() * 0.10);
        for (let i = 0; i < 145; i++) {
            const cx = rng() * S;
            const cy = cirrusY + (rng() - 0.5) * S * 0.11;
            const rx = 55 + rng() * 295;
            const ry = rx * (0.025 + rng() * 0.095);
            const ang = (rng() - 0.5) * 0.38;
            const al = 0.014 + rng() * 0.026;
            const t = rng();
            const [cr, cg, cb] = t > 0.5 ? [212, 202, 228] : [228, 218, 238];
            blobW(cx, cy, rx, ry, ang, cr, cg, cb, al, 'screen');
        }

        const altoY = S * (0.37 + rng() * 0.06);
        for (let i = 0; i < 20; i++) {
            const clx = rng() * S;
            const cly = altoY + (rng() - 0.5) * S * 0.06;
            const clR = 48 + rng() * 92;
            for (let p = 0; p < 18; p++) {
                const ang = rng() * Math.PI * 2;
                const dist = Math.pow(rng(), 0.58) * clR;
                const px = clx + Math.cos(ang) * dist;
                const py = cly + Math.sin(ang) * dist * 0.22;
                const rx = 20 + rng() * 48;
                const ry = rx * (0.32 + rng() * 0.32);
                const al = 0.022 + rng() * 0.032;
                const [cr, cg, cb] = rng() > 0.5 ? [198, 182, 208] : [208, 192, 218];
                blobW(px, py, rx, ry, rng() * Math.PI, cr, cg, cb, al, 'screen');
            }
        }

        const clusters = [];
        for (let i = 0; i < 30; i++) {
            clusters.push({
                x: rng() * S,
                y: (0.40 + rng() * 0.30) * S,
                r: 138 + rng() * 215,
                depth: rng()
            });
        }
        clusters.sort((a, b) => a.depth - b.depth);

        clusters.forEach(cl => {
            const ds = 0.48 + cl.depth * 0.52;
            const cnt = Math.floor(55 * ds) + 18;
            const by = cl.y;
            cloudPuff(cl.x, by + 18, cl.r, 0.38, 52, 46, 68, 0.020, 0.032, 55 * ds, 52 * ds, [0.32, 0.42], Math.floor(cnt * 0.42), 'source-over');
            cloudPuff(cl.x, by, cl.r, 0.30, 188 + rng() * 18, 150 + rng() * 18, 148 + rng() * 18, 0.026, 0.036, 58 * ds, 52 * ds, [0.35, 0.44], cnt, 'source-over');
            cloudPuff(cl.x, by - 28, cl.r * 0.78, 0.20, 255, 215, 182, 0.034, 0.048, 44 * ds, 38 * ds, [0.28, 0.38], Math.floor(cnt * 0.48), 'screen');
        });

        const sunX = S * 0.72;
        const sunY = S * 0.64;
        ctx.globalCompositeOperation = 'screen';
        [[S * 0.58, 0.09], [S * 0.32, 0.08], [S * 0.17, 0.07], [S * 0.08, 0.055]].forEach(([radius, alpha]) => {
            wrapped((wx) => {
                const g = ctx.createRadialGradient(wx, sunY, 0, wx, sunY, radius);
                g.addColorStop(0,    `rgba(255,215,178,${alpha})`);
                g.addColorStop(0.28, `rgba(255,198,158,${alpha * 0.52})`);
                g.addColorStop(0.68, `rgba(238,178,138,${alpha * 0.18})`);
                g.addColorStop(1,    'rgba(0,0,0,0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(wx, sunY, radius, 0, Math.PI * 2);
                ctx.fill();
            }, sunX);
        });

        const horizGrad = ctx.createLinearGradient(0, S * 0.52, 0, S);
        horizGrad.addColorStop(0,    'rgba(255,200,158,0)');
        horizGrad.addColorStop(0.28, 'rgba(255,185,138,0.050)');
        horizGrad.addColorStop(0.72, 'rgba(238,168,128,0.030)');
        horizGrad.addColorStop(1,    'rgba(0,0,0,0)');
        ctx.fillStyle = horizGrad;
        ctx.fillRect(0, S * 0.52, S, S * 0.48);
    }

    // Polar Seam Correction (fixes UV sphere pinching artifacts)
    (function flattenPoles() {
        const featherPx = Math.round(S * 0.035);
        const img = ctx.getImageData(0, 0, S, S);
        const d = img.data;
        const averageRow = (y) => {
            let r = 0, g = 0, b = 0;
            for (let x = 0; x < S; x++) {
                const i = (y * S + x) * 4;
                r += d[i];
                g += d[i + 1];
                b += d[i + 2];
            }
            return [r / S, g / S, b / S];
        };
        const featherFrom = (yStart, dir) => {
            const avg = averageRow(yStart);
            for (let k = 0; k < featherPx; k++) {
                const y = dir > 0 ? yStart + k : yStart - k;
                if (y < 0 || y >= S) continue;
                const t = 1.0 - (k / featherPx);
                for (let x = 0; x < S; x++) {
                    const i = (y * S + x) * 4;
                    d[i]     = d[i]     * (1.0 - t) + avg[0] * t;
                    d[i + 1] = d[i + 1] * (1.0 - t) + avg[1] * t;
                    d[i + 2] = d[i + 2] * (1.0 - t) + avg[2] * t;
                }
            }
        };
        featherFrom(0, 1);
        featherFrom(S - 1, -1);
        ctx.putImageData(img, 0, 0);
    })();

    // Uniform Film Grain
    ctx.globalCompositeOperation = 'overlay';
    for (let i = 0; i < 7500; i++) {
        const nx = Math.floor(rng() * S);
        const ny = Math.floor(rng() * S);
        const ns = 0.38 + rng() * 1.25;
        const drawGrain = (tx) => {
            ctx.fillStyle = `rgba(255,255,255,${0.025 + rng() * 0.038})`;
            ctx.fillRect(tx, ny, ns, ns);
        };
        drawGrain(nx);
        if (nx + ns > S) drawGrain(nx - S);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,0.055)';
    for (let i = 0; i < 3000; i++) {
        ctx.fillRect(rng() * S, rng() * S, 1, 1);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    return tex;
}

const skyGeo = new THREE.SphereGeometry(450, 32, 32);
const skyMesh = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({
    map: createSkyTexture(CHAPTERS[0].env.skyStops),
    side: THREE.BackSide,
    fog: false,
    toneMapped: false
}));
scene.add(skyMesh);

// --- PROCEDURAL WATER NORMAL TEXTURE PIPELINE ---
function createWaterNormalTexture({ size = 256, strength = 6 } = {}) {
    const TWO_PI = Math.PI * 2;
    const waves = [
        { fx: 3,  fy: 2,  w: 0.45, phase: 0.00 },
        { fx: 2,  fy: -4, w: 0.30, phase: 1.10 },
        { fx: 7,  fy: 5,  w: 0.14, phase: 0.60 },
        { fx: -6, fy: 8,  w: 0.10, phase: 2.20 },
        { fx: 5,  fy: -3, w: 0.08, phase: 1.80 },
        { fx: 13, fy: 11, w: 0.04, phase: 0.40 },
        { fx: -9, fy: 14, w: 0.03, phase: 3.00 },
        { fx: 11, fy: -7, w: 0.02, phase: 1.50 }
    ];

    function heightAt(u, v) {
        let h = 0;
        for (let i = 0; i < waves.length; i++) {
            const wv = waves[i];
            h += Math.sin(u * TWO_PI * wv.fx + v * TWO_PI * wv.fy + wv.phase) * wv.w;
        }
        return h;
    }

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(size, size);
    const px = imageData.data;
    const inv = 1.0 / size;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = x * inv;
            const v = y * inv;

            const hL = heightAt(u - inv, v);
            const hR = heightAt(u + inv, v);
            const hD = heightAt(u, v - inv);
            const hU = heightAt(u, v + inv);

            const nx = -(hR - hL) * strength;
            const ny = -(hU - hD) * strength;
            const nz = 4.0;

            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            const rnx = nx / len;
            const rny = ny / len;
            const rnz = nz / len;

            const i = (y * size + x) * 4;
            px[i]     = (rnx * 0.5 + 0.5) * 255 | 0;
            px[i + 1] = (rny * 0.5 + 0.5) * 255 | 0;
            px[i + 2] = (rnz * 0.5 + 0.5) * 255 | 0;
            px[i + 3] = 255;
        }
    }

    ctx.putImageData(imageData, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
}

const waterNormalTex = createWaterNormalTexture();

// --- POST-PROCESSING RENDER PASSES & EFFECT COMPOSER ---
const renderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    samples: 0
});

const depthCaptureTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight);
depthCaptureTarget.depthTexture = new THREE.DepthTexture(window.innerWidth, window.innerHeight);
depthCaptureTarget.depthTexture.type = THREE.UnsignedIntType;
const depthTexture = depthCaptureTarget.depthTexture;

const composer = new EffectComposer(renderer, renderTarget);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
ssaoPass.kernelRadius = 1.2;
ssaoPass.minDistance = 0.001;
ssaoPass.maxDistance = 0.025;

// Shader patching for SSAOPass: converts texture2D to textureLod for ANGLE compatibility
(function patchSSAOBias(pass) {
    const fix = (mat) => {
        if (!mat || !mat.fragmentShader) return;
        mat.fragmentShader = mat.fragmentShader.replace(
            /texture2D\s*\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*-\s*100\.0\s*\)/g,
            'textureLod($1, $2, 0.0)'
        );
        mat.needsUpdate = true;
    };
    ['ssaoMaterial', 'normalMaterial', 'blurMaterial', 'depthRenderMaterial'].forEach(k => fix(pass[k]));
})(ssaoPass);

// SSAO Layer Mask: restricts normal/depth gathering to base geometry (skips decals and high-frequency grass)
(function patchSSAOLayers(pass) {
    const _origRender = pass.render.bind(pass);
    pass.render = function(rendererInstance, writeBuffer, readBuffer, deltaTime, maskActive) {
        const savedMask = this.camera.layers.mask;
        this.camera.layers.set(0); // Only sample base geometry for ambient occlusion
        _origRender(rendererInstance, writeBuffer, readBuffer, deltaTime, maskActive);
        this.camera.layers.mask = savedMask; // Restore full layer mask
    };
})(ssaoPass);

composer.addPass(ssaoPass);

const ssrPass = new OptimizedSSRPass(scene, camera, window.innerWidth, window.innerHeight);
ssrPass.maxSteps = 64;
ssrPass.thickness = 0.5;
ssrPass.maxDistance = 90.0;
ssrPass.opacity = 1.0;
ssrPass.setSize(window.innerWidth, window.innerHeight);
composer.addPass(ssrPass);

// Volumetric Point & Directional Light Ray Marcher Shader
const VolumetricShader = {
    uniforms: {
        tDiffuse:         { value: null },
        tDepth:           { value: null },
        cameraNear:       { value: 0.1 },
        cameraFar:        { value: 850.0 },
        invProjMatrix:    { value: new THREE.Matrix4() },
        invViewMatrix:    { value: new THREE.Matrix4() },
        pointLightsPos:   { value: pointPosUniformArray },
        pointLightsColor: { value: pointColUniformArray },
        pointLightCount:  { value: 0 },
        sunDirection:     { value: new THREE.Vector3(0.3, 0.8, -0.5).normalize() },
        sunColor:         { value: new THREE.Vector3(1.0, 0.95, 0.85) },
        sunIntensity:     { value: 0.8 },
        scattering:       { value: 0.04 },
        maxDistance:      { value: 65.0 },
        volRadiusSq:      { value: 900.0 },
        volBrightness:    { value: 1.8 },
        time:             { value: 0.0 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        precision highp float;
        varying vec2 vUv;

        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float cameraNear;
        uniform float cameraFar;
        uniform mat4 invProjMatrix;
        uniform mat4 invViewMatrix;

        #define MAX_POINT_LIGHTS 16
        uniform vec3 pointLightsPos[MAX_POINT_LIGHTS];
        uniform vec3 pointLightsColor[MAX_POINT_LIGHTS];
        uniform int pointLightCount;

        uniform vec3 sunDirection;
        uniform vec3 sunColor;
        uniform float sunIntensity;

        uniform float scattering;
        uniform float maxDistance;
        uniform float volRadiusSq;
        uniform float volBrightness;
        uniform float time;

        const int STEPS = 28;

        vec3 worldPosFromDepth(vec2 uv, float depth) {
            vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
            vec4 viewPos = invProjMatrix * clip;
            viewPos /= viewPos.w;
            vec4 worldPos = invViewMatrix * viewPos;
            return worldPos.xyz;
        }

        float hash(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
        }

        void main() {
            vec4 baseColor = texture2D(tDiffuse, vUv);
            float depth = texture2D(tDepth, vUv).r;

            vec3 camWorldPos = (invViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            vec3 worldPos;
            float marchDist;

            // Fix: Do NOT abort on sky/open air; march up to maxDistance
            if (depth >= 0.9999) {
                vec4 clipFar = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
                vec4 viewFar = invProjMatrix * clipFar;
                viewFar /= viewFar.w;
                vec3 farWorldDir = normalize((invViewMatrix * viewFar).xyz - camWorldPos);
                worldPos = camWorldPos + farWorldDir * maxDistance;
                marchDist = maxDistance;
            } else {
                worldPos = worldPosFromDepth(vUv, depth);
                float rayLen = length(worldPos - camWorldPos);
                marchDist = min(rayLen, maxDistance);
            }

            vec3 rayDir = normalize(worldPos - camWorldPos);
            float stepSize = marchDist / float(STEPS);

            float dither = hash(gl_FragCoord.xy + fract(time) * 10.0);
            vec3 currentPos = camWorldPos + rayDir * (stepSize * dither);

            vec3 totalVolumetric = vec3(0.0);
            int nLights = min(pointLightCount, MAX_POINT_LIGHTS);

            // Phase function for forward Mie scattering
            float cosTheta = dot(rayDir, -sunDirection);
            float g = 0.55;
            float phaseMie = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosTheta, 1.5) * 0.07957;

            for (int i = 0; i < STEPS; i++) {
                // 1. Point Lights Accumulation
                for (int j = 0; j < MAX_POINT_LIGHTS; j++) {
                    if (j >= nLights) break;
                    vec3 toLight = pointLightsPos[j] - currentPos;
                    float distSq = dot(toLight, toLight);
                    if (distSq < volRadiusSq) {
                        float atten = clamp(1.0 - (distSq / volRadiusSq), 0.0, 1.0);
                        atten = atten * atten;
                        totalVolumetric += pointLightsColor[j] * atten * 0.15;
                    }
                }

                // 2. Directional Sun Beam Scattering
                totalVolumetric += sunColor * sunIntensity * phaseMie * 0.8;

                currentPos += rayDir * stepSize;
            }

            totalVolumetric *= scattering * stepSize * volBrightness;

            // Tone-mapping to prevent blinding blowouts
            totalVolumetric = totalVolumetric / (1.0 + totalVolumetric);

            gl_FragColor = vec4(baseColor.rgb + totalVolumetric, baseColor.a);
        }
    `
};

const volumetricPass = new ShaderPass(VolumetricShader);
volumetricPass.material.uniforms.tDepth.value = depthTexture;
composer.addPass(volumetricPass);

const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2),
    0.22,
    1.15,
    0.94
);
composer.addPass(bloomPass);

const smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
composer.addPass(smaaPass);

composer.addPass(new OutputPass());

// --- SCENE LIGHTING CONFIGURATION ---
const hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.0);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
sunLight.position.set(20, 18, -40);
sunLight.castShadow = true;
sunLight.shadow.camera.near = 0.5;
sunLight.shadow.camera.far = 160;
const shadowDist = 65;
sunLight.shadow.camera.left = -shadowDist;
sunLight.shadow.camera.right = shadowDist;
sunLight.shadow.camera.top = shadowDist;
sunLight.shadow.camera.bottom = -shadowDist;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.bias = -0.0005;
sunLight.shadow.normalBias = 0.05;
scene.add(sunLight);
scene.add(sunLight.target);

const fillLight = new THREE.DirectionalLight(0xffffff, 1.0);
scene.add(fillLight);

function addVolumetricPointLight(pos, color, intensity, range) {
    const light = new THREE.PointLight(color, intensity, range);
    light.position.copy(pos);
    scene.add(light);
    levelLights.push(light);
    return light;
}

// --- WALL LIGHT PANELS & PROCEDURAL CONES ---
const wallLightPanelGeo = new THREE.BoxGeometry(0.72, 0.72, 0.06);
const wallLightPanelMat = new THREE.MeshStandardMaterial({
    color: 0xffeebb,
    emissive: 0xffddaa,
    emissiveIntensity: 2.0,
    roughness: 0.4,
    metalness: 0.1,
    toneMapped: false
});
const wallLightPanelMesh = new THREE.InstancedMesh(wallLightPanelGeo, wallLightPanelMat, 250);
wallLightPanelMesh.castShadow = false;
wallLightPanelMesh.receiveShadow = false;
scene.add(wallLightPanelMesh);
let wallLightPanelCount = 0;

// --- ATMOSPHERIC AMBIENT DUST & SPARKS ---
const dustGeo = new THREE.BufferGeometry();
const dustPos = [];
const dustSizes = [];
for (let i = 0; i < 1400; i++) {
    dustPos.push((Math.random() - 0.5) * 160, Math.random() * 90, (Math.random() - 0.5) * 160);
    dustSizes.push(0.03 + Math.random() * 0.12);
}
dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(dustPos, 3));
dustGeo.setAttribute('size', new THREE.Float32BufferAttribute(dustSizes, 1));

const dustCanvas = document.createElement('canvas');
dustCanvas.width = dustCanvas.height = 64;
const dc = dustCanvas.getContext('2d');
const dg = dc.createRadialGradient(32, 32, 0, 32, 32, 32);
dg.addColorStop(0,   'rgba(255,248,240,1)');
dg.addColorStop(0.4, 'rgba(240,230,220,0.5)');
dg.addColorStop(1,   'rgba(220,210,200,0)');
dc.fillStyle = dg;
dc.fillRect(0, 0, 64, 64);
const dustTex = new THREE.CanvasTexture(dustCanvas);

const dustMat = new THREE.PointsMaterial({
    color: 0xfff5e8,
    size: 0.12,
    map: dustTex,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    sizeAttenuation: true,
    blending: THREE.AdditiveBlending
});
const dustMesh = new THREE.Points(dustGeo, dustMat);
dustMesh.matrixAutoUpdate = false;
scene.add(dustMesh);

const sparkGeo = new THREE.BufferGeometry();
const sparkPos = [];
for (let i = 0; i < 300; i++) {
    const r = Math.random() * 120;
    const a = Math.random() * Math.PI * 2;
    sparkPos.push(Math.cos(a) * r, 1 + Math.random() * 50, Math.sin(a) * r);
}
sparkGeo.setAttribute('position', new THREE.Float32BufferAttribute(sparkPos, 3));
const sparkMat = new THREE.PointsMaterial({
    color: 0xffeedd,
    size: 0.04,
    transparent: true,
    opacity: 0.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending
});
const sparkMesh = new THREE.Points(sparkGeo, sparkMat);
scene.add(sparkMesh);

// --- WIND SIMULATION SYSTEM ---
const windZones = [];

function createWindZone(pos, size, direction, strength = 15) {
    const zone = {
        pos: pos.clone().applyQuaternion(globalTiltThree),
        size: size,
        dir: direction.clone().applyQuaternion(globalTiltThree),
        strength: strength,
        particles: null
    };

    const pCount = Math.floor(size.x * size.y * size.z * 2);
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(pCount * 3);
    const life = new Float32Array(pCount);

    for (let i = 0; i < pCount; i++) {
        positions[i * 3]     = (Math.random() - 0.5) * size.x * 2;
        positions[i * 3 + 1] = (Math.random() - 0.5) * size.y * 2;
        positions[i * 3 + 2] = (Math.random() - 0.5) * size.z * 2;
        life[i] = Math.random();
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('life', new THREE.BufferAttribute(life, 1));

    const mat = new THREE.PointsMaterial({
        color: 0xccddee,
        size: 0.05,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    zone.particles = new THREE.Points(geo, mat);
    zone.particles.position.copy(zone.pos);
    zone.particles.lookAt(zone.pos.clone().add(zone.dir));

    scene.add(zone.particles);
    windZones.push(zone);
}

// --- HOLOGRAPHIC TERMINAL PROJECTIONS ---
const holograms = [];

function createHologram(text, pos) {
    const W = 1024, H = 256;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(0,10,30,0.78)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (let y = 0; y < H; y += 4) {
        ctx.fillRect(0, y, W, 2);
    }
    ctx.strokeStyle = 'rgba(0,200,255,0.08)';
    ctx.lineWidth = 1;
    for (let y = 20; y < H; y += 32) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
    }

    const borderGrad = ctx.createLinearGradient(0, 0, W, 0);
    borderGrad.addColorStop(0,   'rgba(0,255,255,0.0)');
    borderGrad.addColorStop(0.1, 'rgba(0,255,255,0.7)');
    borderGrad.addColorStop(0.9, 'rgba(0,255,255,0.7)');
    borderGrad.addColorStop(1,   'rgba(0,255,255,0.0)');
    ctx.strokeStyle = borderGrad;
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, W - 16, H - 16);

    const cornerLen = 28, cOff = 8;
    ctx.strokeStyle = 'rgba(0,255,255,0.9)';
    ctx.lineWidth = 3;
    [
        [cOff, cOff, 1, 1],
        [W - cOff, cOff, -1, 1],
        [cOff, H - cOff, 1, -1],
        [W - cOff, H - cOff, -1, -1]
    ].forEach(([x, y, dx, dy]) => {
        ctx.beginPath();
        ctx.moveTo(x + dx * cornerLen, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + dy * cornerLen);
        ctx.stroke();
    });

    ctx.font = 'bold 22px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const lines = text.split('\n');
    const lineHeight = 32;
    const startY = H / 2 - ((lines.length - 1) * lineHeight) / 2;

    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur = 40;
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = '#00ffff';
    lines.forEach((line, i) => ctx.fillText(line, W / 2, startY + i * lineHeight + 2));

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ccffff';
    lines.forEach((line, i) => ctx.fillText(line, W / 2, startY + i * lineHeight));

    let maxTw = 0;
    lines.forEach(line => { maxTw = Math.max(maxTw, ctx.measureText(line).width); });
    const tw = maxTw;

    ctx.strokeStyle = 'rgba(0,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(W / 2 - tw / 2 - 20, H / 2 - 45);
    ctx.lineTo(W / 2 + tw / 2 + 20, H / 2 - 45);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(W / 2 - tw / 2 - 20, H / 2 + 45);
    ctx.lineTo(W / 2 + tw / 2 + 20, H / 2 + 45);
    ctx.stroke();

    const tex = new THREE.CanvasTexture(canvas);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;

    const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(7.0, 1.75, 1);
    const basePos = pos.clone().applyQuaternion(globalTiltThree);
    sprite.position.copy(basePos);
    sprite.position.y -= 2.0;
    scene.add(sprite);

    const light = new THREE.PointLight(0x00ccff, 0.0, 4);
    light.position.copy(basePos);
    light.position.y -= 1.5;
    scene.add(light);

    const baseGeo = new THREE.PlaneGeometry(7.0, 0.06);
    const baseMat = new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);

    return { sprite, basePos, light, baseMesh, baseMat };
}

// =============================================================================
// SHATTER — CORE ENGINE & PROCEDURAL VEGETATION SUBSYSTEM
// PART 3 OF 6: MECHANISMS, LOGIC ENGINE, CRYSTAL SPIRES & DECAL SYNTHESIZER
// =============================================================================

// --- BRONZE GEAR & RACK MATERIALS ---
const bronzeMat = new THREE.MeshStandardMaterial({ 
    color: 0xc27a3e,
    metalness: 0.95,
    roughness: 0.32,
    envMapIntensity: 1.4
});

const darkSteelMat = new THREE.MeshStandardMaterial({ 
    color: 0x222428,
    metalness: 0.88,
    roughness: 0.55,
    envMapIntensity: 0.8
});

const polishedChromeMat = new THREE.MeshStandardMaterial({
    color: 0xdddddd,
    metalness: 0.98,
    roughness: 0.12,
    envMapIntensity: 2.0
});

// --- PROCEDURAL GEAR GENERATION SUBSYSTEM ---
const RACK_PITCH = 0.2042;
const PITCH_MODIFIER = 0.0325;

function buildGearGeo(teethCount) {
    const pitchR = teethCount * PITCH_MODIFIER;
    const outerR = pitchR + 0.065;
    const innerR = pitchR - 0.065;
    const shape = new THREE.Shape();
    const totalPoints = teethCount * 2;
    const aOffset = (Math.PI * 2) / (teethCount * 8);

    for (let i = 0; i < totalPoints; i++) {
        const isOuter = (i % 2 === 0);
        const r = isOuter ? outerR : innerR;
        const a = (i / totalPoints) * Math.PI * 2;
        const p1x = Math.cos(a - aOffset) * r;
        const p1y = Math.sin(a - aOffset) * r;
        const p2x = Math.cos(a + aOffset) * r;
        const p2y = Math.sin(a + aOffset) * r;

        if (i === 0) {
            shape.moveTo(p1x, p1y);
            shape.lineTo(p2x, p2y);
        } else {
            shape.lineTo(p1x, p1y);
            shape.lineTo(p2x, p2y);
        }
    }
    shape.closePath();

    // Central axle hole with keyway slot
    const axleR = Math.max(0.08, pitchR * 0.28);
    const axleHole = new THREE.Path();
    axleHole.absarc(0, 0, axleR, 0, Math.PI * 2, true);
    
    // Keyway notch cutout for industrial mechanical realism
    const kwW = axleR * 0.35;
    const kwH = axleR * 0.45;
    const keywayPath = new THREE.Path();
    keywayPath.moveTo(-kwW * 0.5, axleR * 0.7);
    keywayPath.lineTo(kwW * 0.5, axleR * 0.7);
    keywayPath.lineTo(kwW * 0.5, axleR + kwH);
    keywayPath.lineTo(-kwW * 0.5, axleR + kwH);
    keywayPath.closePath();
    shape.holes.push(axleHole);
    shape.holes.push(keywayPath);

    // Decorative weight-reducing circular cutouts on larger gears
    if (teethCount >= 12) {
        const cutoutCount = teethCount >= 16 ? 5 : 3;
        const cutoutR = pitchR * 0.18;
        const ringDist = pitchR * 0.62;
        for (let k = 0; k < cutoutCount; k++) {
            const cutoutAngle = (k / cutoutCount) * Math.PI * 2;
            const cx = Math.cos(cutoutAngle) * ringDist;
            const cy = Math.sin(cutoutAngle) * ringDist;
            const weightHole = new THREE.Path();
            weightHole.absarc(cx, cy, cutoutR, 0, Math.PI * 2, true);
            shape.holes.push(weightHole);
        }
    }

    const geo = new THREE.ExtrudeGeometry(shape, { 
        depth: 0.16,
        bevelEnabled: true,
        bevelSize: 0.015,
        bevelThickness: 0.02,
        curveSegments: 12
    });
    geo.center();
    return { geo, pitchR };
}

const gearXS = buildGearGeo(8);
const gearS  = buildGearGeo(10);
const gearM  = buildGearGeo(14);
const gearL  = buildGearGeo(18);

// --- PRESSURE PLATE WITH ROTATING GEAR TRAIN ---
const activePlates = [];

function createPressurePlate(data) {
    const group = new THREE.Group();
    const pos = new THREE.Vector3(data.x, data.y, data.z).applyQuaternion(globalTiltThree);
    group.position.copy(pos);
    group.quaternion.copy(globalTiltThree);

    const baseGroup = new THREE.Group();
    group.add(baseGroup);

    // Heavy housing base collar
    const centralCollar = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.62, 1.48), darkSteelMat);
    centralCollar.position.y = 0.31;
    centralCollar.castShadow = true;
    centralCollar.receiveShadow = true;
    baseGroup.add(centralCollar);

    const floorRim = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.1, 2.1), darkSteelMat);
    floorRim.position.y = 0.05;
    floorRim.receiveShadow = true;
    baseGroup.add(floorRim);

    // Mounting bolts on collar corners
    const boltGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.1, 6);
    const boltMat = polishedChromeMat;
    const boltOffsets = [
        [-0.65, 0.62, -0.65], [0.65, 0.62, -0.65],
        [-0.65, 0.62, 0.65],  [0.65, 0.62, 0.65]
    ];
    boltOffsets.forEach(([bx, by, bz]) => {
        const bolt = new THREE.Mesh(boltGeo, boltMat);
        bolt.position.set(bx, by, bz);
        baseGroup.add(bolt);
    });

    // Four differential meshing gears with axles
    const gears = [];
    const axleGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.62, 12);
    axleGeo.rotateX(Math.PI / 2);

    const gearConfigs = [
        { type: gearS,  axis: 'z', offset: [0.5 + gearS.pitchR, 0],   ry: 0,         dir: 1 },
        { type: gearL,  axis: 'z', offset: [-0.5 - gearL.pitchR, 0],  ry: 0,         dir: -1 },
        { type: gearM,  axis: 'x', offset: [0, 0.5 + gearM.pitchR],   ry: Math.PI/2, dir: 1 },
        { type: gearXS, axis: 'x', offset: [0, -0.5 - gearXS.pitchR], ry: Math.PI/2, dir: -1 }
    ];

    gearConfigs.forEach((cfg) => {
        const gMesh = new THREE.Mesh(cfg.type.geo, bronzeMat);
        gMesh.position.set(cfg.offset[0], 0.6, cfg.offset[1]);
        gMesh.rotation.y = cfg.ry;
        gMesh.castShadow = true;
        baseGroup.add(gMesh);

        const axle = new THREE.Mesh(axleGeo, darkSteelMat);
        axle.position.copy(gMesh.position);
        axle.rotation.y = cfg.ry;
        baseGroup.add(axle);

        const toothOffset = (Math.PI * 2) / (cfg.type.pitchR * 40);

        gears.push({ 
            mesh: gMesh, 
            axis: cfg.axis, 
            dir: cfg.dir, 
            pitchR: cfg.type.pitchR,
            baseAngle: toothOffset 
        });
    });

    // Moving piston, toothed vertical rack column, and capture cradle
    const movingGroup = new THREE.Group();
    movingGroup.position.y = 1.4;
    group.add(movingGroup);

    const topCap = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.22, 2.45), darkSteelMat);
    topCap.castShadow = true;
    topCap.receiveShadow = true;
    movingGroup.add(topCap);

    const capBevel = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 2.2), darkSteelMat);
    capBevel.position.y = -0.12;
    movingGroup.add(capBevel);

    const pillarGeo = new THREE.BoxGeometry(1.0, 1.8, 1.0);
    const pillar = new THREE.Mesh(pillarGeo, wallMaterial);
    pillar.position.y = -0.9;
    pillar.castShadow = true;
    movingGroup.add(pillar);

    // Lateral gear rack teeth ribs
    const ribGeo = new THREE.BoxGeometry(1.16, 0.082, 1.16);
    for (let y = -1.8; y <= 0.0; y += RACK_PITCH) {
        const rib = new THREE.Mesh(ribGeo, darkSteelMat);
        rib.position.y = y;
        movingGroup.add(rib);
    }

    // Energy Absorption Lens & Internal Emitter Core
    const lensGeo = new THREE.BoxGeometry(1.85, 0.16, 1.85);
    const lensMat = new THREE.MeshPhysicalMaterial({
        color: 0x111620,
        emissive: 0x000000,
        transparent: true,
        opacity: 0.65, 
        roughness: 0.08,
        metalness: 0.85,
        clearcoat: 1.0,
        clearcoatRoughness: 0.1
    });

    const lens = new THREE.Mesh(lensGeo, lensMat);
    lens.position.y = 0.12;
    movingGroup.add(lens);

    const coreGeo = new THREE.BoxGeometry(0.85, 1.45, 0.85);
    const coreMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.0,
        blending: THREE.AdditiveBlending
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.y = -0.7;
    movingGroup.add(core);

    const pLight = new THREE.PointLight(0xffffff, 0, 8);
    pLight.position.y = 1.0;
    movingGroup.add(pLight);

    // Cannon-es kinematic collider for the sinking piston cap
    const body = new CANNON.Body({
        mass: 0,
        type: CANNON.Body.KINEMATIC,
        shape: new CANNON.Box(new CANNON.Vec3(0.88, 0.12, 0.88)),
        collisionFilterGroup: CG_STATIC,
        collisionFilterMask: CG_DYNAMIC | CG_PLAYER
    });
    body.position.set(pos.x, pos.y + 1.4, pos.z);
    body.quaternion.set(globalTiltThree.x, globalTiltThree.y, globalTiltThree.z, globalTiltThree.w);
    world.addBody(body);
    levelBodies.push(body);

    scene.add(group);
    levelMeshes.push(group);

    activePlates.push({
        group: movingGroup,
        body: body,
        basePos: pos,
        gears: gears,
        lensMat: lensMat,
        coreMat: coreMat,
        light: pLight,
        channel: data.channel,
        progress: 0.0
    });
}

// --- SLIDING INDUSTRIAL GLASS GATES ---
const activeDoors = [];

function createGlassDoor(data) {
    const group = new THREE.Group();
    const basePos = new THREE.Vector3(data.x, data.y, data.z).applyQuaternion(globalTiltThree);
    group.position.copy(basePos);

    if (data.normal) {
        const n = new THREE.Vector3(data.normal.x, data.normal.y, data.normal.z).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
        group.quaternion.copy(q);
    }
    group.quaternion.premultiply(globalTiltThree);

    const w = data.width || 3;
    const h = data.height || 3;
    const dist = data.moveDist || 2.8;

    // Structural steel framework
    const frameThickness = 0.22;
    const frameDepth = 0.32;
    const frameMat = new THREE.MeshStandardMaterial({
        color: 0x181a1e,
        metalness: 0.85,
        roughness: 0.38
    });

    const frameTop = new THREE.Mesh(new THREE.BoxGeometry(w, frameThickness, frameDepth), frameMat);
    frameTop.position.y = (h / 2) - (frameThickness / 2);
    frameTop.castShadow = true;

    const frameBottom = new THREE.Mesh(new THREE.BoxGeometry(w, frameThickness, frameDepth), frameMat);
    frameBottom.position.y = -(h / 2) + (frameThickness / 2);
    frameBottom.castShadow = true;

    const sideHeight = h - (frameThickness * 2);
    const frameLeft = new THREE.Mesh(new THREE.BoxGeometry(frameThickness, sideHeight, frameDepth), frameMat);
    frameLeft.position.x = -(w / 2) + (frameThickness / 2);
    frameLeft.castShadow = true;

    const frameRight = new THREE.Mesh(new THREE.BoxGeometry(frameThickness, sideHeight, frameDepth), frameMat);
    frameRight.position.x = (w / 2) - (frameThickness / 2);
    frameRight.castShadow = true;

    group.add(frameTop, frameBottom, frameLeft, frameRight);

    // Reinforced glass central pane
    const paneW = w - (frameThickness * 2);
    const paneH = sideHeight;
    const glassGeo = new THREE.BoxGeometry(paneW, paneH, 0.05);
    const glassMat = new THREE.MeshPhysicalMaterial({ 
        color: 0x44aaff,
        emissive: 0x002244,
        transparent: true,
        opacity: 0.45,
        roughness: 0.08,
        metalness: 0.82,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        depthWrite: false
    });
    const pane = new THREE.Mesh(glassGeo, glassMat);
    group.add(pane);

    // Glowing boundary edge lines
    const edgesGeo = new THREE.EdgesGeometry(glassGeo);
    const edgesMat = new THREE.LineBasicMaterial({
        color: 0x66ccff,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending
    });
    pane.add(new THREE.LineSegments(edgesGeo, edgesMat));

    // Internal structural reinforcing mullions
    const barGeo = new THREE.BoxGeometry(paneW, 0.065, 0.16);
    const barMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.9, roughness: 0.45 });
    const bar1 = new THREE.Mesh(barGeo, barMat);
    bar1.position.y = paneH / 6;
    const bar2 = new THREE.Mesh(barGeo, barMat);
    bar2.position.y = -paneH / 6;
    group.add(bar1, bar2);

    scene.add(group);
    levelMeshes.push(group);

    // Kinematic collider body
    const body = new CANNON.Body({
        mass: 0,
        type: CANNON.Body.KINEMATIC,
        shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, 0.16)),
        collisionFilterGroup: CG_STATIC,
        collisionFilterMask: CG_PLAYER | CG_DYNAMIC
    });
    body.position.copy(basePos);
    body.quaternion.copy(group.quaternion);
    world.addBody(body);
    levelBodies.push(body);

    const moveDir = new THREE.Vector3();
    if (data.dir === 'left')  moveDir.set(-dist, 0, 0);
    if (data.dir === 'right') moveDir.set( dist, 0, 0);
    if (data.dir === 'up')    moveDir.set(0,  dist, 0);
    if (data.dir === 'down')  moveDir.set(0, -dist, 0);

    moveDir.applyQuaternion(group.quaternion);

    activeDoors.push({
        group,
        body,
        basePos,
        channel: data.channel,
        moveVector: moveDir,
        progress: 0.0
    });
}

// --- OPTICAL AERO-FILTERS & HARD-LIGHT BARRIERS ---
const activeFields = [];

function createAeroFilter(data) {
    const group = new THREE.Group();
    const pos = new THREE.Vector3(data.x, data.y, data.z).applyQuaternion(globalTiltThree);
    group.position.copy(pos);
    group.quaternion.copy(globalTiltThree);

    const w = data.w || 3;
    const h = data.h || 3;

    const frameMat = new THREE.MeshStandardMaterial({ color: 0x111418, metalness: 0.85, roughness: 0.45 });
    const frameT = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, 0.26), frameMat); frameT.position.y = h / 2;
    const frameB = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, 0.26), frameMat); frameB.position.y = -h / 2;
    const frameL = new THREE.Mesh(new THREE.BoxGeometry(0.16, h, 0.26), frameMat); frameL.position.x = -w / 2;
    const frameR = new THREE.Mesh(new THREE.BoxGeometry(0.16, h, 0.26), frameMat); frameR.position.x = w / 2;
    group.add(frameT, frameB, frameL, frameR);

    const segX = Math.round(w * 1.5);
    const segY = Math.round(h * 1.5);
    const gridGeo = new THREE.PlaneGeometry(w, h, segX, segY);

    const baseMat = new THREE.MeshBasicMaterial({ 
        color: 0x00ffff,
        transparent: true,
        opacity: 0.15, 
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide 
    });
    const baseMesh = new THREE.Mesh(gridGeo, baseMat);
    group.add(baseMesh);

    const edges = new THREE.EdgesGeometry(gridGeo);
    const lineMat = new THREE.LineBasicMaterial({ 
        color: 0x00ffff,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending 
    });
    const gridLines = new THREE.LineSegments(edges, lineMat);
    group.add(gridLines);

    if (data.normal) {
        const target = new THREE.Vector3(data.x + data.normal.x, data.y + data.normal.y, data.z + data.normal.z);
        group.lookAt(target.applyQuaternion(globalTiltThree));
    }
    scene.add(group);
    levelMeshes.push(group);

    const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, 0.25)),
        collisionFilterGroup: CG_AERO_FIELD, 
        collisionFilterMask: 0 
    });
    body.position.copy(pos);
    body.quaternion.copy(group.quaternion);
    world.addBody(body);
    levelBodies.push(body);

    activeFields.push({ 
        type: 'aero',
        group,
        body,
        channel: data.channel,
        active: false,
        baseMesh,
        gridLines
    });
}

function createOneWayField(data) {
    const group = new THREE.Group();
    const pos = new THREE.Vector3(data.x, data.y, data.z).applyQuaternion(globalTiltThree);
    group.position.copy(pos);
    group.quaternion.copy(globalTiltThree);

    const w = data.w || 3;
    const h = data.h || 3;

    const frameMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.9, roughness: 0.3 });
    const frameT = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, 0.2), frameMat); frameT.position.y = h / 2;
    const frameB = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, 0.2), frameMat); frameB.position.y = -h / 2;
    group.add(frameT, frameB);

    const shieldMat = new THREE.MeshBasicMaterial({ 
        color: 0xffaa00,
        transparent: true,
        opacity: 0.25, 
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide 
    });
    const shieldMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), shieldMat);
    group.add(shieldMesh);

    const arrowGroup = new THREE.Group();
    const shaftGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.3, 4);
    shaftGeo.rotateX(Math.PI / 2);
    const headGeo = new THREE.ConeGeometry(0.08, 0.15, 4);
    headGeo.rotateX(Math.PI / 2);
    headGeo.translate(0, 0, 0.15);

    const arrowMat = new THREE.MeshBasicMaterial({
        color: 0xffaa00,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending
    });

    const stepX = w / 3;
    const stepY = h / 3;
    for (let ax = -w / 2 + stepX / 2; ax < w / 2; ax += stepX) {
        for (let ay = -h / 2 + stepY / 2; ay < h / 2; ay += stepY) {
            const shaft = new THREE.Mesh(shaftGeo, arrowMat);
            const head = new THREE.Mesh(headGeo, arrowMat);
            shaft.position.set(ax, ay, 0);
            head.position.set(ax, ay, 0);
            arrowGroup.add(shaft, head);
        }
    }

    if (data.inverted) arrowGroup.rotation.y = Math.PI;
    group.add(arrowGroup);

    if (data.normal) {
        const target = new THREE.Vector3(data.x + data.normal.x, data.y + data.normal.y, data.z + data.normal.z);
        group.lookAt(target.applyQuaternion(globalTiltThree));
    }
    scene.add(group);
    levelMeshes.push(group);

    const body = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, 0.05)),
        collisionFilterGroup: CG_STATIC,
        collisionFilterMask: CG_PLAYER | CG_DYNAMIC
    });
    body.position.copy(pos);
    body.quaternion.copy(group.quaternion); 
    world.addBody(body);
    levelBodies.push(body);

    activeFields.push({ 
        type: 'oneway',
        group,
        body,
        shieldMesh,
        arrowGroup,
        channel: data.channel,
        inverted: data.inverted || false,
        active: true 
    });
}

// --- DYNAMIC PHYSICS ROPES ---
const dynamicRopes = [];
const sharedRopeGeo = new THREE.CylinderGeometry(0.04, 0.04, 1, 6);
sharedRopeGeo.rotateX(Math.PI / 2);
const sharedRopeMat = new THREE.MeshStandardMaterial({
    color: 0x181818,
    roughness: 0.92,
    metalness: 0.12
});

function createRope(data) {
    const { p1, p2, segments } = data;
    const bodies = [];
    const segMeshes = [];
    const start = new THREE.Vector3(p1.x, p1.y, p1.z).applyQuaternion(globalTiltThree);
    const end = new THREE.Vector3(p2.x, p2.y, p2.z).applyQuaternion(globalTiltThree);
    const segLen = start.distanceTo(end) / segments;

    for (let i = 0; i <= segments; i++) {
        const pos = new THREE.Vector3().lerpVectors(start, end, i / segments);
        const body = new CANNON.Body({
            mass: (i === 0 || i === segments) ? 0 : 0.85,
            shape: new CANNON.Sphere(0.1),
            position: new CANNON.Vec3(pos.x, pos.y, pos.z),
            linearDamping: 0.55,
            angularDamping: 0.55,
            collisionFilterGroup: CG_ROPE,
            collisionFilterMask: CG_STATIC | CG_DYNAMIC | CG_PLAYER
        });
        world.addBody(body);
        bodies.push(body);
        levelBodies.push(body);

        if (i > 0) {
            const constraint = new CANNON.DistanceConstraint(bodies[i - 1], bodies[i], segLen);
            world.addConstraint(constraint);
            levelConstraints.push(constraint);

            const mesh = new THREE.Mesh(sharedRopeGeo, sharedRopeMat);
            scene.add(mesh);
            segMeshes.push(mesh);
            levelMeshes.push(mesh);
        }
    }
    dynamicRopes.push({ bodies, segmentMeshes: segMeshes });
}

// --- MULTI-PASS BOOLEAN LOGIC SOLVER ---
const logicNodes = {
    inputs: new Array(10).fill(false),
    resolved: new Array(10).fill(false),
    configs: {}
};

function resolveLogic() {
    for (let i = 1; i <= 9; i++) {
        logicNodes.resolved[i] = logicNodes.inputs[i];
    }

    // Three iterative passes to allow signal cascading across multi-stage circuits
    for (let pass = 0; pass < 3; pass++) {
        for (const ch in logicNodes.configs) {
            const cfg = logicNodes.configs[ch];
            const chIdx = parseInt(ch, 10);
            const ops = cfg.operands || cfg.sources || [];
            const srcA = ops[0] !== undefined ? ops[0] : cfg.source;
            const srcB = ops[1];

            switch (cfg.type) {
                case 'NOT':
                    logicNodes.resolved[chIdx] = !logicNodes.resolved[srcA];
                    break;
                case 'AND':
                    logicNodes.resolved[chIdx] = !!(logicNodes.resolved[srcA] && logicNodes.resolved[srcB]);
                    break;
                case 'OR':
                    logicNodes.resolved[chIdx] = !!(logicNodes.resolved[srcA] || logicNodes.resolved[srcB]);
                    break;
                case 'XOR':
                    logicNodes.resolved[chIdx] = !!(logicNodes.resolved[srcA] !== logicNodes.resolved[srcB]);
                    break;
                case 'NAND':
                    logicNodes.resolved[chIdx] = !(logicNodes.resolved[srcA] && logicNodes.resolved[srcB]);
                    break;
                case 'NOR':
                    logicNodes.resolved[chIdx] = !(logicNodes.resolved[srcA] || logicNodes.resolved[srcB]);
                    break;
            }
        }
    }
}

// --- MEGA CRYSTAL SPIRE SUBTERRANEAN GENERATOR ---
const bgGroup = new THREE.Group();
scene.add(bgGroup);

function createProceduralCrystalTexture() {
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);

    // Sharp internal stress fractures across anisotropic axes
    for (let i = 0; i < 220; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const length = 60 + Math.random() * 320;
        const angle = Math.random() * Math.PI * 2;
        
        const x2 = x + Math.cos(angle) * length;
        const y2 = y + Math.sin(angle) * length;

        const grad = ctx.createLinearGradient(x, y, x2, y2);
        const intensity = Math.random();
        grad.addColorStop(0, `rgba(255, 255, 255, ${intensity * 0.55})`);
        grad.addColorStop(0.5, 'rgba(128, 128, 128, 0.1)');
        grad.addColorStop(1, `rgba(0, 0, 0, ${intensity * 0.55})`);
        
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x + (Math.random() - 0.5) * length * 0.4, y + (Math.random() - 0.5) * length * 0.4);
        ctx.fill();
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 4);
    return texture;
}

function createCrystalStructure(pos, spreadRadius, clusterCount, crystalsPerCluster, hueCenter, hueRange, options) {
    const opts = Object.assign({
        mainHeightMin: 110, mainHeightMax: 360,
        sideHeightMin: 35,  sideHeightMax: 110,
        thicknessMin: 60,   thicknessMax: 78,
        depthVariance: 20,
        tiltMain: 0.22,
        tiltSide: 0.65
    }, options);

    const crystalTexture = createProceduralCrystalTexture();
    const crystalGeo = new THREE.CylinderGeometry(0, 0.5, 1, 6);
    crystalGeo.translate(0, 0.5, 0);

    const crystalMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        flatShading: true,
        transparent: true,
        opacity: 0.55,
        ior: 2.24,
        thickness: 16.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        metalness: 0.08,
        roughness: 0.18,
        roughnessMap: crystalTexture
    });

    const totalInstances = clusterCount * crystalsPerCluster;
    const mesh = new THREE.InstancedMesh(crystalGeo, crystalMat, totalInstances);
    mesh.userData.mega = true;

    const _d = new THREE.Object3D();
    const _col = new THREE.Color();
    let idx = 0;

    for (let c = 0; c < clusterCount; c++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = spreadRadius * (0.2 + Math.random() * 0.8);
        const cx = pos.x + Math.cos(angle) * dist;
        const cz = pos.z + Math.sin(angle) * dist;
        const cy = pos.y - Math.random() * opts.depthVariance;
        const clusterHue = hueCenter + (Math.random() - 0.5) * hueRange;

        for (let i = 0; i < crystalsPerCluster; i++) {
            _d.position.set(cx, cy, cz);
            _d.rotation.set(0, 0, 0);

            const isMain = (i === 0);
            if (isMain) {
                _d.rotateX((Math.random() - 0.5) * opts.tiltMain);
                _d.rotateZ((Math.random() - 0.5) * opts.tiltMain);
            } else {
                const tiltDir = Math.random() * Math.PI * 2;
                const tiltAmt = (opts.tiltSide * 0.5) + Math.random() * (opts.tiltSide * 0.5);
                _d.rotation.y = tiltDir;
                _d.rotateZ(tiltAmt);
            }
            _d.rotateY(Math.random() * Math.PI * 2);

            const thickness = opts.thicknessMin + Math.random() * (opts.thicknessMax - opts.thicknessMin);
            const height = isMain
                ? opts.mainHeightMin + Math.random() * (opts.mainHeightMax - opts.mainHeightMin)
                : opts.sideHeightMin + Math.random() * (opts.sideHeightMax - opts.sideHeightMin);

            _d.scale.set(thickness, height, thickness);
            _d.updateMatrix();
            mesh.setMatrixAt(idx, _d.matrix);

            const hue = clusterHue + (Math.random() - 0.5) * 0.06;
            const saturation = 0.65 + Math.random() * 0.35;
            const lightness = 0.42 + Math.random() * 0.38;
            _col.setHSL(hue, saturation, lightness);
            mesh.setColorAt(idx, _col);

            idx++;
        }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
}

function createMegaStructures() {
    const toRemove = [];
    bgGroup.children.forEach(obj => {
        if (obj.userData && obj.userData.mega) toRemove.push(obj);
    });
    
    toRemove.forEach(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            if (obj.material.roughnessMap) obj.material.roughnessMap.dispose();
            obj.material.dispose();
        }
        bgGroup.remove(obj);
    });

    const megaMesh = createCrystalStructure(
        new THREE.Vector3(0, -65, 0),
        420,
        75,
        8,
        0.54,
        0.36,
        {
            mainHeightMin: 100, mainHeightMax: 350,
            sideHeightMin: 30,  sideHeightMax: 100,
            thicknessMin: 60,   thicknessMax: 76,
            depthVariance: 20,
            tiltMain: 0.2,
            tiltSide: 0.62
        }
    );
    bgGroup.add(megaMesh);
}

// --- LEVEL EXIT / GOAL CONSTRUCT ---
function createGoal(x, y, z, isLocked) {
    const goalGroup = new THREE.Group();
    goalGroup.position.set(x, y, z);
    const col = isLocked ? 0xff2222 : 0x00ffff;

    const coreGeo = new THREE.OctahedronGeometry(0.28);
    const core = new THREE.Mesh(coreGeo, new THREE.MeshPhysicalMaterial({ 
        color: col,
        emissive: col,
        emissiveIntensity: 3.2,
        toneMapped: false,
        roughness: 0.1,
        metalness: 0.85,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05
    }));

    const shellGeo = new THREE.IcosahedronGeometry(0.48, 1);
    const shellMat = new THREE.MeshBasicMaterial({
        color: col,
        wireframe: true,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending
    });
    const shell = new THREE.Mesh(shellGeo, shellMat);

    core.add(shell);
    goalGroup.add(core);

    const goalLight = new THREE.PointLight(col, 2.0, 7.0);
    goalGroup.add(goalLight);

    goalGroup.userData.core = core;
    goalGroup.userData.shell = shell;
    goalGroup.userData.light = goalLight;
    goalGroup.userData.isLocked = isLocked || false;

    return goalGroup;
}

// =============================================================================
// HIGH-FIDELITY PROCEDURAL DECAL SYSTEM (PUDDLES, MOSS & WALL SEEPAGE)
// =============================================================================

// ── MATH & NOISE HELPERS (Self-Contained) ───────────────────────────────────
const _clamp = (v, minVal, maxVal) => Math.min(Math.max(v, minVal), maxVal);
const _mix = (x, y, a) => x * (1.0 - a) + y * a;
const _smoothstep = (edge0, edge1, x) => {
    if (edge0 === edge1) return x >= edge1 ? 1.0 : 0.0;
    const t = _clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
};

if (typeof _fbm === 'undefined') {
    var _fbm = function(noiseFn, x, y, octaves = 3, lacunarity = 2.0, gain = 0.5) {
        let sum = 0.0, amp = 1.0, freq = 1.0, max = 0.0;
        for (let i = 0; i < octaves; i++) {
            sum += noiseFn(x * freq, y * freq) * amp;
            max += amp;
            freq *= lacunarity;
            amp *= gain;
        }
        return sum / max;
    };
}

let _decalSystem = null;

function initDecalSystem() {
    if (_decalSystem) return _decalSystem;

    const S = 512;
    const H = S * 0.5;
    const noise2D = _createNoise2D(555);
    const detailNoise = _createNoise2D(888);

    const makeCtx = () => {
        const c = document.createElement('canvas');
        c.width = c.height = S;
        return { c, ctx: c.getContext('2d', { willReadFrequently: true }) };
    };

    const makeTex = (canvas, srgb = false) => {
        const t = new THREE.CanvasTexture(canvas);
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = 4;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        return t;
    };

    // ── 1. PROCEDURAL ORGANIC MOSS DECALS (FLOOR CUSHIONS & CRUSTOSE LICHEN) ─
    const buildOrganicMossDecal = (variant = 'cushion', seed = 101) => {
        const rng = _makeRng(seed);
        const { c: aC, ctx: a } = makeCtx();
        const { c: nC, ctx: n } = makeCtx();
        const { c: rC, ctx: r } = makeCtx();

        const aData = a.createImageData(S, S);
        const nData = n.createImageData(S, S);
        const rData = r.createImageData(S, S);

        const freq = variant === 'creeping' ? 0.015 : 0.022;

        for (let y = 0; y < S; y++) {
            for (let x = 0; x < S; x++) {
                const idx = (y * S + x) * 4;

                const dx = (x - H) / H;
                const dy = (y - H) / H;
                const dist = Math.sqrt(dx * dx + dy * dy);

                // Multi-octave fractal moss density
                const fbmVal = _fbm(noise2D, x * freq, y * freq, 4);
                const microN = detailNoise(x * 0.12, y * 0.12) * 0.5 + 0.5;

                const mossDensity = _clamp((1.0 - dist * 1.25) + (fbmVal - 0.45) * 1.1, 0.0, 1.0);

                if (mossDensity < 0.18) {
                    aData.data[idx + 3] = 0;
                    nData.data[idx + 0] = 128;
                    nData.data[idx + 1] = 128;
                    nData.data[idx + 2] = 255;
                    nData.data[idx + 3] = 0;
                    rData.data[idx + 0] = 255;
                    rData.data[idx + 1] = 255;
                    rData.data[idx + 2] = 255;
                    rData.data[idx + 3] = 0;
                    continue;
                }

                const alpha = _smoothstep(0.18, 0.42, mossDensity);
                const coreMask = _smoothstep(0.40, 0.85, mossDensity);
                const sporeHighlight = _smoothstep(0.65, 0.95, microN * mossDensity);

                const rCol = Math.round(_mix(20.0, _mix(45.0, 115.0, sporeHighlight), coreMask));
                const gCol = Math.round(_mix(50.0, _mix(115.0, 185.0, sporeHighlight), coreMask));
                const bCol = Math.round(_mix(15.0, _mix(30.0, 60.0, sporeHighlight), coreMask));

                aData.data[idx + 0] = rCol;
                aData.data[idx + 1] = gCol;
                aData.data[idx + 2] = bCol;
                aData.data[idx + 3] = Math.round(alpha * 255);

                rData.data[idx + 0] = 245;
                rData.data[idx + 1] = 245;
                rData.data[idx + 2] = 245;
                rData.data[idx + 3] = Math.round(alpha * 255);

                const nx = (detailNoise(x * 0.15, y * 0.15) * 32.0) * coreMask;
                const ny = (detailNoise(x * 0.15 + 50, y * 0.15 + 50) * 32.0) * coreMask;
                nData.data[idx + 0] = Math.max(0, Math.min(255, 128 + nx));
                nData.data[idx + 1] = Math.max(0, Math.min(255, 128 + ny));
                nData.data[idx + 2] = 255;
                nData.data[idx + 3] = Math.round(alpha * 255);
            }
        }

        a.putImageData(aData, 0, 0);
        n.putImageData(nData, 0, 0);
        r.putImageData(rData, 0, 0);

        return {
            albedo: makeTex(aC, true),
            normal: makeTex(nC),
            roughness: makeTex(rC)
        };
    };

// ── 2. HIGH-DETAIL BOTANICAL WALL MOSS (MATCHES FLOOR MOSS QUALITY) ─────
    const buildWallWeepingMossDecal = (variant = 'weeping', seed = 404) => {
        const { c: aC, ctx: a } = makeCtx();
        const { c: nC, ctx: n } = makeCtx();
        const { c: rC, ctx: r } = makeCtx();

        const aData = a.createImageData(S, S);
        const nData = n.createImageData(S, S);
        const rData = r.createImageData(S, S);

        const freq = 0.024; // High-density fractal frequency

        for (let y = 0; y < S; y++) {
            const v = y / S; // 0.0 at top, 1.0 at bottom
            for (let x = 0; x < S; x++) {
                const idx = (y * S + x) * 4;

                const dx = (x - H) / H;
                const dy = (y - H * 0.75) / (H * 0.75); // Anchored slightly higher
                const dist = Math.sqrt(dx * dx + dy * dy);

                // Multi-octave fractal moss cushion density
                const fbmVal = _fbm(noise2D, x * freq, y * freq, 4);
                const microN = detailNoise(x * 0.16, y * 0.16) * 0.5 + 0.5;

                // Subtle downward gravitational trailing streamer noise
                const gravityDrip = (v > 0.45) ? (noise2D(x * 0.035, y * 0.012) - 0.45) * 0.35 : 0.0;

                // Organic cellular moss boundary
                const density = _clamp((1.0 - dist * 1.35) + (fbmVal - 0.45) * 1.15 + gravityDrip, 0.0, 1.0);

                if (density < 0.18) {
                    aData.data[idx + 3] = 0;
                    nData.data[idx + 0] = 128;
                    nData.data[idx + 1] = 128;
                    nData.data[idx + 2] = 255;
                    nData.data[idx + 3] = 0;
                    rData.data[idx + 0] = 255;
                    rData.data[idx + 1] = 255;
                    rData.data[idx + 2] = 255;
                    rData.data[idx + 3] = 0;
                    continue;
                }

                const alpha = _smoothstep(0.18, 0.40, density);
                const coreMask = _smoothstep(0.38, 0.82, density);
                const sporeHighlight = _smoothstep(0.60, 0.92, microN * density);

                // Identical Botanical Palette: Deep Spruce -> Emerald Cushion -> Golden Spore Tips
                const rCol = Math.round(_mix(20.0, _mix(50.0, 115.0, sporeHighlight), coreMask));
                const gCol = Math.round(_mix(50.0, _mix(125.0, 195.0, sporeHighlight), coreMask));
                const bCol = Math.round(_mix(16.0, _mix(32.0, 55.0, sporeHighlight), coreMask));

                aData.data[idx + 0] = rCol;
                aData.data[idx + 1] = gCol;
                aData.data[idx + 2] = bCol;
                aData.data[idx + 3] = Math.round(alpha * 255);

                // High-relief 3D Micro-Nodular Normals (Pillowy cushions on stone)
                const nx = (detailNoise(x * 0.16, y * 0.16) * 36.0) * coreMask;
                const ny = (detailNoise(x * 0.16 + 60, y * 0.16 + 60) * 36.0 - (1.0 - v) * 12.0) * coreMask;
                nData.data[idx + 0] = Math.max(0, Math.min(255, 128 + nx));
                nData.data[idx + 1] = Math.max(0, Math.min(255, 128 + ny));
                nData.data[idx + 2] = 255;
                nData.data[idx + 3] = Math.round(alpha * 255);

                // Velvety matte roughness
                rData.data[idx + 0] = 245;
                rData.data[idx + 1] = 245;
                rData.data[idx + 2] = 245;
                rData.data[idx + 3] = Math.round(alpha * 255);
            }
        }

        a.putImageData(aData, 0, 0);
        n.putImageData(nData, 0, 0);
        r.putImageData(rData, 0, 0);

        return {
            albedo: makeTex(aC, true),
            normal: makeTex(nC),
            roughness: makeTex(rC)
        };
    };

    // ── 3. REALISTIC REFLECTIVE PUDDLE DECALS ─────────────────────────────────
    const buildOrganicPuddleDecal = (variant = 'pool', seed = 202) => {
        const { c: aC, ctx: a } = makeCtx();
        const { c: nC, ctx: n } = makeCtx();
        const { c: rC, ctx: r } = makeCtx();

        const aData = a.createImageData(S, S);
        const nData = n.createImageData(S, S);
        const rData = r.createImageData(S, S);

        const freq = variant === 'trough' ? 0.012 : 0.018;

        for (let y = 0; y < S; y++) {
            const dy = (y - H) / H * (variant === 'trough' ? 2.0 : 1.0);
            for (let x = 0; x < S; x++) {
                const idx = (y * S + x) * 4;
                const dx = (x - H) / H;
                const dist = Math.sqrt(dx * dx + dy * dy);

                const n1 = _fbm(noise2D, x * freq, y * freq, 3);
                const puddleDist = dist + (n1 - 0.45) * 0.45;

                if (puddleDist > 0.70) {
                    aData.data[idx + 3] = 0;
                    nData.data[idx + 0] = 128;
                    nData.data[idx + 1] = 128;
                    nData.data[idx + 2] = 255;
                    nData.data[idx + 3] = 0;
                    rData.data[idx + 0] = 255;
                    rData.data[idx + 1] = 255;
                    rData.data[idx + 2] = 255;
                    rData.data[idx + 3] = 0;
                    continue;
                }

                const isWater = _smoothstep(0.48, 0.44, puddleDist);
                const isDampFringe = _smoothstep(0.70, 0.48, puddleDist);

                const darkAbsorption = _mix(0.35, 0.75, isWater);
                aData.data[idx + 0] = 6;
                aData.data[idx + 1] = 10;
                aData.data[idx + 2] = 14;
                aData.data[idx + 3] = Math.round(isDampFringe * darkAbsorption * 255);

                const roughVal = Math.round(_mix(_mix(255.0, 95.0, isDampFringe), 4.0, isWater));
                rData.data[idx + 0] = roughVal;
                rData.data[idx + 1] = roughVal;
                rData.data[idx + 2] = roughVal;
                rData.data[idx + 3] = 255;

                const meniscus = Math.sin(_clamp((puddleDist - 0.43) / 0.05, 0.0, 1.0) * Math.PI);
                const ripple = Math.sin(dist * 24.0) * 8.0 * isWater;

                const safeDist = Math.max(dist, 0.001);
                const nx = Math.round(128 + (dx / safeDist) * meniscus * 45.0 + ripple);
                const ny = Math.round(128 + (dy / safeDist) * meniscus * 45.0);

                nData.data[idx + 0] = _clamp(nx, 0, 255);
                nData.data[idx + 1] = _clamp(ny, 0, 255);
                nData.data[idx + 2] = 255;
                nData.data[idx + 3] = Math.round(isDampFringe * 255);
            }
        }

        a.putImageData(aData, 0, 0);
        n.putImageData(nData, 0, 0);
        r.putImageData(rData, 0, 0);

        return {
            albedo: makeTex(aC, true),
            normal: makeTex(nC),
            roughness: makeTex(rC)
        };
    };

    // ── 4. PRE-BAKE TEXTURE SUITES ──────────────────────────────────────────
    _decalSystem = {
        moss: [
            buildOrganicMossDecal('cushion', 101),
            buildOrganicMossDecal('creeping', 102),
            buildOrganicMossDecal('cushion', 103)
        ],
        wall_moss: [
            buildWallWeepingMossDecal('cushion', 401),
            buildWallWeepingMossDecal('weeping', 402),
            buildWallWeepingMossDecal('cushion', 403)
        ],
        puddles: [
            buildOrganicPuddleDecal('pool', 201),
            buildOrganicPuddleDecal('trough', 202)
        ]
    };

    return _decalSystem;
}

// =============================================================================
// MATERIAL FACTORY & GRAVITY-ALIGNED PLACEMENT API
// =============================================================================

function createDecalMaterial(type = 'moss', variantIndex = 0) {
    const sys = initDecalSystem();

    if (type === 'puddle') {
        const v = sys.puddles[variantIndex % sys.puddles.length];
        return new THREE.MeshStandardMaterial({
            map: v.albedo,
            normalMap: v.normal,
            roughnessMap: v.roughness,
            transparent: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -4.0,
            polygonOffsetUnits: -4.0,
            side: THREE.DoubleSide,
            metalness: 0.05,
            roughness: 0.15,
            envMapIntensity: 3.0
        });
    }

    if (type === 'wall_moss') {
        const v = sys.wall_moss[variantIndex % sys.wall_moss.length];
        return new THREE.MeshStandardMaterial({
            map: v.albedo,
            normalMap: v.normal,
            roughnessMap: v.roughness,
            transparent: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -4.0,
            polygonOffsetUnits: -4.0,
            side: THREE.DoubleSide, // Crucial: prevents backface culling
            metalness: 0.0,
            roughness: 0.95,
            envMapIntensity: 0.15
        });
    }

    // Default Floor Moss
    const v = sys.moss[variantIndex % sys.moss.length];
    return new THREE.MeshStandardMaterial({
        map: v.albedo,
        normalMap: v.normal,
        roughnessMap: v.roughness,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4.0,
        polygonOffsetUnits: -4.0,
        side: THREE.DoubleSide,
        metalness: 0.0,
        roughness: 0.95,
        envMapIntensity: 0.15
    });
}

const decalPlaneGeo = new THREE.PlaneGeometry(1, 1);

function placeDecal(type, variantIdx, rawPos, faceNormal, scale = 1.5, rollRad = 0, alignGravity = false) {
    const mat = createDecalMaterial(type, variantIdx);
    levelMaterials.push(mat);

    const faceVec = new THREE.Vector3(
        faceNormal.dx || faceNormal.x || 0,
        faceNormal.dy || faceNormal.y || 0,
        faceNormal.dz || faceNormal.z || 0
    ).normalize();

    let alignQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), faceVec);

    // Gravity Alignment: on vertical walls, local +Y points up so weeping tendrils hang downward
    if (alignGravity && Math.abs(faceVec.y) < 0.75) {
        const worldUp = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(worldUp, faceVec).normalize();
        const actualUp = new THREE.Vector3().crossVectors(faceVec, right).normalize();
        const m = new THREE.Matrix4().makeBasis(right, actualUp, faceVec);
        alignQ.setFromRotationMatrix(m);
    } else {
        const rollQ = new THREE.Quaternion().setFromAxisAngle(faceVec, rollRad);
        alignQ.premultiply(rollQ);
    }

    alignQ.premultiply(globalTiltThree);

    const mesh = new THREE.Mesh(decalPlaneGeo, mat);

    // Lift 0.02m (2cm) off the surface into open air to guarantee visibility
    const offsetPos = new THREE.Vector3(rawPos.x, rawPos.y, rawPos.z).addScaledVector(faceVec, 0.02);
    mesh.position.copy(offsetPos.applyQuaternion(globalTiltThree));
    mesh.quaternion.copy(alignQ);

    // Wall moss stretches naturally down the wall (1.45x height multiplier)
    const heightMult = (type === 'wall_moss') ? 1.45 : 1.0;
    mesh.scale.set(scale, scale * heightMult, 1);

    mesh.renderOrder = 2;
    mesh.layers.set(1);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    scene.add(mesh);
    levelMeshes.push(mesh);
    return mesh;
}

// =============================================================================
// SHATTER — CORE ENGINE & PROCEDURAL VEGETATION SUBSYSTEM
// PART 4 OF 6: PROCEDURAL DENSE GRASS, FERNS, COMPOUND BUSH VOLUMES & SHADERS
// =============================================================================

// --- VEGETATION ROOT CONTAINER & UNIFORM BUFFERS ---
const vegetationSceneGroup = new THREE.Group();
vegetationSceneGroup.name = "VegetationSubsystem";
scene.add(vegetationSceneGroup);

const vegUniforms = {
    uTime: { value: 0.0 },
    uWindDir: { value: new THREE.Vector3(1.0, 0.0, 0.5).normalize() },
    uWindStrength: { value: 0.5 },
    uPlayerPos: { value: new THREE.Vector3() },
    uGrassBaseColor: { value: new THREE.Color(0x1a3311) },
    uGrassTipColor: { value: new THREE.Color(0x529432) },
    uGrassDryColor: { value: new THREE.Color(0x8a9144) },
    uSunDirection: { value: new THREE.Vector3(0.3, 0.8, -0.5).normalize() }
};

// =============================================================================
// 1. DENSE GROUND GRASS BLADE SYSTEM
// =============================================================================

function buildGrassBladeGeometry() {
    // 5-segment tapered, curved ribbon blade (12 vertices, 10 triangles)
    // Pivot is located at the blade base (0, 0, 0)
    const geom = new THREE.BufferGeometry();
    const segments = 5;
    const positions = [];
    const uvs = [];
    const indices = [];

    const baseWidth = 0.085;
    const height = 0.35;

    for (let i = 0; i <= segments; i++) {
        const v = i / segments;
        const y = Math.pow(v, 1.15) * height;
        // Blade width tapers non-linearly towards a sharp tip
        const currentWidth = baseWidth * (1.0 - Math.pow(v, 1.4));

        positions.push(-currentWidth * 0.5, y, 0.0);
        positions.push( currentWidth * 0.5, y, 0.0);

        uvs.push(0.0, v);
        uvs.push(1.0, v);

        if (i < segments) {
            const rowA = i * 2;
            const rowB = (i + 1) * 2;
            indices.push(rowA, rowA + 1, rowB);
            indices.push(rowA + 1, rowB + 1, rowB);
        }
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
}

const grassBladeGeometry = buildGrassBladeGeometry();

const grassVertexShader = `
    precision highp float;

    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec3 vNormalVec;
    varying float vInstanceRandom;

    uniform float uTime;
    uniform vec3 uWindDir;
    uniform float uWindStrength;
    uniform vec3 uPlayerPos;

    attribute vec4 aInstanceTransform0;
    attribute vec4 aInstanceTransform1;
    attribute vec4 aInstanceTransform2;
    attribute vec4 aInstanceParams; // x: randomSeed, y: heightScale, z: trampleResistance, w: tintVariation

    // Simplex Noise Hash Helper
    vec3 hash33(vec3 p3) {
        p3 = fract(p3 * vec3(.1031, .1030, .0973));
        p3 += dot(p3, p3.yxz + 33.33);
        return fract((p3.xxy + p3.yxx) * p3.zyx);
    }

    void main() {
        vUv = uv;
        vInstanceRandom = aInstanceParams.x;

        // Reconstruct local instance model matrix from chunked attributes
        mat4 instMatrix = mat4(
            vec4(aInstanceTransform0.xyz, 0.0),
            vec4(aInstanceTransform1.xyz, 0.0),
            vec4(aInstanceTransform2.xyz, 0.0),
            vec4(aInstanceTransform0.w, aInstanceTransform1.w, aInstanceTransform2.w, 1.0)
        );

        vec3 transformed = position;
        transformed.y *= aInstanceParams.y; // Height variation
        transformed.xz *= (0.8 + aInstanceParams.x * 0.4); // Width variation

        // Pre-curvature: arch the blade slightly naturally forward along Z
        float curveFactor = pow(uv.y, 2.0);
        transformed.z += curveFactor * 0.12 * (0.8 + aInstanceParams.x * 0.4);

        // Convert blade base to world space to calculate global wind wave coordinates
        vec4 bladeWorldOrigin = modelMatrix * instMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec3 worldBase = bladeWorldOrigin.xyz;

        // Multi-frequency directional wind wave simulation
        float windSpeed = uTime * 2.2;
        float wave1 = sin(dot(worldBase.xz, uWindDir.xz * 0.45) - windSpeed);
        float wave2 = cos(dot(worldBase.xz, vec2(-uWindDir.z, uWindDir.x) * 0.8) - windSpeed * 1.5) * 0.5;
        float windGust = (wave1 + wave2) * uWindStrength;

        // Individual blade flutter
        float flutter = sin(uTime * 7.0 + aInstanceParams.x * 31.4) * 0.08 * uv.y;

        // Apply wind deflection proportional to blade height squared (base stays planted)
        vec3 windDisplacement = (uWindDir + vec3(flutter, 0.0, flutter)) * (windGust * 0.35 + 0.15) * pow(uv.y, 1.8);
        transformed.xyz += windDisplacement;

        // Player Trample / Reactive Physics: Push grass away from the player's feet
        vec3 toPlayer = (modelMatrix * instMatrix * vec4(transformed, 1.0)).xyz - uPlayerPos;
        float distToPlayer = length(toPlayer.xz);
        float trampleRadius = 1.15;
        if (distToPlayer < trampleRadius && toPlayer.y > -0.5 && toPlayer.y < 1.8) {
            float trampleFactor = (1.0 - (distToPlayer / trampleRadius)) * pow(uv.y, 1.2);
            vec2 pushDir = normalize(toPlayer.xz + vec2(0.0001));
            transformed.xz += pushDir * trampleFactor * 0.65;
            transformed.y -= trampleFactor * 0.25;
        }

        vec4 worldPosition = modelMatrix * instMatrix * vec4(transformed, 1.0);
        vWorldPos = worldPosition.xyz;
        vNormalVec = normalize(mat3(modelMatrix * instMatrix) * normal);

        gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
`;

const grassFragmentShader = `
    precision highp float;

    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec3 vNormalVec;
    varying float vInstanceRandom;

    uniform vec3 uGrassBaseColor;
    uniform vec3 uGrassTipColor;
    uniform vec3 uGrassDryColor;
    uniform vec3 uSunDirection;

    void main() {
        // Vertical gradient: deep dark root, vibrant middle, sun-bleached / dry tip
        vec3 col = mix(uGrassBaseColor, uGrassTipColor, smoothstep(0.05, 0.75, vUv.y));
        
        // Per-instance color mutation (some blades are dry golden-green, others emerald)
        vec3 dryBlend = mix(col, uGrassDryColor, vInstanceRandom * 0.45);
        col = mix(col, dryBlend, smoothstep(0.65, 1.0, vUv.y));

        // Subsurface Translucency / Forward scattering
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float sss = pow(clamp(dot(viewDir, -uSunDirection), 0.0, 1.0), 3.0) * 0.45 * vUv.y;

        // Fake Ambient Occlusion at ground level
        float ao = smoothstep(0.0, 0.35, vUv.y);

        // Diffuse lighting from sun
        float diff = max(dot(vNormalVec, uSunDirection), 0.0) * 0.5 + 0.5;

        vec3 finalColor = (col * diff * ao) + vec3(sss * 0.6, sss * 0.9, sss * 0.3);

        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

const grassMaterial = new THREE.ShaderMaterial({
    vertexShader: grassVertexShader,
    fragmentShader: grassFragmentShader,
    uniforms: {
        uTime: vegUniforms.uTime,
        uWindDir: vegUniforms.uWindDir,
        uWindStrength: vegUniforms.uWindStrength,
        uPlayerPos: vegUniforms.uPlayerPos,
        uGrassBaseColor: vegUniforms.uGrassBaseColor,
        uGrassTipColor: vegUniforms.uGrassTipColor,
        uGrassDryColor: vegUniforms.uGrassDryColor,
        uSunDirection: vegUniforms.uSunDirection
    },
    side: THREE.DoubleSide,
    toneMapped: false
});

class GrassFieldManager {
    constructor() {
        this.maxInstances = 35000;
        this.instancedMesh = null;
        this.instanceCount = 0;
        this.init();
    }

    init() {
        const instGeom = new THREE.InstancedBufferGeometry();
        instGeom.copy(grassBladeGeometry);

        this.aTransform0 = new Float32Array(this.maxInstances * 4);
        this.aTransform1 = new Float32Array(this.maxInstances * 4);
        this.aTransform2 = new Float32Array(this.maxInstances * 4);
        this.aParams      = new Float32Array(this.maxInstances * 4);

        this.attrTransform0 = new THREE.InstancedBufferAttribute(this.aTransform0, 4);
        this.attrTransform1 = new THREE.InstancedBufferAttribute(this.aTransform1, 4);
        this.attrTransform2 = new THREE.InstancedBufferAttribute(this.aTransform2, 4);
        this.attrParams     = new THREE.InstancedBufferAttribute(this.aParams, 4);

        instGeom.setAttribute('aInstanceTransform0', this.attrTransform0);
        instGeom.setAttribute('aInstanceTransform1', this.attrTransform1);
        instGeom.setAttribute('aInstanceTransform2', this.attrTransform2);
        instGeom.setAttribute('aInstanceParams', this.attrParams);

        this.instancedMesh = new THREE.Mesh(instGeom, grassMaterial);
        this.instancedMesh.frustumCulled = false;
        this.instancedMesh.layers.set(2); // Set on layer 2 for selective passes
        vegetationSceneGroup.add(this.instancedMesh);
    }

    clear() {
        this.instanceCount = 0;
        this.instancedMesh.geometry.instanceCount = 0;
    }

    addCluster(cx, cy, cz, radius, bladeCount, rngFn) {
        const tempMat = new THREE.Matrix4();
        const tempPos = new THREE.Vector3();
        const tempEuler = new THREE.Euler();
        const tempQuat = new THREE.Quaternion();
        const tempScale = new THREE.Vector3();

        for (let i = 0; i < bladeCount; i++) {
            if (this.instanceCount >= this.maxInstances) break;

            const idx = this.instanceCount;
            const r = Math.sqrt(rngFn()) * radius;
            const theta = rngFn() * Math.PI * 2.0;

            tempPos.set(
                cx + Math.cos(theta) * r,
                cy,
                cz + Math.sin(theta) * r
            );

            // Random yaw with slight random pitch/roll tilt
            tempEuler.set(
                (rngFn() - 0.5) * 0.25,
                rngFn() * Math.PI * 2.0,
                (rngFn() - 0.5) * 0.25
            );
            tempQuat.setFromEuler(tempEuler);

            const scaleVal = 0.65 + rngFn() * 0.7;
            tempScale.set(scaleVal, scaleVal, scaleVal);

            tempMat.compose(tempPos, tempQuat, tempScale);

            const e = tempMat.elements;
            this.aTransform0[idx * 4 + 0] = e[0];
            this.aTransform0[idx * 4 + 1] = e[1];
            this.aTransform0[idx * 4 + 2] = e[2];
            this.aTransform0[idx * 4 + 3] = e[12]; // posX

            this.aTransform1[idx * 4 + 0] = e[4];
            this.aTransform1[idx * 4 + 1] = e[5];
            this.aTransform1[idx * 4 + 2] = e[6];
            this.aTransform1[idx * 4 + 3] = e[13]; // posY

            this.aTransform2[idx * 4 + 0] = e[8];
            this.aTransform2[idx * 4 + 1] = e[9];
            this.aTransform2[idx * 4 + 2] = e[10];
            this.aTransform2[idx * 4 + 3] = e[14]; // posZ

            this.aParams[idx * 4 + 0] = rngFn();                 // randomSeed
            this.aParams[idx * 4 + 1] = 0.8 + rngFn() * 0.5;    // heightScale
            this.aParams[idx * 4 + 2] = 1.0;                    // trample resistance
            this.aParams[idx * 4 + 3] = rngFn();                 // color tint

            this.instanceCount++;
        }
    }

    commit() {
        this.attrTransform0.needsUpdate = true;
        this.attrTransform1.needsUpdate = true;
        this.attrTransform2.needsUpdate = true;
        this.attrParams.needsUpdate = true;
        this.instancedMesh.geometry.instanceCount = this.instanceCount;
    }
}

const grassField = new GrassFieldManager();

// =============================================================================
// 2. PROCEDURAL BOTANICAL FERN ROSETTES & FIDDLEHEAD CROZIERS (BALANCED SCALE)
// =============================================================================

function buildCompactFernFrond(stemLength, leafletPairs, droopFactor, rngFn) {
    const geos = [];

    // 1. Tapered Catmull-Rom Arched Rachis (Stem)
    const curvePoints = [
        new THREE.Vector3(0.0, 0.0, 0.0),
        new THREE.Vector3(0.0, stemLength * 0.28, stemLength * 0.14),
        new THREE.Vector3(0.0, stemLength * 0.58, stemLength * 0.40),
        new THREE.Vector3(0.0, stemLength * 0.72 - (droopFactor * 0.10), stemLength * 0.68),
        new THREE.Vector3(0.0, stemLength * 0.62 - (droopFactor * 0.22), stemLength * 0.95)
    ];
    const stemCurve = new THREE.CatmullRomCurve3(curvePoints);
    const stemGeo = new THREE.TubeGeometry(stemCurve, 14, 0.015, 4, false);
    geos.push(stemGeo);

    // 2. 3D Creased Chevron Pinnae (V-Folded Leaflets)
    for (let i = 1; i <= leafletPairs; i++) {
        const t = i / (leafletPairs + 1);
        const pt = stemCurve.getPointAt(t);
        const tangent = stemCurve.getTangentAt(t);
        const normal = new THREE.Vector3(1.0, 0.0, 0.0);
        const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();

        // Asymmetric parabolic envelope: expands outward from base, peaks at 45%, tapers sharply to tip
        const sizeEnvelope = Math.sin(Math.pow(t, 0.82) * Math.PI);
        const leafW = 0.085 * sizeEnvelope;
        const leafL = (0.22 + rngFn() * 0.06) * sizeEnvelope;

        // Build a creased 3D folded triangular leaflet (4 vertices, 2 triangles)
        const makeFoldedLeaflet = (dirMultiplier) => {
            const geom = new THREE.BufferGeometry();
            const foldAngle = 0.24; // Dihedral V-fold angle

            const positions = new Float32Array([
                // Triangle 1: Base -> Midrib Tip -> Upper Wing
                0.0, 0.0, 0.0,
                0.0, leafL, 0.0,
                dirMultiplier * leafW, leafL * 0.55, foldAngle * leafW,

                // Triangle 2: Base -> Upper Wing -> Lower Wing Base
                0.0, 0.0, 0.0,
                dirMultiplier * leafW, leafL * 0.55, foldAngle * leafW,
                dirMultiplier * (leafW * 0.5), 0.0, foldAngle * leafW * 0.5
            ]);

            const uvs = new Float32Array([
                0.0, 0.0,  0.0, 1.0,  1.0, 0.55,
                0.0, 0.0,  1.0, 0.55, 0.5, 0.0
            ]);

            geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
            geom.computeVertexNormals();

            // Rotate pinna forward along rachis tangent & cup slightly upward
            geom.rotateZ(dirMultiplier * (-Math.PI * 0.38));
            geom.rotateX(0.18);
            geom.lookAt(binormal);
            geom.translate(pt.x + (dirMultiplier * 0.01), pt.y, pt.z);
            return geom;
        };

        // Alternating slight offset for natural organic rhythm
        const staggeredZ = (rngFn() - 0.5) * 0.015;
        pt.z += staggeredZ;

        geos.push(makeFoldedLeaflet(-1.0)); // Left pinna
        geos.push(makeFoldedLeaflet( 1.0)); // Right pinna
    }

    return safeMergeGeometries(geos);
}

function buildFiddleheadCrozier(height, rngFn) {
    // Spiraling uncoiled young frond core
    const spiralPoints = [];
    const coils = 2.4;
    const steps = 20;

    for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        if (u < 0.55) {
            // Lower stalk
            spiralPoints.push(new THREE.Vector3(0.0, u * height, 0.0));
        } else {
            // Upper spiral coil
            const coilT = (u - 0.55) / 0.45;
            const theta = coilT * Math.PI * 2.0 * coils;
            const r = (1.0 - coilT) * 0.045;
            spiralPoints.push(new THREE.Vector3(
                (rngFn() - 0.5) * 0.008,
                0.55 * height + Math.sin(theta) * r + (coilT * 0.04),
                Math.cos(theta) * r
            ));
        }
    }

    const curve = new THREE.CatmullRomCurve3(spiralPoints);
    return new THREE.TubeGeometry(curve, 18, 0.011, 4, false);
}

function createFernRosetteGeometry(seed = 1337) {
    const rngLocal = _makeRng(seed);
    const frondGeos = [];

    // GOLDEN ANGLE PHYLLOTAXIS (137.507°)
    const GOLDEN_ANGLE = 2.39996;
    let currentAngle = rngLocal() * Math.PI * 2.0;

    // ── TIER 1: Outer Cascading Fronds (Mature, low-drooping) ───────────────
    // Length: 70cm - 85cm (balanced intermediate reach)
    const outerCount = 8;
    for (let i = 0; i < outerCount; i++) {
        currentAngle += GOLDEN_ANGLE + (rngLocal() - 0.5) * 0.16;
        const stemLen = 0.70 + rngLocal() * 0.15;
        const droop = 1.1 + rngLocal() * 0.4;
        const frond = buildCompactFernFrond(stemLen, 13, droop, rngLocal);

        frond.rotateY(currentAngle);
        frond.rotateX(0.26 + rngLocal() * 0.14); // Arch gracefully toward ground
        frondGeos.push(frond);
    }

    // ── TIER 2: Mid Canopy Fronds (Vibrant, 45° angle) ───────────────────────
    // Length: 50cm - 62cm
    const midCount = 6;
    for (let i = 0; i < midCount; i++) {
        currentAngle += GOLDEN_ANGLE + (rngLocal() - 0.5) * 0.16;
        const stemLen = 0.50 + rngLocal() * 0.12;
        const droop = 0.5 + rngLocal() * 0.25;
        const frond = buildCompactFernFrond(stemLen, 10, droop, rngLocal);

        frond.rotateY(currentAngle);
        frond.rotateX(0.10 + rngLocal() * 0.10); // Held proudly upward
        frondGeos.push(frond);
    }

    // ── TIER 3: Crown Core Fiddleheads (Uncoiling croziers) ──────────────────
    const crozierCount = 4;
    for (let i = 0; i < crozierCount; i++) {
        const phi = (i / crozierCount) * Math.PI * 2.0 + (rngLocal() - 0.5) * 0.4;
        const h = 0.25 + rngLocal() * 0.07;
        const crozier = buildFiddleheadCrozier(h, rngLocal);

        crozier.rotateY(phi);
        crozier.rotateX((rngLocal() - 0.5) * 0.12);
        crozier.translate(Math.cos(phi) * 0.03, 0.0, Math.sin(phi) * 0.03);
        frondGeos.push(crozier);
    }

    const mergedRosette = safeMergeGeometries(frondGeos);
    mergedRosette.computeVertexNormals();
    return mergedRosette;
}

const fernVertexShader = `
    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec3 vNormalVec;

    uniform float uTime;
    uniform vec3 uWindDir;
    uniform float uWindStrength;

    void main() {
        vUv = uv;
        vec3 transformed = position;

        // Radial distance from rosette root (0.0 at center, ~0.75 at tips)
        float distFromCenter = length(transformed.xz);
        float heightFactor = clamp(transformed.y * 1.8, 0.0, 1.2);

        // 1. Primary frond stem sway (smoothly proportional to frond length)
        float stemSway = sin(uTime * 2.0 + dot(transformed.xz, vec2(1.2, 0.8))) * 0.055 * uWindStrength;
        transformed.xz += uWindDir.xz * stemSway * pow(distFromCenter / 0.75, 1.25);

        // 2. High-frequency leaflet flutter on outer tips
        float leafFlutter = sin(uTime * 9.5 + transformed.x * 24.0 + transformed.z * 16.0) * 0.015 * uWindStrength;
        transformed.y += leafFlutter * clamp(distFromCenter, 0.0, 1.0);

        vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
        vWorldPos = worldPos.xyz;
        vNormalVec = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
`;

const fernFragmentShader = `
    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec3 vNormalVec;

    uniform vec3 uSunDirection;

    void main() {
        // Deep forest-green root/vein transitioning to luminous leaf emerald
        vec3 rootColor    = vec3(0.04, 0.14, 0.03); // Shaded heart
        vec3 midColor     = vec3(0.12, 0.38, 0.10); // Healthy frond
        vec3 tipHighlight = vec3(0.28, 0.65, 0.18); // Sunlit tip

        // Two-tone gradient based on UV height & local elevation
        vec3 col = mix(rootColor, midColor, smoothstep(0.02, 0.45, vUv.y));
        col = mix(col, tipHighlight, smoothstep(0.50, 1.0, vUv.y) * 0.7);

        // Subsurface Translucency / Forward sun scattering
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float sss = pow(clamp(dot(viewDir, -uSunDirection), 0.0, 1.0), 3.0) * 0.55;

        // Ground Ambient Occlusion (darker near soil level)
        float groundAo = smoothstep(-0.05, 0.42, vWorldPos.y);

        float diff = max(dot(vNormalVec, uSunDirection), 0.0) * 0.65 + 0.35;
        vec3 finalCol = (col * diff * groundAo) + vec3(sss * 0.35, sss * 0.85, sss * 0.20);

        gl_FragColor = vec4(finalCol, 1.0);
    }
`;

const fernMaterial = new THREE.ShaderMaterial({
    vertexShader: fernVertexShader,
    fragmentShader: fernFragmentShader,
    uniforms: {
        uTime: vegUniforms.uTime,
        uWindDir: vegUniforms.uWindDir,
        uWindStrength: vegUniforms.uWindStrength,
        uSunDirection: vegUniforms.uSunDirection
    },
    side: THREE.DoubleSide,
    toneMapped: false
});

const sharedFernGeometry = createFernRosetteGeometry(777);

function spawnFernEntity(x, y, z, scale = 1.0) {
    const mesh = new THREE.Mesh(sharedFernGeometry, fernMaterial);
    mesh.position.set(x, y, z).applyQuaternion(globalTiltThree);
    
    // Balanced intermediate scale factor (~1.1m to 1.4m diameter)
    const tunedScale = scale * 0.95;
    mesh.scale.set(tunedScale, tunedScale * (0.90 + Math.random() * 0.2), tunedScale);
    mesh.quaternion.copy(globalTiltThree);
    mesh.rotateY(Math.random() * Math.PI * 2.0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    vegetationSceneGroup.add(mesh);
    levelMeshes.push(mesh);
    return mesh;
}

// =============================================================================
// 3. HIGH-FIDELITY PROCEDURAL VOLUMETRIC BUSH & CANOPY SUBSYSTEM
// =============================================================================

function createBushTextures() {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, S, S);

    // 1. Draw Dense Overlapping Botanical Foliage Spray
    const numLeaves = 18;
    const rng = _makeRng(404);

    for (let i = 0; i < numLeaves; i++) {
        const ang = (i / numLeaves) * Math.PI * 2.0 + (rng() - 0.5) * 0.4;
        const dist = 30 + rng() * 60;
        const lx = S * 0.5 + Math.cos(ang) * dist;
        const ly = S * 0.5 + Math.sin(ang) * dist;
        const rot = ang + Math.PI * 0.5 + (rng() - 0.5) * 0.5;
        const leafW = 22 + rng() * 14;
        const leafL = 40 + rng() * 20;

        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(rot);

        // Serrated / Curved Leaf Blade
        ctx.beginPath();
        ctx.moveTo(0, -leafL * 0.5);
        ctx.bezierCurveTo(-leafW * 0.6, -leafL * 0.2, -leafW * 0.5, leafL * 0.35, 0, leafL * 0.5);
        ctx.bezierCurveTo(leafW * 0.5, leafL * 0.35, leafW * 0.6, -leafL * 0.2, 0, -leafL * 0.5);
        ctx.closePath();

        // Two-tone leaf gradient (dark forest base -> luminous lime highlight)
        const lGrad = ctx.createLinearGradient(0, -leafL * 0.5, 0, leafL * 0.5);
        lGrad.addColorStop(0.0, '#58a832'); // Bright tip
        lGrad.addColorStop(0.5, '#2b6e1a'); // Rich chlorophyll body
        lGrad.addColorStop(1.0, '#133e0a'); // Deep shadow base
        ctx.fillStyle = lGrad;
        ctx.fill();

        // Leaf Midrib Vein
        ctx.strokeStyle = 'rgba(180, 240, 140, 0.45)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(0, -leafL * 0.45);
        ctx.lineTo(0, leafL * 0.45);
        ctx.stroke();

        ctx.restore();
    }

    // 2. Sprinkle Subtle Floral Buds / Wild Berries Among Leaves
    for (let b = 0; b < 10; b++) {
        const bx = S * 0.5 + (rng() - 0.5) * 110;
        const by = S * 0.5 + (rng() - 0.5) * 110;
        const br = 4 + rng() * 3.5;

        // Berry gradient
        const bGrad = ctx.createRadialGradient(bx - 1, by - 1, 1, bx, by, br);
        bGrad.addColorStop(0.0, '#fca5a5'); // Sun highlight
        bGrad.addColorStop(0.6, '#dc2626'); // Ripe scarlet berry
        bGrad.addColorStop(1.0, '#7f1d1d'); // Deep rim
        ctx.fillStyle = bGrad;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}

const bushLeafTexture = createBushTextures();

// =============================================================================
// PROCEDURAL FOLIAGE CARD GEOMETRY GENERATOR (WITH SPHERICAL NORMAL TRANSFER)
// =============================================================================

function createVolumetricLeafTuftGeometry(radius, cardCount, rngFn) {
    const geos = [];
    const cardSize = radius * 1.35;

    for (let i = 0; i < cardCount; i++) {
        // Fibonacci sphere surface distribution for perfectly even foliage volume
        const phi = Math.acos(1.0 - 2.0 * (i + 0.5) / cardCount);
        const theta = Math.PI * (1.0 + Math.sqrt(5.0)) * i;

        // Position on the outer lobe envelope
        const r = radius * (0.65 + rngFn() * 0.35);
        const px = Math.sin(phi) * Math.cos(theta) * r;
        const py = Math.cos(phi) * r * 0.85 + (radius * 0.2); // Tends slightly upward
        const pz = Math.sin(phi) * Math.sin(theta) * r;

        // Double-sided leaf card quad
        const cardGeo = new THREE.PlaneGeometry(cardSize, cardSize);

        // Orient card outwards from center with organic tilt
        cardGeo.lookAt(new THREE.Vector3(px, py, pz));
        cardGeo.rotateZ(rngFn() * Math.PI * 2.0);
        cardGeo.translate(px, py, pz);

        // ── SPHERICAL NORMAL TRANSFER ────────────────────────────────────────
        // Forces all vertex normals to point outward from the cluster origin,
        // producing soft, cloud-like volumetric lighting instead of faceted cardboard
        const posAttr = cardGeo.attributes.position;
        const normAttr = cardGeo.attributes.normal;
        const vPos = new THREE.Vector3();
        const vNorm = new THREE.Vector3();

        for (let v = 0; v < posAttr.count; v++) {
            vPos.fromBufferAttribute(posAttr, v);
            // Blend 75% spherical outward direction + 25% card surface normal
            vNorm.copy(vPos).normalize().multiplyScalar(0.75);
            vNorm.addScaledVector(new THREE.Vector3(0, 0, 1), 0.25).normalize();
            normAttr.setXYZ(v, vNorm.x, vNorm.y, vNorm.z);
        }

        geos.push(cardGeo);
    }

    return safeMergeGeometries(geos);
}

// =============================================================================
// SHADERS WITH ALPHA-TEST, VOLUMETRIC OCCLUSION & SUBSURFACE TRANSLUCENCY
// =============================================================================

const bushFoliageVertexShader = `
    precision highp float;

    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec3 vNormalVec;
    varying float vHeightGradient;

    uniform float uTime;
    uniform vec3 uWindDir;
    uniform float uWindStrength;

    void main() {
        vUv = uv;

        vec3 transformed = position;

        // Height factor: bottom stays rooted, upper canopy sways
        float hFactor = clamp(transformed.y * 1.2, 0.0, 1.5);
        vHeightGradient = clamp(transformed.y * 0.8 + 0.2, 0.0, 1.0);

        // 1. Primary macro wind sway
        float sway = sin(uTime * 1.8 + dot(transformed.xz, vec2(1.2, 0.8))) * 0.065 * uWindStrength;
        transformed.xz += uWindDir.xz * sway * pow(hFactor, 1.3);

        // 2. Micro leaf flutter on outer foliage
        float flutter = sin(uTime * 8.5 + transformed.x * 16.0 + transformed.z * 14.0) * 0.015 * uWindStrength;
        transformed.y += flutter * hFactor;

        vec4 worldPos = modelMatrix * vec4(transformed, 1.0);
        vWorldPos = worldPos.xyz;
        vNormalVec = normalize(mat3(modelMatrix) * normal);

        gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
`;

const bushFoliageFragmentShader = `
    precision highp float;

    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec3 vNormalVec;
    varying float vHeightGradient;

    uniform sampler2D uLeafMap;
    uniform vec3 uSunDirection;
    uniform vec3 uBaseFoliageColor;
    uniform vec3 uHighlightFoliageColor;
    uniform vec3 uInteriorShadowColor;

    void main() {
        // Sample procedural leaf card spray with crisp alpha cutout
        vec4 texColor = texture2D(uLeafMap, vUv);
        if (texColor.a < 0.45) discard;

        // 1. Volumetric Light Model
        float diff = max(dot(vNormalVec, uSunDirection), 0.0);

        // 2. Subsurface Scattering (Leaves glow when looking into the sun)
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float sss = pow(clamp(dot(viewDir, -uSunDirection), 0.0, 1.0), 3.0) * 0.65;

        // 3. Multi-tier Chlorophyll Palette
        vec3 leafColor = mix(uBaseFoliageColor, uHighlightFoliageColor, vHeightGradient * 0.6 + diff * 0.4);
        leafColor = mix(leafColor, texColor.rgb, 0.45); // Blend with procedural leaf details

        // 4. Core Ambient Occlusion (dark interior depths)
        float coreAO = smoothstep(0.05, 0.85, vHeightGradient);
        vec3 finalColor = mix(uInteriorShadowColor, leafColor, coreAO * 0.7 + 0.3);

        // Add soft diffuse lighting & glowing SSS transmission
        finalColor = (finalColor * (diff * 0.6 + 0.4)) + vec3(0.18, 0.45, 0.08) * sss;

        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

function createProceduralBushMaterial() {
    return new THREE.ShaderMaterial({
        vertexShader: bushFoliageVertexShader,
        fragmentShader: bushFoliageFragmentShader,
        uniforms: {
            uTime: vegUniforms.uTime,
            uWindDir: vegUniforms.uWindDir,
            uWindStrength: vegUniforms.uWindStrength,
            uSunDirection: vegUniforms.uSunDirection,
            uLeafMap: { value: bushLeafTexture },
            uBaseFoliageColor: { value: new THREE.Color(0x235e16) },      // Rich botanical emerald
            uHighlightFoliageColor: { value: new THREE.Color(0x72c238) }, // Sunlit golden-lime tips
            uInteriorShadowColor: { value: new THREE.Color(0x061804) }    // Deep core shadow
        },
        side: THREE.DoubleSide,
        toneMapped: false
    });
}

const sharedBushMaterial = createProceduralBushMaterial();

// =============================================================================
// COMPOUND BUSH GENERATOR (GNARLED WOOD SKELETON + PROCEDURAL FOLIAGE TUFTS)
// =============================================================================

function generateBushFromRectangles(volumes, options = {}) {
    if (!volumes || volumes.length === 0) return null;
    const compoundGroup = new THREE.Group();
    const seed = options.seed || 12345;
    const rngLocal = _makeRng(seed);

    // 1. Calculate compound bounding center to anchor group
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    volumes.forEach(v => {
        if (v.minX < minX) minX = v.minX;
        if (v.maxX > maxX) maxX = v.maxX;
        if (v.minY < minY) minY = v.minY;
        if (v.maxY > maxY) maxY = v.maxY;
        if (v.minZ < minZ) minZ = v.minZ;
        if (v.maxZ > maxZ) maxZ = v.maxZ;
    });

    const originX = (minX + maxX) * 0.5;
    const originY = minY - 0.5;
    const originZ = (minZ + maxZ) * 0.5;

    compoundGroup.position.set(originX, originY, originZ);

    const foliageGeos = [];
    const branchGeos = [];

    const woodBarkMat = new THREE.MeshStandardMaterial({
        color: 0x3d2b1f,
        roughness: 0.92,
        metalness: 0.05
    });

    // 2. Generate Gnarled Branches & Volumetric Leaf Clusters
    volumes.forEach(vol => {
        const w = Math.max(0.7, vol.maxX - vol.minX);
        const h = Math.max(0.7, vol.maxY - vol.minY);
        const d = Math.max(0.7, vol.maxZ - vol.minZ);

        const lcx = (vol.minX + vol.maxX) * 0.5 - originX;
        const lcy = 0.0;
        const lcz = (vol.minZ + vol.maxZ) * 0.5 - originZ;

        // A. Primary Gnarled Trunk
        const trunkCurve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(lcx, lcy, lcz),
            new THREE.Vector3(lcx + (rngLocal() - 0.5) * 0.15, lcy + h * 0.35, lcz + (rngLocal() - 0.5) * 0.15),
            new THREE.Vector3(lcx + (rngLocal() - 0.5) * 0.25, lcy + h * 0.70, lcz + (rngLocal() - 0.5) * 0.25)
        ]);
        branchGeos.push(new THREE.TubeGeometry(trunkCurve, 6, 0.038, 4, false));

        // B. Secondary Spreading Twigs
        const subBranches = 3 + Math.floor(rngLocal() * 3);
        for (let b = 0; b < subBranches; b++) {
            const t = 0.35 + (b / subBranches) * 0.45;
            const startPt = trunkCurve.getPointAt(t);
            const targetX = lcx + (rngLocal() - 0.5) * w * 0.75;
            const targetY = lcy + h * (0.45 + rngLocal() * 0.35);
            const targetZ = lcz + (rngLocal() - 0.5) * d * 0.75;

            const subCurve = new THREE.CatmullRomCurve3([
                startPt,
                new THREE.Vector3((startPt.x + targetX) * 0.5, (startPt.y + targetY) * 0.5 + 0.06, (startPt.z + targetZ) * 0.5),
                new THREE.Vector3(targetX, targetY, targetZ)
            ]);
            branchGeos.push(new THREE.TubeGeometry(subCurve, 5, 0.018, 4, false));
        }

        // C. Volumetric Foliage Tufts (Soft-lit cloud clusters)
        const tuftCount = Math.max(4, Math.floor(w * d * 5.0));
        for (let ti = 0; ti < tuftCount; ti++) {
            const px = lcx + (rngLocal() - 0.5) * w * 0.85;
            const pz = lcz + (rngLocal() - 0.5) * d * 0.85;
            const py = lcy + h * (0.35 + rngLocal() * 0.45);

            const tuftRadius = Math.min(0.55, Math.min(w, d) * 0.45) * (0.8 + rngLocal() * 0.35);
            const tuft = createVolumetricLeafTuftGeometry(tuftRadius, 14, rngLocal);
            tuft.translate(px, py, pz);
            foliageGeos.push(tuft);
        }
    });

    if (foliageGeos.length > 0) {
        const mergedFoliage = safeMergeGeometries(foliageGeos);
        const foliageMesh = new THREE.Mesh(mergedFoliage, sharedBushMaterial);
        foliageMesh.castShadow = true;
        foliageMesh.receiveShadow = true;
        compoundGroup.add(foliageMesh);
    }

    if (branchGeos.length > 0) {
        const mergedBranches = safeMergeGeometries(branchGeos);
        const branchMesh = new THREE.Mesh(mergedBranches, woodBarkMat);
        branchMesh.castShadow = true;
        branchMesh.receiveShadow = true;
        compoundGroup.add(branchMesh);
    }

    compoundGroup.position.applyQuaternion(globalTiltThree);
    vegetationSceneGroup.add(compoundGroup);
    levelMeshes.push(compoundGroup);
    return compoundGroup;
}

// =============================================================================
// 4. CREEPING IVY & CEILING VINES
// =============================================================================

function generateIvyWallClimber(startPos, wallNormal, height = 4.5, width = 1.8, seed = 555) {
    const rngLocal = _makeRng(seed);
    const group = new THREE.Group();
    const stemGeos = [];
    const leafGeos = [];

    const lateralAxis = new THREE.Vector3(0.0, 1.0, 0.0).cross(wallNormal).normalize();
    const branchCount = 3 + Math.floor(rngLocal() * 3);

    for (let b = 0; b < branchCount; b++) {
        const points = [];
        let curr = startPos.clone().addScaledVector(lateralAxis, (rngLocal() - 0.5) * 0.4);
        points.push(curr.clone());

        const steps = 16;
        for (let s = 1; s <= steps; s++) {
            const vFrac = s / steps;
            curr.y += (height / steps) * (0.8 + rngLocal() * 0.35);
            curr.addScaledVector(lateralAxis, (rngLocal() - 0.5) * (width / steps) * 1.4);
            curr.addScaledVector(wallNormal, 0.02 + (rngLocal() - 0.5) * 0.015);
            points.push(curr.clone());

            // 5 to 7 small leaves per node
            const leafCount = 5 + Math.floor(rngLocal() * 3);
            for (let lf = 0; lf < leafCount; lf++) {
                const lw = 0.08 + rngLocal() * 0.06; // Small realistic ivy size (8-14cm)
                const lh = lw * 1.15;
                const leaf = new THREE.PlaneGeometry(lw, lh);

                leaf.lookAt(wallNormal);
                leaf.rotateZ((rngLocal() - 0.5) * 1.6);
                leaf.rotateX((rngLocal() - 0.5) * 0.35);
                leaf.translate(
                    curr.x + (rngLocal() - 0.5) * 0.3,
                    curr.y + (rngLocal() - 0.5) * 1.2,
                    curr.z + 0.02 + rngLocal() * 0.015
                );

                // Leaf hue variation (emerald, lime, olive)
                const isTip = vFrac > 0.75;
                const r = isTip ? 1.12 : (0.80 + rngLocal() * 0.25);
                const g = isTip ? 1.25 : (0.90 + rngLocal() * 0.20);
                const bCol = isTip ? 0.75 : (0.70 + rngLocal() * 0.20);

                const colors = new Float32Array([
                    r, g, bCol,
                    r, g, bCol,
                    r, g, bCol,
                    r, g, bCol
                ]);
                leaf.setAttribute('color', new THREE.BufferAttribute(colors, 3));
                leafGeos.push(leaf);
            }
        }

        const curve = new THREE.CatmullRomCurve3(points);
        stemGeos.push(new THREE.TubeGeometry(curve, 24, 0.016, 5, false));
    }

    if (stemGeos.length > 0) {
        group.add(new THREE.Mesh(safeMergeGeometries(stemGeos), vineWoodMat));
    }
    if (leafGeos.length > 0) {
        group.add(new THREE.Mesh(safeMergeGeometries(leafGeos), vineLeafMat));
    }

    group.position.applyQuaternion(globalTiltThree);
    vegetationSceneGroup.add(group);
    levelMeshes.push(group);
    return group;
}

// =============================================================================
// 5. VEGETATION SUBSYSTEM RUNTIME UPDATER & TEARDOWN
// =============================================================================

function updateVegetation(delta, time) {
    vegUniforms.uTime.value = time;

    // Sync player position for dynamic grass flattening / repulsion
    if (playerBody) {
        vegUniforms.uPlayerPos.value.set(
            playerBody.position.x,
            playerBody.position.y - playerHalfH,
            playerBody.position.z
        );
    }

    // Directional wind vector synthesis
    if (activeWinds.length > 0) {
        vegUniforms.uWindDir.value.copy(activeWinds[0].dir);
        vegUniforms.uWindStrength.value = Math.min(activeWinds[0].strength * 0.1, 2.5);
    } else {
        vegUniforms.uWindDir.value.set(1.0, 0.0, 0.4).normalize();
        vegUniforms.uWindStrength.value = 1.0;
    }

    if (sunLight) {
        vegUniforms.uSunDirection.value.copy(sunLight.position).normalize();
    }
}

function clearVegetation() {
    grassField.clear();

    while (vegetationSceneGroup.children.length > 0) {
        const child = vegetationSceneGroup.children[0];
        vegetationSceneGroup.remove(child);
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
            else child.material.dispose();
        }
    }
    // Re-mount instanced grass container
    grassField.init();
}

// =============================================================================
// SHATTER — LEVEL GENERATORS (OVERHAULED & COMPACT CHAMBER SYSTEM)
// =============================================================================
// Overhaul pass: bigger multi-tier geometry, real puzzles (not just tech demos),
// wider block variety per level, and two recurring puzzle patterns layered
// throughout: BLOCK STANDING (climb atop a cube to reach an otherwise unreachable
// ledge) and BLOCK SWAPPING (carry/relocate a single prop between two or more
// trigger points instead of just dropping it once). Numbers are close to the
// original scale but may need a light in-engine pass to tune exact reach/timing.

const roomBox = (x, y, z, w, h, d) => (x <= -w || x >= w || z <= -d || z >= d || y <= 0 || y >= h);

// ─────────────────────────────────────────────────────────────────────────────
// CHAPTER 1: THE FUNDAMENTALS
// ─────────────────────────────────────────────────────────────────────────────

function getLevelParamsV1(lvl) {
    const builder = new LevelBuilder(lvl, LEVEL_NAMES[lvl]);
    switch (lvl) {

        // LEVEL 0: THE ATRIUM — Reading Sightlines
        // Zig-zagging terrace climb instead of a straight run — forces the player
        // to scan left/right for the next step rather than just holding forward.
        case 0:
            return builder.setBounds(6, 10, 9)
                .setSpawn(0, 2, -6)
                .setExit(0, 6.5, 6)
                .addLight(0, 5, 0, 0xffeedd, 5.0, 14.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 5, 9, 8)) return true;
                    if (z >= -6 && z <= -4 && y <= 1) return true;           // entry shelf
                    if (z >= -3 && z <= -2 && x >= 1 && y <= 2) return true; // step right
                    if (z >= -1 && z <= 0 && x <= -1 && y <= 3) return true; // step left
                    if (z >= 1 && z <= 2 && x >= 1 && y <= 4) return true;   // step right
                    if (z >= 3 && y <= 5) return true;                      // exit terrace
                    return y <= 0;
                }).build();

// LEVEL 1: THE CORRIDOR — The Green Core (Delivery Key)
        // Two consecutive 3-block-tall ledges (y=1 -> y=4 -> y=7).
        // The player's base jump height is ~2.6m, so 3-block ledges cannot be cleared directly.
        // The player must place the 1-block green cube as a step, climb up, retrieve the
        // cube from below using the grab tool, and repeat for the second ledge.
        case 1:
            return builder.setBounds(6, 13, 12)
                .setSpawn(0, 2, -9)
                .setExit(0, 8.5, 8)
                .addEntity('green', 0, 2, -6)
                .addLight(0, 8, 0, 0x44ffaa, 5.0, 18.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 5, 12, 11)) return true;
                    if (z <= -4 && y <= 1) return true;           // Tier 1: Spawn shelf (floor at y=1)
                    if (z >= -3 && z <= 1 && y <= 4) return true; // Tier 2: Mid corridor (+3 blocks, floor at y=4)
                    if (z >= 2 && y <= 7) return true;            // Tier 3: Exit terrace (+3 blocks, floor at y=7)
                    return y <= 0;
                }).build();

        // LEVEL 2: THE SHAFTS — Blue Pad (Kinetic Momentum Conservation)
        // Expanded chamber (8 x 22 x 11): 
        // 1. Plunge 15 blocks down from the high spawn gantry (y=16) onto the first blue pad at y=1.
        // 2. High-momentum kinetic launch propels the player up to the expansive mid mezzanine (y=9).
        // 3. Retrieve and reposition the misplaced second blue pad to clear the final shaft to the summit balcony (y=17).
        case 2:
            return builder.setBounds(8, 22, 11)
                .setSpawn(0, 17, -8)
                .setExit(0, 18.5, 8)
                .addEntity('blue', 0, 1, -4)
                .addEntity('blue', -4, 10, -1)
                .addLight(0, 6, -3, 0x3388ff, 6.0, 24.0)
                .addLight(0, 16, 4, 0x88ccff, 5.0, 20.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 7, 21, 10)) return true;
                    if (z <= -6 && y <= 15) return true;                          // High entry gantry (y=15)
                    if (z >= 6 && y <= 17) return true;                           // High exit balcony (y=17)
                    if (Math.abs(x) <= 5 && z >= -3 && z <= 3 && y <= 9) return true; // Mid mezzanine shelf (y=9)
                    if (x <= -3 && z >= -2 && z <= 0 && y <= 11) return true;    // Perch holding the second pad
                    return y <= 0;
                }).build();

        // LEVEL 3: THE PENTHOUSE — Red Cube (Wedging & Scaling)
        // Shrink through the mousehole, then re-grow the cube on the far side and
        // stand on top of it (block standing) to clear the raised exit terrace.
        case 3:
            return builder.setBounds(6, 9, 7)
                .setSpawn(0, 1, -5)
                .setExit(0, 5.5, 5)
                .addEntity('red', 0, 1, -3, { startScale: 2.5 })
                .addLight(0, 5, 0, 0xff4455, 4.0, 12.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 5, 8, 6)) return true;
                    if (z === 0) {
                        if (Math.abs(x) <= 0.6 && y <= 1) return false; // mousehole, shrunk cube only
                        if (x >= 3 && y <= 2) return false;             // player-only door
                        return true;
                    }
                    if (z >= 4 && y <= 4) return true; // exit terrace, needs the cube as a step
                    return y <= 0;
                }).build();

// LEVEL 4: THE WELL — The Flooded Siphon & Reservoir Vault
        // A complete overhaul with zero side ledges and strictly gated vertical thresholds:
        // 1. Chamber 1 (The Siphon Well): Water is at y=3.5. The only exit is an elevated
        //    sluice window at z=-3, y=8 (4.5 blocks above water). Freeze the yellow cube at
        //    y=5.5 against the dam wall to mantle through onto the high flume (y=7).
        // 2. Chamber 2 (The Reservoir Vault): Retrieve the yellow cube through the window.
        //    Drop to the intake plinth (y=5). The Exit Sanctuary sits at y=9 (4 blocks up and
        //    4 blocks away). Freeze the cube mid-air over the reservoir pool at z=7, y=7 to
        //    bridge the final leap into the sanctuary.
        case 4:
            return builder.setBounds(6, 15, 13)
                .setSpawn(0, 5, -10)
                .setExit(0, 10.5, 10)
                .setWater(3.5, { color: 0x0e4d75, distortionScale: 4.5, alpha: 0.75 })
                .addEntity('yellow', 0, 4.2, -6)
                .addLight(0, 3, -6, 0x00a2ff, 5.0, 18.0) // Deep pool underwater glow (Chamber 1)
                .addLight(0, 11, -3, 0xd0f0ff, 4.5, 16.0) // Window sluice skylight
                .addLight(0, 3, 5, 0x0088cc, 5.0, 18.0)  // Deep reservoir glow (Chamber 2)
                .addLight(0, 12, 10, 0x67e8f9, 5.5, 18.0) // Sanctuary beacon light
                .addCustomLogic((x, y, z) => {
                    // Outer chamber boundaries: interior x in [-4, 4], y in [1, 13], z in [-11, 11]
                    if (roomBox(x, y, z, 5, 14, 12)) return true;

                    // ── CHAMBER 1: The Siphon Well ───────────────────────────
                    // Dry entrance staging dock (y <= 4, z <= -9)
                    if (z <= -9 && y <= 4) return true;

                    // Monolithic Dam Wall (z = -3): Solid floor-to-ceiling barrier (y=0 to 14)
                    // The ONLY opening is the high sluice window at y in [8, 10], x in [-1, 1]
                    if (z === -3) {
                        if (Math.abs(x) <= 1 && y >= 8 && y <= 10) return false; // Window aperture
                        return true; // Completely solid wall
                    }

                    // ── INTERMEDIATE: Sluice Flume Catwalk ───────────────────
                    // Elevated narrow conduit (y <= 7, z from -2 to 0, x in [-1, 1])
                    if (z >= -2 && z <= 0 && Math.abs(x) <= 1 && y <= 7) return true;

                    // Ceiling baffle arch at z=2: Intercepts high sprint-jump arcs from flume
                    if (z === 2 && y >= 9) return true;

                    // ── CHAMBER 2: The Reservoir Vault ───────────────────────
                    // Central Water-Intake Plinth (z=4 to 5, x in [-1, 1], top at y <= 5)
                    if ((z === 4 || z === 5) && Math.abs(x) <= 1 && y <= 5) return true;

                    // Exit Sanctuary Terrace (z >= 9, floor at y <= 9)
                    // (4 blocks above the intake plinth, 5.5 blocks above the water)
                    if (z >= 9 && y <= 9) return true;

                    // Submerged bedrock cistern floor (under 3.5m of water)
                    return y <= 0;
                }).build();

        // LEVEL 5: THE TOWER — Tight Spiral Ascent
        // The same red cube is hauled up the whole spiral and re-grown TWICE, at
        // two separate missing steps — carrying it further each time (block swap).
        case 5:
            return builder.setBounds(6, 16, 6)
                .setSpawn(-3, 2, -3)
                .setExit(0, 13.5, 0)
                .addEntity('red', -3, 2, -1, { startScale: 1.0 })
                .addLight(0, 8, 0, 0xffeedd, 4.5, 18.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 5, 15, 5)) return true;
                    if (x <= -3 && z <= 0 && y <= 1) return true;
                    if (x <= -2 && z >= 2 && y <= 4) return true;
                    if (x >= 1 && z >= 3 && y <= 7) return true;   // gap 1 — bridge with the cube
                    if (x >= 3 && z <= 0 && y <= 10) return true;  // gap 2 — carry it up, bridge again
                    if (Math.abs(x) <= 1 && Math.abs(z) <= 1 && y <= 12) return true; // goal crown
                    return y <= 0;
                }).build();

        // LEVEL 6: THE TUNNEL — Spatial Freezing (Yellow Block Mastery)
        // A long subterranean transit tunnel fractured by two massive chasms.
        // Tests full 3D mid-air spatial freezing:
        // 1. Freeze the yellow cube in mid-air (y=2.5, z=-4) to bridge Chasm 1 and climb from y=1 up to the Mid Catwalk (y=4).
        // 2. Retrieve the cube from behind, carry it across the catwalk, and freeze it mid-air (y=5.5, z=5)
        //    to bridge Chasm 2 and ascend to the High Exit Portal (y=7).
        case 6:
            return builder.setBounds(6, 12, 14)
                .setSpawn(0, 2, -10)
                .setExit(0, 8.5, 10)
                .addEntity('yellow', 0, 2, -7)
                .addLight(0, 6, -5, 0xffaa33, 4.5, 18.0)
                .addLight(0, 7, 0,  0xffdd44, 4.5, 18.0)
                .addLight(0, 9, 7,  0xff8822, 5.0, 18.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 5, 11, 13)) return true;

                    // Station 1: Lower Entry Depot (y=1, z <= -7)
                    if (z <= -7 && y <= 1) return true;

                    // Station 2: Mid Catwalk (+3m rise at y=4, z from -1 to 2)
                    if (z >= -1 && z <= 2 && y <= 4) return true;

                    // Station 3: High Exit Portal (+3m rise at y=7, z >= 8)
                    if (z >= 8 && y <= 7) return true;

                    // Tunnel structural rib arches along sidewalls (leaves center 5 blocks open)
                    if (Math.abs(x) >= 3 && (Math.abs(z) % 4 === 0) && y <= 9) return true;

                    // Bottomless void floor
                    return y <= 0;
                }).build();

        // LEVEL 7: THE LEDGES — Kinetic Stacking & Citadel Ascent
        // A colossal brutalist quarry fortress featuring a two-stage vertical ascent:
        // 1. Lower Bastion (Tier 1 -> Tier 2): Use the scaled Red cube and Blue pad to clear
        //    the 6-block-tall lower fortified wall (y=1 -> y=5).
        // 2. The Citadel Apex (Tier 2 -> Tier 3): Retrieve both blocks onto the grand mezzanine,
        //    scale Red up to giant size, stack Blue atop Red, climb the stepped side galleries
        //    to y=8, and plunge onto the elevated pad to launch through the high citadel aperture
        //    over the 8-block-tall fortress wall into the summit balcony (y=12).
        case 7:
            return builder.setBounds(8, 20, 13)
                .setSpawn(0, 2, -9)
                .setExit(0, 13.5, 9)
                .addEntity('red', -2, 2, -7, { startScale: 1.4 })
                .addLight(0, 6, -8, 0xffeedd, 5.0, 18.0) // Lower quarry warm light
                .addLight(0, 10, 0, 0x60a5fa, 5.5, 20.0) // Mezzanine cool blue fill
                .addLight(0, 15, 8, 0xfbbf24, 6.0, 20.0) // Summit beacon
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 7, 19, 12)) return true;

                    // ── TIER 1: Lower Staging Quarry (z <= -5) ───────────────
                    if (z <= -5 && y <= 1) return true;
                    // Lower quarry recessed side alcoves / buttresses
                    if (z <= -6 && Math.abs(x) >= 5 && y <= 4) return true;

                    // ── BARRIER 1: The Lower Bastion (z = -4) ────────────────
                    // 6-block-tall sheer wall rising to y <= 7
                    if (z === -4 && y <= 7) return true;
                    // Heavy flanking bastion pillars
                    if (z === -4 && Math.abs(x) >= 4 && y <= 11) return true;

                    // ── TIER 2: Grand Mezzanine (z from -3 to 3) ─────────────
                    // Main central deck (y <= 5)
                    if (z >= -3 && z <= 3 && y <= 5) return true;
                    // Elevated side observation galleries at y <= 8 (launch perches)
                    if (z >= -3 && z <= 3 && Math.abs(x) >= 4 && y <= 8) return true;
                    // Stepped approach stairs leading up to the side galleries
                    if (z >= -2 && z <= -1 && Math.abs(x) >= 3 && y <= 6) return true;
                    if (z >= 0 && z <= 1 && Math.abs(x) >= 3 && y <= 7) return true;

                    // ── BARRIER 2: The High Citadel Wall (z = 4 & 5) ─────────
                    // Towering 8-block fortress wall rising from y=5 to y <= 13
                    if ((z === 4 || z === 5) && y <= 13) return true;
                    // Overhead gate lintel framing the high launch aperture
                    if (z === 4 && y >= 16 && Math.abs(x) <= 3) return true;
                    // Colossal flanking gate towers (blocking gallery bypass)
                    if ((z === 4 || z === 5) && Math.abs(x) >= 4 && y <= 16) return true;

                    // ── TIER 3: Apex Summit Balcony (z >= 6) ─────────────────
                    // Elevated summit floor at y <= 12
                    if (z >= 6 && y <= 12) return true;
                    // Decorative perimeter colonnade framing the exit
                    if (z >= 7 && Math.abs(x) >= 5 && y <= 16) return true;

                    return y <= 0;
                }).build();

// LEVEL 8: THE CROSSING — The Kinetic Chasm & Sun Sanctum Citadel
        // A colossal canyon climb using ONLY a single Blue bounce block.
        // Utilizes momentum conversion (bounceForce = 18 + impactVel * 0.45) with a grand Citadel exit:
        // 1. Stage 1 (West Base -> East Terrace): Drop into the crater (y=1), bounce up
        //    to the fortified East Terrace (y=6), and retrieve the pad with the grab tool.
        // 2. Stage 2 (East Terrace -> Monolith Spire): Place the pad at y=6, climb the East
        //    Perch (y=9), and dive 3m into the pad to slingshot across onto the Monolith Spire (y=12).
        // 3. Stage 3 (Monolith Spire -> Citadel Sun Sanctum): Pull the pad up to y=12, climb to the
        //    elevated Spire Crest (y=15), and plunge into the pad to rocket across the grand abyss,
        //    threading the monumental Citadel Gate Arch into the high Sun Sanctum Altar (y=19).
        case 8:
            return builder.setBounds(9, 23, 13)
                .setSpawn(-5, 3.5, -8)
                .setExit(-5, 20.5, 9)
                .addEntity('blue', -5, 3, -6)
                .addDestructionZone(0, 8, 0, 4, 8)
                .addLight(0, 3, 0,   0xff5511, 6.0, 22.0)  // Deep canyon rift smoldering glow
                .addLight(0, 14, 0,  0x38bdf8, 5.5, 20.0)  // Monolith spire azure highlight
                .addLight(-4, 18, 3, 0xffaa44, 5.0, 16.0)  // Citadel arrival portico torch
                .addLight(-5, 21, 9, 0xffea77, 6.5, 20.0)  // Grand Altar celestial golden beacon
                .addCustomLogic((x, y, z) => {
                    // Outer chamber boundaries: interior x in [-7, 7], y in [1, 21], z in [-11, 11]
                    if (roomBox(x, y, z, 8, 22, 12)) return true;

                    // ── STAGE 1: West Canyon Base (Spawn Deck, y <= 2) ───────
                    if (x <= -4 && z <= -5 && y <= 2) return true;

                    // ── CENTRAL FRACTURED MONOLITH ───────────────────────────
                    // Crater floor staging base around the monolith (y <= 1)
                    if (Math.abs(x) <= 2 && Math.abs(z) <= 2 && y <= 1) return true;

                    // High Monolith Spire shaft (rises sheer to launch notch at y <= 12)
                    if (Math.abs(x) <= 1 && z >= -1 && z <= 2 && y <= 12) return true;

                    // Elevated Spire Crest diving perch at y <= 15 (clean 3m drop to y=12)
                    if (Math.abs(x) <= 1 && z >= -2 && z <= -1 && y <= 15) return true;

                    // ── STAGE 2: East Cliff (Terrace & Diving Perch) ─────────
                    // Main landing terrace at y <= 6 (z from -3 to 3, x in [4, 7])
                    if (x >= 4 && z >= -3 && z <= 3 && y <= 6) return true;

                    // Elevated East Diving Perch at y <= 9 (x in [5, 7], z from -4 to -1)
                    if (x >= 5 && z >= -4 && z <= -1 && y <= 9) return true;

                    // Stepped approach stairs leading up to the diving perch
                    if (x >= 4 && z >= -3 && z <= -2 && y <= 7) return true;
                    if (x >= 4 && z >= -2 && z <= -1 && y <= 8) return true;

                    // ── STAGE 3: THE HIGH CITADEL SUN SANCTUM (EXIT AREA) ────
                    // A. Cantilevered Arrival Court / Landing Terrace (y <= 16, z from 3 to 6, x in [-6, -3])
                    if (x <= -3 && x >= -6 && z >= 3 && z <= 6 && y <= 16) return true;

                    // B. Low forward parapet / safety catch (z = 3, y <= 17) to prevent sliding off
                    if (z === 3 && x <= -3 && x >= -6 && y <= 17) return true;

                    // C. Monumental Gate Arch (z = 3): Framing columns rising to y=20
                    if (z === 3 && (x === -3 || x === -6) && y <= 20) return true;
                    // Lintel beam connecting the gate columns overhead
                    if (z === 3 && x <= -3 && x >= -6 && y >= 20) return true;

                    // D. Ascending Sanctum Steps (z = 7, x in [-6, -4], y <= 17)
                    if (x <= -4 && x >= -6 && z === 7 && y <= 17) return true;

                    // E. Inner Temple Altar Floor (z >= 8, x in [-6, -4], y <= 18)
                    if (x <= -4 && x >= -6 && z >= 8 && y <= 18) return true;

                    // F. Elevated Altar Plinth (x = -5, z = 9, y <= 19) directly under the Goal
                    if (x === -5 && z === 9 && y <= 19) return true;

                    // G. Temple Shrine Pylons flanking the altar (x = -4 & -6, z = 9, rising to y=21)
                    if ((x === -4 || x === -6) && z === 9 && y <= 21) return true;

                    // Vaulted cliff canopy enclosing the inner shrine
                    if (x <= -4 && z >= 8 && y >= 22) return true;

                    // Deep abyss chasm floor
                    return y <= 0;
                }).build();

// LEVEL 9: THE ROTUNDA — Chapter 1 Climax: The Colosseum of the Oculus
        // A monumental 26m-tall Pantheon amphitheater testing extreme scale mastery (NO Blue block):
        // 1. Stage 1 (Micro-Slit Extraction): Red is locked in the West Crypt behind a barred wall.
        //    Aim through the 0.6m floor drain, shrink Red to 0.35m, and pull it out into the arena.
        // 2. Stage 2 (The Tier 2 Escalation, y=1 -> y=6): A 5m sheer wall. Assemble a stepping chain
        //    using Green (1m) and scaled Red (2.6m) to reach Tier 2, then shrink Red to hoist both up.
        // 3. Stage 3 (The Spanning Abutment, y=6 -> y=11): Drop Red into the deep moat slot and expand
        //    it to giant Scale 3.5m to create a wedged bridge slab. Cross to Tier 3 using Green as a step.
        // 4. Stage 4 (The Compound Spire Launch, y=11 -> y=17): On the Tier 3 pier, expand Red to 3.5m,
        //    mount it using Green, lift the Green Core, and leap across the final void onto the Altar
        //    beneath the radiant Oculus to complete Chapter 1!
        case 9:
            return builder.setBounds(13, 26, 13)
                .setSpawn(0, 2, -9.5)
                .setExit(0, 18.5, 0)
                .addEntity('green', 0, 2, 9.5)
                .addEntity('red', -10, 1.5, 0, { startScale: 0.9 }) // Locked inside West Crypt
                .addLight(0, 22, 0,   0xffeedd, 9.0, 30.0) // Golden celestial sunbeam pouring from the Oculus
                .addLight(0, 15, 0,   0x44ffaa, 5.5, 18.0) // Altar emerald core beacon
                .addLight(-8, 4, 0,   0xff4455, 4.5, 16.0) // West crypt red shrine torch
                .addLight(0, 4, 8,    0x44ffaa, 4.5, 16.0) // South green core shrine torch
                .addLight(8, 4, 0,    0xffaa44, 4.5, 16.0) // East colonnade torch
                .addLight(0, 4, -8,   0x38bdf8, 4.5, 16.0) // North spawn portal torch
                .addCustomLogic((x, y, z) => {
                    const rSq = x * x + z * z;
                    const r = Math.sqrt(rSq);

                    // Outer perimeter circular boundary & ceiling limits
                    if (r >= 12.0 || y <= 0 || y >= 25) return true;

                    // ── THE PANTHEON CELESTIAL DOME & OCULUS (y from 19 to 24)
                    if (y >= 19) {
                        const domeR = 12.0 - (y - 19) * 1.5;
                        // Open celestial oculus at the dome apex (r <= 2.6, y >= 22)
                        if (r >= domeR && !(y >= 22 && r <= 2.6)) return true;
                    }

                    // ── 12 MONUMENTAL FLUTED COLONNADE PILLARS ───────────────
                    // Classical columns along the perimeter (leaves cardinal portals open)
                    if (r >= 9.5 && r <= 11.5 && y <= 19) {
                        const theta = Math.atan2(z, x);
                        if (Math.abs(Math.sin(6 * theta)) > 0.65) return true;
                    }

                    // ── STAGE 1: The Locked West Crypt (Red Block Puzzle) ────
                    // Solid portcullis wall sealing the west crypt at x = -8
                    if (x === -8 && Math.abs(z) <= 2 && y <= 6) {
                        // The ONLY opening is a 0.6m micro-drainage slit at floor level:
                        if (z === 0 && y === 1) return false;
                        return true;
                    }

                    // ── TIER 4: The Central Apex Spire & Altar (r <= 1.4) ─────
                    // Monolithic stone spire rising sheer from bedrock to y <= 17
                    if (r <= 1.4 && y <= 17) return true;

                    // ── TIER 3: The Sanctuary Colonnade Ring (r in [2.4, 3.8], y <= 11)
                    if (r >= 2.4 && r <= 3.8 && y <= 11) return true;

                    // Overlook pier jutting toward the central spire on Tier 3
                    if (Math.abs(x) <= 1 && z >= -3.8 && z <= -2.4 && y <= 11) return true;

                    // Overhead anti-skip ceiling coffer ring
                    if (r >= 3.2 && r <= 4.4 && y >= 14 && y <= 15) return true;

                    // ── STAGE 3: Sunken Moat & Bridging Slot (r in [3.8, 5.2])
                    // Sunken moat floor at y <= 2
                    if (r > 3.8 && r < 5.2 && y <= 2) return true;
                    // Bridging foundation slot at z in [-1, 1] (y <= 4)
                    if (r > 3.8 && r < 5.2 && Math.abs(z) <= 1 && y <= 4) return true;

                    // ── TIER 2: Mezzanine Gallery (r in [5.2, 7.2], y <= 6) ──
                    if (r >= 5.2 && r <= 7.2 && y <= 6) return true;

                    // Sunken bedrock trench between Tier 1 and Tier 2 (r in [7.2, 7.8])
                    if (r > 7.2 && r < 7.8 && y <= 0) return true;

                    // ── TIER 1: Ambulatory Arena Floor (r in [7.8, 11.5], y <= 1)
                    if (r >= 7.8 && r <= 11.5 && y <= 1) return true;

                    // Base bedrock foundation
                    return y <= 0;
                }).build();
        default:
            return builder.build();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAPTER 2: THE ARCHIVE
// ─────────────────────────────────────────────────────────────────────────────

function getLevelParamsV2(lvl) {
    const builder = new LevelBuilder(lvl, LEVEL_NAMES[10 + lvl]);
    switch (lvl) {

        // LEVEL 0: THE SPIRAL — Mechanical Coupling
        // The block and the plate sit on opposite raised catwalks — fetch one,
        // carry it across the open floor, and place it to open the gate.
        case 0:
            return builder.setBounds(7, 10, 9)
                .setSpawn(0, 1, -5)
                .setExit(0, 2, 5)
                .addEntity('gray', -3, 2, -3)
                .addLight(0, 4, 0, 0x7df9ff, 4, 12)
                .addPlate(3, 2, -3, 1)
                .addDoor(0, 2, 0, { channel: 1, dir: 'left', width: 4, height: 4, moveDist: 3.5 })
                .addCustomLogic((() => {
                    const solids = new Set(["-6,0,-8","-6,0,-7","-6,0,-6","-6,0,-5","-6,0,-4","-6,0,-3","-6,0,-2","-6,0,-1","-6,0,0","-6,0,1","-6,0,2","-6,0,3","-6,0,4","-6,0,5","-6,0,6","-6,0,7","-6,0,8","-6,1,-8","-6,1,-7","-6,1,-6","-6,1,-5","-6,1,-4","-6,1,-3","-6,1,-2","-6,1,-1","-6,1,0","-6,1,1","-6,1,2","-6,1,3","-6,1,4","-6,1,5","-6,1,6","-6,1,7","-6,1,8","-6,2,-8","-6,2,-7","-6,2,-6","-6,2,-5","-6,2,-4","-6,2,-3","-6,2,-2","-6,2,-1","-6,2,0","-6,2,1","-6,2,2","-6,2,3","-6,2,4","-6,2,5","-6,2,6","-6,2,7","-6,2,8","-6,3,-8","-6,3,-7","-6,3,-6","-6,3,-5","-6,3,-4","-6,3,-3","-6,3,-2","-6,3,-1","-6,3,0","-6,3,1","-6,3,2","-6,3,3","-6,3,4","-6,3,5","-6,3,6","-6,3,7","-6,3,8","-6,4,-8","-6,4,-7","-6,4,-6","-6,4,-5","-6,4,-4","-6,4,-3","-6,4,-2","-6,4,-1","-6,4,0","-6,4,1","-6,4,2","-6,4,3","-6,4,4","-6,4,5","-6,4,6","-6,4,7","-6,4,8","-6,5,-8","-6,5,-7","-6,5,-6","-6,5,-5","-6,5,-4","-6,5,-3","-6,5,-2","-6,5,-1","-6,5,0","-6,5,1","-6,5,2","-6,5,3","-6,5,4","-6,5,5","-6,5,6","-6,5,7","-6,5,8","-6,6,-8","-6,6,-7","-6,6,-6","-6,6,-5","-6,6,-4","-6,6,-3","-6,6,-2","-6,6,-1","-6,6,0","-6,6,1","-6,6,2","-6,6,3","-6,6,4","-6,6,5","-6,6,6","-6,6,7","-6,6,8","-6,7,-8","-6,7,-7","-6,7,-6","-6,7,-5","-6,7,-4","-6,7,-3","-6,7,-2","-6,7,-1","-6,7,0","-6,7,1","-6,7,2","-6,7,3","-6,7,4","-6,7,5","-6,7,6","-6,7,7","-6,7,8","-6,8,-8","-6,8,-7","-6,8,-6","-6,8,-5","-6,8,-4","-6,8,-3","-6,8,-2","-6,8,-1","-6,8,0","-6,8,1","-6,8,2","-6,8,3","-6,8,4","-6,8,5","-6,8,6","-6,8,7","-6,8,8","-5,0,-8","-5,0,-7","-5,0,-6","-5,0,-5","-5,0,-4","-5,0,-3","-5,0,-2","-5,0,-1","-5,0,0","-5,0,1","-5,0,2","-5,0,3","-5,0,4","-5,0,5","-5,0,6","-5,0,7","-5,0,8","-5,1,-8","-5,1,-7","-5,1,-6","-5,1,-5","-5,1,-4","-5,1,-3","-5,1,-2","-5,1,-1","-5,1,0","-5,1,1","-5,1,2","-5,1,3","-5,1,4","-5,1,5","-5,1,6","-5,1,7","-5,1,8","-5,2,-8","-5,2,-7","-5,2,-6","-5,2,-5","-5,2,-4","-5,2,-3","-5,2,-2","-5,2,-1","-5,2,0","-5,2,1","-5,2,2","-5,2,3","-5,2,4","-5,2,5","-5,2,6","-5,2,7","-5,2,8","-5,3,-8","-5,3,-7","-5,3,-6","-5,3,-5","-5,3,-4","-5,3,-3","-5,3,-2","-5,3,-1","-5,3,0","-5,3,1","-5,3,2","-5,3,3","-5,3,4","-5,3,5","-5,3,6","-5,3,7","-5,3,8","-5,4,-8","-5,4,-7","-5,4,-6","-5,4,-5","-5,4,-4","-5,4,-3","-5,4,-2","-5,4,-1","-5,4,0","-5,4,1","-5,4,2","-5,4,3","-5,4,4","-5,4,5","-5,4,6","-5,4,7","-5,4,8","-5,5,-8","-5,5,-7","-5,5,-6","-5,5,-5","-5,5,-4","-5,5,-3","-5,5,-2","-5,5,-1","-5,5,0","-5,5,1","-5,5,2","-5,5,3","-5,5,4","-5,5,5","-5,5,6","-5,5,7","-5,5,8","-5,6,-8","-5,6,-7","-5,6,-6","-5,6,-5","-5,6,-4","-5,6,-3","-5,6,-2","-5,6,-1","-5,6,0","-5,6,1","-5,6,2","-5,6,3","-5,6,4","-5,6,5","-5,6,6","-5,6,7","-5,6,8","-5,7,-8","-5,7,-7","-5,7,-6","-5,7,-5","-5,7,-4","-5,7,-3","-5,7,-2","-5,7,-1","-5,7,0","-5,7,1","-5,7,2","-5,7,3","-5,7,4","-5,7,5","-5,7,6","-5,7,7","-5,7,8","-5,8,-8","-5,8,-7","-5,8,-6","-5,8,-5","-5,8,-4","-5,8,-3","-5,8,-2","-5,8,-1","-5,8,0","-5,8,1","-5,8,2","-5,8,3","-5,8,4","-5,8,5","-5,8,6","-5,8,7","-5,8,8","-4,0,-8","-4,0,-7","-4,0,-6","-4,0,-5","-4,0,-4","-4,0,-3","-4,0,-2","-4,0,-1","-4,0,0","-4,0,1","-4,0,2","-4,0,3","-4,0,4","-4,0,5","-4,0,6","-4,0,7","-4,0,8","-4,1,-8","-4,1,-7","-4,1,-6","-4,1,-5","-4,1,-4","-4,1,-3","-4,1,-2","-4,1,0","-4,1,7","-4,1,8","-4,2,-8","-4,2,-7","-4,2,0","-4,2,7","-4,2,8","-4,3,-8","-4,3,-7","-4,3,0","-4,3,7","-4,3,8","-4,4,-8","-4,4,-7","-4,4,0","-4,4,7","-4,4,8","-4,5,-8","-4,5,-7","-4,5,0","-4,5,7","-4,5,8","-4,6,-8","-4,6,-7","-4,6,0","-4,6,7","-4,6,8","-4,7,-8","-4,7,-7","-4,7,-6","-4,7,-5","-4,7,-4","-4,7,-3","-4,7,-2","-4,7,-1","-4,7,0","-4,7,1","-4,7,2","-4,7,3","-4,7,4","-4,7,5","-4,7,6","-4,7,7","-4,7,8","-4,8,-8","-4,8,-7","-4,8,-6","-4,8,-5","-4,8,-4","-4,8,-3","-4,8,-2","-4,8,-1","-4,8,0","-4,8,1","-4,8,2","-4,8,3","-4,8,4","-4,8,5","-4,8,6","-4,8,7","-4,8,8","-3,0,-8","-3,0,-7","-3,0,-6","-3,0,-5","-3,0,-4","-3,0,-3","-3,0,-2","-3,0,-1","-3,0,0","-3,0,1","-3,0,2","-3,0,3","-3,0,4","-3,0,5","-3,0,6","-3,0,7","-3,0,8","-3,1,-8","-3,1,-7","-3,1,-6","-3,1,-5","-3,1,-4","-3,1,-3","-3,1,-2","-3,1,0","-3,1,7","-3,1,8","-3,2,-8","-3,2,-7","-3,2,0","-3,2,7","-3,2,8","-3,3,-8","-3,3,-7","-3,3,0","-3,3,7","-3,3,8","-3,4,-8","-3,4,-7","-3,4,0","-3,4,7","-3,4,8","-3,5,-8","-3,5,-7","-3,5,0","-3,5,7","-3,5,8","-3,6,-8","-3,6,-7","-3,6,0","-3,6,7","-3,6,8","-3,7,-8","-3,7,-7","-3,7,-6","-3,7,-5","-3,7,-4","-3,7,-3","-3,7,-2","-3,7,-1","-3,7,0","-3,7,1","-3,7,2","-3,7,3","-3,7,4","-3,7,5","-3,7,6","-3,7,7","-3,7,8","-3,8,-8","-3,8,-7","-3,8,-6","-3,8,-5","-3,8,-4","-3,8,-3","-3,8,-2","-3,8,-1","-3,8,0","-3,8,1","-3,8,2","-3,8,3","-3,8,4","-3,8,5","-3,8,6","-3,8,7","-3,8,8","-2,0,-8","-2,0,-7","-2,0,-6","-2,0,-5","-2,0,-4","-2,0,-3","-2,0,-2","-2,0,-1","-2,0,0","-2,0,1","-2,0,2","-2,0,3","-2,0,4","-2,0,5","-2,0,6","-2,0,7","-2,0,8","-2,1,-8","-2,1,-7","-2,1,-6","-2,1,-5","-2,1,-4","-2,1,-3","-2,1,-2","-2,1,0","-2,1,7","-2,1,8","-2,2,-8","-2,2,-7","-2,2,0","-2,2,7","-2,2,8","-2,3,-8","-2,3,-7","-2,3,0","-2,3,7","-2,3,8","-2,4,-8","-2,4,-7","-2,4,0","-2,4,7","-2,4,8","-2,5,-8","-2,5,-7","-2,5,0","-2,5,7","-2,5,8","-2,6,-8","-2,6,-7","-2,6,0","-2,6,7","-2,6,8","-2,7,-8","-2,7,-7","-2,7,-6","-2,7,-5","-2,7,-4","-2,7,-3","-2,7,-2","-2,7,-1","-2,7,0","-2,7,1","-2,7,2","-2,7,3","-2,7,4","-2,7,5","-2,7,6","-2,7,7","-2,7,8","-2,8,-8","-2,8,-7","-2,8,-6","-2,8,-5","-2,8,-4","-2,8,-3","-2,8,-2","-2,8,-1","-2,8,0","-2,8,1","-2,8,2","-2,8,3","-2,8,4","-2,8,5","-2,8,6","-2,8,7","-2,8,8","-1,0,-8","-1,0,-7","-1,0,-6","-1,0,-5","-1,0,-4","-1,0,-3","-1,0,-2","-1,0,-1","-1,0,0","-1,0,1","-1,0,2","-1,0,3","-1,0,4","-1,0,5","-1,0,6","-1,0,7","-1,0,8","-1,1,-8","-1,1,-7","-1,1,7","-1,1,8","-1,2,-8","-1,2,-7","-1,2,7","-1,2,8","-1,3,-8","-1,3,-7","-1,3,7","-1,3,8","-1,4,-8","-1,4,-7","-1,4,7","-1,4,8","-1,5,-8","-1,5,-7","-1,5,7","-1,5,8","-1,6,-8","-1,6,-7","-1,6,7","-1,6,8","-1,7,-8","-1,7,-7","-1,7,-6","-1,7,-5","-1,7,-4","-1,7,-3","-1,7,-2","-1,7,-1","-1,7,0","-1,7,1","-1,7,2","-1,7,3","-1,7,4","-1,7,5","-1,7,6","-1,7,7","-1,7,8","-1,8,-8","-1,8,-7","-1,8,-6","-1,8,-5","-1,8,-4","-1,8,-3","-1,8,-2","-1,8,-1","-1,8,0","-1,8,1","-1,8,2","-1,8,3","-1,8,4","-1,8,5","-1,8,6","-1,8,7","-1,8,8","0,0,-8","0,0,-7","0,0,-6","0,0,-5","0,0,-4","0,0,-3","0,0,-2","0,0,-1","0,0,0","0,0,1","0,0,2","0,0,3","0,0,4","0,0,5","0,0,6","0,0,7","0,0,8","0,1,-8","0,1,-7","0,1,7","0,1,8","0,2,-8","0,2,-7","0,2,7","0,2,8","0,3,-8","0,3,-7","0,3,7","0,3,8","0,4,-8","0,4,-7","0,4,7","0,4,8","0,5,-8","0,5,-7","0,5,7","0,5,8","0,6,-8","0,6,-7","0,6,7","0,6,8","0,7,-8","0,7,-7","0,7,-6","0,7,-5","0,7,-4","0,7,-3","0,7,-2","0,7,-1","0,7,0","0,7,1","0,7,2","0,7,3","0,7,4","0,7,5","0,7,6","0,7,7","0,7,8","0,8,-8","0,8,-7","0,8,-6","0,8,-5","0,8,-4","0,8,-3","0,8,-2","0,8,-1","0,8,0","0,8,1","0,8,2","0,8,3","0,8,4","0,8,5","0,8,6","0,8,7","0,8,8","1,0,-8","1,0,-7","1,0,-6","1,0,-5","1,0,-4","1,0,-3","1,0,-2","1,0,-1","1,0,0","1,0,1","1,0,2","1,0,3","1,0,4","1,0,5","1,0,6","1,0,7","1,0,8","1,1,-8","1,1,-7","1,1,7","1,1,8","1,2,-8","1,2,-7","1,2,7","1,2,8","1,3,-8","1,3,-7","1,3,7","1,3,8","1,4,-8","1,4,-7","1,4,7","1,4,8","1,5,-8","1,5,-7","1,5,7","1,5,8","1,6,-8","1,6,-7","1,6,7","1,6,8","1,7,-8","1,7,-7","1,7,-6","1,7,-5","1,7,-4","1,7,-3","1,7,-2","1,7,-1","1,7,0","1,7,1","1,7,2","1,7,3","1,7,4","1,7,5","1,7,6","1,7,7","1,7,8","1,8,-8","1,8,-7","1,8,-6","1,8,-5","1,8,-4","1,8,-3","1,8,-2","1,8,-1","1,8,0","1,8,1","1,8,2","1,8,3","1,8,4","1,8,5","1,8,6","1,8,7","1,8,8","2,0,-8","2,0,-7","2,0,-6","2,0,-5","2,0,-4","2,0,-3","2,0,-2","2,0,-1","2,0,0","2,0,1","2,0,2","2,0,3","2,0,4","2,0,5","2,0,6","2,0,7","2,0,8","2,1,-8","2,1,-7","2,1,-6","2,1,-5","2,1,-4","2,1,-3","2,1,-2","2,1,0","2,1,7","2,1,8","2,2,-8","2,2,-7","2,2,0","2,2,7","2,2,8","2,3,-8","2,3,-7","2,3,0","2,3,7","2,3,8","2,4,-8","2,4,-7","2,4,0","2,4,7","2,4,8","2,5,-8","2,5,-7","2,5,0","2,5,7","2,5,8","2,6,-8","2,6,-7","2,6,0","2,6,7","2,6,8","2,7,-8","2,7,-7","2,7,-6","2,7,-5","2,7,-4","2,7,-3","2,7,-2","2,7,-1","2,7,0","2,7,1","2,7,2","2,7,3","2,7,4","2,7,5","2,7,6","2,7,7","2,7,8","2,8,-8","2,8,-7","2,8,-6","2,8,-5","2,8,-4","2,8,-3","2,8,-2","2,8,-1","2,8,0","2,8,1","2,8,2","2,8,3","2,8,4","2,8,5","2,8,6","2,8,7","2,8,8","3,0,-8","3,0,-7","3,0,-6","3,0,-5","3,0,-4","3,0,-3","3,0,-2","3,0,-1","3,0,0","3,0,1","3,0,2","3,0,3","3,0,4","3,0,5","3,0,6","3,0,7","3,0,8","3,1,-8","3,1,-7","3,1,-6","3,1,-5","3,1,-4","3,1,-3","3,1,-2","3,1,0","3,1,7","3,1,8","3,2,-8","3,2,-7","3,2,0","3,2,7","3,2,8","3,3,-8","3,3,-7","3,3,0","3,3,7","3,3,8","3,4,-8","3,4,-7","3,4,0","3,4,7","3,4,8","3,5,-8","3,5,-7","3,5,0","3,5,7","3,5,8","3,6,-8","3,6,-7","3,6,0","3,6,7","3,6,8","3,7,-8","3,7,-7","3,7,-6","3,7,-5","3,7,-4","3,7,-3","3,7,-2","3,7,-1","3,7,0","3,7,1","3,7,2","3,7,3","3,7,4","3,7,5","3,7,6","3,7,7","3,7,8","3,8,-8","3,8,-7","3,8,-6","3,8,-5","3,8,-4","3,8,-3","3,8,-2","3,8,-1","3,8,0","3,8,1","3,8,2","3,8,3","3,8,4","3,8,5","3,8,6","3,8,7","3,8,8","4,0,-8","4,0,-7","4,0,-6","4,0,-5","4,0,-4","4,0,-3","4,0,-2","4,0,-1","4,0,0","4,0,1","4,0,2","4,0,3","4,0,4","4,0,5","4,0,6","4,0,7","4,0,8","4,1,-8","4,1,-7","4,1,-6","4,1,-5","4,1,-4","4,1,-3","4,1,-2","4,1,0","4,1,7","4,1,8","4,2,-8","4,2,-7","4,2,0","4,2,7","4,2,8","4,3,-8","4,3,-7","4,3,0","4,3,7","4,3,8","4,4,-8","4,4,-7","4,4,0","4,4,7","4,4,8","4,5,-8","4,5,-7","4,5,0","4,5,7","4,5,8","4,6,-8","4,6,-7","4,6,0","4,6,7","4,6,8","4,7,-8","4,7,-7","4,7,-6","4,7,-5","4,7,-4","4,7,-3","4,7,-2","4,7,-1","4,7,0","4,7,1","4,7,2","4,7,3","4,7,4","4,7,5","4,7,6","4,7,7","4,7,8","4,8,-8","4,8,-7","4,8,-6","4,8,-5","4,8,-4","4,8,-3","4,8,-2","4,8,-1","4,8,0","4,8,1","4,8,2","4,8,3","4,8,4","4,8,5","4,8,6","4,8,7","4,8,8","5,0,-8","5,0,-7","5,0,-6","5,0,-5","5,0,-4","5,0,-3","5,0,-2","5,0,-1","5,0,0","5,0,1","5,0,2","5,0,3","5,0,4","5,0,5","5,0,6","5,0,7","5,0,8","5,1,-8","5,1,-7","5,1,-6","5,1,-5","5,1,-4","5,1,-3","5,1,-2","5,1,-1","5,1,0","5,1,1","5,1,2","5,1,3","5,1,4","5,1,5","5,1,6","5,1,7","5,1,8","5,2,-8","5,2,-7","5,2,-6","5,2,-5","5,2,-4","5,2,-3","5,2,-2","5,2,-1","5,2,0","5,2,1","5,2,2","5,2,3","5,2,4","5,2,5","5,2,6","5,2,7","5,2,8","5,3,-8","5,3,-7","5,3,-6","5,3,-5","5,3,-4","5,3,-3","5,3,-2","5,3,-1","5,3,0","5,3,1","5,3,2","5,3,3","5,3,4","5,3,5","5,3,6","5,3,7","5,3,8","5,4,-8","5,4,-7","5,4,-6","5,4,-5","5,4,-4","5,4,-3","5,4,-2","5,4,-1","5,4,0","5,4,1","5,4,2","5,4,3","5,4,4","5,4,5","5,4,6","5,4,7","5,4,8","5,5,-8","5,5,-7","5,5,-6","5,5,-5","5,5,-4","5,5,-3","5,5,-2","5,5,-1","5,5,0","5,5,1","5,5,2","5,5,3","5,5,4","5,5,5","5,5,6","5,5,7","5,5,8","5,6,-8","5,6,-7","5,6,-6","5,6,-5","5,6,-4","5,6,-3","5,6,-2","5,6,-1","5,6,0","5,6,1","5,6,2","5,6,3","5,6,4","5,6,5","5,6,6","5,6,7","5,6,8","5,7,-8","5,7,-7","5,7,-6","5,7,-5","5,7,-4","5,7,-3","5,7,-2","5,7,-1","5,7,0","5,7,1","5,7,2","5,7,3","5,7,4","5,7,5","5,7,6","5,7,7","5,7,8","5,8,-8","5,8,-7","5,8,-6","5,8,-5","5,8,-4","5,8,-3","5,8,-2","5,8,-1","5,8,0","5,8,1","5,8,2","5,8,3","5,8,4","5,8,5","5,8,6","5,8,7","5,8,8","6,0,-8","6,0,-7","6,0,-6","6,0,-5","6,0,-4","6,0,-3","6,0,-2","6,0,-1","6,0,0","6,0,1","6,0,2","6,0,3","6,0,4","6,0,5","6,0,6","6,0,7","6,0,8","6,1,-8","6,1,-7","6,1,-6","6,1,-5","6,1,-4","6,1,-3","6,1,-2","6,1,-1","6,1,0","6,1,1","6,1,2","6,1,3","6,1,4","6,1,5","6,1,6","6,1,7","6,1,8","6,2,-8","6,2,-7","6,2,-6","6,2,-5","6,2,-4","6,2,-3","6,2,-2","6,2,-1","6,2,0","6,2,1","6,2,2","6,2,3","6,2,4","6,2,5","6,2,6","6,2,7","6,2,8","6,3,-8","6,3,-7","6,3,-6","6,3,-5","6,3,-4","6,3,-3","6,3,-2","6,3,-1","6,3,0","6,3,1","6,3,2","6,3,3","6,3,4","6,3,5","6,3,6","6,3,7","6,3,8","6,4,-8","6,4,-7","6,4,-6","6,4,-5","6,4,-4","6,4,-3","6,4,-2","6,4,-1","6,4,0","6,4,1","6,4,2","6,4,3","6,4,4","6,4,5","6,4,6","6,4,7","6,4,8","6,5,-8","6,5,-7","6,5,-6","6,5,-5","6,5,-4","6,5,-3","6,5,-2","6,5,-1","6,5,0","6,5,1","6,5,2","6,5,3","6,5,4","6,5,5","6,5,6","6,5,7","6,5,8","6,6,-8","6,6,-7","6,6,-6","6,6,-5","6,6,-4","6,6,-3","6,6,-2","6,6,-1","6,6,0","6,6,1","6,6,2","6,6,3","6,6,4","6,6,5","6,6,6","6,6,7","6,6,8","6,7,-8","6,7,-7","6,7,-6","6,7,-5","6,7,-4","6,7,-3","6,7,-2","6,7,-1","6,7,0","6,7,1","6,7,2","6,7,3","6,7,4","6,7,5","6,7,6","6,7,7","6,7,8","6,8,-8","6,8,-7","6,8,-6","6,8,-5","6,8,-4","6,8,-3","6,8,-2","6,8,-1","6,8,0","6,8,1","6,8,2","6,8,3","6,8,4","6,8,5","6,8,6","6,8,7","6,8,8","-1,6,0","-1,5,0","0,6,0","0,5,0","1,6,0","1,5,0"]);
                    return (x, y, z) => solids.has(x + ',' + y + ',' + z);
                })()).build();

        // LEVEL 1: THE INTERLOCK — Boolean AND Logic
        // Two plates on opposite side ledges over an open pit, each needing its
        // own block held down at the same time.
        case 1:
            return builder.setBounds(8, 10, 9)
                .setSpawn(0, 1, -5)
                .setExit(0, 2, 5)
                .addEntity('gray', -4, 2, -3)
                .addEntity('blue', 4, 2, -3)
                .addLight(0, 4, 0, 0x4ade80, 4, 14)
                .addPlate(-4, 2, 0, 1)
                .addPlate(4, 2, 0, 2)
                .addDoor(0, 2, 2, { channel: 3, dir: 'up', width: 3.5, height: 4, moveDist: 3.5 })
                .addLogicGate(3, 'AND', [1,2])
                .addCustomLogic((() => {
                    const solids = new Set(["-7,0,-8","-7,0,-7","-7,0,-6","-7,0,-5","-7,0,-4","-7,0,-3","-7,0,-2","-7,0,-1","-7,0,0","-7,0,1","-7,0,2","-7,0,3","-7,0,4","-7,0,5","-7,0,6","-7,0,7","-7,0,8","-7,1,-8","-7,1,-7","-7,1,-6","-7,1,-5","-7,1,-4","-7,1,-3","-7,1,-2","-7,1,-1","-7,1,0","-7,1,1","-7,1,2","-7,1,3","-7,1,4","-7,1,5","-7,1,6","-7,1,7","-7,1,8","-7,2,-8","-7,2,-7","-7,2,-6","-7,2,-5","-7,2,-4","-7,2,-3","-7,2,-2","-7,2,-1","-7,2,0","-7,2,1","-7,2,2","-7,2,3","-7,2,4","-7,2,5","-7,2,6","-7,2,7","-7,2,8","-7,3,-8","-7,3,-7","-7,3,-6","-7,3,-5","-7,3,-4","-7,3,-3","-7,3,-2","-7,3,-1","-7,3,0","-7,3,1","-7,3,2","-7,3,3","-7,3,4","-7,3,5","-7,3,6","-7,3,7","-7,3,8","-7,4,-8","-7,4,-7","-7,4,-6","-7,4,-5","-7,4,-4","-7,4,-3","-7,4,-2","-7,4,-1","-7,4,0","-7,4,1","-7,4,2","-7,4,3","-7,4,4","-7,4,5","-7,4,6","-7,4,7","-7,4,8","-7,5,-8","-7,5,-7","-7,5,-6","-7,5,-5","-7,5,-4","-7,5,-3","-7,5,-2","-7,5,-1","-7,5,0","-7,5,1","-7,5,2","-7,5,3","-7,5,4","-7,5,5","-7,5,6","-7,5,7","-7,5,8","-7,6,-8","-7,6,-7","-7,6,-6","-7,6,-5","-7,6,-4","-7,6,-3","-7,6,-2","-7,6,-1","-7,6,0","-7,6,1","-7,6,2","-7,6,3","-7,6,4","-7,6,5","-7,6,6","-7,6,7","-7,6,8","-7,7,-8","-7,7,-7","-7,7,-6","-7,7,-5","-7,7,-4","-7,7,-3","-7,7,-2","-7,7,-1","-7,7,0","-7,7,1","-7,7,2","-7,7,3","-7,7,4","-7,7,5","-7,7,6","-7,7,7","-7,7,8","-7,8,-8","-7,8,-7","-7,8,-6","-7,8,-5","-7,8,-4","-7,8,-3","-7,8,-2","-7,8,-1","-7,8,0","-7,8,1","-7,8,2","-7,8,3","-7,8,4","-7,8,5","-7,8,6","-7,8,7","-7,8,8","-6,0,-8","-6,0,-7","-6,0,-6","-6,0,-5","-6,0,-4","-6,0,-3","-6,0,-2","-6,0,-1","-6,0,0","-6,0,1","-6,0,2","-6,0,3","-6,0,4","-6,0,5","-6,0,6","-6,0,7","-6,0,8","-6,1,-8","-6,1,-7","-6,1,-6","-6,1,-5","-6,1,-4","-6,1,-3","-6,1,-2","-6,1,-1","-6,1,0","-6,1,1","-6,1,2","-6,1,3","-6,1,4","-6,1,5","-6,1,6","-6,1,7","-6,1,8","-6,2,-8","-6,2,-7","-6,2,-6","-6,2,-5","-6,2,-4","-6,2,-3","-6,2,-2","-6,2,-1","-6,2,0","-6,2,1","-6,2,2","-6,2,3","-6,2,4","-6,2,5","-6,2,6","-6,2,7","-6,2,8","-6,3,-8","-6,3,-7","-6,3,-6","-6,3,-5","-6,3,-4","-6,3,-3","-6,3,-2","-6,3,-1","-6,3,0","-6,3,1","-6,3,2","-6,3,3","-6,3,4","-6,3,5","-6,3,6","-6,3,7","-6,3,8","-6,4,-8","-6,4,-7","-6,4,-6","-6,4,-5","-6,4,-4","-6,4,-3","-6,4,-2","-6,4,-1","-6,4,0","-6,4,1","-6,4,2","-6,4,3","-6,4,4","-6,4,5","-6,4,6","-6,4,7","-6,4,8","-6,5,-8","-6,5,-7","-6,5,-6","-6,5,-5","-6,5,-4","-6,5,-3","-6,5,-2","-6,5,-1","-6,5,0","-6,5,1","-6,5,2","-6,5,3","-6,5,4","-6,5,5","-6,5,6","-6,5,7","-6,5,8","-6,6,-8","-6,6,-7","-6,6,-6","-6,6,-5","-6,6,-4","-6,6,-3","-6,6,-2","-6,6,-1","-6,6,0","-6,6,1","-6,6,2","-6,6,3","-6,6,4","-6,6,5","-6,6,6","-6,6,7","-6,6,8","-6,7,-8","-6,7,-7","-6,7,-6","-6,7,-5","-6,7,-4","-6,7,-3","-6,7,-2","-6,7,-1","-6,7,0","-6,7,1","-6,7,2","-6,7,3","-6,7,4","-6,7,5","-6,7,6","-6,7,7","-6,7,8","-6,8,-8","-6,8,-7","-6,8,-6","-6,8,-5","-6,8,-4","-6,8,-3","-6,8,-2","-6,8,-1","-6,8,0","-6,8,1","-6,8,2","-6,8,3","-6,8,4","-6,8,5","-6,8,6","-6,8,7","-6,8,8","-5,0,-8","-5,0,-7","-5,0,-6","-5,0,-5","-5,0,-4","-5,0,-3","-5,0,-2","-5,0,-1","-5,0,0","-5,0,1","-5,0,2","-5,0,3","-5,0,4","-5,0,5","-5,0,6","-5,0,7","-5,0,8","-5,1,-8","-5,1,-7","-5,1,-6","-5,1,-5","-5,1,-4","-5,1,-3","-5,1,-2","-5,1,-1","-5,1,0","-5,1,1","-5,1,2","-5,1,3","-5,1,4","-5,1,5","-5,1,6","-5,1,7","-5,1,8","-5,2,-8","-5,2,-7","-5,2,2","-5,2,7","-5,2,8","-5,3,-8","-5,3,-7","-5,3,2","-5,3,7","-5,3,8","-5,4,-8","-5,4,-7","-5,4,2","-5,4,7","-5,4,8","-5,5,-8","-5,5,-7","-5,5,2","-5,5,7","-5,5,8","-5,6,-8","-5,6,-7","-5,6,2","-5,6,7","-5,6,8","-5,7,-8","-5,7,-7","-5,7,-6","-5,7,-5","-5,7,-4","-5,7,-3","-5,7,-2","-5,7,-1","-5,7,0","-5,7,1","-5,7,2","-5,7,3","-5,7,4","-5,7,5","-5,7,6","-5,7,7","-5,7,8","-5,8,-8","-5,8,-7","-5,8,-6","-5,8,-5","-5,8,-4","-5,8,-3","-5,8,-2","-5,8,-1","-5,8,0","-5,8,1","-5,8,2","-5,8,3","-5,8,4","-5,8,5","-5,8,6","-5,8,7","-5,8,8","-4,0,-8","-4,0,-7","-4,0,-6","-4,0,-5","-4,0,-4","-4,0,-3","-4,0,-2","-4,0,-1","-4,0,0","-4,0,1","-4,0,2","-4,0,3","-4,0,4","-4,0,5","-4,0,6","-4,0,7","-4,0,8","-4,1,-8","-4,1,-7","-4,1,-6","-4,1,-5","-4,1,-4","-4,1,-3","-4,1,-2","-4,1,-1","-4,1,0","-4,1,1","-4,1,2","-4,1,3","-4,1,4","-4,1,5","-4,1,6","-4,1,7","-4,1,8","-4,2,-8","-4,2,-7","-4,2,2","-4,2,7","-4,2,8","-4,3,-8","-4,3,-7","-4,3,2","-4,3,7","-4,3,8","-4,4,-8","-4,4,-7","-4,4,2","-4,4,7","-4,4,8","-4,5,-8","-4,5,-7","-4,5,2","-4,5,7","-4,5,8","-4,6,-8","-4,6,-7","-4,6,2","-4,6,7","-4,6,8","-4,7,-8","-4,7,-7","-4,7,-6","-4,7,-5","-4,7,-4","-4,7,-3","-4,7,-2","-4,7,-1","-4,7,0","-4,7,1","-4,7,2","-4,7,3","-4,7,4","-4,7,5","-4,7,6","-4,7,7","-4,7,8","-4,8,-8","-4,8,-7","-4,8,-6","-4,8,-5","-4,8,-4","-4,8,-3","-4,8,-2","-4,8,-1","-4,8,0","-4,8,1","-4,8,2","-4,8,3","-4,8,4","-4,8,5","-4,8,6","-4,8,7","-4,8,8","-3,0,-8","-3,0,-7","-3,0,-6","-3,0,-5","-3,0,-4","-3,0,-3","-3,0,-2","-3,0,-1","-3,0,0","-3,0,1","-3,0,2","-3,0,3","-3,0,4","-3,0,5","-3,0,6","-3,0,7","-3,0,8","-3,1,-8","-3,1,-7","-3,1,-6","-3,1,-5","-3,1,-4","-3,1,-3","-3,1,-2","-3,1,-1","-3,1,0","-3,1,1","-3,1,2","-3,1,3","-3,1,4","-3,1,5","-3,1,6","-3,1,7","-3,1,8","-3,2,-8","-3,2,-7","-3,2,2","-3,2,7","-3,2,8","-3,3,-8","-3,3,-7","-3,3,2","-3,3,7","-3,3,8","-3,4,-8","-3,4,-7","-3,4,2","-3,4,7","-3,4,8","-3,5,-8","-3,5,-7","-3,5,2","-3,5,7","-3,5,8","-3,6,-8","-3,6,-7","-3,6,2","-3,6,7","-3,6,8","-3,7,-8","-3,7,-7","-3,7,-6","-3,7,-5","-3,7,-4","-3,7,-3","-3,7,-2","-3,7,-1","-3,7,0","-3,7,1","-3,7,2","-3,7,3","-3,7,4","-3,7,5","-3,7,6","-3,7,7","-3,7,8","-3,8,-8","-3,8,-7","-3,8,-6","-3,8,-5","-3,8,-4","-3,8,-3","-3,8,-2","-3,8,-1","-3,8,0","-3,8,1","-3,8,2","-3,8,3","-3,8,4","-3,8,5","-3,8,6","-3,8,7","-3,8,8","-2,0,-8","-2,0,-7","-2,0,-6","-2,0,-5","-2,0,-4","-2,0,-3","-2,0,-2","-2,0,-1","-2,0,0","-2,0,1","-2,0,2","-2,0,3","-2,0,4","-2,0,5","-2,0,6","-2,0,7","-2,0,8","-2,1,-8","-2,1,-7","-2,1,2","-2,1,7","-2,1,8","-2,2,-8","-2,2,-7","-2,2,2","-2,2,7","-2,2,8","-2,3,-8","-2,3,-7","-2,3,2","-2,3,7","-2,3,8","-2,4,-8","-2,4,-7","-2,4,2","-2,4,7","-2,4,8","-2,5,-8","-2,5,-7","-2,5,2","-2,5,7","-2,5,8","-2,6,-8","-2,6,-7","-2,6,2","-2,6,7","-2,6,8","-2,7,-8","-2,7,-7","-2,7,-6","-2,7,-5","-2,7,-4","-2,7,-3","-2,7,-2","-2,7,-1","-2,7,0","-2,7,1","-2,7,2","-2,7,3","-2,7,4","-2,7,5","-2,7,6","-2,7,7","-2,7,8","-2,8,-8","-2,8,-7","-2,8,-6","-2,8,-5","-2,8,-4","-2,8,-3","-2,8,-2","-2,8,-1","-2,8,0","-2,8,1","-2,8,2","-2,8,3","-2,8,4","-2,8,5","-2,8,6","-2,8,7","-2,8,8","-1,0,-8","-1,0,-7","-1,0,-6","-1,0,-5","-1,0,-4","-1,0,-3","-1,0,-2","-1,0,-1","-1,0,0","-1,0,1","-1,0,2","-1,0,3","-1,0,4","-1,0,5","-1,0,6","-1,0,7","-1,0,8","-1,1,-8","-1,1,-7","-1,1,7","-1,1,8","-1,2,-8","-1,2,-7","-1,2,7","-1,2,8","-1,3,-8","-1,3,-7","-1,3,7","-1,3,8","-1,4,-8","-1,4,-7","-1,4,7","-1,4,8","-1,5,-8","-1,5,-7","-1,5,7","-1,5,8","-1,6,-8","-1,6,-7","-1,6,7","-1,6,8","-1,7,-8","-1,7,-7","-1,7,-6","-1,7,-5","-1,7,-4","-1,7,-3","-1,7,-2","-1,7,-1","-1,7,0","-1,7,1","-1,7,2","-1,7,3","-1,7,4","-1,7,5","-1,7,6","-1,7,7","-1,7,8","-1,8,-8","-1,8,-7","-1,8,-6","-1,8,-5","-1,8,-4","-1,8,-3","-1,8,-2","-1,8,-1","-1,8,0","-1,8,1","-1,8,2","-1,8,3","-1,8,4","-1,8,5","-1,8,6","-1,8,7","-1,8,8","0,0,-8","0,0,-7","0,0,-6","0,0,-5","0,0,-4","0,0,-3","0,0,-2","0,0,-1","0,0,0","0,0,1","0,0,2","0,0,3","0,0,4","0,0,5","0,0,6","0,0,7","0,0,8","0,1,-8","0,1,-7","0,1,7","0,1,8","0,2,-8","0,2,-7","0,2,7","0,2,8","0,3,-8","0,3,-7","0,3,7","0,3,8","0,4,-8","0,4,-7","0,4,7","0,4,8","0,5,-8","0,5,-7","0,5,7","0,5,8","0,6,-8","0,6,-7","0,6,7","0,6,8","0,7,-8","0,7,-7","0,7,-6","0,7,-5","0,7,-4","0,7,-3","0,7,-2","0,7,-1","0,7,0","0,7,1","0,7,2","0,7,3","0,7,4","0,7,5","0,7,6","0,7,7","0,7,8","0,8,-8","0,8,-7","0,8,-6","0,8,-5","0,8,-4","0,8,-3","0,8,-2","0,8,-1","0,8,0","0,8,1","0,8,2","0,8,3","0,8,4","0,8,5","0,8,6","0,8,7","0,8,8","1,0,-8","1,0,-7","1,0,-6","1,0,-5","1,0,-4","1,0,-3","1,0,-2","1,0,-1","1,0,0","1,0,1","1,0,2","1,0,3","1,0,4","1,0,5","1,0,6","1,0,7","1,0,8","1,1,-8","1,1,-7","1,1,7","1,1,8","1,2,-8","1,2,-7","1,2,7","1,2,8","1,3,-8","1,3,-7","1,3,7","1,3,8","1,4,-8","1,4,-7","1,4,7","1,4,8","1,5,-8","1,5,-7","1,5,7","1,5,8","1,6,-8","1,6,-7","1,6,7","1,6,8","1,7,-8","1,7,-7","1,7,-6","1,7,-5","1,7,-4","1,7,-3","1,7,-2","1,7,-1","1,7,0","1,7,1","1,7,2","1,7,3","1,7,4","1,7,5","1,7,6","1,7,7","1,7,8","1,8,-8","1,8,-7","1,8,-6","1,8,-5","1,8,-4","1,8,-3","1,8,-2","1,8,-1","1,8,0","1,8,1","1,8,2","1,8,3","1,8,4","1,8,5","1,8,6","1,8,7","1,8,8","2,0,-8","2,0,-7","2,0,-6","2,0,-5","2,0,-4","2,0,-3","2,0,-2","2,0,-1","2,0,0","2,0,1","2,0,2","2,0,3","2,0,4","2,0,5","2,0,6","2,0,7","2,0,8","2,1,-8","2,1,-7","2,1,2","2,1,7","2,1,8","2,2,-8","2,2,-7","2,2,2","2,2,7","2,2,8","2,3,-8","2,3,-7","2,3,2","2,3,7","2,3,8","2,4,-8","2,4,-7","2,4,2","2,4,7","2,4,8","2,5,-8","2,5,-7","2,5,2","2,5,7","2,5,8","2,6,-8","2,6,-7","2,6,2","2,6,7","2,6,8","2,7,-8","2,7,-7","2,7,-6","2,7,-5","2,7,-4","2,7,-3","2,7,-2","2,7,-1","2,7,0","2,7,1","2,7,2","2,7,3","2,7,4","2,7,5","2,7,6","2,7,7","2,7,8","2,8,-8","2,8,-7","2,8,-6","2,8,-5","2,8,-4","2,8,-3","2,8,-2","2,8,-1","2,8,0","2,8,1","2,8,2","2,8,3","2,8,4","2,8,5","2,8,6","2,8,7","2,8,8","3,0,-8","3,0,-7","3,0,-6","3,0,-5","3,0,-4","3,0,-3","3,0,-2","3,0,-1","3,0,0","3,0,1","3,0,2","3,0,3","3,0,4","3,0,5","3,0,6","3,0,7","3,0,8","3,1,-8","3,1,-7","3,1,-6","3,1,-5","3,1,-4","3,1,-3","3,1,-2","3,1,-1","3,1,0","3,1,1","3,1,2","3,1,3","3,1,4","3,1,5","3,1,6","3,1,7","3,1,8","3,2,-8","3,2,-7","3,2,2","3,2,7","3,2,8","3,3,-8","3,3,-7","3,3,2","3,3,7","3,3,8","3,4,-8","3,4,-7","3,4,2","3,4,7","3,4,8","3,5,-8","3,5,-7","3,5,2","3,5,7","3,5,8","3,6,-8","3,6,-7","3,6,2","3,6,7","3,6,8","3,7,-8","3,7,-7","3,7,-6","3,7,-5","3,7,-4","3,7,-3","3,7,-2","3,7,-1","3,7,0","3,7,1","3,7,2","3,7,3","3,7,4","3,7,5","3,7,6","3,7,7","3,7,8","3,8,-8","3,8,-7","3,8,-6","3,8,-5","3,8,-4","3,8,-3","3,8,-2","3,8,-1","3,8,0","3,8,1","3,8,2","3,8,3","3,8,4","3,8,5","3,8,6","3,8,7","3,8,8","4,0,-8","4,0,-7","4,0,-6","4,0,-5","4,0,-4","4,0,-3","4,0,-2","4,0,-1","4,0,0","4,0,1","4,0,2","4,0,3","4,0,4","4,0,5","4,0,6","4,0,7","4,0,8","4,1,-8","4,1,-7","4,1,-6","4,1,-5","4,1,-4","4,1,-3","4,1,-2","4,1,-1","4,1,0","4,1,1","4,1,2","4,1,3","4,1,4","4,1,5","4,1,6","4,1,7","4,1,8","4,2,-8","4,2,-7","4,2,2","4,2,7","4,2,8","4,3,-8","4,3,-7","4,3,2","4,3,7","4,3,8","4,4,-8","4,4,-7","4,4,2","4,4,7","4,4,8","4,5,-8","4,5,-7","4,5,2","4,5,7","4,5,8","4,6,-8","4,6,-7","4,6,2","4,6,7","4,6,8","4,7,-8","4,7,-7","4,7,-6","4,7,-5","4,7,-4","4,7,-3","4,7,-2","4,7,-1","4,7,0","4,7,1","4,7,2","4,7,3","4,7,4","4,7,5","4,7,6","4,7,7","4,7,8","4,8,-8","4,8,-7","4,8,-6","4,8,-5","4,8,-4","4,8,-3","4,8,-2","4,8,-1","4,8,0","4,8,1","4,8,2","4,8,3","4,8,4","4,8,5","4,8,6","4,8,7","4,8,8","5,0,-8","5,0,-7","5,0,-6","5,0,-5","5,0,-4","5,0,-3","5,0,-2","5,0,-1","5,0,0","5,0,1","5,0,2","5,0,3","5,0,4","5,0,5","5,0,6","5,0,7","5,0,8","5,1,-8","5,1,-7","5,1,-6","5,1,-5","5,1,-4","5,1,-3","5,1,-2","5,1,-1","5,1,0","5,1,1","5,1,2","5,1,3","5,1,4","5,1,5","5,1,6","5,1,7","5,1,8","5,2,-8","5,2,-7","5,2,2","5,2,7","5,2,8","5,3,-8","5,3,-7","5,3,2","5,3,7","5,3,8","5,4,-8","5,4,-7","5,4,2","5,4,7","5,4,8","5,5,-8","5,5,-7","5,5,2","5,5,7","5,5,8","5,6,-8","5,6,-7","5,6,2","5,6,7","5,6,8","5,7,-8","5,7,-7","5,7,-6","5,7,-5","5,7,-4","5,7,-3","5,7,-2","5,7,-1","5,7,0","5,7,1","5,7,2","5,7,3","5,7,4","5,7,5","5,7,6","5,7,7","5,7,8","5,8,-8","5,8,-7","5,8,-6","5,8,-5","5,8,-4","5,8,-3","5,8,-2","5,8,-1","5,8,0","5,8,1","5,8,2","5,8,3","5,8,4","5,8,5","5,8,6","5,8,7","5,8,8","6,0,-8","6,0,-7","6,0,-6","6,0,-5","6,0,-4","6,0,-3","6,0,-2","6,0,-1","6,0,0","6,0,1","6,0,2","6,0,3","6,0,4","6,0,5","6,0,6","6,0,7","6,0,8","6,1,-8","6,1,-7","6,1,-6","6,1,-5","6,1,-4","6,1,-3","6,1,-2","6,1,-1","6,1,0","6,1,1","6,1,2","6,1,3","6,1,4","6,1,5","6,1,6","6,1,7","6,1,8","6,2,-8","6,2,-7","6,2,-6","6,2,-5","6,2,-4","6,2,-3","6,2,-2","6,2,-1","6,2,0","6,2,1","6,2,2","6,2,3","6,2,4","6,2,5","6,2,6","6,2,7","6,2,8","6,3,-8","6,3,-7","6,3,-6","6,3,-5","6,3,-4","6,3,-3","6,3,-2","6,3,-1","6,3,0","6,3,1","6,3,2","6,3,3","6,3,4","6,3,5","6,3,6","6,3,7","6,3,8","6,4,-8","6,4,-7","6,4,-6","6,4,-5","6,4,-4","6,4,-3","6,4,-2","6,4,-1","6,4,0","6,4,1","6,4,2","6,4,3","6,4,4","6,4,5","6,4,6","6,4,7","6,4,8","6,5,-8","6,5,-7","6,5,-6","6,5,-5","6,5,-4","6,5,-3","6,5,-2","6,5,-1","6,5,0","6,5,1","6,5,2","6,5,3","6,5,4","6,5,5","6,5,6","6,5,7","6,5,8","6,6,-8","6,6,-7","6,6,-6","6,6,-5","6,6,-4","6,6,-3","6,6,-2","6,6,-1","6,6,0","6,6,1","6,6,2","6,6,3","6,6,4","6,6,5","6,6,6","6,6,7","6,6,8","6,7,-8","6,7,-7","6,7,-6","6,7,-5","6,7,-4","6,7,-3","6,7,-2","6,7,-1","6,7,0","6,7,1","6,7,2","6,7,3","6,7,4","6,7,5","6,7,6","6,7,7","6,7,8","6,8,-8","6,8,-7","6,8,-6","6,8,-5","6,8,-4","6,8,-3","6,8,-2","6,8,-1","6,8,0","6,8,1","6,8,2","6,8,3","6,8,4","6,8,5","6,8,6","6,8,7","6,8,8","7,0,-8","7,0,-7","7,0,-6","7,0,-5","7,0,-4","7,0,-3","7,0,-2","7,0,-1","7,0,0","7,0,1","7,0,2","7,0,3","7,0,4","7,0,5","7,0,6","7,0,7","7,0,8","7,1,-8","7,1,-7","7,1,-6","7,1,-5","7,1,-4","7,1,-3","7,1,-2","7,1,-1","7,1,0","7,1,1","7,1,2","7,1,3","7,1,4","7,1,5","7,1,6","7,1,7","7,1,8","7,2,-8","7,2,-7","7,2,-6","7,2,-5","7,2,-4","7,2,-3","7,2,-2","7,2,-1","7,2,0","7,2,1","7,2,2","7,2,3","7,2,4","7,2,5","7,2,6","7,2,7","7,2,8","7,3,-8","7,3,-7","7,3,-6","7,3,-5","7,3,-4","7,3,-3","7,3,-2","7,3,-1","7,3,0","7,3,1","7,3,2","7,3,3","7,3,4","7,3,5","7,3,6","7,3,7","7,3,8","7,4,-8","7,4,-7","7,4,-6","7,4,-5","7,4,-4","7,4,-3","7,4,-2","7,4,-1","7,4,0","7,4,1","7,4,2","7,4,3","7,4,4","7,4,5","7,4,6","7,4,7","7,4,8","7,5,-8","7,5,-7","7,5,-6","7,5,-5","7,5,-4","7,5,-3","7,5,-2","7,5,-1","7,5,0","7,5,1","7,5,2","7,5,3","7,5,4","7,5,5","7,5,6","7,5,7","7,5,8","7,6,-8","7,6,-7","7,6,-6","7,6,-5","7,6,-4","7,6,-3","7,6,-2","7,6,-1","7,6,0","7,6,1","7,6,2","7,6,3","7,6,4","7,6,5","7,6,6","7,6,7","7,6,8","7,7,-8","7,7,-7","7,7,-6","7,7,-5","7,7,-4","7,7,-3","7,7,-2","7,7,-1","7,7,0","7,7,1","7,7,2","7,7,3","7,7,4","7,7,5","7,7,6","7,7,7","7,7,8","7,8,-8","7,8,-7","7,8,-6","7,8,-5","7,8,-4","7,8,-3","7,8,-2","7,8,-1","7,8,0","7,8,1","7,8,2","7,8,3","7,8,4","7,8,5","7,8,6","7,8,7","7,8,8","1,6,2","1,5,2","0,6,2","0,5,2","-1,6,2","-1,5,2"]);
                    return (x, y, z) => solids.has(x + ',' + y + ',' + z);
                })()).build();

// LEVEL 2: THE VAULT — The Security Swap
        // A mechanical cube-swap puzzle utilizing the service window & green core delivery:
        // 1. Place Green on Plate 1 (x=3, z=-2) to open Gate 1 (Channel 1).
        // 2. Enter the vault. Look back through the Service Window (x=3, z=0) and grab Green
        //    through the bars. Door 1 slams shut behind you!
        // 3. The Gray cube is on an elevated 3m security ledge (y=4). Use Green (1m) as a stepping
        //    stone to climb the ledge and retrieve the Gray cube.
        // 4. Carry Gray to the Service Window and drop it through onto Plate 1. Gate 1 re-opens!
        // 5. Retrieve Green and carry it through to the Exit Goal at the rear of the vault.
        case 2:
            return builder.setBounds(7, 9, 10)
                .setSpawn(0, 2, -6)
                .setExit(0, 2.5, 7)
                .addEntity('green', -3, 2, -4)
                .addEntity('gray', -3.5, 5, 4) // Elevated on the security ledge
                .addPlate(3, 1, -2, 1)        // Plate 1 (aligned with service window)
                .addDoor(0, 2.5, 0, { channel: 1, dir: 'up', width: 3, height: 4, moveDist: 3.5 })
                .addLight(0, 5, -4,  0x38bdf8, 4.5, 14.0) // Antechamber cool cyan light
                .addLight(3, 3, -1,  0x4ade80, 3.5, 10.0) // Service window & swap plate accent
                .addLight(-3, 6, 3,  0xffaa33, 4.5, 14.0) // Security ledge amber spotlight
                .addLight(0, 4, 7,   0x34d399, 5.0, 16.0) // Exit sanctum emerald beacon
                .addCustomLogic((x, y, z) => {
                    // Outer chamber boundaries: interior x in [-5, 5], y in [1, 7], z in [-8, 8]
                    if (roomBox(x, y, z, 6, 8, 9)) return true;

                    // ── CENTRAL SECURITY BULKHEAD (z = 0) ───────────────────
                    if (z === 0) {
                        // Sliding Door 1 aperture (x in [-1, 1], y in [1, 4])
                        if (Math.abs(x) <= 1 && y >= 1 && y <= 4) return false;
                        return true; // Solid wall everywhere else
                    }

                    // ── HIGH SECURITY LEDGE (x in [-5, -2], z in [2, 5]) ────
                    // Sheer 3m cliff holding the Gray Cube (floor at y <= 4)
                    // The ledge surface itself blocks line-of-sight to the cube from the floor
                    if (x >= -5 && x <= -2 && z >= 2 && z <= 5 && y <= 4) return true;

                    // Base chamber floor
                    return y <= 0;
                }).build();
// LEVEL 3: THE PRESS — The Grand Hydraulic Ascent
        // A monumental 27m-long, 16m-tall industrial hall with a crystal-clear 3-tier layout:
        // 1. Tier 1 (Lower Basin, y=1): Place the Gray cube on Plate 1 (z=-6) -> Press Gate 1 slides UP.
        //    Walk up the wide central staircase to the Mid Mezzanine (Tier 2, y=6).
        // 2. Walk to either side balcony railing, look down over the drop, and hoist the cube up to Tier 2.
        // 3. Tier 2 (Mid Mezzanine, y=6): Place the cube on Plate 2 (z=2) -> Press Gate 2 slides UP.
        //    Walk up the second central staircase to the Apex Sanctum (Tier 3, y=11).
        // 4. Look over the Tier 3 railing, hoist the cube up once more, and place it at the base of
        //    the monumental 3m Altar Plinth to reach the Exit Goal!
        case 3:
            return builder.setBounds(9, 18, 15)
                .setSpawn(0, 2, -11)
                .setExit(0, 15.5, 12)
                .addEntity('gray', 0, 1, -8)  // The single versatile gray cube
                .addPlate(0, 1, -6, 1)        // Plate 1 (Tier 1 floor, Ch 1)
                .addPlate(0, 6, 2, 2)         // Plate 2 (Tier 2 deck, Ch 2)
                .addDoor(0, 3.5, -4, { channel: 1, dir: 'up', width: 4, height: 5, moveDist: 4.5 }) // Gate 1
                .addDoor(0, 8.5, 5,  { channel: 2, dir: 'up', width: 4, height: 5, moveDist: 4.5 }) // Gate 2
                .addLight(0, 5, -8,  0x38bdf8, 5.0, 18.0) // Tier 1 Lower Basin cold cyan
                .addLight(0, 10, 0,  0x103040, 5.0, 16.0) // Tier 2 Mid Mezzanine deep teal
                .addLight(0, 15, 11, 0xffeedd, 6.0, 20.0) // Tier 3 Apex Altar golden beacon
                .addCustomLogic((x, y, z) => {
                    // Outer chamber boundaries: interior x in [-7, 7], y in [1, 16], z in [-13, 13]
                    if (roomBox(x, y, z, 8, 17, 14)) return true;

                    // ── TIER 1: Lower Press Basin (z <= -4, floor at y <= 1) ──
                    if (z <= -4 && y <= 1) return true;

                    // ── BULKHEAD 1 at z = -4 (Separating Tier 1 & Tier 2, y <= 6)
                    if (z === -4) {
                        if (Math.abs(x) <= 2 && y >= 1 && y <= 5) return false; // Gate 1 doorway
                        if (y <= 6) return true;
                    }

                    // Central Staircase 1 (Rising from y=1 to y=6, z in [-3, -1])
                    if (Math.abs(x) <= 2) {
                        if (z === -3 && y <= 2) return true;
                        if (z === -2 && y <= 3) return true;
                        if (z === -1 && y <= 4) return true;
                    }

                    // ── TIER 2: Mid Mezzanine Deck (floor at y <= 6, z in [-3, 5])
                    // Flanking overlook balconies at |x| >= 3 extend to z = -3 so you can
                    // stand on either side wing and easily hoist the cube from Plate 1 below
                    if (z >= -3 && z <= 5 && y <= 6) {
                        if (z < 0 && Math.abs(x) < 3) return false; // Open stairwell space
                        return true;
                    }

                    // ── BULKHEAD 2 at z = 5 (Separating Tier 2 & Tier 3, y <= 11)
                    if (z === 5) {
                        if (Math.abs(x) <= 2 && y >= 6 && y <= 10) return false; // Gate 2 doorway
                        if (y <= 11) return true;
                    }

                    // Central Staircase 2 (Rising from y=6 to y=11, z in [6, 8])
                    if (Math.abs(x) <= 2) {
                        if (z === 6 && y <= 7) return true;
                        if (z === 7 && y <= 8) return true;
                        if (z === 8 && y <= 9) return true;
                    }

                    // ── TIER 3: Apex Sanctum (floor at y <= 11, z in [6, 13]) ──
                    // Flanking balconies at |x| >= 3 extend to z = 6 overlooking Plate 2 below
                    if (z >= 6 && z <= 13 && y <= 11) {
                        if (z < 9 && Math.abs(x) < 3) return false; // Open stairwell space
                        return true;
                    }

                    // Monumental Altar Plinth (z >= 11, x in [-2, 2], rising to y <= 14)
                    // (3m sheer cliff above Tier 3 floor, requiring the cube as a step)
                    if (z >= 11 && Math.abs(x) <= 2 && y <= 14) return true;

                    return y <= 0;
                }).build();
// LEVEL 4: THE GALE — The Transfer Relay (OR / AND Logic)
        // A pure facility logic puzzle with a button right at spawn:
        // 1. Spawn facing Plate 1. Place Cube 1 on Plate 1 -> Gate 1 (OR[1, 2]) slides open!
        // 2. Enter the facility. In the West Bay, find Cube 2 and place it on Plate 2.
        // 3. Plate 2 now holds Gate 1 open via the OR circuit (0 OR 1 = 1).
        // 4. Walk back into the start room and pick up Cube 1 -> Gate 1 stays open!
        // 5. Carry Cube 1 across to the East Bay and place it on Plate 3.
        // 6. With both substations active, Channel 5 (AND[2, 3]) triggers -> Master Exit Gate opens!
        case 4:
            return builder.setBounds(8, 9, 12)
                .setSpawn(0, 2, -9)
                .setExit(0, 2.5, 8)
                .addEntity('gray', -2, 1, -7)         // Cube 1 (Start Room)
                .addEntity('gray', -5, 1, 0)          // Cube 2 (West Bay)
                .addPlate(0, 1, -7, 1)                // Plate 1 (Directly at spawn, Ch 1)
                .addPlate(-5, 1, 2, 2)                // Plate 2 (West Bay, Ch 2)
                .addPlate(5, 1, 2, 3)                 // Plate 3 (East Bay, Ch 3)
                .addDoor(0, 2.5, -3, { channel: 4, dir: 'up', width: 3, height: 4, moveDist: 3.5 }) // Gate 1 (OR[1, 2])
                .addDoor(0, 2.5, 4,  { channel: 5, dir: 'up', width: 3, height: 4, moveDist: 3.5 }) // Master Exit Gate (AND[2, 3])
                .addLogicGate(4, 'OR', [1, 2])        // Gate 1 holds open if Plate 1 OR Plate 2 is active
                .addLogicGate(5, 'AND', [2, 3])       // Master Gate opens when BOTH facility bays are weighted
                .addLight(0, 5, -7,  0x7df9ff, 4.5, 16.0) // Start Room cold cyan
                .addLight(0, 5, 0,   0x38bdf8, 4.0, 14.0) // Central Hub blue
                .addLight(-5, 4, 1,  0xffaa33, 4.5, 14.0) // West Bay amber worklight
                .addLight(5, 4, 1,   0x4ade80, 4.5, 14.0) // East Bay green terminal
                .addLight(0, 5, 8,   0xffeedd, 5.0, 16.0) // Exit sanctum golden beacon
                .addCustomLogic((x, y, z) => {
                    // Outer chamber boundaries: interior x in [-6, 6], y in [1, 7], z in [-10, 10]
                    if (roomBox(x, y, z, 7, 8, 11)) return true;

                    // ── BULKHEAD 1 at z = -3 (Holding Gate 1) ─────────────────
                    if (z === -3) {
                        if (Math.abs(x) <= 1 && y >= 1 && y <= 4) return false; // Gate 1 doorway
                        return true; // Solid wall to ceiling
                    }

                    // ── CENTRAL HUB DIVIDER WALLS at x = -3 and x = 3 ────────
                    // Left wall separating Hub from West Bay (has open doorway at z in [0, 2])
                    if (x === -3 && z >= -2 && z <= 3) {
                        if (z >= 0 && z <= 2 && y <= 4) return false; // Open archway
                        return true;
                    }
                    // Right wall separating Hub from East Bay (has open doorway at z in [0, 2])
                    if (x === 3 && z >= -2 && z <= 3) {
                        if (z >= 0 && z <= 2 && y <= 4) return false; // Open archway
                        return true;
                    }

                    // ── MASTER EXIT BULKHEAD at z = 4 (Holding Gate 2) ───────
                    if (z === 4) {
                        if (Math.abs(x) <= 1 && y >= 1 && y <= 4) return false; // Master Gate doorway
                        return true; // Solid wall to ceiling
                    }

                    // Solid bedrock floor
                    return y <= 0;
                }).build();

        // LEVEL 5: THE DROP — The Vertical Gravity Siphon
        // A 3-tier vertical logic well replacing water with a gravitational drop sequence:
        // 1. Upper Gantry (y=8): Align Cube 1 over the 7m drop chute on the left and drop it
        //    down to the bedrock crypt (y=1) directly onto Plate 1.
        // 2. Take Cube 2 down the access ramp to the Mezzanine (y=4) and place it on Plate 2.
        // 3. Channel 3 (AND[1, 2]) activates, opening Gate 1 on the mezzanine to the Exit Goal.
        case 5:
            return builder.setBounds(8, 14, 11)
                .setSpawn(0, 9, -7)
                .setExit(0, 5.5, 8)
                .addEntity('gray', -3, 8, -6)
                .addEntity('gray', 3, 8, -6)
                .addPlate(-3, 1, 3, 1) // Lower Plate 1 (Crypt floor at y=1)
                .addPlate(3, 4, 1, 2)  // Mid Plate 2 (Mezzanine at y=4)
                .addDoor(0, 5.5, 5, { channel: 3, dir: 'up', width: 3, height: 4, moveDist: 3.5 })
                .addLogicGate(3, 'AND', [1, 2])
                .addLight(0, 11, -6, 0x7df9ff, 5.0, 18.0) // Upper gantry cold cyan
                .addLight(3, 6, 2,   0x4ade80, 4.5, 14.0) // Mezzanine plate green
                .addLight(-3, 3, 3,  0x103040, 5.0, 16.0) // Deep crypt floor glow
                .addLight(0, 6, 8,   0xffeedd, 4.5, 16.0) // Exit sanctuary
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 7, 13, 10)) return true;

                    // Tier 1: Upper Gantry (y <= 7, z <= -4)
                    if (z <= -4 && y <= 7) {
                        // Left gravity drop chute (open 2x2 hole directly over Plate 1)
                        if (x >= -4 && x <= -2 && z >= -6 && z <= -4) return false;
                        return true;
                    }

                    // Connecting ramp from Upper Gantry to Mezzanine (Right side, x >= 4)
                    if (x >= 4 && z >= -3 && z <= -1 && y <= 5) return true;

                    // Tier 2: Mid Siphon Mezzanine (y <= 3, z from -2 to 4)
                    if (z >= -2 && z <= 4 && y <= 3) {
                        // Open well on left allowing the chute to drop cleanly to y=1
                        if (x <= -1) return false;
                        return true;
                    }

                    // Vault Divider Wall at z = 5 (y from 4 to 9) holding Gate 1
                    if (z === 5 && y >= 4 && y <= 9) {
                        if (Math.abs(x) <= 1 && y <= 7) return false; // Doorway
                        return true;
                    }

                    // Tier 3: Exit Platform behind Gate 1 (z >= 5, y <= 4)
                    if (z >= 5 && y <= 4) return true;

                    // Return stairway from Crypt (y=1) up to Mezzanine (y=4)
                    if (x === 0 && z === 0 && y <= 2) return true;
                    if (x === 0 && z === 1 && y <= 3) return true;

                    // Crypt Bedrock Floor
                    return y <= 0;
                }).build();
// LEVEL 6: THE AQUEDUCT — The Siphon Viaduct & High Sun Promontory
        // A focused 40m open canyon viaduct with an expansive, non-claustrophobic sun terrace exit:
        // 1. Button Side (z<=-11, y=1): Plate 1 sits in the open at (3, 1, -12). Place a cube on Plate 1 -> Gate 1 opens!
        // 2. The wall at z=-10 completely seals the button side. Walk through Gate 1 onto the landing (z=-9).
        //    The wall has a 1x1 hole at (x=3, y=2) that is only 1 block tall: shrink Red to 0.35m and pull it through!
        // 3. Walk up the enclosed 1-block stairs to Pier 1 (y=8). Put Gray on Plate 2 -> Gate 2 (Semi-Final Door) opens.
        // 4. Expand Red to 3.5m across the chasm, cross through Gate 2, and retrieve both blocks onto the open deck.
        // 5. Reception Court (y=8): Right past Gate 2, drop a block on Plate 3 (z=7) -> Monumental Gate 3 (z=10) opens!
        // 6. Walk up the broad steps onto the spacious High Sun Promontory (y=10) to reach the Goal!
        case 6:
            return builder.setBounds(7, 17, 21)
                .setSpawn(0, 3, -15)
                .setExit(0, 11.5, 16)
                .addEntity('gray', -2, 3, -14) // Gray ballast block (spawns at y=3)
                .addEntity('red', 1, 3, -14, { startScale: 1.0 }) // Red scaling cube (spawns at y=3)
                .addPlate(3, 1, -12, 1)        // Plate 1 (Open on button side, Ch 1)
                .addPlate(-2, 7, -1, 2)        // Plate 2 (Pier 1 Deck, Ch 2)
                .addPlate(0, 7, 7, 3)          // Plate 3 (Right after Semi-Final Door, Ch 3)
                .addDoor(-1, 2.5, -10, { channel: 1, dir: 'up', width: 3, height: 4, moveDist: 3.5 }) // Gate 1
                .addDoor(0, 8.5, 5,    { channel: 2, dir: 'up', width: 3, height: 4, moveDist: 3.5 }) // Gate 2 (Semi-Final Door)
                .addDoor(0, 9.5, 10,   { channel: 3, dir: 'up', width: 4, height: 5, moveDist: 4.5 }) // Gate 3 (Monumental Exit Arch)
                .addLight(0, 5, -13, 0x38bdf8, 5.0, 18.0) // Button side cold cyan skylight
                .addLight(3, 3, -12, 0x4ade80, 3.5, 10.0) // Plate 1 open floor accent
                .addLight(0, 9, 2,   0xffaa33, 4.5, 16.0) // Open chasm amber torchlight
                .addLight(0, 9, 7,   0x4ade80, 4.5, 14.0) // Reception court green beacon
                .addLight(0, 14, 15, 0xffeedd, 6.5, 22.0) // Panoramic Promontory golden sunbeam
                .addCustomLogic((x, y, z) => {
                    // Outer canyon boundaries: interior x in [-5, 5], y in [1, 15], z in [-20, 20]
                    if (roomBox(x, y, z, 6, 16, 20)) return true;

                    // ── STAGE 1: Valley Basin Floor (Button side, z <= -10, floor at y <= 1)
                    if (z <= -10 && y <= 1) return true;

                    // ── DIVIDING WALL at z = -10 (Seals off the button side completely) ──
                    if (z === -10) {
                        // Gate 1 doorway (the ONLY way the player can pass through to the stairs)
                        if (x >= -2 && x <= 0 && y >= 1 && y <= 4) return false;
                        // 1x1 hole at x = 3, y = 2 (strictly 1 block tall: player cannot fit, but micro-Red passes!)
                        if (x === 3 && y === 2) return false;
                        return true; // Solid wall to ceiling everywhere else
                    }

                    // ── LANDING BEHIND GATE 1 (z = -9, floor at y <= 1) ────────
                    // Flat floor allowing you to walk through Gate 1 and step over to x=3 to reach the 1x1 hole
                    if (z === -9 && x >= -2 && x <= 3 && y <= 1) return true;

                    // ── ENCLOSED 1-BLOCK STEEP STAIRCASE (y=1 to y=8, z in [-8, -2]) ──
                    if (x >= -2 && x <= 0 && z >= -8 && z <= -2) {
                        if (z === -8 && y <= 2) return true;
                        if (z === -7 && y <= 3) return true;
                        if (z === -6 && y <= 4) return true;
                        if (z === -5 && y <= 5) return true;
                        if (z === -4 && y <= 6) return true;
                        if (z === -3 && y <= 7) return true;
                        if (z === -2 && y <= 8) return true;
                    }
                    // Side blocking walls for the staircase (sealing tunnel at x=-3 and x=1)
                    if ((x === -3 || x === 1) && z >= -9 && z <= -2 && y <= 9) return true;

                    // ── PIER 1 ARCH DECK (z in [-2, 0], floor at y <= 7) ───────
                    if (z >= -2 && z <= 0 && Math.abs(x) <= 4 && y <= 7) return true;

                    // ── THE 4M CHASM BRIDGE GAP (z in [1, 4], floor drops to y <= 1)
                    // Lower bridge corbels at y <= 5 for the 3.5m Red bridge slab to rest upon
                    if (z >= 1 && z <= 4 && Math.abs(x) <= 1 && y <= 5) return true;

                    // ── GATE 2 BULKHEAD (Semi-Final Door) at z = 5 ────────────
                    // Solid bulkhead wall sealing across canyon to ceiling (y=15)
                    if (z === 5) {
                        if (Math.abs(x) <= 1 && y >= 7 && y <= 10) return false; // Gate 2 doorway
                        return true;
                    }

                    // ── EXPANSIVE RECEPTION COURT (z in [6, 9], floor at y <= 7) ────
                    // Wide open terrace (x in [-5, 5]), soaring 8m of open vertical air
                    if (z >= 6 && z <= 9 && y <= 7) return true;

                    // ── MONUMENTAL GATE 3 BULKHEAD at z = 10 ─────────────────
                    // Grand Roman gateway framing Gate 3
                    if (z === 10) {
                        if (Math.abs(x) <= 2 && y >= 7 && y <= 11) return false; // Wide 4m x 5m doorway
                        return true;
                    }

                    // ── PANORAMIC HIGH SUN PROMONTORY (z >= 11) ───────────────
                    // Broad, open-air stone steps rising to an expansive overlook (y=8 to y=10)
                    if (z >= 11) {
                        // Low perimeter safety parapets along the canyon edges (|x| = 5)
                        if ((x <= -5 || x >= 5) && y <= 12) return true;
                        // Broad, open steps and altar terrace
                        if (z === 11 && y <= 8) return true;  // Step 1
                        if (z === 12 && y <= 9) return true;  // Step 2
                        if (z >= 13 && y <= 10) return true; // Wide panoramic terrace
                    }

                    // Open canyon abyss floor
                    return y <= 0;
                }).build();
// LEVEL 7: THE BRIDGE — The Symmetrical Cantilever Viaduct
        // A compact, zero-dead-space bridge puzzle with 100% reliable physical logic:
        // Gate 1 is on Channel 4 (OR[1, 2]). Gate 2 is on Channel 5 (OR[2, 3]).
        // Plate 2 on the Central Pylon links both gates!
        // 1. South Anchorage: Place Cube 1 on Plate 1 -> Gate 1 opens (OR[1, 2]).
        // 2. Carry Cube 2 across to the Central Pylon and place it on Plate 2:
        //    - Gate 1 stays open via Plate 2.
        //    - Gate 2 SLIDES OPEN ahead of you (OR[2, 3])!
        // 3. Walk back to South Anchorage, grab Cube 1, and carry it across both spans onto North Anchorage!
        // 4. Place Cube 1 on Plate 3 -> latches Gate 2 open from the North side.
        // 5. Retrieve Cube 2 from Central Pylon, carry it to North Anchorage, and use it
        //    as a step to climb the 3m altar plinth and reach the Goal!
        case 7:
            return builder.setBounds(6, 12, 13)
                .setSpawn(0, 3, -9)
                .setExit(0, 6.5, 10)
                .addEntity('green', -2, 3, -8) // Cube 1 (South Anchorage)
                .addEntity('green', 2, 3, -8)  // Cube 2 (South Anchorage)
                .addPlate(0, 2, -7, 1)        // Plate 1 (South Anchorage, Ch 1)
                .addPlate(0, 2, 0, 2)         // Plate 2 (Central Pylon, Ch 2)
                .addPlate(0, 2, 6, 3)         // Plate 3 (North Anchorage, Ch 3)
                .addDoor(0, 3.5, -4, { channel: 4, dir: 'up', width: 3, height: 4, moveDist: 3.5 }) // Gate 1 (OR[1, 2])
                .addDoor(0, 3.5, 4,  { channel: 5, dir: 'up', width: 3, height: 4, moveDist: 3.5 }) // Gate 2 (OR[2, 3])
                .addLogicGate(4, 'OR', [1, 2]) // Gate 1 open if Plate 1 OR Plate 2 active
                .addLogicGate(5, 'OR', [2, 3]) // Gate 2 open if Plate 2 OR Plate 3 active
                .addLight(0, 6, -8, 0x7df9ff, 5.0, 16.0) // South Anchorage cold cyan
                .addLight(0, 6, 0,  0xffaa33, 5.0, 16.0) // Central Pylon amber beacon
                .addLight(0, 7, 9,  0xffeedd, 5.5, 18.0) // North Altar golden beacon
                .addCustomLogic((x, y, z) => {
                    // Outer chamber boundaries: interior x in [-4, 4], y in [1, 10], z in [-11, 11]
                    if (roomBox(x, y, z, 5, 11, 12)) return true;

                    // ── 1. SOUTH ANCHORAGE (z <= -5, floor at y <= 2) ────────
                    if (z <= -5 && y <= 2) return true;

                    // Bulkhead 1 at z = -4 (Seals entire width x in [-4, 4] and height to ceiling y=10)
                    if (z === -4) {
                        if (Math.abs(x) <= 1 && y >= 2 && y <= 5) return false; // Gate 1 doorway
                        return true; // Completely solid to ceiling (no jumping over or around)
                    }

                    // ── 2. SOUTH SPAN BRIDGE (z in [-3, -2], deck at y <= 2) ──
                    if (z >= -3 && z <= -2 && Math.abs(x) <= 2 && y <= 2) return true;
                    // Protective safety curbs preventing cubes from falling off (|x| = 3)
                    if (z >= -3 && z <= -2 && (x === -3 || x === 3) && y <= 4) return true;

                    // ── 3. CENTRAL PYLON DECK (z in [-1, 1], deck at y <= 2) ──
                    if (z >= -1 && z <= 1 && Math.abs(x) <= 3 && y <= 2) return true;
                    // Central pylon decorative towers rising to ceiling (|x| = 4, y <= 10)
                    if (Math.abs(z) <= 1 && (x === -4 || x === 4) && y <= 10) return true;

                    // ── 4. NORTH SPAN BRIDGE (z in [2, 3], deck at y <= 2) ────
                    if (z >= 2 && z <= 3 && Math.abs(x) <= 2 && y <= 2) return true;
                    // Protective safety curbs (|x| = 3)
                    if (z >= 2 && z <= 3 && (x === -3 || x === 3) && y <= 4) return true;

                    // Bulkhead 2 at z = 4 (Seals entire width x in [-4, 4] and height to ceiling y=10)
                    if (z === 4) {
                        if (Math.abs(x) <= 1 && y >= 2 && y <= 5) return false; // Gate 2 doorway
                        return true; // Completely solid to ceiling
                    }

                    // ── 5. NORTH ANCHORAGE (z >= 5, floor at y <= 2) ─────────
                    if (z >= 5 && y <= 2) return true;

                    // 3m Altar Plinth at rear (z >= 9, |x| <= 2, rising to y <= 5)
                    // Requires 1 cube placed at the base as a step to reach the Goal
                    if (z >= 9 && Math.abs(x) <= 2 && y <= 5) return true;

                    // Bottomless abyss canyon floor
                    return y <= 0;
                }).build();
 // LEVEL 8: THE GAUNTLET — The Two-Core Vault Siphon
        // An expansive 33m facility puzzle using ONLY 2 cubes (Green & Gray) and 3 buttons:
        // 1. Sector 1 (Intake): Place Green on Plate 1 -> Gate 1 opens via OR[1, 2]. Enter Sector 2.
        // 2. Sector 2: Find Gray, place it on Plate 2 (Override) -> Plate 2 holds Gate 1 open (0 OR 1 = 1).
        // 3. Return to Sector 1, pick up Green, and carry it through open Gate 1 into Sector 2.
        // 4. In Sector 2, place Green at the base of the 3m catwalk as a step. Carry Gray up onto the
        //    catwalk and place it on Plate 3 -> Gate 2 (Omega Vault Door) slides open!
        // 5. Hop down, retrieve the Green Core, walk through Gate 2, and ascend the Vault Ziggurat to the Goal!
        case 8:
            return builder.setBounds(8, 12, 18)
                .setSpawn(0, 3, -14)
                .setExit(0, 5.5, 14)
                .addEntity('green', 0, 3, -12) // Green Core (Delivery Key, spawns at y=3)
                .addEntity('gray', 3, 3, -1)   // Gray Block (Circuit Ballast, spawns at y=3)
                .addPlate(0, 1, -9, 1)         // Plate 1 (Sector 1 Intake, Ch 1)
                .addPlate(3, 1, 2, 2)          // Plate 2 (Sector 2 Override, Ch 2)
                .addPlate(-4, 4, 3, 4)         // Plate 3 (Sector 2 Catwalk, Ch 4)
                .addDoor(0, 2.5, -5, { channel: 3, dir: 'up', width: 3, height: 4, moveDist: 3.5 }) // Gate 1 (OR[1, 2])
                .addDoor(0, 2.5, 6,  { channel: 4, dir: 'up', width: 3, height: 4, moveDist: 3.5 }) // Gate 2 (Vault Door)
                .addLogicGate(3, 'OR', [1, 2]) // Gate 1 holds open if Plate 1 OR Plate 2 is active
                .addLight(0, 6, -12, 0x7df9ff, 5.0, 18.0) // Sector 1 cold cyan
                .addLight(3, 4, 2,   0xffaa33, 4.0, 12.0) // Plate 2 amber worklight
                .addLight(-4, 7, 3,  0x38bdf8, 4.5, 14.0) // Catwalk cold blue accent
                .addLight(0, 7, 14,  0x4ade80, 6.0, 20.0) // Omega Vault emerald beacon
                .addCustomLogic((x, y, z) => {
                    // Outer chamber boundaries: interior x in [-6, 6], y in [1, 10], z in [-16, 16]
                    if (roomBox(x, y, z, 7, 11, 17)) return true;

                    // ── SECTOR 1: Intake Atrium (z <= -6, floor at y <= 1) ───
                    if (z <= -6 && y <= 1) return true;

                    // Bulkhead 1 at z = -5 (holding Gate 1, solid to ceiling y=10)
                    if (z === -5) {
                        if (Math.abs(x) <= 1 && y >= 1 && y <= 4) return false; // Gate 1 doorway
                        return true;
                    }

                    // ── SECTOR 2: Central Gauntlet Hall (z in [-4, 5]) ───────
                    // Main floor at y <= 1
                    if (z >= -4 && z <= 5 && y <= 1) return true;

                    // Elevated Security Catwalk holding Plate 3 (x in [-6, -2], z in [0, 5], floor at y <= 4)
                    // 3m sheer cliff above floor; impossible to climb without Green as a step
                    if (x >= -6 && x <= -2 && z >= 0 && z <= 5 && y <= 4) return true;

                    // Bulkhead 2 at z = 6 (holding Gate 2, solid to ceiling y=10)
                    if (z === 6) {
                        if (Math.abs(x) <= 1 && y >= 1 && y <= 4) return false; // Gate 2 doorway
                        return true;
                    }

                    // ── SECTOR 3: Omega Vault & Ziggurat (z >= 7) ────────────
                    // Floor at y <= 1
                    if (z >= 7 && y <= 1) return true;

                    // Monumental Fluted Shrine Pillars flanking the pathway (|x| = 3, z in [9, 13])
                    if ((x === -3 || x === 3) && z >= 9 && z <= 13 && y <= 8) return true;

                    // Ascending Ziggurat Altar leading to the Goal (z in [10, 15], x in [-2, 2])
                    if (Math.abs(x) <= 2 && z >= 10 && z <= 15) {
                        if (z === 10 && y <= 2) return true; // Step 1 (y=2)
                        if (z === 11 && y <= 3) return true; // Step 2 (y=3)
                        if (z >= 12 && y <= 4) return true; // Altar Crown (y=4)
                    }

                    return y <= 0;
                }).build();

// LEVEL 9: THE CATHEDRAL — The Cruciform Basilica & Dual-Aisle Relay
        // Complete ground-up overhaul: a monumental 27m cathedral with nave, colonnades, and apse:
        // 1. South Narthex: Place Gray on Plate 1 -> Gate 1 (East Aisle) opens via Channel 4 (OR[1, 2]).
        // 2. East Aisle: Carry Green through Gate 1 and place it on Plate 2.
        //    Plate 2 holds Gate 1 open AND opens Gate 2 (West Aisle) via Channel 5 (OR[2, 3])!
        // 3. South Narthex: Retrieve Gray from Plate 1. Carry it through Gate 2 into the West Aisle.
        // 4. West Aisle: Place Gray on Plate 3 -> Gate 2 stays open AND Gate 3 (Master Altar) opens!
        // 5. East Aisle: Retrieve Green from Plate 2. Carry it through the North crossing, through Gate 3,
        //    and ascend the High Altar steps to deposit Green into the Goal!
        case 9:
            return builder.setBounds(11, 16, 15)
                .setSpawn(0, 3, -12)
                .setExit(0, 5.5, 11)
                .addEntity('green', -2, 3, -10) // Green Core (Delivery Key, spawns at y=3)
                .addEntity('gray', 2, 3, -10)  // Gray Block (Circuit Ballast, spawns at y=3)
                .addPlate(0, 1, -9, 1)         // Plate 1 (South Narthex, Ch 1)
                .addPlate(6, 1, 0, 2)          // Plate 2 (East Aisle, Ch 2)
                .addPlate(-6, 1, 0, 3)         // Plate 3 (West Aisle, Ch 3)
                .addDoor(5, 2.5, -8,  { channel: 4, dir: 'up', width: 3, height: 4, moveDist: 3.5 }) // Gate 1 (East Aisle, OR[1, 2])
                .addDoor(-5, 2.5, -8, { channel: 5, dir: 'up', width: 3, height: 4, moveDist: 3.5 }) // Gate 2 (West Aisle, OR[2, 3])
                .addDoor(0, 2.5, 6,   { channel: 3, dir: 'up', width: 4, height: 4, moveDist: 3.5 }) // Gate 3 (Master Altar Gate, Ch 3)
                // ── LOGIC RELAYS ──
                .addLogicGate(4, 'OR', [1, 2]) // Gate 1 open if Plate 1 OR Plate 2 active
                .addLogicGate(5, 'OR', [2, 3]) // Gate 2 open if Plate 2 OR Plate 3 active
                .addLight(0, 6, -11, 0x7df9ff, 5.0, 18.0) // Narthex cold cyan
                .addLight(6, 6, 0,   0xffaa33, 5.0, 16.0) // East Aisle warm amber
                .addLight(-6, 6, 0,  0x38bdf8, 5.0, 16.0) // West Aisle industrial blue
                .addLight(0, 8, 0,   0xd0e8ff, 5.5, 20.0) // Central Nave vaulted wash
                .addLight(0, 9, 11,  0x4ade80, 6.5, 22.0) // High Altar emerald sunbeam
                .addCustomLogic((x, y, z) => {
                    // Outer cathedral boundaries: interior x in [-9, 9], y in [1, 14], z in [-13, 13]
                    if (roomBox(x, y, z, 10, 15, 14)) return true;

                    // ── BASE CATHEDRAL FLOOR (y <= 1 throughout) ─────────────
                    if (y <= 1) return true;

                    // ── MONUMENTAL NAVE COLONNADES (|x| = 3, spaced at z = -8, -4, 0, 4) ──
                    // Soaring fluted pillars separating Central Nave from Side Aisles
                    if ((x === -3 || x === 3) && (z === -8 || z === -4 || z === 0 || z === 4) && y <= 14) {
                        return true;
                    }

                    // ── SOUTH NARTHEX BULKHEAD at z = -8 ─────────────────────
                    // Wall separating Narthex from Central Nave & Aisles
                    if (z === -8) {
                        // Center is closed off by ornamental stone screen (|x| <= 2, y <= 14)
                        if (Math.abs(x) <= 2) return true;
                        // East Aisle doorway (Gate 1, x in [4, 6])
                        if (x >= 4 && x <= 6 && y >= 1 && y <= 4) return false;
                        // West Aisle doorway (Gate 2, x in [-6, -4])
                        if (x >= -6 && x <= -4 && y >= 1 && y <= 4) return false;
                        return true; // Solid to ceiling
                    }

                    // ── MASTER HIGH ALTAR GATE BULKHEAD at z = 6 ─────────────
                    // Wall sealing the High Altar sanctuary at the north end of the Nave
                    if (z === 6 && Math.abs(x) <= 3) {
                        if (Math.abs(x) <= 2 && y >= 1 && y <= 4) return false; // Gate 3 doorway
                        return true; // Solid to ceiling
                    }

                    // ── HIGH ALTAR SANCTUARY & APSE (z in [7, 13], |x| <= 3) ──
                    // Enclosing apse walls
                    if ((x === -3 || x === 3) && z >= 6 && z <= 12) return true;
                    if (z === 13 && Math.abs(x) <= 3) return true; // Rear apse wall

                    // Grand Ziggurat Altar Steps leading to Goal
                    if (Math.abs(x) <= 2 && z >= 8 && z <= 12) {
                        if (z === 8  && y <= 2) return true;  // Step 1
                        if (z === 9  && y <= 3) return true;  // Step 2
                        if (z >= 10 && y <= 4) return true;  // Altar Plinth (Goal at y=5.5)
                    }

                    return y <= 0;
                }).build();

        default:
            return builder.build();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAPTER 3: THE CITADEL
// ─────────────────────────────────────────────────────────────────────────────

function getLevelParamsV3(lvl) {
    const builder = new LevelBuilder(lvl, LEVEL_NAMES[20 + lvl]);
    switch (lvl) {

        // LEVEL 0: THE GATES — Heavy Counterweight Coupling
        // Two separate heavy blocks, each on its own side of the room, must be
        // fetched and placed at the same time to satisfy the AND gate.
        case 0:
            return builder.setBounds(7, 9, 9)
                .setSpawn(0, 1, -6)
                .setExit(0, 3.5, 6)
                .addEntity('big_yellow', -4, 1, -6)
                .addEntity('gray', 4, 1, -6)
                .addPlate(-4, 1, 0, 1)
                .addPlate(4, 1, 0, 2)
                .addLogicGate(3, 'AND', [1, 2])
                .addDoor(0, 4, 4, { channel: 3, dir: 'up', width: 4.5, height: 4.5, moveDist: 4.5 })
                .addLight(0, 6, 0, 0xff5080, 4.5, 14.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 6, 8, 8)) return true;
                    if (z === 4 && Math.abs(x) >= 2) return true; // divider wall holding the gate
                    if (z >= 5 && y <= 2) return true;            // goal terrace beyond the gate
                    return y <= 0;
                }).build();

        // LEVEL 1: THE LAUNCHPAD — Overcharged Blue Kinetic Launch
        // Grow the red cube to full size on the high gallery, then drop it onto
        // the blue pad below to overcharge the bounce enough to reach the exit.
        case 1:
            return builder.setBounds(6, 16, 6)
                .setSpawn(0, 11, -3)
                .setExit(0, 13.5, 3)
                .addEntity('red', 0, 11, -3, { startScale: 2.4 })
                .addEntity('blue', 0, 1, 0)
                .addLight(0, 8, 0, 0xff5080, 4.5, 16.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 5, 15, 5)) return true;
                    if (z <= -3 && y <= 10) return true;
                    if (z >= 3 && y <= 12) return true;
                    return y <= 0;
                }).build();

        // LEVEL 2: THE DEPTHS — Multi-Level Submerged Vault
        // Haul the buoyant yellow block down to the first sunken plate, swim it
        // through the opened gate, then hold it on a SECOND sunken plate deeper
        // in to open the final gate.
        case 2:
            return builder.setBounds(7, 12, 8)
                .setSpawn(0, 7, -5)
                .setExit(0, 1.5, 5)
                .setWater(4.5)
                .addEntity('yellow', -3, 7, -3)
                .addPlate(0, 0.5, -1, 1)
                .addDoor(0, 2, 1, { channel: 1, dir: 'right', width: 4.5, height: 4.5, moveDist: 4.5 })
                .addPlate(0, 0.5, 4, 2)
                .addDoor(0, 2, 6, { channel: 2, dir: 'up', width: 4, height: 4, moveDist: 4 })
                .addLight(0, 6, 0, 0x3388ff, 4.5, 14.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 6, 11, 7)) return true;
                    if (z <= -4 && y <= 6) return true;
                    return y <= 0;
                }).build();

        // LEVEL 3: THE SCALE — Goldilocks Mass Bridge
        // A low ceiling spans the approach to the plate — a fully grown cube
        // won't fit beneath it. Grow the shrunken cube just enough to add mass
        // while still clearing the gap.
        case 3:
            return builder.setBounds(6, 9, 9)
                .setSpawn(0, 1, -6)
                .setExit(0, 4.5, 6)
                .addEntity('red', -3, 1, -3, { startScale: 0.5 })
                .addPlate(3, 1, -3, 1)
                .addDoor(0, 3, 3, { channel: 1, dir: 'up', width: 4, height: 4, moveDist: 4 })
                .addLight(0, 5, 0, 0xffccaa, 4.0, 12.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 5, 8, 8)) return true;
                    if (x >= 0 && Math.abs(z) <= 4 && y >= 2 && y <= 4) return true; // low ceiling
                    if (z >= 4 && y <= 3) return true;
                    return y <= 0;
                }).build();

        // LEVEL 4: THE MECHANISM — Cascading Logic Relay
        // A double NOT: the door only cares whether the plate is pressed, same
        // as a direct wire — the puzzle is realizing the "complex" relay reduces
        // to the simple case, not fighting it.
        case 4:
            return builder.setBounds(7, 8, 9)
                .setSpawn(0, 1, -6)
                .setExit(0, 1.5, 6)
                .addEntity('gray', -4, 1, -4)
                .addPlate(-4, 1, -1, 1)
                .addLogicGate(2, 'NOT', [1])
                .addLogicGate(3, 'NOT', [2])
                .addDoor(0, 2, 1, { channel: 3, dir: 'left', width: 4, height: 4, moveDist: 4 })
                .addLight(0, 4, 0, 0xff5080, 4.5, 14.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 6, 7, 8)) return true;
                    if (z === 1 && Math.abs(x) >= 2) return true;
                    return y <= 0;
                }).build();

        // LEVEL 5: THE ASCENT — Stepped Updraft Relay
        // Two wind shafts, one buoyant yellow cube carried between them —
        // it lifts more eagerly than red does, and drifts if you're not careful.
        case 5:
            return builder.setBounds(5, 15, 7)
                .setSpawn(0, 1, -4)
                .setExit(0, 12.5, 4)
                .addEntity('yellow', 0, 1, -2)
                .addWind(0, 2, -2, 3, 6, 2, 0, 1, 0, 18)
                .addWind(0, 9, 2, 3, 6, 2, 0, 1, 0, 22)
                .addLight(0, 8, 0, 0xffeedd, 4.5, 16.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 4, 14, 6)) return true;
                    if (Math.abs(z) <= 1 && y <= 7) return true; // mid ledge between the shafts
                    if (z >= 3 && y <= 11) return true;
                    return y <= 0;
                }).build();

        // LEVEL 6: THE OVERHANG — Inverted Suspension Platform
        // Grow the red cube and stand on top of it (block standing) to reach the
        // overhead rope, then swing hand-over-hand across the gap.
        case 6:
            return builder.setBounds(6, 9, 9)
                .setSpawn(0, 1, -6)
                .setExit(0, 5.5, 6)
                .addRope(0, 7, -4, 0, 7, 4, 12)
                .addEntity('red', 0, 1, -3, { startScale: 1.6 })
                .addLight(0, 6, 0, 0xff5080, 4.5, 14.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 5, 8, 8)) return true;
                    if (z >= 4 && y <= 4) return true;
                    return y <= 0;
                }).build();

        // LEVEL 7: THE COMPANION — Dual-Core Entanglement
        // The tunnel to the final plate is single-file — bring the green core
        // through first, come back for blue, and stack both on the plate.
        case 7:
            return builder.setBounds(6, 8, 9)
                .setSpawn(0, 1, -6)
                .setExit(0, 1.5, 6)
                .addEntity('green', -2, 1, -5)
                .addEntity('blue', 2, 1, -5)
                .addPlate(0, 1, 4, 1)
                .addDoor(0, 2, 6, { channel: 1, dir: 'up', width: 4, height: 4, moveDist: 4 })
                .addLight(0, 4, 0, 0x4ade80, 4.0, 14.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 5, 7, 8)) return true;
                    if (Math.abs(x) <= 0.6 && z >= -3 && z <= 3 && y <= 2) return true; // single-file tunnel
                    return y <= 0;
                }).build();

        // LEVEL 8: THE BREACH — Fractured Bulkhead & One-Way Barrier
        // Escort the gray block through the one-way field and across the
        // fractured rubble pillar to reach the far plate.
        case 8:
            return builder.setBounds(7, 8, 9)
                .setSpawn(-3, 1, -6)
                .setExit(3, 1.5, -6)
                .addEntity('gray', -3, 1, 4)
                .addOneWayField(-3, 2, 0, 1, false, 4, 4)
                .addDestructionZone(0, 3, 4, 2, 5)
                .addPlate(3, 1, 4, 2)
                .addDoor(3, 2, 0, { channel: 2, dir: 'up', width: 4, height: 4, moveDist: 4 })
                .addLight(0, 4, 0, 0xff5080, 4.5, 14.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 6, 7, 8)) return true;
                    if (x === 0 && Math.abs(z) <= 6) return true;
                    if (Math.abs(x) <= 0.6 && Math.abs(z - 4) <= 0.6 && y <= 3) return true; // rubble pillar
                    return y <= 0;
                }).build();

        // LEVEL 9: THE ZENITH — The Citadel Apex Climax
        // Send the gray block up the wind shaft to weight its plate, trigger the
        // second plate directly, bounce off blue through the opening gate, and
        // carry the green core up to the altar to finish the game.
        case 9:
            return builder.setBounds(9, 16, 10)
                .setSpawn(0, 1, -7)
                .setExit(0, 12.5, 5)
                .addEntity('blue', 0, 1, -3)
                .addEntity('gray', -5, 1, 0)
                .addEntity('green', 5, 2, -5)
                .addWind(-5, 2, 0, 2, 7, 2, 0, 1, 0, 22)
                .addPlate(-5, 7, 2, 1)
                .addPlate(5, 2, -3, 2)
                .addLogicGate(3, 'AND', [1, 2])
                .addDoor(0, 11, 3, { channel: 3, dir: 'up', width: 5, height: 5, moveDist: 5 })
                .addLight(0, 9, 0, 0xffccaa, 7.0, 22.0)
                .addCustomLogic((x, y, z) => {
                    if (roomBox(x, y, z, 8, 15, 9)) return true;
                    // Wind-fed deck with a vent hole over the shaft — same trick as the Cathedral.
                    if (x <= -4 && Math.abs(z) <= 2 && y >= 5 && y <= 6 &&
                        !(x >= -6 && x <= -4 && Math.abs(z) <= 1)) return true;
                    if (x >= 4 && z <= 0 && y <= 1) return true;            // lower ledge
                    if (z >= 4 && y <= 11) return true;                     // final altar
                    return y <= 0;
                }).build();

        default:
            return builder.build();
    }
}

export { getLevelParamsV1, getLevelParamsV2, getLevelParamsV3 };

// --- ACTIVE LEVEL DISPOSAL & RESOURCE CLEANUP ---
function clearCurrentLevel() {
    clearVegetation();

    for (let k in counts) { 
        counts[k] = 0; 
        if (meshes[k]) {
            meshes[k].count = 0; 
            meshes[k].instanceMatrix.needsUpdate = true;
        } 
    }

    if (typeof _activeDecorationMeshes !== 'undefined') {
        _activeDecorationMeshes.forEach(m => {
            scene.remove(m);
            m.traverse(c => { if (c.isMesh && c.geometry) c.geometry.dispose(); });
        });
        _activeDecorationMeshes.length = 0;
    }
    if (typeof clearDecorInstances === 'function') {
        clearDecorInstances();
    }

    levelBodies.forEach(b => world.removeBody(b));
    levelBodies.length = 0;

    levelConstraints.forEach(c => world.removeConstraint(c));
    levelConstraints.length = 0;

    activePlates.forEach(p => {
        world.removeBody(p.body);
        scene.remove(p.group);
        if (p.lensMat) p.lensMat.dispose();
        if (p.coreMat) p.coreMat.dispose();
    });
    activePlates.length = 0;

    activeDoors.forEach(d => {
        world.removeBody(d.body);
        scene.remove(d.group);
        d.group.traverse(child => {
            if (child.material) child.material.dispose();
        });
    });
    activeDoors.length = 0;

    logicNodes.inputs.fill(false);
    logicNodes.resolved.fill(false);
    if (!isEditorMode && !isPlayingCustom) {
        logicNodes.configs = {};
    }

    activeFields.forEach(f => {
        world.removeBody(f.body);
        scene.remove(f.group);
        if (f.baseMesh && f.baseMesh.material) f.baseMesh.material.dispose();
        if (f.gridLines && f.gridLines.material) f.gridLines.material.dispose();
        if (f.shieldMesh && f.shieldMesh.material) f.shieldMesh.material.dispose();
    });
    activeFields.length = 0;

    _activeDecorationMeshes.forEach(m => {
        scene.remove(m);
        m.traverse(c => { if (c.isMesh && c.geometry) c.geometry.dispose(); });
    });
    _activeDecorationMeshes.length = 0;

    levelGeometries.forEach(g => g.dispose());
    levelGeometries.length = 0;

    levelMaterials.forEach(m => m.dispose());
    levelMaterials.length = 0;

    levelMeshes.forEach(m => scene.remove(m));
    levelMeshes.length = 0;

    levelLights.forEach(l => scene.remove(l));
    levelLights.length = 0;

    dynamicRopes.forEach(r => {
        r.segmentMeshes.forEach(mesh => scene.remove(mesh));
    });
    dynamicRopes.length = 0;

    windZones.forEach(z => {
        scene.remove(z.particles);
        z.particles.geometry.dispose();
        z.particles.material.dispose();
    });
    windZones.length = 0;

    if (waterMesh) {
        if (waterMesh.material && waterMesh.material.uniforms && waterMesh.material.uniforms['mirrorSampler']) {
            const rt = waterMesh.material.uniforms['mirrorSampler'].value;
            if (rt && rt.dispose) rt.dispose();
        }
        if (waterMesh.geometry) waterMesh.geometry.dispose();
        if (waterMesh.material) waterMesh.material.dispose();
    }

    if (currentGoal) {
        scene.remove(currentGoal);
        currentGoal.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        });
    }

    holograms.forEach(h => {
        scene.remove(h.sprite);
        h.sprite.material.map.dispose();
        h.sprite.material.dispose();
        if (h.light) scene.remove(h.light);
        if (h.baseMesh) scene.remove(h.baseMesh);
    });
    holograms.length = 0;

    wallLightPanelMesh.count = 0;
    wallLightPanelCount = 0;

    dynamicSyncList.length = 0;
    interactiveBlocks.length = 0;
    interactiveTargets.length = 0;
    meshToBlock.clear();
    grabbedBlock = null;
    exitMesh = null;
    waterMesh = null;
    currentGoal = null;
    currentGreenBlock = null;
    pendingBounce = false;
    pendingBounceBlock = null;
    AudioSys.focusElement = null;

    scene.children = scene.children.filter(Boolean);
}

// Compress integer coordinates [-512, 511] into a single 30-bit integer key
function getVoxelKey(x, y, z) {
    return ((x + 512) & 0x3FF) | (((y + 512) & 0x3FF) << 10) | (((z + 512) & 0x3FF) << 20);
}

// =============================================================================
// LEVEL BUILDER ORCHESTRATION & PROCEDURAL VEGETATION INTEGRATION
// =============================================================================

function buildLevel(lvlIndex, isPreview = false, isReset = false, keepPos = false) {
    const rngLocal = splitmix32(5);
    clearCurrentLevel();
    currentParams = getLevelParams(lvlIndex);

    if (currentParams.lights && currentParams.lights.length > 0 && !isPreview) {
        currentParams.lights.forEach(l => {
            addVolumetricPointLight(new THREE.Vector3(l.x, l.y, l.z), l.color, l.intensity, l.radius);
        });
    }

    if (currentParams.plates) currentParams.plates.forEach(p => createPressurePlate(p));
    if (currentParams.doors) currentParams.doors.forEach(d => createGlassDoor(d));
    if (currentParams.ropes) currentParams.ropes.forEach(r => createRope(r));
    if (currentParams.fields) {
        currentParams.fields.forEach(f => {
            if (f.type === 'aero') createAeroFilter(f);
            if (f.type === 'oneway') createOneWayField(f);
        });
    }

    logicNodes.configs = {};
    if (currentParams.logic) {
        currentParams.logic.forEach(l => {
            logicNodes.configs[l.ch] = {
                type: l.type,
                source: l.operands ? l.operands[0] : null,
                sources: l.operands || [],
                operands: l.operands || []
            };
        });
    }

    if (currentParams.cutscene && !isPreview && !isReset) {
        const mm = document.getElementById('main-menu');
        if (mm && mm.style.display === 'none') {
            isCutscene = true;
            cutsceneTimer = 0;
            cutsceneType = currentParams.cutscene || 'flyover';
            cutsceneDuration = 12.0;
        } else {
            isCutscene = false;
        }
        document.getElementById('crosshair').style.opacity = '0';
    } else {
        isCutscene = false;
        isTransitioning = false;
        if (!isPreview && !isMontageCutscene) {
            document.getElementById('fade-overlay').style.opacity = '0';
            document.getElementById('crosshair').style.opacity = '1';
        }
    }

    activeWinds.forEach(w => {
        scene.remove(w.visuals);
        w.visuals.geometry.dispose();
        w.visuals.material.dispose();
    });
    activeWinds.length = 0;

    if (currentParams.winds && !isPreview) {
        currentParams.winds.forEach(wData => {
            const wind = {
                pos: wData.pos.clone().applyQuaternion(globalTiltThree),
                size: wData.size.clone(),
                dir: wData.dir.clone().applyQuaternion(globalTiltThree),
                strength: wData.strength
            };

            const lineCount = Math.floor(wData.size.x * wData.size.y * wData.size.z * 2.5);
            const geo = new THREE.BufferGeometry();
            const posArray = new Float32Array(lineCount * 6);
            const opacities = new Float32Array(lineCount * 2);
            const speeds = new Float32Array(lineCount);

            for (let i = 0; i < lineCount; i++) {
                let x = (Math.random() - 0.5) * wData.size.x * 2;
                let y = (Math.random() - 0.5) * wData.size.y * 2;
                let z = (Math.random() - 0.5) * wData.size.z * 2;
                let len = 0.5 + (Math.random() * wData.strength * 0.1);

                posArray[i * 6 + 0] = x;
                posArray[i * 6 + 1] = y;
                posArray[i * 6 + 2] = z;
                posArray[i * 6 + 3] = x;
                posArray[i * 6 + 4] = y;
                posArray[i * 6 + 5] = z - len;

                opacities[i * 2 + 0] = 0.0;
                opacities[i * 2 + 1] = Math.random() * 0.5 + 0.2;
                speeds[i] = wData.strength * (0.8 + Math.random() * 0.4);
            }

            geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
            geo.setAttribute('opacity', new THREE.BufferAttribute(opacities, 1));

            const mat = new THREE.ShaderMaterial({
                uniforms: { color: { value: new THREE.Color(0xaaddff) } },
                vertexShader: `
                    attribute float opacity;
                    varying float vOpacity;
                    void main() {
                        vOpacity = opacity;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform vec3 color;
                    varying float vOpacity;
                    void main() {
                        gl_FragColor = vec4(color, vOpacity);
                    }
                `,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });

            wind.visuals = new THREE.LineSegments(geo, mat);
            wind.visuals.position.copy(wind.pos);
            wind.visuals.lookAt(wind.pos.clone().add(wind.dir));
            wind.speeds = speeds;

            scene.add(wind.visuals);
            activeWinds.push(wind);
        });
    }

    if (!isPreview) document.getElementById('level-title').innerText = currentParams.name;
    applyAtmosphere(activeChapter);

    const grid = new Map();
    const bX = currentParams.bounds.x, bY = currentParams.bounds.y, bZ = currentParams.bounds.z;

    for (let x = -bX - 1; x <= bX + 1; x++) {
        for (let y = -1; y <= bY + 1; y++) {
            for (let z = -bZ - 1; z <= bZ + 1; z++) {
                if (currentParams.isSolid(x, y, z)) {
                    grid.set(getVoxelKey(x, y, z), { x, y, z, exposed: [] });
                }
            }
        }
    }

    const neighbors = [
        { dx:  1, dy:  0, dz:  0 }, { dx: -1, dy:  0, dz:  0 },
        { dx:  0, dy:  1, dz:  0 }, { dx:  0, dy: -1, dz:  0 },
        { dx:  0, dy:  0, dz:  1 }, { dx:  0, dy:  0, dz: -1 }
    ];
    const finalVisible = [];
    const destroyZones = currentParams.destructionZones || [];

    grid.forEach(blk => {
        let isExp = false;
        for (let i = 0; i < neighbors.length; i++) {
            const n = neighbors[i];
            const nKey = getVoxelKey(blk.x + n.dx, blk.y + n.dy, blk.z + n.dz);
            if (!grid.has(nKey)) {
                blk.exposed.push(n);
                isExp = true;
            }
        }
        if (isExp) {
            let minDist = Infinity;
            let closestInner = 8, closestOuter = 11;
            let noise = Math.sin(blk.x * 2.5) * Math.cos(blk.z * 2.5) * 1.5;
            for (let j = 0; j < destroyZones.length; j++) {
                const dz = destroyZones[j];
                const dx = blk.x - dz.cx, dy = blk.y - dz.cy, ddzz = blk.z - dz.cz;
                const d = Math.sqrt(dx * dx + dy * dy + ddzz * ddzz) + noise;
                if (d < minDist) {
                    minDist = d;
                    closestInner = dz.innerRadius;
                    closestOuter = dz.outerRadius;
                }
            }

            if (minDist < closestInner) {
                if (rngLocal() < 0.65) {
                    grid.delete(getVoxelKey(blk.x, blk.y, blk.z));
                    return;
                }
                blk.isBroken = true;
            } else if (minDist < closestOuter) {
                if (rngLocal() < 0.4) blk.isBroken = true;
            }

            if (!blk.isBroken) {
                if (currentParams.waterY !== undefined &&
                    blk.y <= currentParams.waterY + 3 && blk.y >= currentParams.waterY - 1 &&
                    rngLocal() < 0.35) {
                    blk.variant = 'mossy';
                } else if (minDist < closestOuter * 1.3 && rngLocal() < 0.15) {
                    blk.variant = 'scorched';
                }
            }
            finalVisible.push(blk);
        }
    });

    const blocksToRender = [];
    const ceilingAnchors = [];
    const wallAnchors = [];
    const topSurfaces = [];

// ── 1. COLLECT ANCHORS FOR DECORATIONS & VEGETATION ───────────────────────
    finalVisible.forEach(b => {
        const bPos = new THREE.Vector3(b.x, b.y, b.z);

        // Ceiling Anchors (with strict 4-voxel downward clearance check)
        if (b.exposed.some(n => n.dy === -1)) {
            let hasClearance = true;
            for (let dy = 1; dy <= 4; dy++) {
                if (currentParams.isSolid(b.x, b.y - dy, b.z)) {
                    hasClearance = false;
                    break;
                }
            }
            const waterLevel = currentParams.waterY !== undefined ? currentParams.waterY : -999.0;
            if (b.y - 3.5 <= waterLevel) hasClearance = false;

            if (hasClearance) {
                ceilingAnchors.push(bPos.clone().set(b.x, b.y - 0.5, b.z).applyQuaternion(globalTiltThree));
            }
        } 
        // Wall Anchors
        else if (b.y < 8 && b.y > 2 && b.exposed.some(n => n.dx !== 0 || n.dz !== 0)) {
            const wn = b.exposed.find(n => n.dx !== 0 || n.dz !== 0);
            wallAnchors.push({
                pos: bPos.clone().applyQuaternion(globalTiltThree),
                normal: new THREE.Vector3(wn.dx, 0, wn.dz).applyQuaternion(globalTiltThree)
            });
        }

        // Top Floor/Ledge Surfaces
        if (!b.isBroken && b.exposed.some(n => n.dy === 1)) {
            topSurfaces.push(bPos.clone().set(b.x, b.y + 0.5, b.z).applyQuaternion(globalTiltThree));
        }
    });

    // ── 2. GREEDY VOXEL MERGING: CONSOLIDATE 1x1 INTO 2x1 & 2x2 BLOCKS ──────
    const consumed = new Set();
    const visMap = new Map();

    const getMeshType = (b) => {
        if (b.y <= 0) return 'floor';
        if (b.isBroken) return 'broken';
        if (b.variant === 'mossy') return 'mossy';
        if (b.variant === 'scorched') return 'scorched';
        return 'wall';
    };

    finalVisible.forEach(b => {
        visMap.set(getVoxelKey(b.x, b.y, b.z), b);
    });

    finalVisible.forEach(b => {
        const k0 = getVoxelKey(b.x, b.y, b.z);
        if (consumed.has(k0)) return;

        const mType = getMeshType(b);

        // A. Attempt 2x1x2 Horizontal Slab (2 in X, 1 in Y, 2 in Z)
        const k_x1_z0 = getVoxelKey(b.x + 1, b.y, b.z);
        const k_x0_z1 = getVoxelKey(b.x, b.y, b.z + 1);
        const k_x1_z1 = getVoxelKey(b.x + 1, b.y, b.z + 1);

        const b_x1_z0 = visMap.get(k_x1_z0);
        const b_x0_z1 = visMap.get(k_x0_z1);
        const b_x1_z1 = visMap.get(k_x1_z1);

        if (
            b_x1_z0 && !consumed.has(k_x1_z0) && getMeshType(b_x1_z0) === mType &&
            b_x0_z1 && !consumed.has(k_x0_z1) && getMeshType(b_x0_z1) === mType &&
            b_x1_z1 && !consumed.has(k_x1_z1) && getMeshType(b_x1_z1) === mType
        ) {
            consumed.add(k0);
            consumed.add(k_x1_z0);
            consumed.add(k_x0_z1);
            consumed.add(k_x1_z1);

            blocksToRender.push({
                type: '2x1x2',
                x: b.x + 0.5,
                y: b.y,
                z: b.z + 0.5,
                meshType: mType,
                isBroken: b.isBroken
            });
            return;
        }

        // B. Attempt 2x2x1 Vertical Wall Slab (2 in X, 2 in Y, 1 in Z)
        const k_x1_y0 = getVoxelKey(b.x + 1, b.y, b.z);
        const k_x0_y1 = getVoxelKey(b.x, b.y + 1, b.z);
        const k_x1_y1 = getVoxelKey(b.x + 1, b.y + 1, b.z);

        const b_x1_y0 = visMap.get(k_x1_y0);
        const b_x0_y1 = visMap.get(k_x0_y1);
        const b_x1_y1 = visMap.get(k_x1_y1);

        if (
            b_x1_y0 && !consumed.has(k_x1_y0) && getMeshType(b_x1_y0) === mType &&
            b_x0_y1 && !consumed.has(k_x0_y1) && getMeshType(b_x0_y1) === mType &&
            b_x1_y1 && !consumed.has(k_x1_y1) && getMeshType(b_x1_y1) === mType
        ) {
            consumed.add(k0);
            consumed.add(k_x1_y0);
            consumed.add(k_x0_y1);
            consumed.add(k_x1_y1);

            blocksToRender.push({
                type: '2x2x1',
                x: b.x + 0.5,
                y: b.y + 0.5,
                z: b.z,
                meshType: mType,
                isBroken: b.isBroken
            });
            return;
        }

        // C. Attempt 1x2x2 Side Wall Slab (1 in X, 2 in Y, 2 in Z)
        const k_y1_z0 = getVoxelKey(b.x, b.y + 1, b.z);
        const k_y0_z1 = getVoxelKey(b.x, b.y, b.z + 1);
        const k_y1_z1 = getVoxelKey(b.x, b.y + 1, b.z + 1);

        const b_y1_z0 = visMap.get(k_y1_z0);
        const b_y0_z1 = visMap.get(k_y0_z1);
        const b_y1_z1 = visMap.get(k_y1_z1);

        if (
            b_y1_z0 && !consumed.has(k_y1_z0) && getMeshType(b_y1_z0) === mType &&
            b_y0_z1 && !consumed.has(k_y0_z1) && getMeshType(b_y0_z1) === mType &&
            b_y1_z1 && !consumed.has(k_y1_z1) && getMeshType(b_y1_z1) === mType
        ) {
            consumed.add(k0);
            consumed.add(k_y1_z0);
            consumed.add(k_y0_z1);
            consumed.add(k_y1_z1);

            blocksToRender.push({
                type: '1x2x2',
                x: b.x,
                y: b.y + 0.5,
                z: b.z + 0.5,
                meshType: mType,
                isBroken: b.isBroken
            });
            return;
        }

        // D. Fallback: Standard 1x1x1 Single Block
        consumed.add(k0);
        blocksToRender.push({
            type: '1x1x1',
            x: b.x,
            y: b.y,
            z: b.z,
            meshType: mType,
            isBroken: b.isBroken
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // AUTOMATIC VEGETATION POPULATION: GRASS CARPETS, FERNS & COMPOUND BUSHES
    // ─────────────────────────────────────────────────────────────────────────
    if (!isPreview) {
        const vegRng = _makeRng(lvlIndex * 31337 + 101);
        const spawnPt = currentParams.spawn.clone().applyQuaternion(globalTiltThree);
        const exitPt  = currentParams.exit.clone().applyQuaternion(globalTiltThree);
        const waterLevel = currentParams.waterY !== undefined ? currentParams.waterY : -999.0;

        // 1. DENSE GRASS BLADE POPULATION ACROSS EXPOSED HORIZONTAL SURFACES
        topSurfaces.forEach(pos => {
            // Keep spawn and exit clear from grass obstruction
            if (pos.distanceTo(spawnPt) < 2.0 || pos.distanceTo(exitPt) < 2.0) return;
            // Skip sub-water surfaces
            if (pos.y < waterLevel - 0.2) return;

            // Density: 16 to 28 blades per square meter tile
            const bladesPerTile = 18 + Math.floor(vegRng() * 10);
            grassField.addCluster(pos.x, pos.y, pos.z, 0.48, bladesPerTile, vegRng);
        });
        grassField.commit();

        // 2. FERN ROSETTES IN SHADED CORNERS & NEAR WATER
        topSurfaces.forEach(pos => {
            if (pos.distanceTo(spawnPt) < 2.5 || pos.distanceTo(exitPt) < 2.5) return;
            if (pos.y < waterLevel - 0.1) return;

            const isNearWater = Math.abs(pos.y - waterLevel) < 2.5;
            const fernChance = isNearWater ? 0.35 : 0.08;

            if (vegRng() < fernChance) {
                const fernScale = 0.75 + vegRng() * 0.5;
                spawnFernEntity(pos.x, pos.y, pos.z, fernScale);
            }
        });

        // 3. COMPOUND VOLUMETRIC BUSHES: MERGED RECTANGULAR REGIONS
        // Cluster adjacent top surfaces to form multi-rectangle bush boundaries
        const bushVolumes = [];
        const visitedBushVoxel = new Set();

        topSurfaces.forEach(pos => {
            if (pos.distanceTo(spawnPt) < 4.0 || pos.distanceTo(exitPt) < 4.0) return;
            if (pos.y < waterLevel) return;

            const key = `${Math.round(pos.x)},${Math.round(pos.z)}`;
            if (visitedBushVoxel.has(key)) return;

            // Spawn bush thickets organically in rooms with a 7% starting probability
            if (vegRng() < 0.07) {
                const compoundRects = [];
                const clusterW = 1 + Math.floor(vegRng() * 2); // 1 to 2 tiles wide
                const clusterD = 1 + Math.floor(vegRng() * 2);

                const minX = pos.x - clusterW * 0.5;
                const maxX = pos.x + clusterW * 0.5;
                const minZ = pos.z - clusterD * 0.5;
                const maxZ = pos.z + clusterD * 0.5;
                const h = 0.9 + vegRng() * 0.6;

                compoundRects.push({
                    minX, maxX,
                    minY: pos.y,
                    maxY: pos.y + h,
                    minZ, maxZ
                });

                // Add an overlapping intersecting volume to create natural asymmetric rounding
                if (vegRng() > 0.4) {
                    compoundRects.push({
                        minX: minX + (vegRng() - 0.5) * 0.8,
                        maxX: maxX + (vegRng() - 0.5) * 0.8,
                        minY: pos.y,
                        maxY: pos.y + h * (0.8 + vegRng() * 0.3),
                        minZ: minZ + (vegRng() - 0.5) * 0.8,
                        maxZ: maxZ + (vegRng() - 0.5) * 0.8
                    });
                }

                generateBushFromRectangles(compoundRects, { seed: Math.floor(vegRng() * 100000) });

                // Mark nearby surface tiles so bushes don't awkwardly intersect
                for (let dx = -2; dx <= 2; dx++) {
                    for (let dz = -2; dz <= 2; dz++) {
                        visitedBushVoxel.add(`${Math.round(pos.x + dx)},${Math.round(pos.z + dz)}`);
                    }
                }
            }
        });

        // 4. CREEPING WALL IVY
        wallAnchors.forEach(anchor => {
            if (anchor.pos.distanceTo(spawnPt) < 3.0 || anchor.pos.distanceTo(exitPt) < 3.0) return;
            if (vegRng() < 0.22) {
                const ivyH = 2.0 + vegRng() * 3.5;
                const ivyW = 1.0 + vegRng() * 1.5;
                generateIvyWallClimber(anchor.pos, anchor.normal, ivyH, ivyW, Math.floor(vegRng() * 100000));
            }
        });

        // ── SPAWN HANGING CEILING VINES (Clamped to avoid touching the floor) ───
        ceilingAnchors.forEach(pos => {
            if (pos.distanceTo(spawnPt) < 3.0 || pos.distanceTo(exitPt) < 3.0) return;
            if (vegRng() < 0.28) {
                const vx = Math.round(pos.x);
                const vy = Math.round(pos.y + 0.5);
                const vz = Math.round(pos.z);

                // Measure exact distance to whatever surface lies below
                let openDrop = 0;
                for (let dy = 1; dy <= 6; dy++) {
                    if (!currentParams.isSolid(vx, vy - dy, vz)) openDrop++;
                    else break;
                }

                if (openDrop >= 3) {
                    // Ensure a safe 0.8m gap above the floor below
                    const safeMaxLen = Math.max(0.6, openDrop - 0.8);
                    const vineProp = buildDecoVineHanging(_makeRng(Math.floor(vegRng() * 10000)), safeMaxLen);
                    vineProp.position.copy(pos);
                    vegetationSceneGroup.add(vineProp);
                    levelMeshes.push(vineProp);
                }
            }
        });

        // Run secondary ruin debris placement
        spawnCustomDecorations();
    }

    // Static physics mesh assembly
    const staticTileBody = new CANNON.Body({ 
        mass: 0, 
        material: defaultMat, 
        collisionFilterGroup: CG_STATIC, 
        collisionFilterMask: CG_DYNAMIC | CG_ROPE | CG_PLAYER 
    });
    staticTileBody.quaternion.set(globalTiltThree.x, globalTiltThree.y, globalTiltThree.z, globalTiltThree.w);

    blocksToRender.forEach(blk => {
        _v1.set(blk.x, blk.y, blk.z); 
        const physGX = blk.x, physGY = blk.y, physGZ = blk.z;
        let rx = 0, ry = 0, rz = 0;
        let scaleVal = 1.0;

        const isCompound = blk.type !== '1x1x1';

        if (blk.isBroken) {
            if (rngLocal() > 0.35 && !isCompound) { 
                _v1.y -= rngLocal() * 0.25; 
                _v1.x += (rngLocal() - 0.5) * 0.20;
                _v1.z += (rngLocal() - 0.5) * 0.20;
                rx = (rngLocal() - 0.5) * 0.25;
                ry = (rngLocal() - 0.5) * 0.10;
                rz = (rngLocal() - 0.5) * 0.25; 
                scaleVal = 0.88 + rngLocal() * 0.12;
            }
        } else if (!isCompound) {
            // Gentle jitter only on 1x1 blocks so compound seams stay flush
            _v1.add(_v2.set((rngLocal() - 0.5) * 0.05, (rngLocal() - 0.5) * 0.05, (rngLocal() - 0.5) * 0.05)); 
            rx = (rngLocal() - 0.5) * 0.02;
            ry = (rngLocal() - 0.5) * 0.02;
            rz = (rngLocal() - 0.5) * 0.02;
        }

        _v1.applyQuaternion(globalTiltThree); 
        _q1.setFromEuler(new THREE.Euler(rx, ry, rz)).premultiply(globalTiltThree);
        dummy.position.copy(_v1); 
        dummy.quaternion.copy(_q1); 
        dummy.scale.setScalar(scaleVal); 
        dummy.updateMatrix();

        const meshKey = blk.meshType + blk.type;
        if (meshes[meshKey] && counts[meshKey] < maxCounts[meshKey]) {
            if (isMontageCutscene) {
                expandAnimData.push({
                    meshKey: meshKey,
                    index: counts[meshKey],
                    pos: dummy.position.clone(),
                    quat: dummy.quaternion.clone(),
                    targetScale: scaleVal,
                    dist: Math.sqrt(blk.x * blk.x + blk.y * blk.y + blk.z * blk.z)
                });
            }
            meshes[meshKey].setMatrixAt(counts[meshKey]++, dummy.matrix);
        }

        if (!isPreview && shapes[blk.type]) {
            staticTileBody.addShape(shapes[blk.type], new CANNON.Vec3(physGX, physGY, physGZ));
        }
    });

    if (!isPreview) { 
        world.addBody(staticTileBody); 
        levelBodies.push(staticTileBody); 
    }

    for (const k in meshes) { 
        meshes[k].count = counts[k]; 
        meshes[k].instanceMatrix.needsUpdate = true; 
        if (counts[k] > 0) meshes[k].computeBoundingSphere(); 
    }

    // Dynamic blocks & entities instantiation
    currentParams.blocks.forEach(bData => {
        const config = blockConfigs[bData.type];
        if (!config) return;

        const mat = config.mat.clone();
        levelMaterials.push(mat);

        const isRed = bData.type === 'red';
        const startScale = bData.startScale !== undefined ? bData.startScale : (isRed ? 1.0 : undefined);

        const mesh = new THREE.Mesh(config.geo, mat);
        if (isRed && startScale) { mesh.scale.setScalar(startScale); }
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        scene.add(mesh);
        levelMeshes.push(mesh);

        _v1.copy(bData.pos).applyQuaternion(globalTiltThree);
        let extents = config.extents;
        if (isRed && startScale) {
            const half = startScale * 0.5;
            extents = new CANNON.Vec3(half, half, half);
        }

        const body = new CANNON.Body({
            mass: config.mass,
            position: new CANNON.Vec3(_v1.x, _v1.y, _v1.z),
            shape: new CANNON.Box(extents),
            material: defaultMat,
            collisionFilterGroup: CG_DYNAMIC,
            collisionFilterMask: CG_STATIC | CG_DYNAMIC | CG_PLAYER
        });

        if (bData.type === 'yellow' || bData.type === 'big_yellow') {
            body.type = CANNON.Body.KINEMATIC;
        }

        _q1.setFromEuler(new THREE.Euler(rngLocal(), rngLocal(), rngLocal())).premultiply(globalTiltThree);
        body.quaternion.set(_q1.x, _q1.y, _q1.z, _q1.w);

        if (!isPreview) {
            body.addEventListener("collide", (e) => {
                const hitBlock = interactiveBlocks.find(b => b.body === e.body) || null;
                const relVel = e.contact ? Math.abs(e.contact.getImpactVelocityAlongNormal()) : 0;

                if (hitBlock && hitBlock.type === 'blue') {
                    if (body.type !== CANNON.Body.KINEMATIC) {
                        body.velocity.y = hitBlock.overcharged ? 40 : 20;
                        if (relVel > 12 && body.mass > 100) {
                            hitBlock.overcharged = true;
                            hitBlock.mat.emissive.setHex(0xffffff);
                            hitBlock.mat.emissiveIntensity = 4.0;
                        } else {
                            hitBlock.mat.emissiveIntensity = 2.5;
                            setTimeout(() => {
                                if (hitBlock && hitBlock.mat && !hitBlock.overcharged) hitBlock.mat.emissiveIntensity = 0.7;
                            }, 300);
                        }
                        AudioSys.triggerBlueBounce();
                    }
                }
            });
            world.addBody(body);
            levelBodies.push(body);
        }

        const initPos = new CANNON.Vec3(_v1.x, _v1.y, _v1.z);
        const blockObj = {
            type: bData.type,
            body,
            mesh,
            mat,
            scale: isRed ? startScale : undefined,
            initialPos: initPos,
            initialScale: startScale,
            hasBeenGrabbed: false
        };

        interactiveBlocks.push(blockObj);
        meshToBlock.set(mesh, blockObj);
        interactiveTargets.push(mesh);
        if (bData.type === 'green') currentGreenBlock = blockObj;

        if (isPreview) {
            mesh.position.copy(_v1);
            mesh.quaternion.copy(_q1);
            mesh.updateMatrix();
        }
    });

    const exitPos = currentParams.exit;
    currentGoal = createGoal(exitPos.x, exitPos.y, exitPos.z, currentParams.lockedExit);
    scene.add(currentGoal);
    currentGoal.quaternion.copy(globalTiltThree);

    // Water shader instantiation
    if (currentParams.waterY !== undefined) {
        const wOpts = currentParams.waterOptions || {};
        const WAVES = {
            A: new THREE.Vector4( 1.0,  0.3, 0.10, 4.0 ),
            B: new THREE.Vector4( 0.4,  1.0, 0.08, 2.5 ),
            C: new THREE.Vector4(-0.7,  0.8, 0.05, 1.5 ),
            D: new THREE.Vector4( 0.2, -0.9, 0.03, 1.0 )
        };

        waveTime = 0;
        const waterGeometry = new THREE.PlaneGeometry(60, 60, 128, 128);
        waterNormalTex.repeat.set(4, 4);

        waterMesh = new Water(waterGeometry, {
            textureWidth: 256,
            textureHeight: 256,
            waterNormals: waterNormalTex,
            sunDirection: sunLight.position.clone().normalize(),
            sunColor: 0xffffff,
            waterColor: wOpts.color || 0xacb9c4,
            distortionScale: wOpts.distortionScale || 6.5,
            fog: scene.fog !== undefined,
            alpha: wOpts.alpha || 0.68
        });

        waterMesh.rotation.x = -Math.PI / 2;
        waterMesh.position.y = currentParams.waterY;
        waterMesh.receiveShadow = true;

        waterMesh.material.onBeforeCompile = (shader) => {
            shader.uniforms.waveA = { value: WAVES.A };
            shader.uniforms.waveB = { value: WAVES.B };
            shader.uniforms.waveC = { value: WAVES.C };
            shader.uniforms.waveD = { value: WAVES.D };
            shader.uniforms.waveTime = { value: 0 };
            shader.uniforms.crestBoost = { value: 1.5 };
            shader.uniforms.fresnelPower = { value: 3.0 };
            shader.uniforms.deepColor = { value: new THREE.Color(0x001622) };
            shader.uniforms.shallowColor = { value: new THREE.Color(0x1a6f9c) };
            waterMesh.userData.waveShader = shader;

            shader.vertexShader = `
                uniform vec4 waveA;
                uniform vec4 waveB;
                uniform vec4 waveC;
                uniform vec4 waveD;
                uniform float waveTime;
                varying float vCrest;
                varying vec3 vWorldNormal;
                varying vec3 vViewDir;

                vec3 gerstner(vec4 wave, vec3 p) {
                    float k = 6.28318 / wave.w;
                    float c = sqrt(9.81 / k);
                    vec2 d = normalize(wave.xy);
                    float f = k * (dot(d, p.xz) - c * waveTime);
                    float a = wave.z / k;
                    return vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
                }

                vec3 gerstnerNormal(vec3 p) {
                    vec3 tangentX = vec3(1.0, 0.0, 0.0);
                    vec3 tangentZ = vec3(0.0, 0.0, 1.0);
                    vec4 waves[4];
                    waves[0] = waveA; waves[1] = waveB; waves[2] = waveC; waves[3] = waveD;
                    for (int i = 0; i < 4; i++) {
                        vec4 wave = waves[i];
                        float k = 6.28318 / wave.w;
                        float c = sqrt(9.81 / k);
                        vec2 d = normalize(wave.xy);
                        float f = k * (dot(d, p.xz) - c * waveTime);
                        float a = wave.z / k;
                        float dY = a * k * cos(f);
                        tangentX += vec3(-d.x * d.x * a * k * sin(f), d.x * dY, -d.x * d.y * a * k * sin(f));
                        tangentZ += vec3(-d.x * d.y * a * k * sin(f), d.y * dY, -d.y * d.y * a * k * sin(f));
                    }
                    return normalize(cross(tangentZ, tangentX));
                }
            ` + shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
                'mirrorCoord = modelMatrix * vec4( position, 1.0 );',
                `
                vec3 gDisp = vec3(0.0);
                gDisp += gerstner(waveA, position);
                gDisp += gerstner(waveB, position);
                gDisp += gerstner(waveC, position);
                gDisp += gerstner(waveD, position);
                vec3 displacedPos = position + gDisp;

                float maxAmp = (waveA.z + waveB.z + waveC.z + waveD.z) / 4.0;
                vCrest = clamp(gDisp.y / max(maxAmp, 0.0001) * 0.5 + 0.5, 0.0, 1.0);

                vec3 waveNormal = gerstnerNormal(position);
                vWorldNormal = normalize(mat3(modelMatrix) * waveNormal);
                vViewDir = normalize(cameraPosition - (modelMatrix * vec4(displacedPos, 1.0)).xyz);

                mirrorCoord = modelMatrix * vec4(displacedPos, 1.0);
                `
            );

            shader.vertexShader = shader.vertexShader.replace(
                'vec4 mvPosition =  modelViewMatrix * vec4( position, 1.0 );',
                'vec4 mvPosition = modelViewMatrix * vec4(displacedPos, 1.0);'
            );

            shader.vertexShader = shader.vertexShader.replace(
                'worldPosition = mirrorCoord.xyzw;',
                'worldPosition = modelMatrix * vec4(displacedPos, 1.0);'
            );

            shader.fragmentShader = `
                varying float vCrest;
                varying vec3 vWorldNormal;
                varying vec3 vViewDir;
                uniform float crestBoost;
                uniform float fresnelPower;
                uniform vec3 deepColor;
                uniform vec3 shallowColor;
            ` + shader.fragmentShader;

            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <dithering_fragment>',
                `
                float fresnel = pow(1.0 - clamp(dot(vWorldNormal, vViewDir), 0.0, 1.0), fresnelPower);
                vec3 depthTint = mix(deepColor, shallowColor, fresnel);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb + depthTint, 0.5);

                float rim = pow(1.0 - abs(vWorldNormal.y), 2.0);
                gl_FragColor.rgb += vec3(rim * 0.12);
                gl_FragColor.rgb += vec3(pow(vCrest, 3.0) * crestBoost * 0.15);

                #include <dithering_fragment>
                `
            );
        };

        const wm = waterMesh.material;
        wm.transparent = true;
        wm.depthWrite = false;
        wm.side = THREE.FrontSide;

        if (wm.uniforms.alpha) wm.uniforms.alpha.value = 0.68;
        if (wm.uniforms.distortionScale) wm.uniforms.distortionScale.value = 6.5;
        if (wm.uniforms.size) wm.uniforms.size.value = 4.0;

        scene.add(waterMesh);
        levelMeshes.push(waterMesh);
    }

    if (currentParams.holograms && !isPreview) {
        currentParams.holograms.forEach(h => {
            holograms.push(createHologram(h.text, h.pos));
        });
    }

    if (!keepPos) {
        _v1.copy(currentParams.spawn).applyQuaternion(globalTiltThree);
        playerBody.position.set(_v1.x, _v1.y, _v1.z);
        playerBody.velocity.set(0, 0, 0);
        playerBody.angularVelocity.set(0, 0, 0);
        smoothCamY = _v1.y + playerHalfH * 0.85;

        if (!isPreview) {
            const center = new THREE.Vector3(0, smoothCamY, 0);
            const spawnPos = new THREE.Vector3(_v1.x, smoothCamY, _v1.z);
            camera.position.lerpVectors(spawnPos, center, 0.2);
        } else {
            previewAngle = currentMontageIdx * Math.PI / 2;
        }
    } else {
        smoothCamY = playerBody.position.y + playerHalfH * 0.85;
    }

    // Refresh PMREM cubemap reflection probe
    cubeCamera.position.copy(currentParams.spawn).applyQuaternion(globalTiltThree);
    cubeCamera.position.y += 4.0;

    interactiveTargets.forEach(mesh => mesh.visible = false);
    dustMesh.visible = false;
    sparkMesh.visible = false;

    cubeCamera.update(renderer, scene);

    interactiveTargets.forEach(mesh => mesh.visible = true);
    if (gfx.particles > 0) dustMesh.visible = true;
    sparkMesh.visible = true;

    if (scene.environment) scene.environment.dispose();
    scene.environment = pmremGenerator.fromCubemap(cubeRenderTarget.texture).texture;

    if (isMontageCutscene) {
        interactiveTargets.forEach(m => m.visible = false);
        wallLightPanelMesh.count = 0;

        expandAnimData.forEach(item => {
            dummy.position.copy(item.pos);
            dummy.position.y += 15.0;
            dummy.quaternion.copy(item.quat);
            dummy.scale.setScalar(0.001);
            dummy.updateMatrix();
            meshes[item.meshKey].setMatrixAt(item.index, dummy.matrix);
        });
        for (const k in meshes) {
            if (meshes[k].count > 0) meshes[k].instanceMatrix.needsUpdate = true;
        }
        expandAnimActive = true;
        expandAnimTime = 0;
    } else {
        expandAnimActive = false;
    }
}

const heavyRubbleMat = new THREE.MeshStandardMaterial({ 
    map: concreteTexs.albedo,
    normalMap: concreteTexs.normal,
    color: 0x605c58,
    roughness: 0.95,
    metalness: 0.2,
    normalScale: new THREE.Vector2(3.0, 3.0)
});

// =============================================================================
// SAFE BUFFER GEOMETRY MERGER (STANDARDIZES ATTRIBUTES & INDICES)
// =============================================================================

// =============================================================================
// SAFE BUFFER GEOMETRY MERGER (WITH VERTEX COLOR PRESERVATION)
// =============================================================================

function safeMergeGeometries(geos) {
    if (!geos || geos.length === 0) return new THREE.BufferGeometry();
    if (geos.length === 1) {
        let single = geos[0].index ? geos[0].toNonIndexed() : geos[0].clone();
        if (!single.attributes.normal) single.computeVertexNormals();
        return single;
    }

    const hasColors = geos.some(g => !!g.attributes.color);

    const standardized = geos.map(g => {
        let geom = g.index ? g.toNonIndexed() : g.clone();

        // 1. Ensure normals exist
        if (!geom.attributes.normal) geom.computeVertexNormals();

        // 2. Ensure UVs exist
        if (!geom.attributes.uv) {
            const count = geom.attributes.position.count;
            const uvs = new Float32Array(count * 2);
            geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        }

        // 3. Ensure Color attribute consistency across all merged geometries
        if (hasColors && !geom.attributes.color) {
            const count = geom.attributes.position.count;
            const colors = new Float32Array(count * 3).fill(1.0);
            geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }

        // 4. Strip non-standard attributes so schema matches 100%
        for (const name in geom.attributes) {
            if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') {
                geom.deleteAttribute(name);
            }
        }
        return geom;
    });

    const merged = BufferGeometryUtils.mergeGeometries(standardized, false);
    if (!merged) {
        console.warn("safeMergeGeometries error, falling back to empty geometry");
        return new THREE.BufferGeometry();
    }
    merged.computeVertexNormals();
    return merged;
}

// =============================================================================
// ENHANCED PROCEDURAL IVY TEXTURES (ALBEDO, ALPHA & TRANSLUCENCY)
// =============================================================================
function createVineTextures() {
    const S = 512;

    // 1. High-Detail 5-Lobed Ivy Leaf
    const lc = document.createElement('canvas');
    lc.width = lc.height = S;
    const lctx = lc.getContext('2d');
    lctx.clearRect(0, 0, S, S);

    // Anchor petiole at (S * 0.5, S * 0.95) so the base is at the bottom edge
    lctx.save();
    lctx.translate(S * 0.5, S * 0.95);

    // Leaf silhouette
    lctx.beginPath();
    lctx.moveTo(0, 0); // Base petiole junction
    lctx.bezierCurveTo(-S * 0.16, -S * 0.08, -S * 0.38, -S * 0.18, -S * 0.36, -S * 0.36);
    lctx.bezierCurveTo(-S * 0.48, -S * 0.42, -S * 0.46, -S * 0.62, -S * 0.30, -S * 0.68);
    lctx.bezierCurveTo(-S * 0.24, -S * 0.70, -S * 0.18, -S * 0.74, -S * 0.15, -S * 0.80);
    lctx.bezierCurveTo(-S * 0.12, -S * 0.88, -S * 0.04, -S * 0.96, 0, -S * 0.98); // Tip
    lctx.bezierCurveTo(S * 0.04, -S * 0.96, S * 0.12, -S * 0.88, S * 0.15, -S * 0.80);
    lctx.bezierCurveTo(S * 0.18, -S * 0.74, S * 0.24, -S * 0.70, S * 0.30, -S * 0.68);
    lctx.bezierCurveTo(S * 0.46, -S * 0.62, S * 0.48, -S * 0.42, S * 0.36, -S * 0.36);
    lctx.bezierCurveTo(S * 0.38, -S * 0.18, S * 0.16, -S * 0.08, 0, 0);
    lctx.closePath();

    // Natural leaf radial gradient
    const leafGrad = lctx.createRadialGradient(0, -S * 0.50, 10, 0, -S * 0.50, S * 0.55);
    leafGrad.addColorStop(0.00, '#388e24'); // Chlorophyll core
    leafGrad.addColorStop(0.55, '#1e5e14'); // Mid body
    leafGrad.addColorStop(0.85, '#0e3a0b'); // Shaded edges
    leafGrad.addColorStop(1.00, '#2d6d1b');
    lctx.fillStyle = leafGrad;
    lctx.fill();

    // Vein network with tapering translucency
    const drawVein = (x1, y1, x2, y2, width, alpha) => {
        lctx.strokeStyle = `rgba(185, 235, 160, ${alpha})`;
        lctx.lineWidth = width;
        lctx.beginPath();
        lctx.moveTo(x1, y1);
        lctx.lineTo(x2, y2);
        lctx.stroke();
    };

    drawVein(0, 0, 0, -S * 0.94, 4.5, 0.75); // Midrib
    drawVein(0, -S * 0.08, -S * 0.28, -S * 0.64, 3.2, 0.60);
    drawVein(0, -S * 0.08,  S * 0.28, -S * 0.64, 3.2, 0.60);
    drawVein(0, -S * 0.04, -S * 0.26, -S * 0.32, 2.4, 0.50);
    drawVein(0, -S * 0.04,  S * 0.26, -S * 0.32, 2.4, 0.50);
    lctx.restore();

    // 2. Normal Map for the Leaf (Gives specular depth to the cuticle and veins)
    const nc = document.createElement('canvas');
    nc.width = nc.height = S;
    const nctx = nc.getContext('2d');
    nctx.fillStyle = '#8080ff'; // Flat tangent space normal
    nctx.fillRect(0, 0, S, S);

    const leafTex = new THREE.CanvasTexture(lc);
    leafTex.colorSpace = THREE.SRGBColorSpace;
    leafTex.generateMipmaps = true;

    // 3. Delicate Jasmine / Star Blossom (Toned down, no neon glare)
    const fc = document.createElement('canvas');
    fc.width = fc.height = 256;
    const fctx = fc.getContext('2d');
    fctx.clearRect(0, 0, 256, 256);
    fctx.save();
    fctx.translate(128, 128);

    for (let i = 0; i < 5; i++) {
        fctx.save();
        fctx.rotate((i / 5) * Math.PI * 2);
        const pGrad = fctx.createRadialGradient(0, -55, 2, 0, -55, 45);
        pGrad.addColorStop(0.0, '#ffffff');
        pGrad.addColorStop(0.7, '#e8ecef');
        pGrad.addColorStop(1.0, '#b8c2cc');
        fctx.fillStyle = pGrad;
        fctx.beginPath();
        fctx.ellipse(0, -50, 16, 38, 0, 0, Math.PI * 2);
        fctx.fill();
        fctx.restore();
    }

    // Yellow-gold center
    const cGrad = fctx.createRadialGradient(0, 0, 1, 0, 0, 18);
    cGrad.addColorStop(0, '#fef08a');
    cGrad.addColorStop(0.7, '#d97706');
    cGrad.addColorStop(1, 'rgba(180, 83, 9, 0)');
    fctx.fillStyle = cGrad;
    fctx.beginPath();
    fctx.arc(0, 0, 18, 0, Math.PI * 2);
    fctx.fill();
    fctx.restore();

    const flowerTex = new THREE.CanvasTexture(fc);
    flowerTex.colorSpace = THREE.SRGBColorSpace;
    flowerTex.generateMipmaps = true;

    return { leafTex, flowerTex };
}

// Rebuild materials with better specular response
const { leafTex: vineLeafTex, flowerTex: vineFlowerTex } = createVineTextures();

const vineLeafMat = new THREE.MeshStandardMaterial({
    map: vineLeafTex,
    alphaTest: 0.35,
    transparent: false,
    vertexColors: true,
    roughness: 0.28,      // Gives realistic waxy cuticle specular highlights
    metalness: 0.02,
    side: THREE.DoubleSide,
    shadowSide: THREE.DoubleSide
});

const vineWoodMat = new THREE.MeshStandardMaterial({
    color: 0x36281e,
    roughness: 0.90,
    metalness: 0.04
});

const vineFlowerMat = new THREE.MeshStandardMaterial({
    map: vineFlowerTex,
    alphaTest: 0.30,
    transparent: false,
    roughness: 0.45,
    metalness: 0.0,
    side: THREE.DoubleSide
});

function createCreasedLeafGeometry(width, height) {
    const geom = new THREE.BufferGeometry();
    const halfW = width * 0.5;
    const archDepth = width * 0.22; // Midrib dip

    // 4 triangles creating a folded, cup-shaped leaf anchored at Y=0
    // Vertices: [base, left-mid, midrib-mid, right-mid, tip]
    const positions = new Float32Array([
        // Triangle 1: Base -> Left-Mid -> Midrib-Center
        0.0, 0.0, 0.0,
        -halfW, height * 0.5, 0.0,
        0.0, height * 0.55, archDepth,

        // Triangle 2: Base -> Midrib-Center -> Right-Mid
        0.0, 0.0, 0.0,
        0.0, height * 0.55, archDepth,
        halfW, height * 0.5, 0.0,

        // Triangle 3: Midrib-Center -> Left-Mid -> Tip
        0.0, height * 0.55, archDepth,
        -halfW, height * 0.5, 0.0,
        0.0, height, 0.05,

        // Triangle 4: Midrib-Center -> Tip -> Right-Mid
        0.0, height * 0.55, archDepth,
        0.0, height, 0.05,
        halfW, height * 0.5, 0.0
    ]);

    const uvs = new Float32Array([
        0.5, 0.05,  0.0, 0.50,  0.5, 0.55,
        0.5, 0.05,  0.5, 0.55,  1.0, 0.50,
        0.5, 0.55,  0.0, 0.50,  0.5, 0.98,
        0.5, 0.55,  0.5, 0.98,  1.0, 0.50
    ]);

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.computeVertexNormals();
    return geom;
}
// =============================================================================
// PROCEDURAL CEILING HANGING VINE (WITH NATURAL CATENARY TAPERING & TIP CURLS)
// =============================================================================

function _createFoldedLeafGeometry(width, height) {
    const geom = new THREE.BufferGeometry();
    const halfW = width * 0.5;
    const archDepth = width * 0.22; // Midrib dihedral fold

    // 4 triangles forming a curved leaf anchored at the petiole junction (Y = 0)
    const positions = new Float32Array([
        // Triangle 1: Base -> Left-Mid -> Midrib-Center
        0.0, 0.0, 0.0,
        -halfW, height * 0.48, 0.0,
        0.0, height * 0.52, archDepth,

        // Triangle 2: Base -> Midrib-Center -> Right-Mid
        0.0, 0.0, 0.0,
        0.0, height * 0.52, archDepth,
        halfW, height * 0.48, 0.0,

        // Triangle 3: Midrib-Center -> Left-Mid -> Tip
        0.0, height * 0.52, archDepth,
        -halfW, height * 0.48, 0.0,
        0.0, height, 0.03,

        // Triangle 4: Midrib-Center -> Tip -> Right-Mid
        0.0, height * 0.52, archDepth,
        0.0, height, 0.03,
        halfW, height * 0.48, 0.0
    ]);

    const uvs = new Float32Array([
        0.5, 0.02,  0.0, 0.50,  0.5, 0.54,
        0.5, 0.02,  0.5, 0.54,  1.0, 0.50,
        0.5, 0.54,  0.0, 0.50,  0.5, 0.98,
        0.5, 0.54,  0.5, 0.98,  1.0, 0.50
    ]);

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.computeVertexNormals();
    return geom;
}

function buildDecoVineHanging(rngFn = _makeRng(666), maxLen = 2.4) {
    const group = new THREE.Group();
    const strandCount = 2 + Math.floor(rngFn() * 3);
    const woodGeos = [];
    const leafGeos = [];

    for (let i = 0; i < strandCount; i++) {
        // Enforce strict clearance so tips never collide with the floor
        const len = Math.max(0.75, Math.min(maxLen, 0.85 + rngFn() * (maxLen - 0.85)));
        const originX = (rngFn() - 0.5) * 0.35;
        const originZ = (rngFn() - 0.5) * 0.35;

        // Spline simulating catenary drape with an organic winding curl at the tip
        const curvePoints = [
            new THREE.Vector3(originX, 0, originZ),
            new THREE.Vector3(originX + (rngFn() - 0.5) * 0.16, -len * 0.30, originZ + (rngFn() - 0.5) * 0.16),
            new THREE.Vector3(originX + (rngFn() - 0.5) * 0.28, -len * 0.65, originZ + (rngFn() - 0.5) * 0.28),
            // Tapered curly tendril tip
            new THREE.Vector3(originX + (rngFn() - 0.5) * 0.34 + 0.06, -len * 0.90, originZ + 0.04),
            new THREE.Vector3(originX + (rngFn() - 0.5) * 0.38 + 0.10, -len, originZ + 0.07)
        ];

        const curve = new THREE.CatmullRomCurve3(curvePoints);

        // Segmented continuous stem that smoothly tapers down to 20% thickness
        const segments = 18;
        for (let s = 0; s < segments; s++) {
            const t1 = s / segments;
            const t2 = (s + 1) / segments;
            const p1 = curve.getPointAt(t1);
            const p2 = curve.getPointAt(t2);
            const radius = (0.015 * (1.0 - t1 * 0.78)) + 0.0025; // 15mm down to ~3mm
            const segCurve = new THREE.LineCurve3(p1, p2);
            woodGeos.push(new THREE.TubeGeometry(segCurve, 1, radius, 4, false));
        }

        // Pendant leaves hanging downward along the strand
        const leafCount = Math.floor(len * 7) + 4;
        for (let j = 0; j < leafCount; j++) {
            const t = 0.08 + (j / leafCount) * 0.88;
            const pt = curve.getPointAt(t);

            // Mature broad leaves near the ceiling anchor; delicate small leaves near the tip
            const sizeTaper = (1.05 - t * 0.50);
            const lw = (0.11 + rngFn() * 0.05) * sizeTaper;
            const lh = lw * 1.15;
            const leaf = _createFoldedLeafGeometry(lw, lh);

            // Natural gravity-draped orientation
            leaf.rotateZ(rngFn() * Math.PI * 2);
            leaf.rotateX(Math.PI * 0.50 + (rngFn() - 0.5) * 0.35); // Hangs downward
            leaf.translate(pt.x, pt.y, pt.z);

            // Shaded dark forest-green canopy at the top, transitioning to luminous chartreuse shoots at the bottom
            const isTip = t > 0.75;
            let r = isTip ? 1.12 : (0.75 + (1.0 - t) * 0.20);
            let g = isTip ? 1.25 : (0.90 + (1.0 - t) * 0.15);
            let b = isTip ? 0.72 : (0.65 + (1.0 - t) * 0.20);

            const colors = new Float32Array(leaf.attributes.position.count * 3);
            for (let c = 0; c < colors.length; c += 3) {
                colors[c + 0] = r;
                colors[c + 1] = g;
                colors[c + 2] = b;
            }
            leaf.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            leafGeos.push(leaf);
        }
    }

    if (woodGeos.length > 0) {
        group.add(new THREE.Mesh(safeMergeGeometries(woodGeos), vineWoodMat));
    }
    if (leafGeos.length > 0) {
        group.add(new THREE.Mesh(safeMergeGeometries(leafGeos), vineLeafMat));
    }

    return group;
}

// =============================================================================
// PRE-BAKED MERGED PROP GEOMETRIES (FACETED FRACTURES & DETAIL SPALLS)
// =============================================================================

function _bakeDebrisGeometry(seed = 111) {
    const rng = _makeRng(seed);
    const geos = [];
    const count = 22;

    for (let i = 0; i < count; i++) {
        const type = rng();
        let geo;
        if (type < 0.45) {
            // Chipped stone cobble
            const r = 0.05 + rng() * 0.14;
            geo = new THREE.DodecahedronGeometry(r, 0);
            _deformGeometry(geo, rng, r * 0.40);
            geo.translate((rng() - 0.5) * 1.5, -0.46 + r * 0.5, (rng() - 0.5) * 1.5);
        } else if (type < 0.75) {
            // Rebar / conduit splinter
            const len = 0.20 + rng() * 0.40;
            geo = new THREE.CylinderGeometry(0.012, 0.012, len, 4);
            geo.rotateX(rng() * Math.PI);
            geo.rotateY(rng() * Math.PI);
            geo.translate((rng() - 0.5) * 1.5, -0.44, (rng() - 0.5) * 1.5);
        } else {
            // Sheared masonry spall
            const sz = 0.10 + rng() * 0.16;
            geo = new THREE.BoxGeometry(sz, 0.035, sz * (0.8 + rng() * 0.5));
            geo.rotateY(rng() * Math.PI);
            geo.rotateZ((rng() - 0.5) * 0.25);
            geo.translate((rng() - 0.5) * 1.5, -0.45, (rng() - 0.5) * 1.5);
        }
        geos.push(geo);
    }
    return safeMergeGeometries(geos);
}

function _bakeRubbleClusterGeometry(seed = 77) {
    const rng = _makeRng(seed);
    const geos = [];
    const count = 18;

    for (let i = 0; i < count; i++) {
        const radius = 0.08 + rng() * 0.34;
        const geo = new THREE.DodecahedronGeometry(radius, 1);
        _deformGeometry(geo, rng, radius * 0.36);
        // Flatten into natural sedimented scree
        geo.scale(1.0 + rng() * 0.45, 0.40 + rng() * 0.45, 1.0 + rng() * 0.45);

        const dist = Math.pow(rng(), 0.65) * 1.45;
        const angle = rng() * Math.PI * 2;
        geo.rotateX(rng() * 6.28);
        geo.rotateY(rng() * 6.28);
        geo.translate(Math.cos(angle) * dist, -0.50 + radius * 0.38, Math.sin(angle) * dist);
        geos.push(geo);
    }
    return safeMergeGeometries(geos);
}

function _bakePillarGeometry(seed = 19) {
    const rng = _makeRng(seed);
    const geos = [];
    const r = 0.28, h = 2.4;

    // Fractured fluted pillar column
    const colGeo = new THREE.CylinderGeometry(r * 0.76, r, h, 8, 5);
    _deformGeometry(colGeo, rng, 0.055);
    colGeo.translate(0, (h / 2) - 0.50, 0);
    geos.push(colGeo);

    // Broken capital & base spall blocks
    for (let i = 0; i < 8; i++) {
        const cr = 0.07 + rng() * 0.16;
        const rock = new THREE.DodecahedronGeometry(cr, 0);
        _deformGeometry(rock, rng, cr * 0.42);
        const ang = (i / 8) * Math.PI * 2 + rng() * 0.35;
        const dist = 0.42 + rng() * 0.38;
        rock.translate(Math.cos(ang) * dist, -0.46 + cr * 0.5, Math.sin(ang) * dist);
        geos.push(rock);
    }
    return safeMergeGeometries(geos);
}

function _bakeShatteredSlabGeometry(seed = 42) {
    const rng = _makeRng(seed);
    const geos = [];
    const w = 1.35, h = 1.95;

    // Primary leaning architectural slab
    const slabGeo = new THREE.BoxGeometry(w, h, 0.24, 3, 3, 2);
    _deformGeometry(slabGeo, rng, 0.085);
    slabGeo.rotateZ((rng() - 0.5) * 0.48);
    slabGeo.rotateX((rng() - 0.5) * 0.24);
    slabGeo.translate(0, h * 0.42 - 0.50, 0);
    geos.push(slabGeo);

    // Fractured slab shards around base
    for (let i = 0; i < 6; i++) {
        const sr = 0.09 + rng() * 0.18;
        const shard = new THREE.BoxGeometry(sr, 0.045, sr * 1.35);
        shard.rotateY(rng() * Math.PI);
        shard.rotateX((rng() - 0.5) * 0.35);
        shard.translate((rng() - 0.5) * 1.3, -0.46, (rng() - 0.5) * 1.3);
        geos.push(shard);
    }
    return safeMergeGeometries(geos);
}

function _bakeWallRubbleAGeometry(seed = 222) {
    const rng = _makeRng(seed);
    const geos = [];

    const base = new THREE.BoxGeometry(1.0, 0.42, 1.0, 3, 2, 3);
    _deformGeometry(base, rng, 0.09);
    base.translate(0, -0.28, 0);
    geos.push(base);

    const slant = new THREE.BoxGeometry(0.78, 0.38, 0.78, 2, 2, 2);
    _deformGeometry(slant, rng, 0.08);
    slant.rotateY(rng() * Math.PI);
    slant.rotateX((rng() - 0.5) * 0.38);
    slant.translate(0.08, 0.12, 0.08);
    geos.push(slant);

    return safeMergeGeometries(geos);
}

function _bakeWallRubbleBGeometry(seed = 333) {
    const rng = _makeRng(seed);
    const geos = [];

    const p1 = new THREE.BoxGeometry(0.32, 1.0, 1.0, 2, 3, 2);
    _deformGeometry(p1, rng, 0.07);
    p1.translate(-0.34, 0, 0);
    geos.push(p1);

    const p2 = new THREE.BoxGeometry(0.32, 1.0, 1.0, 2, 3, 2);
    _deformGeometry(p2, rng, 0.07);
    p2.translate(0.34, 0, 0);
    geos.push(p2);

    return safeMergeGeometries(geos);
}

function _bakeWallRubbleCGeometry(seed = 444) {
    const rng = _makeRng(seed);
    const geos = [];

    const b = new THREE.BoxGeometry(1.0, 0.48, 1.0, 3, 2, 3);
    _deformGeometry(b, rng, 0.08);
    b.translate(0, -0.25, 0);
    geos.push(b);

    for (let i = 0; i < 3; i++) {
        const s = new THREE.BoxGeometry(0.38, 0.38, 0.38);
        _deformGeometry(s, rng, 0.07);
        s.rotateY(rng() * Math.PI);
        s.translate((rng() - 0.5) * 0.40, 0.14, (rng() - 0.5) * 0.40);
        geos.push(s);
    }
    return safeMergeGeometries(geos);
}

// =============================================================================
// BAKED WALL VINE GEOMETRIES (IMBRICATED HEDERA HELIX MAT WITH PETIOLES)
// =============================================================================

function _bakeWallVineGeometry(seed = 888, withFlowers = false) {
    const rng = _makeRng(seed);
    const woodGeos = [];
    const leafGeos = [];
    const flowerGeos = [];

    const totalHeight = 5.6 + rng() * 1.4;
    const spreadWidth = 2.4 + rng() * 0.6;
    const mainBranches = 4;

    for (let b = 0; b < mainBranches; b++) {
        const startX = (rng() - 0.5) * 0.45;
        const branchSpread = (b - 1.5) * (spreadWidth * 0.28);
        const curvePoints = [];

        let curr = new THREE.Vector3(startX, 0.0, 0.015);
        curvePoints.push(curr.clone());

        const segments = 32;
        for (let s = 1; s <= segments; s++) {
            const vFrac = s / segments;
            curr.y += (totalHeight / segments) * (0.85 + rng() * 0.35);
            // Sinuous climbing path that clings tight against the stone facade
            curr.x = startX + branchSpread * Math.pow(vFrac, 0.85) + Math.sin(curr.y * 1.8 + b) * 0.22;
            curr.z = 0.018 + Math.sin(vFrac * Math.PI * 4.0) * 0.006;
            curvePoints.push(curr.clone());

            // ── DENSE OVERLAPPING LEAF CLUSTERS ──
            const isTip = vFrac > 0.85;
            const leavesAtNode = isTip ? 2 : (3 + Math.floor(rng() * 3));
            const taper = 1.0 - (vFrac * 0.52);

            for (let lf = 0; lf < leavesAtNode; lf++) {
                const side = (lf % 2 === 0) ? -1.0 : 1.0;
                const fanAngle = side * (0.42 + (lf / leavesAtNode) * 0.90 + (rng() - 0.5) * 0.28);
                const petLen = 0.05 + rng() * 0.07;

                const petDirX = Math.sin(fanAngle);
                const petDirY = Math.cos(fanAngle) * 0.72;

                const leafPos = new THREE.Vector3(
                    curr.x + petDirX * petLen,
                    curr.y + petDirY * petLen,
                    curr.z + 0.014 + (rng() - 0.5) * 0.008
                );

                const baseW = 0.12 * (0.75 + rng() * 0.45) * taper;
                const baseH = baseW * 1.15;
                const leaf = _createFoldedLeafGeometry(baseW, baseH);

                // Leaf rotation: angled along petiole and tipped forward 15°-25° off the stone to catch sunlight
                leaf.rotateZ(Math.atan2(petDirX, petDirY) + (rng() - 0.5) * 0.35);
                leaf.rotateX(0.24 + (rng() - 0.5) * 0.18);
                leaf.rotateY((rng() - 0.5) * 0.16);
                leaf.translate(leafPos.x, leafPos.y, leafPos.z);

                // Botanical color variations across maturity stages
                const isJuvenile = taper < 0.40 || rng() < 0.22;
                let r = 0.90, g = 1.0, bCol = 0.85;

                if (isJuvenile) {
                    // Young chartreuse tips
                    r = 1.12 + rng() * 0.10;
                    g = 1.25 + rng() * 0.10;
                    bCol = 0.75;
                } else if (rng() < 0.32) {
                    // Deep shaded forest green
                    r = 0.72;
                    g = 0.84;
                    bCol = 0.64;
                } else if (rng() < 0.22) {
                    // Sun-warmed golden olive
                    r = 1.04;
                    g = 1.02;
                    bCol = 0.70;
                }

                const colors = new Float32Array(leaf.attributes.position.count * 3);
                for (let c = 0; c < colors.length; c += 3) {
                    colors[c + 0] = r;
                    colors[c + 1] = g;
                    colors[c + 2] = bCol;
                }
                leaf.setAttribute('color', new THREE.BufferAttribute(colors, 3));
                leafGeos.push(leaf);

                // Connecting wooden petiole (leaf stalk)
                const petCurve = new THREE.LineCurve3(curr, leafPos);
                woodGeos.push(new THREE.TubeGeometry(petCurve, 2, 0.0035, 3, false));

                // Star blossoms
                if (withFlowers && rng() < 0.12) {
                    const fw = 0.085 + rng() * 0.04;
                    const flQuad = new THREE.PlaneGeometry(fw, fw);
                    flQuad.rotateZ(rng() * Math.PI * 2);
                    flQuad.rotateX(0.18);
                    flQuad.translate(leafPos.x + side * 0.03, leafPos.y, leafPos.z + 0.015);
                    flowerGeos.push(flQuad);
                }
            }
        }

        // Tapered climbing stem
        const curve = new THREE.CatmullRomCurve3(curvePoints);
        woodGeos.push(new THREE.TubeGeometry(curve, 28, 0.014, 5, false));
    }

    const result = {
        wood: safeMergeGeometries(woodGeos),
        leaves: safeMergeGeometries(leafGeos)
    };
    if (withFlowers && flowerGeos.length > 0) {
        result.flowers = safeMergeGeometries(flowerGeos);
    }
    return result;
}

// Pre-baked global geometry templates
const BAKED_DECOR_GEOMS = {
    'decor_debris':     _bakeDebrisGeometry(111),
    'decor_rubble':     _bakeRubbleClusterGeometry(77),
    'decor_pillar':     _bakePillarGeometry(19),
    'decor_shattered':  _bakeShatteredSlabGeometry(42),
    'decor_wall_1x1_a': _bakeWallRubbleAGeometry(222),
    'decor_wall_1x1_b': _bakeWallRubbleBGeometry(333),
    'decor_wall_1x1_c': _bakeWallRubbleCGeometry(444),
    'decor_wall_2x2':   _bakeWallRubbleAGeometry(555) // fallback to A
};

// Pre-bake both variants
const BAKED_WALL_VINE = _bakeWallVineGeometry(888, false);               // 100% pure green leaves
const BAKED_WALL_VINE_FLOWERING = _bakeWallVineGeometry(999, true);     // With flower blossoms

// --- GPU INSTANCED MESH BATCHERS ---
const MAX_DECOR_INSTANCES_PER_TYPE = 450;
const decorInstancedMeshes = {};
const decorInstanceCounts = {};

const decorBatchGroup = new THREE.Group();
decorBatchGroup.name = "DecorInstancedSubsystem";
scene.add(decorBatchGroup);

// Initialize InstancedMeshes for concrete clutter
Object.entries(BAKED_DECOR_GEOMS).forEach(([type, geom]) => {
    const im = new THREE.InstancedMesh(geom, heavyRubbleMat, MAX_DECOR_INSTANCES_PER_TYPE);
    im.count = 0;
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    decorInstancedMeshes[type] = im;
    decorInstanceCounts[type] = 0;
    decorBatchGroup.add(im);
});

// Instanced Meshes for Standard Wall Vines (Wood + Leaves only)
const wallVineWoodIM = new THREE.InstancedMesh(BAKED_WALL_VINE.wood, vineWoodMat, MAX_DECOR_INSTANCES_PER_TYPE);
wallVineWoodIM.count = 0;
wallVineWoodIM.castShadow = true;
wallVineWoodIM.receiveShadow = true;
wallVineWoodIM.frustumCulled = false;
decorBatchGroup.add(wallVineWoodIM);

const wallVineLeafIM = new THREE.InstancedMesh(BAKED_WALL_VINE.leaves, vineLeafMat, MAX_DECOR_INSTANCES_PER_TYPE);
wallVineLeafIM.count = 0;
wallVineLeafIM.castShadow = true;
wallVineLeafIM.receiveShadow = true;
wallVineLeafIM.frustumCulled = false;
decorBatchGroup.add(wallVineLeafIM);

let wallVineCount = 0;

// Instanced Meshes for Flowering Wall Vines (Wood + Leaves + Flowers)
const flowerVineWoodIM = new THREE.InstancedMesh(BAKED_WALL_VINE_FLOWERING.wood, vineWoodMat, MAX_DECOR_INSTANCES_PER_TYPE);
flowerVineWoodIM.count = 0;
flowerVineWoodIM.castShadow = true;
flowerVineWoodIM.receiveShadow = true;
flowerVineWoodIM.frustumCulled = false;
decorBatchGroup.add(flowerVineWoodIM);

const flowerVineLeafIM = new THREE.InstancedMesh(BAKED_WALL_VINE_FLOWERING.leaves, vineLeafMat, MAX_DECOR_INSTANCES_PER_TYPE);
flowerVineLeafIM.count = 0;
flowerVineLeafIM.castShadow = true;
flowerVineLeafIM.receiveShadow = true;
flowerVineLeafIM.frustumCulled = false;
decorBatchGroup.add(flowerVineLeafIM);

const flowerVineFlowerIM = new THREE.InstancedMesh(BAKED_WALL_VINE_FLOWERING.flowers, vineFlowerMat, MAX_DECOR_INSTANCES_PER_TYPE);
flowerVineFlowerIM.count = 0;
flowerVineFlowerIM.castShadow = false;
flowerVineFlowerIM.receiveShadow = true;
flowerVineFlowerIM.frustumCulled = false;
decorBatchGroup.add(flowerVineFlowerIM);

let flowerVineCount = 0;

function clearDecorInstances() {
    for (const type in decorInstanceCounts) {
        decorInstanceCounts[type] = 0;
        decorInstancedMeshes[type].count = 0;
        decorInstancedMeshes[type].instanceMatrix.needsUpdate = true;
    }
    wallVineCount = 0;
    wallVineWoodIM.count = 0;
    wallVineWoodIM.instanceMatrix.needsUpdate = true;
    wallVineLeafIM.count = 0;
    wallVineLeafIM.instanceMatrix.needsUpdate = true;

    flowerVineCount = 0;
    flowerVineWoodIM.count = 0;
    flowerVineWoodIM.instanceMatrix.needsUpdate = true;
    flowerVineLeafIM.count = 0;
    flowerVineLeafIM.instanceMatrix.needsUpdate = true;
    flowerVineFlowerIM.count = 0;
    flowerVineFlowerIM.instanceMatrix.needsUpdate = true;
}

function spawnCustomDecorations() {
    clearDecorInstances();

    const tempMat = new THREE.Matrix4();
    const tempPos = new THREE.Vector3();
    const tempEuler = new THREE.Euler();
    const tempQuat = new THREE.Quaternion();
    const tempScale = new THREE.Vector3();

    const allDecs = customDecorations.concat(autoDecorations);

    for (let i = 0; i < allDecs.length; i++) {
        const dec = allDecs[i];

        // 1. Standard Pure Leafy Wall Vines (NO flowers)
        if (dec.type === 'decor_vine_wall') {
            if (wallVineCount >= MAX_DECOR_INSTANCES_PER_TYPE) continue;

            tempPos.set(dec.x, dec.y, dec.z);
            tempEuler.set(0, dec.rotY || 0, 0);
            tempQuat.setFromEuler(tempEuler);
            tempQuat.premultiply(globalTiltThree);

            const scaleVal = 0.85 + (dec.scale || 1.0) * 0.25;
            tempScale.set(scaleVal, scaleVal, scaleVal);
            tempMat.compose(tempPos, tempQuat, tempScale);

            wallVineWoodIM.setMatrixAt(wallVineCount, tempMat);
            wallVineLeafIM.setMatrixAt(wallVineCount, tempMat);
            wallVineCount++;
            continue;
        }

        // 2. Flowering Wall Vines (Wood + Leaves + Flowers)
        if (dec.type === 'decor_vine_wall_flowering') {
            if (flowerVineCount >= MAX_DECOR_INSTANCES_PER_TYPE) continue;

            tempPos.set(dec.x, dec.y, dec.z);
            tempEuler.set(0, dec.rotY || 0, 0);
            tempQuat.setFromEuler(tempEuler);
            tempQuat.premultiply(globalTiltThree);

            const scaleVal = 0.85 + (dec.scale || 1.0) * 0.25;
            tempScale.set(scaleVal, scaleVal, scaleVal);
            tempMat.compose(tempPos, tempQuat, tempScale);

            flowerVineWoodIM.setMatrixAt(flowerVineCount, tempMat);
            flowerVineLeafIM.setMatrixAt(flowerVineCount, tempMat);
            flowerVineFlowerIM.setMatrixAt(flowerVineCount, tempMat);
            flowerVineCount++;
            continue;
        }

        // 3. Concrete / Rock Clutter
        const im = decorInstancedMeshes[dec.type];
        if (!im) continue;

        const count = decorInstanceCounts[dec.type];
        if (count >= MAX_DECOR_INSTANCES_PER_TYPE) continue;

        tempPos.set(dec.x, dec.y, dec.z);
        tempEuler.set(0, dec.rotY || 0, 0);
        tempQuat.setFromEuler(tempEuler);
        tempQuat.premultiply(globalTiltThree);

        const s = dec.scale || 1.0;
        tempScale.set(s, s, s);
        tempMat.compose(tempPos, tempQuat, tempScale);

        im.setMatrixAt(count, tempMat);
        decorInstanceCounts[dec.type]++;
    }

    for (const type in decorInstancedMeshes) {
        decorInstancedMeshes[type].count = decorInstanceCounts[type];
        decorInstancedMeshes[type].instanceMatrix.needsUpdate = true;
    }
    wallVineWoodIM.count = wallVineCount;
    wallVineWoodIM.instanceMatrix.needsUpdate = true;
    wallVineLeafIM.count = wallVineCount;
    wallVineLeafIM.instanceMatrix.needsUpdate = true;

    flowerVineWoodIM.count = flowerVineCount;
    flowerVineWoodIM.instanceMatrix.needsUpdate = true;
    flowerVineLeafIM.count = flowerVineCount;
    flowerVineLeafIM.instanceMatrix.needsUpdate = true;
    flowerVineFlowerIM.count = flowerVineCount;
    flowerVineFlowerIM.instanceMatrix.needsUpdate = true;
}

// =============================================================================
// OPTIMIZED CONTEXT-AWARE VOXEL SCANNER & PROCEDURAL DECORATION POPULATOR
// =============================================================================

const FLOOR_DECOR_TYPES = ['decor_debris', 'decor_rubble', 'decor_shattered', 'decor_pillar'];
const WALL_DECOR_TYPES  = ['decor_wall_1x1_a', 'decor_wall_1x1_b', 'decor_wall_1x1_c', 'decor_wall_2x2'];

function autoPopulateDecorations(topSurfaces, wallAnchors, ceilingAnchors, destroyZones, params, rngFn) {
    autoDecorations.length = 0;
    if (!topSurfaces || !wallAnchors) return;

    // ── 1. PRE-COMPUTE POSITIONS & CRITICAL GAMEPLAY BUFFERS ─────────────────
    const spawn = params.spawn.clone().applyQuaternion(globalTiltThree);
    const exit  = params.exit.clone().applyQuaternion(globalTiltThree);
    const hasWater = (params.waterY !== undefined);
    const waterLevel = hasWater ? params.waterY : -999.0;

    const plateZones = (params.plates || []).map(p => 
        new THREE.Vector3(p.x, p.y, p.z).applyQuaternion(globalTiltThree)
    );
    const doorZones = (params.doors || []).map(d => 
        new THREE.Vector3(d.x, d.y, d.z).applyQuaternion(globalTiltThree)
    );

    const isNearGameplayObject = (pos, minDistance = 2.0) => {
        const dSq = minDistance * minDistance;
        for (let i = 0; i < plateZones.length; i++) {
            if (plateZones[i].distanceToSquared(pos) < dSq) return true;
        }
        for (let i = 0; i < doorZones.length; i++) {
            if (doorZones[i].distanceToSquared(pos) < dSq) return true;
        }
        return false;
    };

    const zones = (destroyZones || []).map(dz => ({
        center: new THREE.Vector3(dz.cx, dz.cy, dz.cz).applyQuaternion(globalTiltThree),
        innerRadius: dz.innerRadius,
        outerRadius: dz.outerRadius
    }));

    const zoneFalloff = (pos) => {
        if (zones.length === 0) return Infinity;
        let best = Infinity;
        for (let i = 0; i < zones.length; i++) {
            const z = zones[i];
            const d = pos.distanceTo(z.center);
            const t = (d - z.innerRadius) / Math.max(1, z.outerRadius - z.innerRadius);
            if (t < best) best = t;
        }
        return best;
    };

    const tooClose = (list, pos, minDist) => {
        const dSq = minDist * minDist;
        for (let i = 0; i < list.length; i++) {
            if (list[i].distanceToSquared(pos) < dSq) return true;
        }
        return false;
    };

    // ── 2. WALL VINES, WEEPING DECALS & CRUMBLED MASONRY ────────────────────
    const placedWall = [];

    wallAnchors.forEach(anchor => {
        const pos = anchor.pos;

        // Keep spawn, exit, plates, and doors unobstructed
        if (pos.distanceTo(spawn) < 3.2 || pos.distanceTo(exit) < 3.2) return;
        if (isNearGameplayObject(pos, 2.2)) return;
        if (tooClose(placedWall, pos, 1.8)) return;

        // Avoid spawning decorations underwater
        if (pos.y < waterLevel - 0.2) return;

        const n = anchor.normal;
        const nx = Math.round(n.x);
        const nz = Math.round(n.z);

        const wx = Math.round(pos.x);
        const wy = Math.round(pos.y);
        const wz = Math.round(pos.z);

        // Sanity: Anchor block must be solid, space in front must be open air
        if (!params.isSolid(wx, wy, wz)) return;
        if (params.isSolid(wx + nx, wy, wz + nz)) return;

        // Crucial: The true outer surface of the wall block is at +0.50m from center
        const wallSurfacePos = pos.clone().addScaledVector(n, 0.50);

        const t = zoneFalloff(pos);
        const isNearMoisture = hasWater && Math.abs(pos.y - waterLevel) < 4.5;
        const rotY = Math.atan2(n.x, n.z);

        const tx = -nz;
        const tz = nx;

        // Check vertical wall continuity (how high does the wall go?)
        let wallUp = 0;
        for (let dy = 1; dy <= 4; dy++) {
            if (params.isSolid(wx, wy + dy, wz) && !params.isSolid(wx + nx, wy + dy, wz + nz)) {
                wallUp++;
            } else break;
        }

        const hasFloorBase = params.isSolid(wx + nx, wy - 1, wz + nz) || params.isSolid(wx, wy - 1, wz);
        const solidLeft    = params.isSolid(wx - tx, wy, wz - tz);
        const solidRight   = params.isSolid(wx + tx, wy, wz + tz);
        const isNarrowPillar = !solidLeft && !solidRight;

        // ── A. CLIMBING 3D WALL VINES ───────────────────────────────────────
        // Spawns across both low and soaring high walls (up to 12m+)
        const vineChance = (t <= 0) ? 0.05 : (isNearMoisture ? 0.55 : (hasFloorBase ? 0.42 : 0.30));

        if (wallUp >= 1 && rngFn() < vineChance) {
            // Scale dynamically based on available vertical wall height
            const finalScale = Math.min(2.2, 0.85 + wallUp * 0.22) * (0.90 + rngFn() * 0.20);

            const isFlowering = isNearMoisture ? (rngFn() < 0.35) : (rngFn() < 0.20);
            const vineType = isFlowering ? 'decor_vine_wall_flowering' : 'decor_vine_wall';

            autoDecorations.push({
                type: vineType,
                x: wallSurfacePos.x,
                y: wallSurfacePos.y - 0.20,
                z: wallSurfacePos.z,
                rotY: rotY + (rngFn() - 0.5) * 0.06,
                scale: finalScale
            });
            placedWall.push(pos);
            return;
        }

        // ── B. WALL VERTICAL WEEPING MOSS & RUNOFF (ACTIVE IN ALL LEVELS) ────
        // Spawns on lower walls, shaded areas, and near moisture (never dependent on waterY)
        const wallMossChance = isNearMoisture ? 0.55 : (hasFloorBase ? 0.35 : 0.22);
        if (typeof placeDecal === 'function' && rngFn() < wallMossChance) {
            const isSeep = rngFn() > 0.35;
            const dType = isSeep ? 'wall_moss' : 'stain';
            const dVariant = isSeep ? Math.floor(rngFn() * 2) : Math.floor(rngFn() * 4);
            const dScale = 2.4 + rngFn() * 1.6; // Large 2.4m to 4.0m spread!
            placeDecal(dType, dVariant, wallSurfacePos, n, dScale, 0, true);
            placedWall.push(pos);
            return;
        }

        // ── C. FRACTURED WALL RUBBLE & CRUMBLED CORNICES ─────────────────────
        const rubbleChance = (t <= 0) ? 0.48 : (t < 1.0 ? 0.26 : 0.04);
        if (rngFn() < rubbleChance) {
            const rubblePos = pos.clone().addScaledVector(n, 0.40);

            const has2x2Space = solidRight && (wallUp >= 1) && params.isSolid(wx + tx, wy + 1, wz + tz);
            let type = WALL_DECOR_TYPES[Math.floor(rngFn() * 3)];

            if (t <= 0.4 && has2x2Space && rngFn() < 0.35) {
                type = 'decor_wall_2x2';
            }

            autoDecorations.push({
                type,
                x: rubblePos.x,
                y: rubblePos.y,
                z: rubblePos.z,
                rotY: rotY + (rngFn() - 0.5) * 0.10,
                scale: 0.90 + rngFn() * 0.25
            });
            placedWall.push(pos);
        }
    });

    // ── 3. FLOOR MASONRY, BOULDERS, SLABS & REFLECTIVE PUDDLES ───────────────
    const placedFloor = [];

    topSurfaces.forEach(pos => {
        if (pos.distanceTo(spawn) < 3.2 || pos.distanceTo(exit) < 3.2) return;
        if (isNearGameplayObject(pos, 2.0)) return;
        if (pos.y < waterLevel - 0.2) return;
        if (tooClose(placedFloor, pos, 1.90)) return;

        const fx = Math.round(pos.x);
        const fy = Math.round(pos.y);
        const fz = Math.round(pos.z);

        if (!params.isSolid(fx, fy - 1, fz)) return;
        if (params.isSolid(fx, fy, fz)) return;

        const t = zoneFalloff(pos);
        const isDamp = hasWater && Math.abs(pos.y - waterLevel) < 3.5;
        const isDepression = pos.y <= 1.5 || isDamp;

        const isJunction = params.isSolid(fx + 1, fy, fz) || params.isSolid(fx - 1, fy, fz) ||
                           params.isSolid(fx, fy, fz + 1) || params.isSolid(fx, fy, fz - 1);

        // ── A. REFLECTIVE WATER PUDDLES & DAMP FLOOR MOSS ───────────────────
        if (typeof placeDecal === 'function') {
            const puddleChance = isDamp ? 0.68 : (isDepression ? 0.45 : (t <= 0.8 ? 0.30 : 0.18));
            if (rngFn() < puddleChance) {
                const pScale = 1.2 + rngFn() * 1.5;
                const pVariant = Math.floor(rngFn() * 2);
                const pPos = {
                    x: pos.x + (rngFn() - 0.5) * 0.32,
                    y: pos.y,
                    z: pos.z + (rngFn() - 0.5) * 0.32
                };
                placeDecal('puddle', pVariant, pPos, { x: 0, y: 1, z: 0 }, pScale, rngFn() * Math.PI * 2, false);
            }

            const floorMossChance = (isJunction && isDamp) ? 0.75 : (isDamp ? 0.50 : (isJunction ? 0.38 : 0.16));
            if (rngFn() < floorMossChance) {
                const mScale = 0.9 + rngFn() * 1.0;
                const mVariant = Math.floor(rngFn() * 3);
                const mPos = {
                    x: pos.x + (rngFn() - 0.5) * 0.35,
                    y: pos.y,
                    z: pos.z + (rngFn() - 0.5) * 0.35
                };
                placeDecal('moss', mVariant, mPos, { x: 0, y: 1, z: 0 }, mScale, rngFn() * Math.PI * 2, false);
            }
        }

        // ── B. PHYSICAL 3D MASONRY & SHATTERED BOULDERS ─────────────────────
        const rubbleChance = (t <= 0) ? 0.65 : (t < 1.0 ? 0.38 : (isJunction ? 0.20 : 0.06));
        if (rngFn() >= rubbleChance) return;

        let type;
        let scale = 0.85 + rngFn() * 0.35;

        if (t <= 0) {
            const roll = rngFn();
            if (roll < 0.42) {
                type = 'decor_shattered';
                scale = 0.95 + rngFn() * 0.35;
            } else if (roll < 0.72) {
                type = 'decor_rubble';
                scale = 1.0 + rngFn() * 0.30;
            } else {
                type = 'decor_pillar';
                scale = 0.85 + rngFn() * 0.25;
            }
        } else if (t < 1.0) {
            type = (rngFn() < 0.55) ? 'decor_rubble' : 'decor_debris';
        } else {
            type = (isDamp && rngFn() < 0.65) ? 'decor_rubble' : 'decor_debris';
            scale = 0.75 + rngFn() * 0.25;
        }

        autoDecorations.push({
            type,
            x: pos.x + (rngFn() - 0.5) * 0.12,
            y: pos.y,
            z: pos.z + (rngFn() - 0.5) * 0.12,
            rotY: rngFn() * Math.PI * 2,
            scale
        });
        placedFloor.push(pos);
    });

    // ── 4. CEILING BREACH DETRITUS ──────────────────────────────────────────
    if (ceilingAnchors && ceilingAnchors.length > 0) {
        const placedCeiling = [];
        ceilingAnchors.forEach(pos => {
            if (pos.distanceTo(spawn) < 3.0 || pos.distanceTo(exit) < 3.0) return;
            if (isNearGameplayObject(pos, 2.0)) return;
            if (tooClose(placedCeiling, pos, 2.4)) return;

            const t = zoneFalloff(pos);
            if (t <= 0.65 && rngFn() < 0.28) {
                autoDecorations.push({
                    type: 'decor_wall_1x1_c',
                    x: pos.x,
                    y: pos.y - 0.15,
                    z: pos.z,
                    rotY: rngFn() * Math.PI * 2,
                    scale: 0.72 + rngFn() * 0.25
                });
                placedCeiling.push(pos);
            }
        });
    }
}

// --- LEVEL TRANSITION & CUTSCENE DIRECTORS ---
function completeLevel() {
    if (isTransitioning) return;
    isTransitioning = true;
    AudioSys.triggerExitLayer();

    const overlayEl = document.getElementById('fade-overlay');
    overlayEl.style.transition = 'opacity 0.6s ease-in-out';
    overlayEl.style.opacity = 1;

    if (currentLevel === 9) {
        if (activeChapter < 2) chaptersUnlocked[activeChapter + 1] = true;
        setTimeout(() => { showEndingSequence(); }, 400);
        return;
    }

    setTimeout(() => {
        isPreviewMode = true;
        controls.unlock();
        document.getElementById('blocker').style.display = 'none';
        currentLevel++;
        SaveSystem.save();
        populateLevelList();
        document.getElementById('preview-title').innerText = getLevelName(currentLevel);
        document.getElementById('level-select-overlay').style.display = 'flex';
        buildLevel(currentLevel, true);
        overlayEl.style.transition = 'opacity 0.4s ease-in-out';
        overlayEl.style.opacity = 0;
        setTimeout(() => { isTransitioning = false; }, 400);
    }, 800);
}

function triggerLevelTransition(isReset = false) {
    if (isTransitioning) return;
    if (!isReset) { completeLevel(); return; }

    isTransitioning = true; 
    const overlayEl = document.getElementById('fade-overlay');
    const title = document.getElementById('level-title');
    overlayEl.style.transition = 'opacity 0.4s ease-in-out';
    overlayEl.style.opacity = 1;
    title.classList.remove('visible');
    title.classList.add('swap-out');

    setTimeout(() => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            buildLevel(currentLevel, false, true);
            title.style.transition = 'none';
            title.classList.remove('swap-out');
            title.classList.add('swap-in');
            void title.offsetWidth;
            title.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
            title.classList.remove('swap-in');
            title.classList.add('visible');
            AudioSys.playTextSound();
            setTimeout(() => {
                overlayEl.style.opacity = 0;
                title.classList.remove('visible');
                title.classList.add('swap-out');
                setTimeout(() => { isTransitioning = false; }, 400);
            }, 1500); 
        }));
    }, 450); 
}

const montageLevels = [1, 4, 5, 7, 9];
let currentMontageIdx = 0;

function showEndingSequence() {
    isPreviewMode = true;
    controls.unlock();

    document.getElementById('crosshair').style.opacity = '0';
    document.getElementById('blocker').style.display = 'none';
    document.getElementById('scale-hud').style.opacity = '0';

    const endOvr = document.getElementById('ending-overlay');
    const endTitle = document.getElementById('ending-title');
    const prompt = document.getElementById('ending-prompt');
    const lines = document.querySelectorAll('.ending-line');

    endOvr.classList.remove('visible');
    endTitle.style.opacity = '0';
    prompt.classList.remove('lit');
    lines.forEach(l => l.classList.remove('lit'));

    const fo = document.getElementById('fade-overlay');
    fo.style.transition = 'opacity 1s ease-in-out';
    fo.style.opacity = '1';

    isCutscene = true; 
    cutsceneType = 'montage'; 

    setTimeout(() => {
        currentMontageIdx = 0;
        playMontageStep();
    }, 1200);
}

function playMontageStep() {
    if (currentMontageIdx >= montageLevels.length) {
        if (activeChapter === 0) showChapter2Title();
        else if (activeChapter === 1) showChapter3Title();
        else showFinalEndingTitle();
        return;
    }

    let lvl = montageLevels[currentMontageIdx];
    currentMontageIdx++;

    isMontageCutscene = true;
    buildLevel(lvl, true);
    isMontageCutscene = false;

    const fo = document.getElementById('fade-overlay');
    fo.style.transition = 'opacity 0.8s ease-in-out';
    fo.style.opacity = '0';

    previewAngle = currentMontageIdx * Math.PI / 2;

    setTimeout(() => {
        fo.style.transition = 'opacity 0.8s ease-in-out';
        fo.style.opacity = '1';
        setTimeout(() => { playMontageStep(); }, 800);
    }, 3200); 
}

function showChapter2Title() {
    const endOvr = document.getElementById('ending-overlay');
    const endTitle = document.getElementById('ending-title');
    const lines = document.querySelectorAll('.ending-line');
    const prompt = document.getElementById('ending-prompt');

    endTitle.innerText = "CHAPTER 2";
    endTitle.style.fontSize = "36px";
    endTitle.style.letterSpacing = "15px";

    lines[0].innerText = "THE ARCHIVE";
    lines[0].style.fontSize = "16px";
    lines[0].style.color = "rgba(160,200,240,0.0)"; 

    for (let i = 1; i < lines.length; i++) lines[i].style.display = 'none';

    prompt.innerText = "— AWAKEN —";
    endOvr.classList.add('visible');
    const fo = document.getElementById('fade-overlay');
    fo.style.opacity = '0'; 

    setTimeout(() => { endTitle.style.opacity = '1'; }, 400);
    setTimeout(() => { lines[0].classList.add('lit'); }, 1500);
    setTimeout(() => { prompt.classList.add('lit'); }, 3000);

    const dismiss = () => {
        endOvr.classList.remove('visible');
        endTitle.style.opacity = '0';
        lines[0].classList.remove('lit');
        prompt.classList.remove('lit');
        prompt.removeEventListener('click', dismiss);

        fo.style.transition = 'opacity 0.4s ease-in-out'; 
        fo.style.opacity = '1';
        setTimeout(() => {
            chaptersUnlocked[1] = true;
            activeChapter = 1;
            currentLevel = 0;
            SaveSystem.save(); 

            isPreviewMode = true;
            isTransitioning = false;
            isCutscene = false;

            rebuildChapterButtons();
            populateLevelList();
            document.getElementById('preview-title').innerText = getLevelName(0);

            const lsOverlay = document.getElementById('level-select-overlay');
            lsOverlay.style.display = 'flex';
            lsOverlay.style.opacity = '0';
            lsOverlay.style.transition = 'opacity 0.8s ease-in-out';

            buildLevel(0, true);

            setTimeout(() => {
                lsOverlay.style.opacity = '1';
                fo.style.transition = 'opacity 0.8s ease-in-out'; 
                fo.style.opacity = '0';
            }, 100);
        }, 500);
    };
    prompt.addEventListener('click', dismiss);
}

function showChapter3Title() {
    const endOvr = document.getElementById('ending-overlay');
    const endTitle = document.getElementById('ending-title');
    const lines = document.querySelectorAll('.ending-line');
    const prompt = document.getElementById('ending-prompt');

    endTitle.innerText = "CHAPTER 3";
    endTitle.style.fontSize = "36px";
    endTitle.style.letterSpacing = "15px";

    lines[0].innerText = "THE CITADEL";
    lines[0].style.fontSize = "14px";
    lines[0].style.color = "rgba(0,255,255,0.0)"; 

    for (let i = 1; i < lines.length; i++) lines[i].style.display = 'none';

    prompt.innerText = "— ENTER —";
    endOvr.classList.add('visible');
    const fo = document.getElementById('fade-overlay');
    fo.style.opacity = '0'; 

    setTimeout(() => { endTitle.style.opacity = '1'; }, 400);
    setTimeout(() => { lines[0].classList.add('lit'); lines[0].style.color = ''; }, 1200);
    setTimeout(() => { prompt.classList.add('lit'); }, 3000);

    const dismiss = () => {
        endOvr.classList.remove('visible');
        endTitle.style.opacity = '0';
        lines.forEach(l => { l.classList.remove('lit'); l.style.display = 'none'; });
        lines[0].style.display = 'block';
        prompt.classList.remove('lit');
        prompt.removeEventListener('click', dismiss);

        fo.style.transition = 'opacity 0.4s ease-in-out'; 
        fo.style.opacity = '1';
        setTimeout(() => {
            chaptersUnlocked[2] = true;
            activeChapter = 2;
            currentLevel = 0;
            SaveSystem.save(); 

            isPreviewMode = true;
            isTransitioning = false;
            isCutscene = false;

            rebuildChapterButtons();
            populateLevelList();
            document.getElementById('preview-title').innerText = getLevelName(0);

            const lsOverlay = document.getElementById('level-select-overlay');
            lsOverlay.style.display = 'flex';
            lsOverlay.style.opacity = '0';
            lsOverlay.style.transition = 'opacity 0.8s ease-in-out';

            buildLevel(0, true);

            setTimeout(() => {
                lsOverlay.style.opacity = '1';
                fo.style.transition = 'opacity 0.8s ease-in-out'; 
                fo.style.opacity = '0';
            }, 100);
        }, 500);
    };
    prompt.addEventListener('click', dismiss);
}

function showFinalEndingTitle() {
    const endOvr = document.getElementById('ending-overlay');
    const endTitle = document.getElementById('ending-title');
    const lines = document.querySelectorAll('.ending-line');
    const prompt = document.getElementById('ending-prompt');

    endTitle.innerText = "CITADEL CORE — OFFLINE";
    endTitle.style.fontSize = "22px";
    endTitle.style.letterSpacing = "8px";

    lines[0].innerText = "All chambers resolved."; lines[0].style.display = 'block';
    lines[1].innerText = "The structure stands stabilized."; lines[1].style.display = 'block';
    lines[2].innerText = "Return to cycle zero."; lines[2].style.display = 'block';

    prompt.innerText = "— RETURN —";
    endOvr.classList.add('visible');
    const fo = document.getElementById('fade-overlay');
    fo.style.opacity = '0';

    setTimeout(() => { endTitle.style.opacity = '1'; }, 400);
    setTimeout(() => { lines[0].classList.add('lit'); }, 1200);
    setTimeout(() => { lines[1].classList.add('lit'); }, 2000);
    setTimeout(() => { lines[2].classList.add('lit'); }, 2800);
    setTimeout(() => { prompt.classList.add('lit'); }, 3800);

    const dismiss = () => {
        endOvr.classList.remove('visible');
        prompt.removeEventListener('click', dismiss);
        window.location.reload();
    };
    prompt.addEventListener('click', dismiss);
}

// --- LEVEL SELECTOR UI POPULATION ---
function populateLevelList() {
    clearCurrentLevel();
    const list = document.getElementById('level-select-list');
    list.innerHTML = '';

    if (isViewingCustomLevels) {
        document.getElementById('preview-title').innerText = "CUSTOM LEVEL";
        document.getElementById('ls-chapter-title-badge').textContent = '— CUSTOM LEVELS —';

        const newCard = document.createElement('div');
        newCard.className = 'list-card';
        newCard.style.borderLeftColor = 'rgba(68,255,170,0.5)';
        newCard.innerHTML = `<div class="lc-info"><span class="lc-num">EDITOR</span><span class="lc-name" style="color:#44ffaa;">+ CREATE NEW LEVEL</span></div>`;
        newCard.addEventListener('click', () => { loadCustomLevelToEditor(-1); });
        list.appendChild(newCard);

        for (let i = 0; i < 99; i++) {
            const data = customLevels[i];
            const card = document.createElement('div');
            card.className = 'list-card' + (currentLevel === `CUSTOM_${i}` ? ' current-selection' : '');
            const stateText = data ? "SAVED DATA" : "EMPTY";
            const color = data ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.2)";
            const dotHtml = data ? `<div class="lc-status-dot"></div>` : '';
            card.innerHTML = `<div class="lc-info"><span class="lc-num">SLOT ${i + 1}</span><span class="lc-name" style="color:${color}">${stateText}</span></div>${dotHtml}`;

            if (data) {
                card.addEventListener('mouseenter', () => {
                    document.querySelectorAll('.list-card').forEach(c => c.classList.remove('previewing'));
                    card.classList.add('previewing');
                    document.getElementById('preview-title').innerText = `SLOT ${i + 1}`;
                    document.getElementById('ls-preview-meta').textContent = 'NOW PREVIEWING';
                    previewTargetLvl = `CUSTOM_${i}`;
                    clearTimeout(previewDebounce);
                    previewDebounce = setTimeout(() => {
                        if (isPreviewMode && previewTargetLvl === `CUSTOM_${i}`) buildLevel(`CUSTOM_${i}`, true);
                    }, 150);
                });
                card.addEventListener('click', () => {
                    previewTargetLvl = `CUSTOM_${i}`;
                    launchFromPreview();
                });
            }
            list.appendChild(card);
        }
    } else {
        const ch = CHAPTERS[activeChapter];
        document.getElementById('ls-chapter-title-badge').textContent = ch.title || ch.name;
        document.getElementById('ls-chapter-title-badge').style.setProperty('--ch-chip-color', ch.chip);
        document.getElementById('ls-chapter-title-badge').style.setProperty('--ch-chip-border', ch.chipBorder);
        document.getElementById('ls-chapter-title-badge').style.setProperty('--ch-chip-shadow', ch.chipShadow || 'none');

        for (let i = 0; i < 10; i++) {
            const card = document.createElement('div');
            const savedData = JSON.parse(localStorage.getItem('shatter_player_data') || '{}');
            const savedCh  = savedData.activeChapter || 0;
            const savedLvl = savedData.currentLevel  || 0;

            const isCompleted = (activeChapter < savedCh) || (activeChapter === savedCh && i < savedLvl);
            const isCurrent   = (activeChapter === savedCh && i === savedLvl);

            card.className = 'list-card';
            if (isCompleted) card.classList.add('completed');
            if (isCurrent)   card.classList.add('current-selection');

            const dotHtml = isCompleted ? `<div class="lc-status-dot"></div>` : isCurrent ? `<div class="lc-current-dot"></div>` : '';
            card.innerHTML = `<div class="lc-info"><span class="lc-num">LEVEL ${i + 1}</span><span class="lc-name">${getLevelName(i)}</span></div>${dotHtml}`;

            card.addEventListener('mouseenter', () => {
                document.querySelectorAll('.list-card').forEach(c => c.classList.remove('previewing'));
                card.classList.add('previewing');
                document.getElementById('preview-title').innerText = getLevelName(i);
                document.getElementById('ls-preview-meta').textContent = isCompleted ? 'COMPLETED' : isCurrent ? 'CURRENT LEVEL' : 'NOW PREVIEWING';
                previewTargetLvl = i;
                clearTimeout(previewDebounce);
                previewDebounce = setTimeout(() => {
                    if (isPreviewMode && previewTargetLvl === i) buildLevel(i, true);
                }, 150);
            });
            card.addEventListener('click', () => {
                previewTargetLvl = i;
                launchFromPreview();
            });
            list.appendChild(card);
        }
    }
}

function rebuildChapterButtons() {
    const row = document.getElementById('chapter-toggle-row');
    const unlockedCount = chaptersUnlocked.filter(Boolean).length;
    const ch2Unlocked = unlockedCount > 1;

    row.style.display = (ch2Unlocked && !isViewingCustomLevels) ? 'flex' : 'none';
    document.getElementById('btn-edit-level').style.display = ch2Unlocked ? 'inline-block' : 'none';
    document.getElementById('btn-custom-levels').style.display = ch2Unlocked ? 'inline-block' : 'none';
    document.getElementById('level-select-watch-cutscene').style.display = (ch2Unlocked && !isViewingCustomLevels) ? 'inline-block' : 'none';

    row.innerHTML = '';
    CHAPTERS.forEach((ch, i) => {
        if (!chaptersUnlocked[i]) return;
        const btn = document.createElement('button');
        btn.className = 'ch-toggle-btn' + (activeChapter === i ? ' active' : '');
        btn.textContent = ch.name;
        btn.setAttribute('data-ch', i);
        btn.style.setProperty('--ch-color', ch.chip || '#888');
        btn.style.setProperty('--ch-border', ch.chipBorder || 'rgba(255,255,255,0.2)');
        btn.style.setProperty('--ch-glow', ch.chipShadow || 'none');

        btn.addEventListener('click', () => {
            if (activeChapter === i) return;
            activeChapter = i;
            currentLevel = 0;
            rebuildChapterButtons();
            populateLevelList();
            document.getElementById('preview-title').innerText = getLevelName(currentLevel);
            if (isPreviewMode) buildLevel(currentLevel, true);
        });
        row.appendChild(btn);
    });
}

function launchFromPreview() {
    const wasFromMainMenu = fromMainMenu;
    fromMainMenu = false;
    document.getElementById('level-select-overlay').style.display = 'none';
    currentLevel = previewTargetLvl;
    isPreviewMode = false;
    if (wasFromMainMenu) AudioSys.init();

    const fo = document.getElementById('fade-overlay');
    fo.style.transition = 'opacity 0.3s ease-in-out';
    fo.style.opacity = '1';

    setTimeout(() => {
        isTransitioning = false;
        buildLevel(currentLevel, false);
        fo.style.transition = 'opacity 0.4s ease-in-out';
        fo.style.opacity = '0';
        setTimeout(() => { isTransitioning = false; }, 400);
    }, 350);
    setTimeout(() => requestPointerLockSafe(), 500);
}

// --- MAIN RUNTIME ANIMATION LOOP ---
let _frameCount = 0;
let elapsedTime = 0;
const crosshairEl = document.getElementById('crosshair');

const clock = {
    _last: performance.now(),
    getDelta() {
        const now = performance.now();
        const dt = (now - this._last) / 1000;
        this._last = now;
        return dt;
    }
};

// =============================================================================
// INPUT CONTROLLER, POINTER LOCK, TOOL DISPATCH & KINETIC RAYCASTERS
// =============================================================================

const keys = { w: false, a: false, s: false, d: false, space: false, shift: false };
let pKeyHeld = false;
let pKeyTimer = null;
let ignoreNextPKeyUp = false;
let scaleHudTimeout = null;
const raycaster = new THREE.Raycaster();
const screenCenter = new THREE.Vector2(0, 0);
const rayResult = new CANNON.RaycastResult();

document.addEventListener('keydown', e => {
    if (e.code === 'KeyW' || e.code === 'KeyZ' || e.code === 'ArrowUp') keys.w = true;
    if (e.code === 'KeyA' || e.code === 'KeyQ' || e.code === 'ArrowLeft') keys.a = true;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.s = true;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.d = true;
    if (e.code === 'Space' && !isTransitioning && !isCutscene && !isPaused) keys.space = true; 
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.shift = true;
    if (e.code === 'KeyR' && controls.isLocked && !isTransitioning && !isCutscene && !isPaused) isRKeyDown = true; 

    if (e.code === 'KeyP' && !e.repeat) {
        pKeyHeld = true;
        if (isEditorMode && !isPlayingCustom) {
            pKeyTimer = setTimeout(() => {
                pKeyTimer = null;
                ignoreNextPKeyUp = true;
                isEditorMode = false;
                isPlayingCustom = true;
                editorSceneGroup.visible = false;
                ghostMesh.visible = false;
                document.getElementById('editor-hud').style.display = 'none';

                world.removeBody(editorPhysicsFloor); 
                world.removeBody(editorStaticBody);
                buildLevel('CUSTOM', false, false, false);

                const scaleHud = document.getElementById('scale-hud');
                scaleHud.textContent = "FULL TEST STARTED";
                scaleHud.style.opacity = '1';
                clearTimeout(scaleHudTimeout);
                scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 1200);
            }, 500);
        }
    }

    if (e.code === 'KeyK' && !e.repeat && isEditorMode && !isPlayingCustom) {
        let slot = currentCustomSlot;
        if (slot === -1) {
            slot = customLevels.findIndex(l => l === null);
            if (slot === -1) slot = 0;
            currentCustomSlot = slot;
        }

        const data = {
            spawn: customSpawn, exit: customExit, 
            solids: Array.from(customSolidBlocks),
            entities: Array.from(customEntities.entries()),
            destruction: customDestruction, lights: customLights,
            plates: customPlates, doors: customDoors, waterY: customWaterY,
            fields: customFields, logic: logicNodes.configs,
            decorations: customDecorations
        };
        customLevels[slot] = data;
        localStorage.setItem('shatter_custom_levels', JSON.stringify(customLevels));

        const scaleHud = document.getElementById('scale-hud');
        scaleHud.textContent = `SAVED TO SLOT ${slot + 1}`;
        scaleHud.style.opacity = '1';
        clearTimeout(scaleHudTimeout);
        scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 2000);
    }

    if (e.code === 'KeyC' && !e.repeat && isEditorMode && !isPlayingCustom) {
        exportLevelCode();
    }

    if (isEditorMode && !isPlayingCustom) {
        if (e.code === 'Tab') {
            e.preventDefault();
            if (!isTabSelectorOpen) openToolSelector();
        }
        if (e.code === 'KeyF' && !e.repeat) {
            isFlyMode = !isFlyMode;
            playerBody.type = isFlyMode ? CANNON.Body.KINEMATIC : CANNON.Body.DYNAMIC;
            playerBody.velocity.set(0, 0, 0);
            const scaleHud = document.getElementById('scale-hud');
            scaleHud.textContent = isFlyMode ? "FLY MODE: ON" : "FLY MODE: OFF";
            scaleHud.style.opacity = '1';
            clearTimeout(scaleHudTimeout);
            scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 1200);
        }
    }
});

document.addEventListener('keyup', e => {
    if (e.code === 'KeyW' || e.code === 'KeyZ' || e.code === 'ArrowUp') keys.w = false;
    if (e.code === 'KeyA' || e.code === 'KeyQ' || e.code === 'ArrowLeft') keys.a = false;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.s = false;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.d = false;
    if (e.code === 'Space') keys.space = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.shift = false;
    if (e.code === 'KeyR') { isRKeyDown = false; rKeyTimer = 0; document.getElementById('scale-hud').style.opacity = '0'; }

    if (e.code === 'KeyP') {
        pKeyHeld = false;
        if (ignoreNextPKeyUp) {
            ignoreNextPKeyUp = false;
            return;
        }

        if (isEditorMode && !isPlayingCustom) {
            if (pKeyTimer) {
                clearTimeout(pKeyTimer);
                pKeyTimer = null;
                isEditorMode = false;
                isPlayingCustom = true;
                editorSceneGroup.visible = false;
                ghostMesh.visible = false;

                world.removeBody(editorPhysicsFloor); 
                world.removeBody(editorStaticBody);
                buildLevel('CUSTOM', false, false, true);

                const scaleHud = document.getElementById('scale-hud');
                scaleHud.textContent = "QUICK TEST";
                scaleHud.style.opacity = '1';
                clearTimeout(scaleHudTimeout);
                scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 1000);
            }
        } else if (!isEditorMode && isPlayingCustom) {
            isEditorMode = true;
            isPlayingCustom = false;
            clearCurrentLevel();                  
            world.addBody(editorPhysicsFloor);    
            world.addBody(editorStaticBody);    
            editorSceneGroup.visible = true;
            ghostMesh.visible = true;

            playerBody.velocity.set(0, 0, 0);
            if (playerBody.position.y < 0) playerBody.position.set(0, 4, 0);

            const scaleHud = document.getElementById('scale-hud');
            scaleHud.textContent = "EDIT MODE";
            scaleHud.style.opacity = '1';
            clearTimeout(scaleHudTimeout);
            scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 1000);
        }
    }
});

function getAvailableSpace(block) {
    let maxS = RED_SCALE_MAX;
    for (let i = 0; i < getSpaceAxes.length; i++) {
        const worldAxis = block.body.quaternion.vmult(getSpaceAxes[i]);
        const pos = block.body.position;
        let distPos = 10, distNeg = 10;
        world.raycastClosest(pos, new CANNON.Vec3(pos.x + worldAxis.x * 10, pos.y + worldAxis.y * 10, pos.z + worldAxis.z * 10), { skipBackfaces: true, collisionFilterMask: CG_STATIC | CG_PLAYER }, rayResult);
        if (rayResult.hasHit) distPos = rayResult.distance;
        world.raycastClosest(pos, new CANNON.Vec3(pos.x - worldAxis.x * 10, pos.y - worldAxis.y * 10, pos.z - worldAxis.z * 10), { skipBackfaces: true, collisionFilterMask: CG_STATIC | CG_PLAYER }, rayResult);
        if (rayResult.hasHit) distNeg = rayResult.distance;
        const available = (distPos + distNeg) - 0.12;
        if (available < maxS) maxS = available;
    }
    return maxS;
}

document.addEventListener('pointerdown', e => {
    isMouseDown = true;
    if (isPaused || isCutscene || document.pointerLockElement !== document.body) return;
    if (e.target !== document.body && e.target.tagName !== 'CANVAS') return;

    raycaster.setFromCamera(screenCenter, camera);

    if (isEditorMode && !isPlayingCustom) {
        const hits = raycaster.intersectObjects(editorSceneGroup.children, false);
        let validHit = null;
        for (let i = 0; i < hits.length; i++) {
            if (hits[i].face) { validHit = hits[i]; break; }
        }
        if (!validHit) return;

        const norm = validHit.face.normal;
        const rawP = validHit.point.clone();

        let blockCenterX, blockCenterY, blockCenterZ;
        if (validHit.instanceId !== undefined && validHit.object.isInstancedMesh) {
            const _instMat = new THREE.Matrix4();
            validHit.object.getMatrixAt(validHit.instanceId, _instMat);
            const _instPos = new THREE.Vector3().setFromMatrixPosition(_instMat);
            blockCenterX = Math.round(_instPos.x);
            blockCenterY = Math.round(_instPos.y);
            blockCenterZ = Math.round(_instPos.z);
        } else {
            const pFallback = rawP.clone().sub(norm.clone().multiplyScalar(0.5));
            blockCenterX = Math.round(pFallback.x);
            blockCenterY = Math.round(pFallback.y);
            blockCenterZ = Math.round(pFallback.z);
        }

        // Middle-click: Inspect existing entity
        if (e.button === 1) { 
            const gx = blockCenterX, gy = blockCenterY, gz = blockCenterZ;
            selectedEditorObject = null;
            selectedEditorObjectType = null;

            let found = customLights.find(l => l.x === gx && l.y === gy && l.z === gz);
            if (found) { selectedEditorObject = found; selectedEditorObjectType = 'light'; }
            else if (found = customDoors.find(d => d.x === gx && d.y === gy && d.z === gz)) { selectedEditorObject = found; selectedEditorObjectType = 'door'; }
            else if (found = customPlates.find(pl => pl.x === gx && pl.y === gy && pl.z === gz)) { selectedEditorObject = found; selectedEditorObjectType = 'plate'; }
            else if (found = customFields.find(f => f.x === gx && f.y === gy && f.z === gz)) { selectedEditorObject = found; selectedEditorObjectType = found.type; }
            else if (customEntities.has(`${gx},${gy},${gz}`)) { selectedEditorObject = customEntities.get(`${gx},${gy},${gz}`); selectedEditorObjectType = selectedEditorObject.type; }

            if (selectedEditorObject) {
                setEditorTool(selectedEditorObjectType);
                if (selectedEditorObjectType === 'light') {
                    lightColor = found.color; lightIntensity = found.intensity; lightRadius = found.radius;
                    document.getElementById('tp-light-color-pick').value = hexToCSS(found.color);
                } else if (selectedEditorObjectType === 'door') {
                    editorDoorWidth = found.width; editorDoorHeight = found.height; editorDoorMoveDist = found.moveDist; editorChannel = found.channel; editorDoorDir = found.dir;
                } else if (selectedEditorObjectType === 'plate' || selectedEditorObjectType === 'aero' || selectedEditorObjectType === 'oneway') {
                    editorChannel = found.channel; editorFieldInverted = found.inverted || false;
                } else if (selectedEditorObjectType === 'red') {
                    redStartScale = found.startScale || 1.0;
                }
                updateParamsPanel(selectedEditorObjectType);
                
                const hud = document.getElementById('scale-hud');
                hud.textContent = `INSPECTING: ${selectedEditorObjectType.toUpperCase()}`;
                hud.style.opacity = '1';
                clearTimeout(scaleHudTimeout);
                scaleHudTimeout = setTimeout(() => hud.style.opacity = '0', 1200);
            }
            return;
        }

        // Left-click: Place
        if (e.button === 0) { 
            const p = rawP.clone().add(norm.clone().multiplyScalar(0.5));
            const gx = Math.round(p.x), gy = Math.round(p.y), gz = Math.round(p.z);
            const key = `${gx},${gy},${gz}`;

            if (editorTool === 'fill') {
                if (!fillStartCorner) {
                    fillStartCorner = { x: gx, y: gy, z: gz };
                } else {
                    const minX = Math.min(fillStartCorner.x, gx), maxX = Math.max(fillStartCorner.x, gx);
                    const minY = Math.min(fillStartCorner.y, gy), maxY = Math.max(fillStartCorner.y, gy);
                    const minZ = Math.min(fillStartCorner.z, gz), maxZ = Math.max(fillStartCorner.z, gz);
                    for (let x = minX; x <= maxX; x++) {
                        for (let y = minY; y <= maxY; y++) {
                            for (let z = minZ; z <= maxZ; z++) {
                                customSolidBlocks.add(`${x},${y},${z}`);
                            }
                        }
                    }
                    fillStartCorner = null;
                }
            } else if (editorTool === 'wall') { customSolidBlocks.add(key); }
            else if (editorTool === 'bomb') customDestruction.push({ cx: gx, cy: gy, cz: gz });
            else if (editorTool === 'spawn') customSpawn = { x: gx, y: gy, z: gz };
            else if (editorTool === 'exit') customExit = { x: gx, y: gy, z: gz };
            else if (editorTool === 'light') {
                customLights = customLights.filter(l => l.x !== gx || l.y !== gy || l.z !== gz);
                customLights.push({ x: gx, y: gy, z: gz, color: lightColor, intensity: lightIntensity, radius: lightRadius });
            } else if (editorTool === 'plate') {
                customPlates = customPlates.filter(pl => pl.x !== gx || pl.y !== gy || pl.z !== gz);
                customPlates.push({ x: gx, y: gy, z: gz, channel: editorChannel });
            } else if (editorTool === 'door') {
                let travelDir = 'left';
                if (Math.abs(norm.y) > 0.5) travelDir = norm.y > 0 ? 'up' : 'down';
                else if (Math.abs(norm.x) > 0.5) travelDir = norm.x > 0 ? 'right' : 'left';
                else travelDir = norm.z > 0 ? 'right' : 'left';

                customDoors.push({ 
                    x: gx, y: gy, z: gz, channel: editorChannel, dir: travelDir,
                    width: editorDoorWidth, height: editorDoorHeight, moveDist: editorDoorMoveDist,
                    normal: { x: norm.x, y: norm.y, z: norm.z } 
                });
            } else if (editorTool === 'aero' || editorTool === 'oneway') {
                customFields = customFields.filter(f => f.x !== gx || f.y !== gy || f.z !== gz);
                customFields.push({ 
                    type: editorTool, x: gx, y: gy, z: gz, channel: editorChannel, w: 3, h: 3, 
                    inverted: editorFieldInverted, normal: { x: norm.x, y: norm.y, z: norm.z } 
                });
            } else if (editorTool.startsWith('decor_')) {
                customDecorations.push({ type: editorTool, x: gx, y: gy, z: gz, rotY: Math.random() * Math.PI * 2 });
            } else {
                const ent = { type: editorTool, x: gx, y: gy, z: gz };
                if (editorTool === 'red') ent.startScale = redStartScale;
                customEntities.set(key, ent);
            }
            updateEditorVisuals();
        } 

        // Right-click: Remove
        else if (e.button === 2 && validHit.object.geometry.type !== 'PlaneGeometry') { 
            const gx = blockCenterX, gy = blockCenterY, gz = blockCenterZ;
            const tKey = `${gx},${gy},${gz}`;

            customSolidBlocks.delete(tKey);
            customEntities.delete(tKey);
            customDestruction = customDestruction.filter(b => b.cx !== gx || b.cy !== gy || b.cz !== gz);
            customLights = customLights.filter(l => l.x !== gx || l.y !== gy || l.z !== gz);
            customPlates = customPlates.filter(p => p.x !== gx || p.y !== gy || p.z !== gz);
            customDoors = customDoors.filter(d => d.x !== gx || d.y !== gy || d.z !== gz);
            customFields = customFields.filter(f => f.x !== gx || f.y !== gy || f.z !== gz);
            customDecorations = customDecorations.filter(d => Math.round(d.x) !== gx || Math.round(d.y) !== gy || Math.round(d.z) !== gz);
            updateEditorVisuals();
        }
        return;
    }

    if (e.button !== 0) return;

    let intersects = raycaster.intersectObjects(interactiveTargets);
    if (intersects.length > 0 && intersects[0].distance < 8) { 
        const obj = intersects[0].object;
        const block = meshToBlock.get(obj) ?? null;
        if (block) {
            grabbedBlock = block;
            grabbedBlock.hasBeenGrabbed = true;
            AudioSys.grab();
            if (grabbedBlock.type === 'yellow' || grabbedBlock.type === 'big_yellow') {
                grabbedBlock.body.type = CANNON.Body.DYNAMIC;
                grabbedBlock.body.updateMassProperties();
            }
            grabbedBlock.body.wakeUp();
        }
        return; 
    }

    if (!grabbedBlock) {
        let closestDist = 2.5;
        let closestBody = null;
        const ray = raycaster.ray;
        const checkList = [...interactiveBlocks, ...dynamicSyncList];
        for (let i = 0; i < checkList.length; i++) {
            const b = checkList[i];
            _v1.set(b.body.position.x, b.body.position.y, b.body.position.z);
            if (distSq(camera.position, _v1) < 64) { 
                const distToRay = ray.distanceSqToPoint(_v1);
                if (distToRay < closestDist) { closestDist = distToRay; closestBody = b; }
            }
        }
        if (closestBody) { 
            grabbedBlock = closestBody;
            if (grabbedBlock.hasBeenGrabbed !== undefined) grabbedBlock.hasBeenGrabbed = true;
            AudioSys.grab();
            if (grabbedBlock.type === 'yellow' || grabbedBlock.type === 'big_yellow') {
                grabbedBlock.body.type = CANNON.Body.DYNAMIC;
                grabbedBlock.body.updateMassProperties();
            }
            grabbedBlock.body.wakeUp(); 
        }
    }
});

document.addEventListener('pointerup', e => { 
    isMouseDown = false;
    if (_editorPhysicsDirty && isEditorMode && !isPlayingCustom) {
        _editorPhysicsDirty = false;
        updateEditorVisuals();
    }
    if (e.button === 0 && grabbedBlock && !isPaused) {
        if (grabbedBlock.type === 'yellow' || grabbedBlock.type === 'big_yellow') { 
            grabbedBlock.body.type = CANNON.Body.KINEMATIC;
            grabbedBlock.body.velocity.set(0, 0, 0);
            grabbedBlock.body.angularVelocity.set(0, 0, 0); 
            grabbedBlock.body.quaternion.set(globalTiltThree.x, globalTiltThree.y, globalTiltThree.z, globalTiltThree.w);
            grabbedBlock.body.updateMassProperties(); 
        }
        grabbedBlock = null;
        AudioSys.drop();
    }
});

const EDITOR_PLACE_INTERVAL_MS = 80;
let _lastEditorPlaceTime = 0;

document.addEventListener('pointermove', e => {
    if (!isEditorMode || isPlayingCustom || !isMouseDown || editorTool !== 'wall') return;
    if (isPaused || document.pointerLockElement !== document.body) return;

    const _now = performance.now();
    if (_now - _lastEditorPlaceTime < EDITOR_PLACE_INTERVAL_MS) return;

    const isLeftClick = (e.buttons === 1);
    const isRightClick = (e.buttons === 2);

    raycaster.setFromCamera(screenCenter, camera);
    const hits = raycaster.intersectObjects(editorSceneGroup.children, false);

    let validHit = null;
    for (let i = 0; i < hits.length; i++) {
        if (hits[i].face) { validHit = hits[i]; break; }
    }

    if (validHit) {
        const norm = validHit.face.normal;
        if (isLeftClick) {
            const p = validHit.point.clone().add(norm.clone().multiplyScalar(0.5));
            const key = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
            if (!customSolidBlocks.has(key)) {
                customSolidBlocks.add(key);
                _lastEditorPlaceTime = _now;
                updateEditorVisuals();
            }
        } else if (isRightClick) {
            const p = validHit.point.clone().sub(norm.clone().multiplyScalar(0.5));
            const key = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
            if (customSolidBlocks.has(key)) {
                customSolidBlocks.delete(key);
                _lastEditorPlaceTime = _now;
                updateEditorVisuals();
            }
        }
    }
});

document.addEventListener('contextmenu', e => e.preventDefault());

document.addEventListener('wheel', e => {
    if (isPreviewMode) {
        previewDistance += e.deltaY * 0.02; 
        previewDistance = Math.max(5, Math.min(45, previewDistance));
        return; 
    }

    if (isPaused || !controls.isLocked || isTransitioning || isCutscene) return;
    raycaster.setFromCamera(screenCenter, camera);
    let redTargets = [];
    for (let i = 0; i < interactiveBlocks.length; i++) {
        if (interactiveBlocks[i].type === 'red') redTargets.push(interactiveTargets[i]);
    }
    let intersects = raycaster.intersectObjects(redTargets);
    let block = null;
    if (intersects.length > 0 && intersects[0].distance < 15) {
        block = meshToBlock.get(intersects[0].object) ?? null;
    } else {
        let closestDist = 4.0;
        const ray = raycaster.ray;
        for (let i = 0; i < interactiveBlocks.length; i++) {
            const b = interactiveBlocks[i];
            if (b.type !== 'red') continue;
            _v1.set(b.body.position.x, b.body.position.y, b.body.position.z);
            if (distSq(camera.position, _v1) < 100) {
                const d = ray.distanceSqToPoint(_v1);
                if (d < closestDist) { closestDist = d; block = b; }
            }
        }
    }

    if (block) {
        let deltaScale = e.deltaY < 0 ? 0.25 : -0.25;
        let maxS = getAvailableSpace(block);
        let targetScale = Math.max(RED_SCALE_MIN, Math.min(RED_SCALE_MAX, block.scale + deltaScale));
        if (deltaScale > 0 && targetScale > maxS) targetScale = Math.max(block.scale, maxS);

        if (Math.abs(targetScale - block.scale) > 0.001) {
            if (deltaScale > 0) {
                let shift = new CANNON.Vec3();
                for (let i = 0; i < world.contacts.length; i++) {
                    let c = world.contacts[i];
                    if (c.bi === block.body || c.bj === block.body) {
                        let n = c.bi === block.body ? c.ni.clone() : c.ni.clone().scale(-1);
                        shift.x -= n.x; shift.y -= n.y; shift.z -= n.z;
                    }
                }
                if (shift.lengthSquared() > 0) {
                    shift.normalize();
                    shift.scale(deltaScale / 2, shift);
                    block.body.position.vadd(shift, block.body.position);
                }
            }
            block.scale = targetScale;
            block.mesh.scale.setScalar(targetScale);
            const half = targetScale * 0.5;
            block.body.removeShape(block.body.shapes[0]);
            block.body.addShape(new CANNON.Box(new CANNON.Vec3(half, half, half)));
            block.body.updateMassProperties();
            block.body.wakeUp();
            block.mat.emissiveIntensity = 1.0;
            setTimeout(() => { if (block && block.mat) block.mat.emissiveIntensity = 0.6; }, 150);

            const scaleHud = document.getElementById('scale-hud');
            scaleHud.textContent = `◆ SIZE ${Math.round(block.scale * 100)}% ◆`;
            scaleHud.style.opacity = '1';
            clearTimeout(scaleHudTimeout);
            scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 1000);
            AudioSys.resize(deltaScale);
        }
    }
});

function updateWater(delta) {
    if (!waterMesh || !currentParams || currentParams.waterY === undefined) return; 
    const wm = waterMesh.material;
    wm.uniforms['time'].value += delta * 0.5;
    waveTime += delta;
    const ws = waterMesh.userData.waveShader;
    if (ws) ws.uniforms.waveTime.value = waveTime;
    wm.uniforms['sunDirection'].value.copy(sunLight.position).normalize();
}

function animate() {
    requestAnimationFrame(animate);
    _frameCount++;
    const delta = Math.min(clock.getDelta(), 0.05);
    elapsedTime += delta;

    const activeCamera = isCutscene ? cutsceneCamera : camera;

    // 1. Montage Geometric Inflation
    if (expandAnimActive) {
        expandAnimTime += delta;
        for (let _ei = 0; _ei < expandAnimData.length; _ei++) {
            const item = expandAnimData[_ei];
            let delay = item.dist * 0.08; 
            let progress = Math.max(0, Math.min(1, (expandAnimTime - delay) * 1.5));
            let ease = 1 - Math.pow(1 - progress, 4); 

            dummy.position.copy(item.pos);
            dummy.position.y += (1 - ease) * 15.0;
            dummy.quaternion.copy(item.quat);
            dummy.rotateX((1 - ease) * Math.PI * 2);
            dummy.rotateY((1 - ease) * Math.PI * 2);
            dummy.scale.setScalar(Math.max(0.001, item.targetScale * ease));
            dummy.updateMatrix();
            meshes[item.meshKey].setMatrixAt(item.index, dummy.matrix);
        }
        for (const k in meshes) {
            if (meshes[k].count > 0) meshes[k].instanceMatrix.needsUpdate = true;
        }
    }

    // 2. Editor Mode Interactive Ghost Cursor
    if (isEditorMode && !isPlayingCustom && !isPaused && !isTabSelectorOpen && (_frameCount % 2 === 0)) {
        raycaster.setFromCamera(screenCenter, activeCamera);
        const hits = raycaster.intersectObjects(editorSceneGroup.children, false);

        let validHit = null;
        for (let i = 0; i < hits.length; i++) {
            if (hits[i].face) { validHit = hits[i]; break; }
        }

        if (validHit) {
            const hit = validHit;
            const norm = hit.face.normal;
            ghostMesh.visible = true;

            const p = hit.point.clone().add(norm.clone().multiplyScalar(0.5));
            const gx = Math.round(p.x), gy = Math.round(p.y), gz = Math.round(p.z);

            if (editorTool === 'fill' && fillStartCorner) {
                const minX = Math.min(fillStartCorner.x, gx), maxX = Math.max(fillStartCorner.x, gx);
                const minY = Math.min(fillStartCorner.y, gy), maxY = Math.max(fillStartCorner.y, gy);
                const minZ = Math.min(fillStartCorner.z, gz), maxZ = Math.max(fillStartCorner.z, gz);
                
                const w = maxX - minX + 1;
                const h = maxY - minY + 1;
                const d = maxZ - minZ + 1;
                
                ghostMesh.scale.set(w, h, d);
                ghostMesh.position.set(minX + (w - 1) / 2, minY + (h - 1) / 2, minZ + (d - 1) / 2);
                ghostMesh.rotation.set(0, 0, 0);
            } else {
                ghostMesh.position.set(gx, gy, gz);
                ghostMesh.scale.set(1, 1, 1);

                if (['door', 'oneway', 'aero'].includes(editorTool)) {
                    if (editorTool === 'door') ghostMesh.scale.set(editorDoorWidth, editorDoorHeight, 0.2);
                    else ghostMesh.scale.set(3, 3, 0.5); 
                    const target = ghostMesh.position.clone().add(norm);
                    ghostMesh.lookAt(target);
                } else {
                    ghostMesh.rotation.set(0, 0, 0);
                }
            }
        }
    }

    // 3. Logic Wire Animation
    if (isEditorMode && !isPlayingCustom && logicVisualizerGroup.children.length > 0) {
        const _lvChildren = logicVisualizerGroup.children;
        for (let _lvi = 0; _lvi < _lvChildren.length; _lvi++) {
            const _line = _lvChildren[_lvi];
            _line.material.opacity = 0.3 + Math.sin(elapsedTime * 5.0 + _line.userData.phase) * 0.2;
        }
    }

    // 4. Water & Dynamic Vegetation Updates
    updateWater(delta);
    updateVegetation(delta, elapsedTime);

    // 5. Submerged Fog Transitions
    if (currentParams && currentParams.waterY !== undefined) {
        const isUnderwater = activeCamera.position.y < currentParams.waterY;
        const chEnv = CHAPTERS[activeChapter].env;

        if (isUnderwater) {
            scene.fog.color.setHex(0x001a2d);
            scene.fog.density = 0.15;
            scene.background = new THREE.Color(0x00101a);
        } else {
            scene.fog.color.setHex(chEnv.fog);
            scene.fog.density = chEnv.density;
            scene.background = morningHorizon;
        }
    }

    // 6. Audio Spatial Orientation
    if (AudioSys.ctx && AudioSys.ctx.listener && _frameCount % 3 === 0) {
        const listener = AudioSys.ctx.listener;
        if (listener.positionX) {
            listener.positionX.value = activeCamera.position.x;
            listener.positionY.value = activeCamera.position.y;
            listener.positionZ.value = activeCamera.position.z;

            activeCamera.getWorldDirection(_dir);
            if (listener.forwardX) {
                listener.forwardX.value = _dir.x;
                listener.forwardY.value = _dir.y;
                listener.forwardZ.value = _dir.z;
                listener.upX.value = activeCamera.up.x;
                listener.upY.value = activeCamera.up.y;
                listener.upZ.value = activeCamera.up.z;
            }
        }
    }

    // 7. Preview Orbit Camera
    if (isPreviewMode) {
        previewAngle += delta * 0.10; 
        const levelHeightCenter = currentParams.bounds.y * 0.5;
        const lookAtTarget = _v3.set(0, levelHeightCenter, 0).applyQuaternion(globalTiltThree);

        activeCamera.position.set(
            lookAtTarget.x + Math.cos(previewAngle) * previewDistance, 
            lookAtTarget.y + (previewDistance * 0.5),
            lookAtTarget.z + Math.sin(previewAngle) * previewDistance
        ); 
        activeCamera.lookAt(lookAtTarget);

        if (currentGoal) { 
            currentGoal.userData.core.rotation.y += 0.02;
            currentGoal.userData.core.rotation.z += 0.01; 
            if (currentGoal.userData.shell) {
                currentGoal.userData.shell.rotation.x -= 0.015;
                currentGoal.userData.shell.rotation.y -= 0.01;
            }
            currentGoal.userData.core.position.y = 1.0 + Math.sin(elapsedTime * 0.6) * 0.2; 
        }

    // 8. In-Game Physics Simulation Step & Controls
    } else if (!isPaused || isCutscene) {
        if (isRKeyDown && controls.isLocked && !isTransitioning && !isCutscene && !isPaused) {
            rKeyTimer += delta;
            const scaleHud = document.getElementById('scale-hud');
            scaleHud.textContent = `RESETTING... ${Math.min(100, Math.floor((rKeyTimer / 1.0) * 100))}%`;
            scaleHud.style.opacity = '1';
            clearTimeout(scaleHudTimeout);
            if (rKeyTimer >= 1.0) {
                isRKeyDown = false;
                rKeyTimer = 0;
                scaleHud.style.opacity = '0';
                triggerLevelTransition(true);
            }
        } else if (rKeyTimer > 0) {
            rKeyTimer = 0;
            document.getElementById('scale-hud').style.opacity = '0';
        }

        world.step(1 / 60, delta, 2);
        const activeTime = elapsedTime * 3.0;

        if (dustMesh.visible) {
            dustMesh.rotation.y += delta * 0.02;
            dustMesh.position.y = Math.sin(activeTime * 0.2) * 2;
            dustMesh.updateMatrix();
        }

        sparkMesh.rotation.y += delta * 0.05;
        sparkMat.opacity = (levelLights.length > 0) ? 0.4 + Math.sin(activeTime * 3.7) * 0.2 : 0.0;
        sparkMesh.position.set(playerBody.position.x, playerBody.position.y, playerBody.position.z);

        if (pendingBounce) {
            let bounceForce = Math.max(10, 15 + (pendingBounceVelocity * 0.32));
            playerBody.velocity.y = Math.min(27, bounceForce);
            playerBody.position.y += 0.05;
            if (pendingBounceBlock) { 
                let b = pendingBounceBlock; 
                b.mat.emissiveIntensity = 2.5; 
                setTimeout(() => { if (b && b.mat) b.mat.emissiveIntensity = 0.7; }, 300); 
            }
            pendingBounce = false; 
            pendingBounceBlock = null;
            pendingBounceVelocity = 0; 
        }

        logicNodes.inputs.fill(false);

        activePlates.forEach(p => {
            let block = null;
            for (let i = 0; i < interactiveBlocks.length; i++) {
                const b = interactiveBlocks[i];
                if (b.body.position.distanceTo(p.body.position) < 1.3 && b.body.position.y > p.body.position.y) { 
                    block = b; 
                    break; 
                }
            }

            if (block) logicNodes.inputs[p.channel] = true;

            const targetProgress = block ? 1.0 : 0.0; 
            p.progress = THREE.MathUtils.lerp(p.progress, targetProgress, 0.08);

            const yOffset = 1.9 - (0.7 * p.progress);
            p.group.position.y = yOffset;

            _v1.set(0, yOffset, 0).applyQuaternion(globalTiltThree);
            p.body.position.set(p.basePos.x + _v1.x, p.basePos.y + _v1.y, p.basePos.z + _v1.z);

            const linearTravel = 1.0 * p.progress;
            p.gears.forEach(g => {
                const rotationAngle = (linearTravel / g.pitchR) * g.dir; 
                const finalAngle = g.baseAngle + rotationAngle;
                if (g.axis === 'z') g.mesh.rotation.z = finalAngle;
                if (g.axis === 'x') g.mesh.rotation.x = finalAngle;
            });

            if (block) {
                const col = blockConfigs[block.type].mat.color;
                const pulse = 0.8 + Math.sin(elapsedTime * 6.0) * 0.2;
                p.lensMat.emissive.lerp(col, 0.1);
                p.lensMat.emissiveIntensity = 12.0 * pulse;
                p.lensMat.opacity = 0.5;
                p.coreMat.color.lerp(col, 0.1);
                p.coreMat.opacity = THREE.MathUtils.lerp(p.coreMat.opacity, 0.7 * pulse, 0.1);
                p.light.color.lerp(col, 0.1);
                p.light.intensity = THREE.MathUtils.lerp(p.light.intensity, 20.0 * pulse, 0.1);
            } else {
                p.lensMat.emissiveIntensity = THREE.MathUtils.lerp(p.lensMat.emissiveIntensity, 0, 0.05);
                p.lensMat.opacity = 0.9;
                p.coreMat.opacity = THREE.MathUtils.lerp(p.coreMat.opacity, 0, 0.05);
                p.light.intensity = THREE.MathUtils.lerp(p.light.intensity, 0, 0.05);
            }
        });

        resolveLogic();

        activeFields.forEach(f => {
            f.active = logicNodes.resolved[f.channel];
            if (f.type === 'aero') {
                f.baseMesh.material.opacity = f.active ? 0.15 : 0.02;
                f.gridLines.material.opacity = f.active ? 0.6 : 0.05;
            }
            if (f.type === 'oneway') {
                f.arrowGroup.visible = f.active;
                f.shieldMesh.material.color.setHex(f.active ? 0xffaa00 : 0x333333);
                f.shieldMesh.material.opacity = f.active ? 0.25 : 0.1;

                if (!f.active) {
                    f.body.collisionFilterMask = 0; 
                } else {
                    _v1.set(playerBody.position.x, playerBody.position.y, playerBody.position.z);
                    const fieldSpacePos = f.group.worldToLocal(_v1);
                    const isOnWrongSide = f.inverted ? (fieldSpacePos.z < 0) : (fieldSpacePos.z > 0);
                    f.body.collisionFilterMask = isOnWrongSide ? (CG_PLAYER | CG_DYNAMIC) : 0;
                }
            }
        });

        activeDoors.forEach(d => {
            const isOpen = logicNodes.resolved[d.channel] === true;
            d.progress = THREE.MathUtils.lerp(d.progress, isOpen ? 1.0 : 0.0, 0.05);
            _v1.copy(d.moveVector).multiplyScalar(d.progress);
            d.group.position.copy(d.basePos).add(_v1);
            d.body.position.copy(d.group.position);
        });

        activeWinds.forEach(wind => {
            const posAttr = wind.visuals.geometry.attributes.position;
            for (let i = 0; i < wind.speeds.length; i++) {
                posAttr.array[i * 6 + 2] += delta * wind.speeds[i];
                posAttr.array[i * 6 + 5] += delta * wind.speeds[i];
                if (posAttr.array[i * 6 + 2] > wind.size.z) {
                    let len = posAttr.array[i * 6 + 2] - posAttr.array[i * 6 + 5];
                    posAttr.array[i * 6 + 2] = -wind.size.z;
                    posAttr.array[i * 6 + 5] = -wind.size.z - len;
                }
            }
            posAttr.needsUpdate = true;

            _v1.set(playerBody.position.x - wind.pos.x, playerBody.position.y - wind.pos.y, playerBody.position.z - wind.pos.z);
            if (Math.abs(_v1.x) < wind.size.x && Math.abs(_v1.y) < wind.size.y && Math.abs(_v1.z) < wind.size.z) {
                let isShielded = false;
                const rayOrigin = playerBody.position;
                _windRayDir.set(-wind.dir.x, -wind.dir.y, -wind.dir.z);
                _windRayDest.set(rayOrigin.x + _windRayDir.x * 4, rayOrigin.y + _windRayDir.y * 4, rayOrigin.z + _windRayDir.z * 4);

                world.raycastClosest(rayOrigin, _windRayDest, { 
                    collisionFilterMask: CG_DYNAMIC | CG_AERO_FIELD,
                    skipBackfaces: true 
                }, rayResult);

                if (rayResult.hasHit) {
                    if (rayResult.body.collisionFilterGroup === CG_DYNAMIC) isShielded = true;
                    else {
                        const filter = activeFields.find(f => f.body === rayResult.body);
                        if (filter && filter.active) isShielded = true;
                    }
                }

                if (!isShielded) {
                    let edgeFalloffX = 1.0 - (Math.abs(_v1.x) / wind.size.x);
                    let edgeFalloffZ = 1.0 - (Math.abs(_v1.z) / wind.size.z);
                    let falloff = Math.min(edgeFalloffX, edgeFalloffZ);
                    falloff = Math.max(0.2, Math.min(1.0, falloff * 2.0));

                    _cannonImpulse.set(
                        wind.dir.x * wind.strength * 50 * falloff, 
                        wind.dir.y * wind.strength * 50 * falloff, 
                        wind.dir.z * wind.strength * 50 * falloff
                    );
                    playerBody.applyForce(_cannonImpulse, playerBody.position);
                    activeCamera.rotation.z += (Math.random() - 0.5) * 0.005 * falloff;
                }
            }

            interactiveBlocks.forEach(block => {
                _v1.set(block.body.position.x - wind.pos.x, block.body.position.y - wind.pos.y, block.body.position.z - wind.pos.z);
                if (Math.abs(_v1.x) < wind.size.x && Math.abs(_v1.y) < wind.size.y && Math.abs(_v1.z) < wind.size.z) {
                    const massScale = block.scale ? Math.pow(1 / block.scale, 2) : 1.0;
                    let turbX = Math.sin(activeTime * 5 + block.body.id) * 0.1;
                    let turbZ = Math.cos(activeTime * 6 + block.body.id) * 0.1;

                    _cannonImpulse.set(
                        (wind.dir.x + turbX) * wind.strength * block.body.mass * massScale,
                        (wind.dir.y) * wind.strength * block.body.mass * massScale,
                        (wind.dir.z + turbZ) * wind.strength * block.body.mass * massScale
                    );
                    block.body.applyForce(_cannonImpulse, block.body.position);
                    block.body.angularVelocity.scale(0.99, block.body.angularVelocity);
                }
            });
        });

        for (let i = 0; i < interactiveBlocks.length; i++) {
            const item = interactiveBlocks[i];
            if (item.type === 'red') item.mat.emissiveIntensity = 0.55 + Math.sin(activeTime * 4) * 0.25;
            else if (item.type === 'cyan' || item.type === 'yellow') item.mat.emissiveIntensity = 1.0 + Math.sin(activeTime * 3) * 0.5;

            if (item.body.position.y < -20) {
                item.body.position.copy(item.initialPos);
                item.body.velocity.set(0, 0, 0);
                item.body.angularVelocity.set(0, 0, 0);
                item.hasBeenGrabbed = false;
                if (item.type === 'red' && item.initialScale !== undefined) {
                    item.scale = item.initialScale;
                    item.mesh.scale.setScalar(item.initialScale);
                    const half = item.initialScale * 0.5;
                    item.body.removeShape(item.body.shapes[0]);
                    item.body.addShape(new CANNON.Box(new CANNON.Vec3(half, half, half)));
                }
                if (item.type === 'yellow' || item.type === 'big_yellow') {
                    item.body.type = CANNON.Body.KINEMATIC;
                    item.body.quaternion.set(globalTiltThree.x, globalTiltThree.y, globalTiltThree.z, globalTiltThree.w);
                }
                item.body.updateMassProperties();
                item.body.wakeUp();
                if (grabbedBlock === item) { grabbedBlock = null; AudioSys.drop(); }
            }
        }

        // 9. Player Locomotion, Swimming & Jump Handling
        if (controls.isLocked && !isTransitioning) {
            if (_frameCount % 5 === 0) {
                raycaster.setFromCamera(screenCenter, activeCamera);
                let audioHits = raycaster.intersectObjects(interactiveTargets);
                let focusType = null;
                if (audioHits.length > 0 && audioHits[0].distance < 15) {
                    const block = meshToBlock.get(audioHits[0].object) ?? null; 
                    focusType = block ? block.type : (grabbedBlock ? grabbedBlock.type : null);
                    AudioSys.focusElement = focusType;
                } else { 
                    AudioSys.focusElement = grabbedBlock ? grabbedBlock.type : null;
                    focusType = AudioSys.focusElement;
                }
                const ch = crosshairEl;
                if (ch.dataset.focus !== focusType) {
                    ch.className = focusType ? `interact-${focusType}` : '';
                    ch.dataset.focus = focusType || '';
                }
            }

            if (playerBody.position.y < -15 && !isTransitioning) {
                isTransitioning = true;
                const ov = document.getElementById('fade-overlay');
                ov.style.transition = "opacity 0.5s ease";
                ov.style.opacity = "1";
                ov.style.backgroundColor = "#0b0c10";

                setTimeout(() => {
                    _v1.copy(currentParams.spawn).applyQuaternion(globalTiltThree);
                    playerBody.position.set(_v1.x, _v1.y, _v1.z);
                    playerBody.velocity.set(0, 0, 0);
                    setTimeout(() => {
                        ov.style.opacity = "0";
                        isTransitioning = false;
                    }, 300);
                }, 200);
            }

            let currentlyGrounded = false;
            rayStart.copy(playerBody.position);
            rayEnd.copy(playerBody.position);
            rayEnd.y -= playerHalfH + 0.12;
            world.raycastClosest(rayStart, rayEnd, { skipBackfaces: true, collisionFilterMask: CG_STATIC | CG_DYNAMIC }, rayResult);
            currentlyGrounded = rayResult.hasHit;

            if (!currentlyGrounded) {
                for (let i = 0; i < world.contacts.length; i++) {
                    let c = world.contacts[i];
                    if (c.bi === playerBody || c.bj === playerBody) {
                        let normalY = (c.bi === playerBody) ? -c.ni.y : c.ni.y;
                        if (normalY > 0.5) { currentlyGrounded = true; break; }
                    }
                }
            }

            wasGrounded = currentlyGrounded;
            if (currentlyGrounded) coyoteTimer = COYOTE_TIME; else coyoteTimer -= delta;

            activeCamera.getWorldDirection(fwd);
            fwd.y = 0;
            fwd.normalize();
            rgt.copy(fwd).cross(activeCamera.up).normalize();
            targetVel.set(0, 0, 0);

            if (isEditorMode && isFlyMode && !isPlayingCustom) {
                activeCamera.getWorldDirection(fwd);
                rgt.copy(fwd).cross(activeCamera.up).normalize();
                if (keys.w) targetVel.add(fwd); if (keys.s) targetVel.sub(fwd);
                if (keys.d) targetVel.add(rgt); if (keys.a) targetVel.sub(rgt);
                if (keys.space) targetVel.y += 1;
                if (keys.shift) targetVel.y -= 1;
                if (targetVel.lengthSq() > 0) targetVel.normalize().multiplyScalar(20.0);

                playerBody.velocity.set(targetVel.x, targetVel.y, targetVel.z);
                playerBody.position.x += targetVel.x * delta;
                playerBody.position.y += targetVel.y * delta;
                playerBody.position.z += targetVel.z * delta;

                _v1.set(playerBody.position.x, playerBody.position.y + playerHalfH * 0.85, playerBody.position.z);
                activeCamera.position.lerp(_v1, 0.4);
            } else {
                if (!isCutscene) {
                    if (keys.w) targetVel.add(fwd); if (keys.s) targetVel.sub(fwd);
                    if (keys.d) targetVel.add(rgt); if (keys.a) targetVel.sub(rgt);
                }
                const isSprinting = keys.shift && currentlyGrounded && !isCutscene && targetVel.lengthSq() > 0;
                if (targetVel.lengthSq() > 0) targetVel.normalize().multiplyScalar(isSprinting ? 10.0 : 6.5);

                for (let i = 0; i < world.contacts.length; i++) {
                    const c = world.contacts[i];
                    let nx = 0, ny = 0, nz = 0;
                    let contactRelY = 0;
                    if (c.bi === playerBody) { nx = -c.ni.x; ny = -c.ni.y; nz = -c.ni.z; contactRelY = c.ri.y; }
                    else if (c.bj === playerBody) { nx = c.ni.x; ny = c.ni.y; nz = c.ni.z; contactRelY = c.rj.y; }
                    else continue;
                    if (Math.abs(ny) > 0.5) continue;
                    if (contactRelY < -0.3) continue;

                    let l = Math.sqrt(nx * nx + nz * nz);
                    if (l > 0.0001) { nx /= l; nz /= l; } else continue;
                    const dot = targetVel.x * nx + targetVel.z * nz;
                    if (dot < 0) { targetVel.x -= dot * nx; targetVel.z -= dot * nz; }
                }

                let diffX = targetVel.x - playerBody.velocity.x;
                let diffZ = targetVel.z - playerBody.velocity.z;
                let accel = currentlyGrounded ? 18.0 : 4.0;

                playerBody.applyImpulse(_cannonImpulse.set(
                    diffX * playerBody.mass * accel * delta,
                    0,
                    diffZ * playerBody.mass * accel * delta
                ), playerBody.position);

                let speedSq = playerBody.velocity.x * playerBody.velocity.x + playerBody.velocity.z * playerBody.velocity.z;

                if (keys.space && coyoteTimer > 0) { 
                    let jumpTarget = 10;
                    let requiredImpulse = jumpTarget - playerBody.velocity.y;
                    if (requiredImpulse > 0) {
                        playerBody.applyImpulse(_cannonImpulse2.set(0, requiredImpulse * playerBody.mass, 0), playerBody.position);
                    }
                    coyoteTimer = 0; 
                }

                if (waterMesh && currentParams && currentParams.waterY !== undefined) {
                    const waterSurface = currentParams.waterY;
                    const playerY = playerBody.position.y;
                    const submerged = playerY < waterSurface;
                    const headUnder = playerY + playerHalfH * 0.85 < waterSurface;

                    if (submerged) {
                        const subDepth = Math.min(waterSurface - playerY, playerHalfH * 2);
                        const buoyancyForce = subDepth * 28 * playerBody.mass;
                        _cannonImpulse.set(0, buoyancyForce * delta, 0);
                        playerBody.applyForce(_cannonImpulse, playerBody.position);

                        const drag = headUnder ? 0.18 : 0.10;
                        playerBody.applyImpulse(_cannonImpulse.set(
                            -playerBody.velocity.x * drag * playerBody.mass,
                            (playerBody.velocity.y < 0) ? -playerBody.velocity.y * drag * playerBody.mass : 0,
                            -playerBody.velocity.z * drag * playerBody.mass
                        ), playerBody.position);

                        if (keys.space) { 
                            playerBody.applyImpulse(_cannonImpulse2.set(0, 30 * delta * playerBody.mass, 0), playerBody.position);
                            coyoteTimer = 0; 
                        }
                    }
                }

                _v1.set(playerBody.position.x, playerBody.position.y + playerHalfH * 0.85, playerBody.position.z);
                activeCamera.position.lerp(_v1, 0.4);

                let targetFov = isSprinting ? 92 : (currentlyGrounded && speedSq > 1) ? 85 : 75;
                if (Math.abs(activeCamera.fov - targetFov) > 0.1) {
                    activeCamera.fov += (targetFov - activeCamera.fov) * 0.1;
                    activeCamera.updateProjectionMatrix();
                }

                if (currentGoal) {
                    const goalIsLocked = currentGoal.userData.isLocked;
                    if (goalIsLocked) {
                        currentGoal.userData.core.material.color.setHex(0xff0000);
                        currentGoal.userData.core.material.emissive.setHex(0xff0000);
                    } else {
                        if (currentGreenBlock) {
                            currentGoal.userData.core.material.color.setHex(0x00ffaa);
                            currentGoal.userData.core.material.emissive.setHex(0x00cc55);
                            if (distSq(currentGreenBlock.body.position, currentGoal.position) < 4.25) {
                                currentGoal.userData.core.material.emissive.setHex(0x00ff00);
                                triggerLevelTransition();
                            }
                        } else {
                            currentGoal.userData.core.material.color.setHex(0x00ffff);
                            currentGoal.userData.core.material.emissive.setHex(0x00ffff);
                            if (distSq(playerBody.position, currentGoal.position) < 3.25) {
                                triggerLevelTransition();
                            }
                        }
                    }
                }
            }
        }

        // 10. Holographic Projections
        for (let i = 0; i < holograms.length; i++) {
            const holo = holograms[i];
            const dist = distSq(playerBody.position, holo.basePos);
            const isActive = dist < 120; 
            const targetY = holo.basePos.y + (isActive ? 0.0 + Math.sin(activeTime * 2) * 0.05 : -1.0);
            const flicker = isActive ? 0.88 + Math.sin(activeTime * 17.3) * 0.06 + Math.sin(activeTime * 31.7) * 0.03 : 0;
            holo.sprite.material.opacity = THREE.MathUtils.lerp(holo.sprite.material.opacity, flicker, 0.1);
            holo.sprite.position.y = THREE.MathUtils.lerp(holo.sprite.position.y, targetY, 0.08);
            if (holo.light) holo.light.intensity = THREE.MathUtils.lerp(holo.light.intensity, isActive ? 1.0 : 0.0, 0.08);
            if (holo.baseMat) holo.baseMat.opacity = THREE.MathUtils.lerp(holo.baseMat.opacity, isActive ? 0.6 : 0.0, 0.08);
        }

        // 11. Kinetic Grab Physics Spring
        if (grabbedBlock) {
            _v3.set(0, 0, -3.5).applyMatrix4(activeCamera.matrixWorld);
            const bPos = grabbedBlock.body.position;
            _cannonV1.set(_v3.x - bPos.x, _v3.y - bPos.y, _v3.z - bPos.z);
            const strength = 12;
            grabbedBlock.body.velocity.set(_cannonV1.x * strength, _cannonV1.y * strength, _cannonV1.z * strength);
            grabbedBlock.body.angularVelocity.scale(0.9, grabbedBlock.body.angularVelocity);
        }

        // 12. Block Meshes GPU Transform Synchronization
        for (let i = 0; i < interactiveBlocks.length; i++) {
            const item = interactiveBlocks[i];
            if (item.mesh.visible === false) continue; 

            if (waterMesh && currentParams && currentParams.waterY !== undefined && item.body.type !== CANNON.Body.KINEMATIC) {
                const bY = item.body.position.y;
                const waterSurface = currentParams.waterY;
                const blockHalf = item.scale ? item.scale * 0.5 : 0.5;
                if (bY - blockHalf < waterSurface) {
                    const subDepth = Math.min(waterSurface - (bY - blockHalf), blockHalf * 2);
                    const buoyFrac = subDepth / (blockHalf * 2);
                    const buoyForce = buoyFrac * item.body.mass * 18;
                    _buoyForceV.set(0, buoyForce, 0);
                    item.body.applyForce(_buoyForceV, item.body.position);
                    const drag = 0.08;
                    item.body.velocity.x *= (1 - drag);
                    item.body.velocity.z *= (1 - drag);
                    if (item.body.velocity.y < 0) item.body.velocity.y *= (1 - drag * 0.5);
                }
            }

            const dx = item.body.position.x - playerBody.position.x;
            const dy = item.body.position.y - playerBody.position.y;
            const dz = item.body.position.z - playerBody.position.z;
            const dSq = (dx * dx) + (dy * dy) + (dz * dz);

            if (dSq > 625 && item.type !== 'yellow' && item.type !== 'big_yellow') { 
                if (item.body.sleepState !== CANNON.Body.SLEEPING) item.body.sleep(); 
                continue; 
            }
            if (dSq < 16.0 && item.body.sleepState === CANNON.Body.SLEEPING && item.type !== 'yellow' && item.type !== 'big_yellow') {
                item.body.wakeUp();
            }

            if (item.body.sleepState !== CANNON.Body.SLEEPING || item.type === 'yellow' || item.type === 'big_yellow' || item.type === 'cyan') {
                item.mesh.position.copy(item.body.position); 
                item.mesh.quaternion.copy(item.body.quaternion); 
                item.mesh.updateMatrix();
            }
        }

        // 13. Dynamic Rope Splines
        for (let i = 0; i < dynamicRopes.length; i++) {
            const r = dynamicRopes[i];
            let isSleeping = true;
            if (r.bodies[0].sleepState) {
                for (let b of r.bodies) { if (b.sleepState !== CANNON.Body.SLEEPING) isSleeping = false; }
            } else {
                isSleeping = false;
            }

            const dx = r.bodies[0].position.x - playerBody.position.x;
            const dy = r.bodies[0].position.y - playerBody.position.y;
            const dz = r.bodies[0].position.z - playerBody.position.z;

            if (dx * dx + dy * dy + dz * dz > 900) { 
                r.segmentMeshes.forEach(m => m.visible = false);
                continue; 
            }
            if (isSleeping) continue;

            for (let j = 0; j < r.segmentMeshes.length; j++) {
                const mesh = r.segmentMeshes[j];
                mesh.visible = true;
                _v1.set(r.bodies[j].position.x, r.bodies[j].position.y, r.bodies[j].position.z);
                _v2.set(r.bodies[j + 1].position.x, r.bodies[j + 1].position.y, r.bodies[j + 1].position.z);
                mesh.position.copy(_v1).lerp(_v2, 0.5);
                mesh.lookAt(_v2);
                mesh.scale.z = _v1.distanceTo(_v2);
            }
        }

        // 14. Cutscene Trajectory Spline
        if (isCutscene && cutsceneType !== 'montage') {
            cutsceneTimer += delta * 2;
            let progress = cutsceneTimer / cutsceneDuration;
            let ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            overlay.style.transition = 'none';

            if (cutsceneType === 'wakeup') {
                let lookAtPos = playerBody.position;
                cutsceneCamera.position.set(lookAtPos.x, lookAtPos.y + playerHalfH * 0.1 + (ease * playerHalfH * 0.85), lookAtPos.z);
                cutsceneCamera.rotation.set(-Math.PI / 2 + ease * (Math.PI / 2), 0, 0);
            } else if (cutsceneType === 'flyover') {
                let startPos = currentParams.flyCamStart || _v1.set(10, 15, 10); 
                let endPos = _v2.set(playerBody.position.x, playerBody.position.y + playerHalfH * 0.85, playerBody.position.z);
                let midPos = _vMid.lerpVectors(startPos, endPos, 0.5); midPos.y += 5; midPos.x += 4;
                let t = ease; let mt = 1 - t;
                cutsceneCamera.position.x = mt * mt * startPos.x + 2 * mt * t * midPos.x + t * t * endPos.x;
                cutsceneCamera.position.y = mt * mt * startPos.y + 2 * mt * t * midPos.y + t * t * endPos.y;
                cutsceneCamera.position.z = mt * mt * startPos.z + 2 * mt * t * midPos.z + t * t * endPos.z;
                let lookStart = currentParams.flyCamLook || _vL1.set(0, 5, 0);
                let lookEnd = _vL2.set(playerBody.position.x, playerBody.position.y + playerHalfH * 0.85, playerBody.position.z - 5);
                _vLook.lerpVectors(lookStart, lookEnd, ease);
                cutsceneCamera.lookAt(_vLook);
                cutsceneCamera.rotation.z = Math.sin(t * Math.PI) * 0.08;
            }

            if (progress < 0.1) overlay.style.opacity = 1 - (progress / 0.1);
            else if (progress > 0.9) overlay.style.opacity = (progress - 0.9) / 0.1;
            else overlay.style.opacity = 0;

            if (progress >= 1.0) {
                isCutscene = false;
                isTransitioning = false;
                overlay.style.opacity = 0;
                document.getElementById('crosshair').style.opacity = '1';
            }
        }
    }

// 15. Volumetric Point-Light Insertion Sort & Buffer Update
    const isVolActive = (gfx.volumetrics >= 1);
    if (isVolActive) {
        let lightCount = Math.min(levelLights.length, _lightSortArray.length);
        for (let i = 0; i < lightCount; i++) {
            _lightSortArray[i].light = levelLights[i];
            _lightSortArray[i].dist = levelLights[i].position.distanceToSquared(activeCamera.position);
        }

        for (let i = 1; i < lightCount; i++) {
            let key = _lightSortArray[i];
            let j = i - 1;
            while (j >= 0 && _lightSortArray[j].dist > key.dist) {
                _lightSortArray[j + 1] = _lightSortArray[j];
                j = j - 1;
            }
            _lightSortArray[j + 1] = key;
        }

        // Write directly to contiguous Float32Array buffers
        for (let i = 0; i < MAX_VOL_LIGHTS; i++) {
            if (i < lightCount) {
                const l = _lightSortArray[i].light;
                l.getWorldPosition(_worldPosVec);
                pointPosUniformArray[i * 3 + 0] = _worldPosVec.x;
                pointPosUniformArray[i * 3 + 1] = _worldPosVec.y;
                pointPosUniformArray[i * 3 + 2] = _worldPosVec.z;

                pointColUniformArray[i * 3 + 0] = l.color.r * l.intensity;
                pointColUniformArray[i * 3 + 1] = l.color.g * l.intensity;
                pointColUniformArray[i * 3 + 2] = l.color.b * l.intensity;
            } else {
                pointPosUniformArray[i * 3 + 0] = 0;
                pointPosUniformArray[i * 3 + 1] = 0;
                pointPosUniformArray[i * 3 + 2] = 0;

                pointColUniformArray[i * 3 + 0] = 0;
                pointColUniformArray[i * 3 + 1] = 0;
                pointColUniformArray[i * 3 + 2] = 0;
            }
        }
        volumetricPass.material.uniforms.pointLightCount.value = Math.min(lightCount, MAX_VOL_LIGHTS);

        if (sunLight) {
            volumetricPass.material.uniforms.sunDirection.value.copy(sunLight.position).normalize();
            volumetricPass.material.uniforms.sunColor.value.set(sunLight.color.r, sunLight.color.g, sunLight.color.b);
            volumetricPass.material.uniforms.sunIntensity.value = Math.min(sunLight.intensity * 0.15, 1.2);
        }
    }

    renderPass.camera = activeCamera;
    ssaoPass.camera = activeCamera;
    ssrPass.camera = activeCamera;

    if (isVolActive) {
        renderer.setRenderTarget(depthCaptureTarget);
        renderer.render(scene, activeCamera);
        renderer.setRenderTarget(null);

        const volU = volumetricPass.material.uniforms;
        volU.invProjMatrix.value.copy(activeCamera.projectionMatrixInverse);
        volU.invViewMatrix.value.copy(activeCamera.matrixWorld);
        volU.cameraNear.value = activeCamera.near;
        volU.cameraFar.value = activeCamera.far;
        volU.time.value = elapsedTime;
    }

    composer.render();
}

// --- WINDOW RESIZE & BOOTSTRAP INITIALIZATION ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    cutsceneCamera.aspect = window.innerWidth / window.innerHeight;
    cutsceneCamera.updateProjectionMatrix();
    applyGraphics();
});

window._debug = { 
    volumetricPass, 
    gfx, 
    levelLights, 
    volAdv, 
    camera, 
    renderer, 
    depthCaptureTarget,
    THREE,
    grassField,
    spawnFernEntity,
    generateBushFromRectangles,
    generateIvyWallClimber
};

SaveSystem.load();
applyGraphics();
animate();