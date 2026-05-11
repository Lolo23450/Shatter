import * as THREE from 'three';
import { Timer } from 'three/examples/jsm/misc/Timer.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import * as CANNON from 'cannon-es';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { CHAPTER_LEVEL_NAMES, LEVEL_NAMES, CHAPTERS, LevelBuilder } from './level-builder.js';
import { OptimizedSSRPass } from './OptimizedSSRPass.js';

import {
    HUB_LEVEL_INDEX, HUB_GATES, GATE_BY_ID,
    getHubWorldParams, HubWorldRuntime,
    saveHubProgress, loadHubProgress, clearHubProgress,
    getLevelSelectStatus, defaultHubProgress,
} from './hub-world.js';


    function distSq(v1, v2) { return (v1.x - v2.x) * (v1.x - v2.x) + (v1.y - v2.y) * (v1.y - v2.y) + (v1.z - v2.z) * (v1.z - v2.z); }
    function splitmix32(a) { return function() { a |= 0; a = a + 0x9e3779b9 | 0; var t = a ^ a >>> 16; t = Math.imul(t, 0x21f0aaad); t = t ^ t >>> 15; t = Math.imul(t, 0x735a2d97); return ((t = t ^ t >>> 15) >>> 0) / 4294967296; } }
    let rng = splitmix32(5);

    let currentLevel = 0; let isTransitioning = true; let isCutscene = false;
    let cutsceneType = ''; let cutsceneTimer = 0; let cutsceneDuration = 0;
    const activeWinds = [];

    // --- CORE THREE.JS & SCENE SETUP ---
    const scene = new THREE.Scene();
    const morningHorizon = new THREE.Color(0xc8d8e8);
    scene.background = morningHorizon; 

    scene.fog = new THREE.FogExp2(0xc0d0de, 0.0012); 
    const overlay = document.getElementById('fade-overlay');
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 750);
    const cutsceneCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 750);
    // Layer 1 = decals: visible to main cameras but excluded from SSAO (see patch below)
    camera.layers.enable(1);
    cutsceneCamera.layers.enable(1);

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", stencil: false });
    renderer.setSize(window.innerWidth, window.innerHeight);

    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.22;
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
    controls.addEventListener('lock', () => { isPaused = false; document.getElementById('blocker').style.display = 'none'; });
    controls.addEventListener('unlock', () => { if(isTabSelectorOpen) return; isPaused = true; if(!isPreviewMode && !isMontageCutscene) document.getElementById('blocker').style.display = 'flex'; });

    document.getElementById('btn-play').addEventListener('click', () => {
        AudioSys.init();
        document.getElementById('main-menu').style.opacity = '0'; document.getElementById('main-menu').style.display = 'none';
        isTransitioning = false; buildLevel(currentLevel, false); setTimeout(() => controls.lock(), 100);
    });

    document.getElementById('btn-enter-hub')?.addEventListener('click', () => {
        AudioSys.init();
        document.getElementById('main-menu').style.opacity = '0';
        document.getElementById('main-menu').style.display  = 'none';
        isTransitioning = false;
        buildLevel(HUB_LEVEL_INDEX, false);
        setTimeout(() => controls.lock(), 100);
    });

    // --- PHYSICS ---
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -28, 0) });
    world.broadphase = new CANNON.SAPBroadphase(world); world.solver.iterations = 3; world.solver.tolerance = 0.05; 
    world.allowSleep = true; world.sleepTimeLimit = 0.5; 

    const CG_STATIC = 1, CG_DYNAMIC = 2, CG_ROPE = 4, CG_PLAYER = 8;
    const defaultMat = new CANNON.Material("default"); const playerMat  = new CANNON.Material("player");
    world.addContactMaterial(new CANNON.ContactMaterial(defaultMat, defaultMat, { friction: 0.5, restitution: 0.1 }));
    world.addContactMaterial(new CANNON.ContactMaterial(playerMat, defaultMat, { friction: 0.0, restitution: 0.0, contactEquationStiffness: 1e7, contactEquationRelaxation: 4 }));

    let fromMainMenu = false; 
    let isPreviewMode = false; let previewAngle = 0; let previewDistance = 4; let previewTargetLvl = 0; let previewDebounce = null;

    // --- EDITOR MODE VARIABLES ---
    let isEditorMode = false;
    let isPlayingCustom = false;
    let isTabSelectorOpen = false;
    let editorTool = 'wall'; 
    let redStartScale = 1.0; // configurable start size for red cubes
    let customSolidBlocks = new Set();
    let customEntities = new Map(); // Key: "x,y,z", Value: {type, x,y,z, startScale?}
    let customDestruction = []; // Array of {cx, cy, cz}
    let customSpawn = { x: 0, y: 2, z: 0 };
    let customExit = { x: 0, y: 5, z: -8 };
    let customLights = []; // Array of {x, y, z, color, intensity, radius}
    let customFields = [];
    let customDecorations = []; // Array of {type, x, y, z, rotY}
    let lightColor = 0xffffff;
    let lightIntensity = 3.0;
    let lightRadius = 8.0;

    const PHYSICAL_BLOCK_TYPES = new Set(['blue', 'green', 'red', 'yellow', 'big_yellow', 'cyan', 'gray', 'big_gray']);

    // --- MORE EDITOR MODE VARIABLES ---
    let customPlates = []; // Array of {x, y, z, channel}
    let customDoors = [];  // Array of {x, y, z, channel, horizontal}
    let customWaterY = undefined;
    let roomDim = { x: 7, y: 5, z: 7 };

    // Custom Level Save System
    let customLevels = JSON.parse(localStorage.getItem('shatter_custom_levels')) || Array(99).fill(null);
    let currentCustomSlot = -1; // -1 means scratching / unsaved
    let isViewingCustomLevels = false;

    // Config for the next one you place
    let editorChannel = 1;
    let editorDoorDir = 'left'; 
    // Add near other editor variables
    let editorDoorWidth = 3.0;
    let editorDoorHeight = 3.0;
    let editorDoorMoveDist = 2.8;
    let isMouseDown = false; // For click-and-drag
    let _editorPhysicsDirty = false; // Deferred CANNON body rebuild flag

    // Add these with your other parameter listeners (around line 1400)
    document.getElementById('tp-door-w').addEventListener('input', e => {
        editorDoorWidth = parseFloat(e.target.value);
        document.getElementById('tp-door-w-val').textContent = editorDoorWidth.toFixed(1);
        if (editorTool === 'door') ghostMesh.scale.set(editorDoorWidth, editorDoorHeight, 0.2);
    });
    document.getElementById('tp-door-h').addEventListener('input', e => {
        editorDoorHeight = parseFloat(e.target.value);
        document.getElementById('tp-door-h-val').textContent = editorDoorHeight.toFixed(1);
        if (editorTool === 'door') ghostMesh.scale.set(editorDoorWidth, editorDoorHeight, 0.2);
    });
    document.getElementById('tp-door-dist').addEventListener('input', e => {
        editorDoorMoveDist = parseFloat(e.target.value);
        document.getElementById('tp-door-dist-val').textContent = editorDoorMoveDist.toFixed(1);
    });

    // OPTIMIZATION: Use InstancedMesh for editor visuals (1 draw call per tool type)
    const MAX_EDITOR_BLOCKS = 15000;
    const editorInstancedMeshes = {};
    const editorSceneGroup = new THREE.Group();
    scene.add(editorSceneGroup);

    // Logic Visualizer: unique color per channel (index 0 unused)
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
        'wall': 0x454545, 'blue': 0x3388ff, 'red': 0xff3344, 'green': 0x33ff99, 
        'bomb': 0xffaa00, 'spawn': 0xffffff, 'exit': 0xffff00, 'gray': 0xaaaaaa,
        'yellow': 0xffdd33, 'big_yellow': 0xffaa33, 'big_gray': 0x888888,
        'light': 0xffee44, 'plate': 0xc27a3e, 'door': 0x66ccff, 'room': 0xffffff,
        'water': 0x0055ff, 'logic': 0x9966ff, 'aero': 0x00ffff, 'oneway': 0xffaa00,
        // DECORATION PROPS
        'decor_rubble':    0x8a7266,
        'decor_shattered': 0xb8a898,
        'decor_vine_hanging': 0x4a7c59,
        'decor_vine_creeping': 0x3a5c39,
        'decor_pipes':     0x505c5a,
        'decor_pillar':    0x9ea1a0,
        'decor_bush':      0x2d8a3c,
        'decor_fern':      0x3acc50,
        'decor_tree':      0x1a6628,
    };

    function applyPOM(material, heightMap, scale = 0.05) {
        material.userData.parallaxScale = { value: scale };
        material.userData.heightMap = { value: heightMap };

        material.onBeforeCompile = (shader) => {
            shader.uniforms.parallaxScale = material.userData.parallaxScale;
            shader.uniforms.heightMap = material.userData.heightMap;

            // 1. Inject math functions at the top
            shader.fragmentShader = `
                uniform float parallaxScale;
                uniform sampler2D heightMap;

                // Calculates Tangent-Space View Vector natively in the fragment shader
                vec3 getPOMViewDir(vec3 viewDir, vec3 normal, vec2 uv) {
                    vec3 dp1 = dFdx(viewDir);
                    vec3 dp2 = dFdy(viewDir);
                    vec2 duv1 = dFdx(uv);
                    vec2 duv2 = dFdy(uv);
                    vec3 dp2perp = cross(dp2, normal);
                    vec3 dp1perp = cross(normal, dp1);
                    vec3 tangent = dp2perp * duv1.x + dp1perp * duv2.x;
                    vec3 bitangent = dp2perp * duv1.y + dp1perp * duv2.y;
                    float invmax = inversesqrt(max(dot(tangent, tangent), dot(bitangent, bitangent)));
                    return vec3(dot(viewDir, tangent * invmax), dot(viewDir, bitangent * invmax), dot(viewDir, normal));
                }

                vec2 parallaxMap(vec2 uv, vec3 viewDir) {
                    float numLayers = mix(30.0, 10.0, abs(viewDir.z));
                    float layerDepth = 1.0 / numLayers;
                    float currentLayerDepth = 0.0;
                    vec2 p = viewDir.xy / viewDir.z * parallaxScale;
                    vec2 deltaUV = p / numLayers;
                    vec2 currentUV = uv;
                    float height = 1.0 - texture2D(heightMap, currentUV).r;

                    for(int i = 0; i < 32; i++) {
                        if(currentLayerDepth >= height) break;
                        currentUV -= deltaUV;
                        height = 1.0 - texture2D(heightMap, currentUV).r;
                        currentLayerDepth += layerDepth;
                    }

                    vec2 prevUV = currentUV + deltaUV;
                    float nextDepth = height - currentLayerDepth;
                    float prevDepth = (1.0 - texture2D(heightMap, prevUV).r) - currentLayerDepth + layerDepth;
                    return mix(currentUV, prevUV, nextDepth / (nextDepth - prevDepth));
                }
            ` + shader.fragmentShader;

            // 2. Calculate offset ONCE, then substitute it directly into Three's native chunks
            // This avoids assigning to read-only `in` variables
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `
                vec2 pomOffset = vec2(0.0);
                #ifdef USE_MAP
                    vec3 pomViewDir = normalize(getPOMViewDir(-vViewPosition, normalize(vNormal), vMapUv));
                    pomOffset = parallaxMap(vMapUv, pomViewDir) - vMapUv;
                #endif
                ` + THREE.ShaderChunk.map_fragment.replace(/vMapUv/g, '(vMapUv + pomOffset)')
            );

            // 3. Offset the Normal map lookup
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <normal_fragment_maps>',
                THREE.ShaderChunk.normal_fragment_maps.replace(/vNormalMapUv/g, '(vNormalMapUv + pomOffset)')
            );

            // 4. Offset the Ambient Occlusion map lookup
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <aomap_fragment>',
                THREE.ShaderChunk.aomap_fragment.replace(/vAoMapUv/g, '(vAoMapUv + pomOffset)')
            );

            // 5. Offset the Roughness map lookup
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <roughnessmap_fragment>',
                THREE.ShaderChunk.roughnessmap_fragment.replace(/vRoughnessMapUv/g, '(vRoughnessMapUv + pomOffset)')
            );
        };
    }

    // Create an InstancedMesh for each tool (GHOST BLOCKS)
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

    // UX: Visual floor plane
    const editorFloorGeo = new THREE.PlaneGeometry(100, 100);
    editorFloorGeo.rotateX(-Math.PI / 2);
    const editorFloor = new THREE.Mesh(editorFloorGeo, new THREE.MeshBasicMaterial({ visible: false }));
    editorFloor.position.y = -0.5; // Set just below Y=0 blocks
    editorSceneGroup.add(editorFloor);

    // UX: Visible Grid
    const editorGrid = new THREE.GridHelper(40, 40, 0xffffff, 0x444444);
    editorGrid.position.y = -0.5;
    editorGrid.material.opacity = 0.2;
    editorGrid.material.transparent = true;
    editorSceneGroup.add(editorGrid);

    // UX: Visible Water Plane for Editor
    const editorWaterGeo = new THREE.PlaneGeometry(200, 200);
    editorWaterGeo.rotateX(-Math.PI / 2);
    const editorWaterPlane = new THREE.Mesh(editorWaterGeo, new THREE.MeshBasicMaterial({ color: 0x0055ff, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
    editorWaterPlane.visible = false;
    editorSceneGroup.add(editorWaterPlane);

    editorSceneGroup.visible = false;

    // Upgraded Editor Cursor (Solid glowing block with crisp wireframe edges)
    const ghostGeo = new THREE.BoxGeometry(1.02, 1.02, 1.02);
    const ghostMat = new THREE.MeshBasicMaterial({ 
        color: 0x44ffaa, transparent: true, opacity: 0.25, 
        blending: THREE.AdditiveBlending, depthWrite: false 
    });
    const ghostMesh = new THREE.Mesh(ghostGeo, ghostMat);

    // Add edge lines to make the grid cursor perfectly readable
    const edgesGeo = new THREE.EdgesGeometry(ghostGeo);
    const edgesMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending });
    const ghostEdges = new THREE.LineSegments(edgesGeo, edgesMat);
    ghostMesh.add(ghostEdges);

    ghostMesh.visible = false;
    scene.add(ghostMesh);

    // Preview point light that follows the ghost mesh when the light tool is active
    const editorPreviewLight = new THREE.PointLight(0xffffff, 0, 10);
    editorPreviewLight.castShadow = false;
    scene.add(editorPreviewLight);

    function createConcreteTextures() {
        const S = 512, EDGE = 28;
        const makeRng = (seed) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; }; };

        const geoRng = makeRng(99);
        const scratches = Array.from({ length: 35 }, () => {
            const x1 = geoRng() * S, y1 = geoRng() * S;
            const len = 20 + geoRng() * 100, angle = geoRng() * Math.PI;
            const width = 0.5 + geoRng() * 2;
            return { x1, y1, angle, width, x2: x1 + Math.cos(angle) * len, y2: y1 + Math.sin(angle) * len };
        });

        const cracks = Array.from({ length: 8 }, () => {
            let cx = geoRng() * S, cy = geoRng() * S;
            const segs = 5 + Math.floor(geoRng() * 8);
            const pts = [{ x: cx, y: cy }];
            for (let j = 0; j < segs; j++) {
                const a = geoRng() * Math.PI * 2, l = 10 + geoRng() * 35;
                cx += Math.cos(a) * l; cy += Math.sin(a) * l;
                pts.push({ x: cx, y: cy });
            }
            return { pts, width: 1 + geoRng() * 1.5 };
        });

        const makeCtx = () => { const c = document.createElement('canvas'); c.width = S; c.height = S; return { c, ctx: c.getContext('2d') }; };

        const { c: aC, ctx: a } = makeCtx();
        const rA = makeRng(42);

        const baseGrd = a.createLinearGradient(0, 0, S, S);
        baseGrd.addColorStop(0, '#c8cac5'); baseGrd.addColorStop(0.5, '#bfc2bc'); baseGrd.addColorStop(1, '#c5c7c2');
        a.fillStyle = baseGrd; a.fillRect(0, 0, S, S);

        // Base broad mottling
        for (let i = 0; i < 12; i++) {
            const px = rA() * S, py = rA() * S, pr = 30 + rA() * 90;
            const g = a.createRadialGradient(px, py, 0, px, py, pr);
            g.addColorStop(0, `rgba(100,100,95,${0.04 + rA() * 0.07})`); g.addColorStop(1, 'rgba(100,100,95,0)');
            a.fillStyle = g; a.beginPath(); a.arc(px, py, pr, 0, Math.PI * 2); a.fill();
        }

        // High-frequency grit (Micro-detail) - eliminates the "flat plastic" look up close
        const aData = a.getImageData(0, 0, S, S);
        for(let i = 0; i < aData.data.length; i += 4) {
            let noise = (rA() - 0.5) * 16; // Slight variation per pixel
            aData.data[i] = Math.min(255, Math.max(0, aData.data[i] + noise));
            aData.data[i+1] = Math.min(255, Math.max(0, aData.data[i+1] + noise));
            aData.data[i+2] = Math.min(255, Math.max(0, aData.data[i+2] + noise));
        }
        a.putImageData(aData, 0, 0);

        // Albedo darkening around edges
        [['rgba(40,40,38,0.55)', 'rgba(40,40,38,0)', 0, 0, 0, EDGE, 0, 0, S, EDGE],
        ['rgba(40,40,38,0.55)', 'rgba(40,40,38,0)', 0, 0, EDGE, 0, 0, 0, EDGE, S],
        ['rgba(220,222,216,0)', 'rgba(220,222,216,0.45)', 0, S-EDGE, 0, S, 0, S-EDGE, S, EDGE],
        ['rgba(220,222,216,0)', 'rgba(220,222,216,0.45)', S-EDGE, 0, S, 0, S-EDGE, 0, EDGE, S],
        ].forEach(([c0, c1, gx0, gy0, gx1, gy1, rx, ry, rw, rh]) => {
            const g = a.createLinearGradient(gx0, gy0, gx1, gy1);
            g.addColorStop(0, c0); g.addColorStop(1, c1);
            a.fillStyle = g; a.fillRect(rx, ry, rw, rh);
        });
        a.strokeStyle = 'rgba(30,30,28,0.35)'; a.lineWidth = 1.5; a.strokeRect(0.75, 0.75, S - 1.5, S - 1.5);

        // NEW: Baked Ambient Occlusion (Shadow Frame)
        const { c: aoC, ctx: ao } = makeCtx();
        ao.fillStyle = '#ffffff'; ao.fillRect(0, 0, S, S);
        const shadowRadius = EDGE * 1.6;
        [['rgba(0,0,0,0.85)', 'rgba(0,0,0,0)', 0, 0, 0, shadowRadius, 0, 0, S, shadowRadius],
         ['rgba(0,0,0,0.85)', 'rgba(0,0,0,0)', 0, 0, shadowRadius, 0, 0, 0, shadowRadius, S],
         ['rgba(0,0,0,0)', 'rgba(0,0,0,0.85)', 0, S-shadowRadius, 0, S, 0, S-shadowRadius, S, shadowRadius],
         ['rgba(0,0,0,0)', 'rgba(0,0,0,0.85)', S-shadowRadius, 0, S, 0, S-shadowRadius, 0, shadowRadius, S],
        ].forEach(([c0, c1, gx0, gy0, gx1, gy1, rx, ry, rw, rh]) => {
            const g = ao.createLinearGradient(gx0, gy0, gx1, gy1);
            g.addColorStop(0, c0); g.addColorStop(1, c1);
            ao.fillStyle = g; ao.fillRect(rx, ry, rw, rh);
        });

        // Normal Map
        const { c: nC, ctx: n } = makeCtx();
        const rN = makeRng(42); 

        n.fillStyle = '#8080ff'; n.fillRect(0, 0, S, S);

        // Base normal undulation
        for (let i = 0; i < 12; i++) {
            const px = rN() * S, py = rN() * S, pr = 120 + rN() * 180;
            const g = n.createRadialGradient(px, py, 0, px, py, pr);
            const dx = Math.floor(118 + rN() * 20), dy = Math.floor(118 + rN() * 20);
            g.addColorStop(0, `rgba(${dx},${dy},255,0.18)`); g.addColorStop(1, 'rgba(128,128,255,0)');
            n.fillStyle = g; n.beginPath(); n.arc(px, py, pr, 0, Math.PI * 2); n.fill();
        }

        // Normal bevel edges
        const bevels = [
            { g: [0,0,0,EDGE],       c0:'rgba(128,80,255,0.95)',  c1:'rgba(128,128,255,0)', r:[0,0,S,EDGE] },
            { g: [0,S-EDGE,0,S],     c0:'rgba(128,128,255,0)',    c1:'rgba(128,176,255,0.95)', r:[0,S-EDGE,S,EDGE] },
            { g: [0,0,EDGE,0],       c0:'rgba(80,128,255,0.95)',  c1:'rgba(128,128,255,0)', r:[0,0,EDGE,S] },
            { g: [S-EDGE,0,S,0],     c0:'rgba(128,128,255,0)',    c1:'rgba(176,128,255,0.95)', r:[S-EDGE,0,EDGE,S] },
        ];
        for (const { g: [gx0,gy0,gx1,gy1], c0, c1, r: [rx,ry,rw,rh] } of bevels) {
            const g = n.createLinearGradient(gx0, gy0, gx1, gy1);
            g.addColorStop(0, c0); g.addColorStop(1, c1);
            n.fillStyle = g; n.fillRect(rx, ry, rw, rh);
        }

        const makeTex = (canvas, srgb = false) => {
            const t = new THREE.CanvasTexture(canvas);
            t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true;
            t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
            if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
        };

        const aoTex = makeTex(aoC);
        aoTex.channel = 0; // Force AO map to use standard UV0 slot 

        // --- ADD HEIGHTMAP DRAWING ---
        const { c: hC, ctx: h } = makeCtx();
        h.fillStyle = '#ffffff'; h.fillRect(0, 0, S, S);
        // Draw cracks into heightmap as depth (black)
        cracks.forEach(ck => {
            h.strokeStyle = 'rgba(0,0,0,0.5)'; h.lineWidth = ck.width * 2.5;
            h.beginPath(); h.moveTo(ck.pts[0].x, ck.pts[0].y);
            ck.pts.forEach(p => h.lineTo(p.x, p.y)); h.stroke();
        });
        const heightTex = makeTex(hC);

        return { albedo: makeTex(aC, true), normal: makeTex(nC), ao: aoTex, height: heightTex };
    }

    function createFloorTextures() {
        const S = 512, EDGE = 24;
        const makeRng = (seed) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; }; };

        const aC = document.createElement('canvas'); aC.width = S; aC.height = S;
        const a = aC.getContext('2d');
        const rA = makeRng(88);

        const baseGrd = a.createLinearGradient(0, 0, S, S);
        baseGrd.addColorStop(0, '#e8eae8'); 
        baseGrd.addColorStop(0.5, '#dfe1df'); 
        baseGrd.addColorStop(1, '#e4e6e4');
        a.fillStyle = baseGrd; a.fillRect(0, 0, S, S);

        for (let i = 0; i < 40; i++) {
            const px = rA() * S, py = rA() * S, pr = 30 + rA() * 100;
            const g = a.createRadialGradient(px, py, 0, px, py, pr);
            const isDark = rA() > 0.5;
            const alpha = 0.02 + rA() * 0.04;
            g.addColorStop(0, isDark ? `rgba(130,130,125,${alpha})` : `rgba(255,255,255,${alpha})`); 
            g.addColorStop(1, 'rgba(130,130,125,0)');
            a.fillStyle = g; a.beginPath(); a.arc(px, py, pr, 0, Math.PI * 2); a.fill();
        }

        const aData = a.getImageData(0, 0, S, S);
        for(let i = 0; i < aData.data.length; i += 4) {
            let noise = (rA() - 0.5) * 10;
            aData.data[i] = Math.min(255, Math.max(0, aData.data[i] + noise));
            aData.data[i+1] = Math.min(255, Math.max(0, aData.data[i+1] + noise));
            aData.data[i+2] = Math.min(255, Math.max(0, aData.data[i+2] + noise));
        }
        a.putImageData(aData, 0, 0);

        // --- ALBEDO EDGES ---
        [['rgba(0,0,0,0.15)', 'rgba(0,0,0,0)', 0, 0, 0, EDGE, 0, 0, S, EDGE], 
        ['rgba(0,0,0,0.15)', 'rgba(0,0,0,0)', 0, 0, EDGE, 0, 0, 0, EDGE, S], 
        ['rgba(255,255,255,0)', 'rgba(255,255,255,0.25)', 0, S-EDGE, 0, S, 0, S-EDGE, S, EDGE], 
        ['rgba(255,255,255,0)', 'rgba(255,255,255,0.25)', S-EDGE, 0, S, 0, S-EDGE, 0, EDGE, S]  
        ].forEach(([c0, c1, gx0, gy0, gx1, gy1, rx, ry, rw, rh]) => {
            const g = a.createLinearGradient(gx0, gy0, gx1, gy1);
            g.addColorStop(0, c0); g.addColorStop(1, c1);
            a.fillStyle = g; a.fillRect(rx, ry, rw, rh);
        });
        a.strokeStyle = 'rgba(20,20,20,0.2)'; a.lineWidth = 1.5; a.strokeRect(0.75, 0.75, S - 1.5, S - 1.5);

        // --- HEIGHTMAP GENERATION ---
        const hC = document.createElement('canvas'); hC.width = S; hC.height = S;
        const h = hC.getContext('2d');
        const rH = makeRng(88); // Use same seed

        // 1. Surface is high (White)
        h.fillStyle = '#ffffff';
        h.fillRect(0, 0, S, S);

        // 2. Beveled Edges (Carve into the floor)
        // Left & Top (Sloping down)
        const edgeInner = EDGE * 0.8;
        const hGrd1 = h.createLinearGradient(0, 0, edgeInner, 0);
        hGrd1.addColorStop(0, '#555555'); hGrd1.addColorStop(1, '#ffffff');
        h.fillStyle = hGrd1; h.fillRect(0, 0, edgeInner, S);

        const hGrd2 = h.createLinearGradient(0, 0, 0, edgeInner);
        hGrd2.addColorStop(0, '#555555'); hGrd2.addColorStop(1, '#ffffff');
        h.fillStyle = hGrd2; h.fillRect(0, 0, S, edgeInner);

        // 3. Concrete Grain (Subtle micro-pits)
        const hData = h.getImageData(0, 0, S, S);
        for(let i = 0; i < hData.data.length; i += 4) {
            let grain = (rH() - 0.5) * 8; // Very subtle noise
            hData.data[i] = Math.min(255, Math.max(0, hData.data[i] + grain));
            hData.data[i+1] = hData.data[i];
            hData.data[i+2] = hData.data[i];
        }
        h.putImageData(hData, 0, 0);

        // --- NORMAL MAP ---
        const nC = document.createElement('canvas'); nC.width = S; nC.height = S;
        const n = nC.getContext('2d');
        const rN = makeRng(88);
        n.fillStyle = '#8080ff'; n.fillRect(0, 0, S, S);
        const bevels = [
            { g: [0,0,0,EDGE],       c0:'rgba(128,30,255,1)',  c1:'rgba(128,128,255,0)', r:[0,0,S,EDGE] },      
            { g: [0,S-EDGE,0,S],     c0:'rgba(128,128,255,0)', c1:'rgba(128,226,255,1)', r:[0,S-EDGE,S,EDGE] }, 
            { g: [0,0,EDGE,0],       c0:'rgba(30,128,255,1)',  c1:'rgba(128,128,255,0)', r:[0,0,EDGE,S] },      
            { g: [S-EDGE,0,S,0],     c0:'rgba(128,128,255,0)', c1:'rgba(226,128,255,1)', r:[S-EDGE,0,EDGE,S] }, 
        ];
        for (const { g: [gx0,gy0,gx1,gy1], c0, c1, r: [rx,ry,rw,rh] } of bevels) {
            const g = n.createLinearGradient(gx0, gy0, gx1, gy1);
            g.addColorStop(0, c0); g.addColorStop(1, c1);
            n.fillStyle = g; n.fillRect(rx, ry, rw, rh);
        }

        // --- AO MAP ---
        const aoC = document.createElement('canvas'); aoC.width = S; aoC.height = S;
        const ao = aoC.getContext('2d');
        ao.fillStyle = '#ffffff'; ao.fillRect(0, 0, S, S);
        const shadowRadius = EDGE * 2;
        [['rgba(0,0,0,0.9)', 'rgba(0,0,0,0)', 0, 0, 0, shadowRadius, 0, 0, S, shadowRadius],
        ['rgba(0,0,0,0.9)', 'rgba(0,0,0,0)', 0, 0, shadowRadius, 0, 0, 0, shadowRadius, S],
        ].forEach(([c0, c1, gx0, gy0, gx1, gy1, rx, ry, rw, rh]) => {
            const g = ao.createLinearGradient(gx0, gy0, gx1, gy1);
            g.addColorStop(0, c0); g.addColorStop(1, c1);
            ao.fillStyle = g; ao.fillRect(rx, ry, rw, rh);
        });

        const makeTex = (canvas, srgb = false) => {
            const t = new THREE.CanvasTexture(canvas);
            t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true;
            t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
            if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t;
        };

        return { 
            albedo: makeTex(aC, true), 
            normal: makeTex(nC), 
            ao: makeTex(aoC), 
            height: makeTex(hC) 
        };
    }

    function applyTriplanar(material, scale = 0.5) {
        material.userData.triScale = { value: scale };

        material.onBeforeCompile = (shader) => {
            shader.uniforms.uTriScale = material.userData.triScale;

            // 1. Send World Pos & Normal from Vertex to Fragment Shader
            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                `#include <common>
                varying vec3 vTriWorldPos;
                varying vec3 vTriWorldNormal;`
            );

            shader.vertexShader = shader.vertexShader.replace(
                '#include <worldpos_vertex>',
                `#include <worldpos_vertex>
                vTriWorldPos = worldPosition.xyz;
                vTriWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`
            );

            // 2. Add Triplanar math to Fragment Shader
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <common>',
                `#include <common>
                varying vec3 vTriWorldPos;
                varying vec3 vTriWorldNormal;
                uniform float uTriScale;

                vec4 triplanarSample(sampler2D pMap, vec3 pPos, vec3 pNormal, float pScale) {
                    vec3 blending = abs(pNormal);
                    blending /= (blending.x + blending.y + blending.z);

                    vec4 x = texture2D(pMap, pPos.yz * pScale);
                    vec4 y = texture2D(pMap, pPos.xz * pScale);
                    vec4 z = texture2D(pMap, pPos.xy * pScale);
                    return x * blending.x + y * blending.y + z * blending.z;
                }`
            );

            // 3. Override Albedo
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <map_fragment>',
                `
                #ifdef USE_MAP
                    vec4 sampledColor = triplanarSample(map, vTriWorldPos, vTriWorldNormal, uTriScale);
                    diffuseColor *= sampledColor;
                #endif
                `
            );

            // 4. Override Normal
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <normal_fragment_maps>',
                `
                #ifdef USE_NORMALMAP
                    // Sample triplanar normal and apply normalScale
                    vec3 triNormal = triplanarSample(normalMap, vTriWorldPos, vTriWorldNormal, uTriScale).xyz * 2.0 - 1.0;
                    triNormal.xy *= normalScale;

                    // Blend with world normal
                    normal = normalize(vTriWorldNormal + triNormal);
                #endif
                `
            );
        };
    }

    const g1x1 = new THREE.BoxGeometry(1, 1, 1); const g2x1x2 = new THREE.BoxGeometry(2, 1, 2); const g2x2x1 = new THREE.BoxGeometry(2, 2, 1);
    const g1x2x2 = new THREE.BoxGeometry(1, 2, 2); const halfTileGeo = new THREE.BoxGeometry(0.7, 0.4, 0.7);

    const concreteTexs = createConcreteTextures();
    const floorTexs = createFloorTextures();

    // --- FLOOR MATERIAL ---
    const floorMaterial = new THREE.MeshStandardMaterial({ 
        map: floorTexs.albedo,           // <-- Put these back
        normalMap: floorTexs.normal,     // <-- Put these back
        roughness: 0.15,
        metalness: 0.6,
        envMapIntensity: 0.4,
        normalScale: new THREE.Vector2(2.0, 2.0)
    });
    applyTriplanar(floorMaterial, 0.4); // 0.4 = scale density

    // --- WALL MATERIAL ---
    const wallMaterial = new THREE.MeshStandardMaterial({ 
        map: concreteTexs.albedo,        // <-- Put these back
        normalMap: concreteTexs.normal,  // <-- Put these back
        roughness: 0.30,
        metalness: 0.35,
        envMapIntensity: 0.2,
        normalScale: new THREE.Vector2(3.0, 3.0)
    });
    applyTriplanar(wallMaterial, 0.5);

    // --- BROKEN MATERIAL ---
    const brokenMaterial = new THREE.MeshStandardMaterial({ 
        map: concreteTexs.albedo,        // <-- Put these back
        normalMap: concreteTexs.normal,  // <-- Put these back
        color: 0x8a8d8a, 
        roughness: 0.45,
        metalness: 0.30, 
        envMapIntensity: 0.1,
        normalScale: new THREE.Vector2(3.0, 3.0)
    });
    applyTriplanar(brokenMaterial, 0.5);

    // 3. Inject POM!
    // Note: 0.04 is a very strong effect for testing, you can lower it to 0.02 if it looks 'swimming'
    applyPOM(wallMaterial, concreteTexs.height, 0.04);
    applyPOM(brokenMaterial, concreteTexs.height, 0.04);
    applyPOM(floorMaterial, floorTexs.height, 0.03);

    const baseEmissiveMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffeedd, emissiveIntensity: 3.0, toneMapped: false });

    // Add to your global variables
    const windZones = [];

    // --- PRE-ALLOCATED MATH OBJECTS FOR PERFORMANCE ---
    const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
    const _pPos = new THREE.Vector3(), _dir = new THREE.Vector3();
    const _q1 = new THREE.Quaternion();
    const _vMid = new THREE.Vector3(), _vL1 = new THREE.Vector3(), _vL2 = new THREE.Vector3(), _vLook = new THREE.Vector3();
    const _cannonV1 = new CANNON.Vec3();
    const _cannonImpulse = new CANNON.Vec3();   // reused for all player impulses
    const _cannonImpulse2 = new CANNON.Vec3();  // reused for water/jump impulses
    const _windRayDir  = new CANNON.Vec3();     // reused per-wind raycast direction
    const _windRayDest = new CANNON.Vec3();     // reused per-wind raycast destination
    const _buoyForceV  = new CANNON.Vec3();     // reused for block buoyancy applyForce
    const _worldPosVec = new THREE.Vector3();   // reused for getWorldPosition calls
    const targetVel = new THREE.Vector3(), fwd = new THREE.Vector3(), rgt = new THREE.Vector3();
    const rayStart = new CANNON.Vec3(), rayEnd = new CANNON.Vec3();
    const getSpaceAxes = [new CANNON.Vec3(1,0,0), new CANNON.Vec3(0,1,0), new CANNON.Vec3(0,0,1)];

    const _lightSortArray = new Array(64).fill(null).map(() => ({
        light: null, dist: 0
    }));

    const wallLightPanelGeo = new THREE.BoxGeometry(0.72, 0.72, 0.06);
    const wallLightPanelMat = new THREE.MeshStandardMaterial({ color: 0xffeebb, emissive: 0xffddaa, emissiveIntensity: 2.0, roughness: 0.4, metalness: 0.1, toneMapped: false });
    const wallLightPanelMesh = new THREE.InstancedMesh(wallLightPanelGeo, wallLightPanelMat, 200);
    wallLightPanelMesh.castShadow = false; wallLightPanelMesh.receiveShadow = false; scene.add(wallLightPanelMesh);
    let wallLightPanelCount = 0;

    const volLightCanvas = document.createElement('canvas'); volLightCanvas.width = 64; volLightCanvas.height = 128;
    const vlc = volLightCanvas.getContext('2d');
    const vlg = vlc.createLinearGradient(0,0,0,128);
    vlg.addColorStop(0,'rgba(255,238,200,0.55)'); vlg.addColorStop(0.5,'rgba(255,220,160,0.18)'); vlg.addColorStop(1,'rgba(255,200,120,0)');
    vlc.fillStyle=vlg; vlc.fillRect(0,0,64,128);
    const volLightTex = new THREE.CanvasTexture(volLightCanvas);

    const cableMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8, metalness: 0.2, side: THREE.DoubleSide });

    const dustGeo = new THREE.BufferGeometry();
    const dustPos = [], dustSizes = [];
    for(let i=0; i<1200; i++) {
        dustPos.push((Math.random()-0.5)*160, Math.random()*90, (Math.random()-0.5)*160);
        dustSizes.push(0.03 + Math.random() * 0.12);
    }
    dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(dustPos, 3));
    dustGeo.setAttribute('size', new THREE.Float32BufferAttribute(dustSizes, 1));

    const dustCanvas = document.createElement('canvas'); dustCanvas.width = dustCanvas.height = 64;
    const dc = dustCanvas.getContext('2d');
    const dg = dc.createRadialGradient(32,32,0,32,32,32);
    dg.addColorStop(0,'rgba(255,248,240,1)'); dg.addColorStop(0.4,'rgba(240,230,220,0.5)'); dg.addColorStop(1,'rgba(220,210,200,0)');
    dc.fillStyle=dg; dc.fillRect(0,0,64,64);
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

    const dustMesh = new THREE.Points(dustGeo, dustMat); dustMesh.matrixAutoUpdate = false; scene.add(dustMesh);

    const sparkGeo = new THREE.BufferGeometry();
    const sparkPos = [];
    for(let i=0; i<300; i++) {
        const r = Math.random()*120, a = Math.random()*Math.PI*2;
        sparkPos.push(Math.cos(a)*r, 1+Math.random()*50, Math.sin(a)*r);
    }
    sparkGeo.setAttribute('position', new THREE.Float32BufferAttribute(sparkPos, 3));
    const sparkMat = new THREE.PointsMaterial({ color: 0xffeedd, size: 0.04, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending });
    const sparkMesh = new THREE.Points(sparkGeo, sparkMat); scene.add(sparkMesh);

    const levelGeometries = [];
    const levelMaterials  = [];

   const baseBlockMat = {
        roughness: 0.15, metalness: 0.25, // Tweaked to offset lack of clearcoat
        envMapIntensity: 4.0,
        transparent: true, opacity: 0.95
        // Removed clearcoat, ior, sheen, transmission for massive FPS gain and zero visual bugs
    };

    const blockConfigs = {
        blue: {
            mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0x3388ff, emissive: 0x001166, attenuationColor: new THREE.Color(0x6699ff) }),
            geo: new RoundedBoxGeometry(1.5, 1.5, 1.5, 4, 0.18), extents: new CANNON.Vec3(0.75, 0.75, 0.75), mass: 50
        },
        green: {
            mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0x33ff99, emissive: 0x003311, attenuationColor: new THREE.Color(0x44ffaa) }),
            geo: new RoundedBoxGeometry(1.0, 1.0, 1.0, 4, 0.12), extents: new CANNON.Vec3(0.5, 0.5, 0.5), mass: 30
        },
        red: {
            mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0xff3344, emissive: 0x440008, attenuationColor: new THREE.Color(0xff6677) }),
            geo: new RoundedBoxGeometry(1.0, 1.0, 1.0, 4, 0.12), extents: new CANNON.Vec3(0.5, 0.5, 0.5), mass: 35
        },
        yellow: {
            mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0xffdd33, emissive: 0x332200, attenuationColor: new THREE.Color(0xffee88) }),
            geo: new RoundedBoxGeometry(1.0, 1.0, 1.0, 4, 0.12), extents: new CANNON.Vec3(0.5, 0.5, 0.5), mass: 40
        },
        big_yellow: {
            mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0xffdd33, emissive: 0x332200, attenuationColor: new THREE.Color(0xffee88) }),
            geo: new RoundedBoxGeometry(2.5, 1.0, 2.5, 4, 0.12), extents: new CANNON.Vec3(1.3, 0.5, 1.3), mass: 50
        },
        cyan: {
            mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0x33ffff, emissive: 0x002233, attenuationColor: new THREE.Color(0x66ffff) }),
            geo: new RoundedBoxGeometry(1.0, 1.0, 1.0, 4, 0.12), extents: new CANNON.Vec3(0.5, 0.5, 0.5), mass: 30
        },
        gray: {
            mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0xaaaaaa, emissive: 0x111111, attenuationColor: new THREE.Color(0xcccccc) }),
            geo: new RoundedBoxGeometry(1.0, 1.0, 1.0, 4, 0.12), extents: new CANNON.Vec3(0.5, 0.5, 0.5), mass: 30
        },
        big_gray: {
            mat: new THREE.MeshPhysicalMaterial({ ...baseBlockMat, color: 0x999999, emissive: 0x111111, attenuationColor: new THREE.Color(0xbbbbbb) }),
            geo: new RoundedBoxGeometry(1.5, 1.5, 1.5, 4, 0.18), extents: new CANNON.Vec3(0.75, 0.75, 0.75), mass: 80
        }
    };

    const shapes = {
        '1x1x1': new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5)), '2x1x2': new CANNON.Box(new CANNON.Vec3(1.0, 0.5, 1.0)),
        '2x2x1': new CANNON.Box(new CANNON.Vec3(1.0, 1.0, 0.5)), '1x2x2': new CANNON.Box(new CANNON.Vec3(0.5, 1.0, 1.0))
    };

    const meshes = {
        'wall1x1x1': new THREE.InstancedMesh(g1x1, wallMaterial, 5000), 
        'wall2x1x2': new THREE.InstancedMesh(g2x1x2, wallMaterial, 2000),
        'wall2x2x1': new THREE.InstancedMesh(g2x2x1, wallMaterial, 2000), 
        'wall1x2x2': new THREE.InstancedMesh(g1x2x2, wallMaterial, 2000),
        'broken1x1x1': new THREE.InstancedMesh(g1x1, brokenMaterial, 3000), 
        'broken2x1x2': new THREE.InstancedMesh(g2x1x2, brokenMaterial, 1000),
        'broken2x2x1': new THREE.InstancedMesh(g2x2x1, brokenMaterial, 1000), 
        'broken1x2x2': new THREE.InstancedMesh(g1x2x2, brokenMaterial, 1000),
        'floor1x1x1': new THREE.InstancedMesh(g1x1, floorMaterial, 3000), 
        'floor2x1x2': new THREE.InstancedMesh(g2x1x2, floorMaterial, 1000),
        'floor2x2x1': new THREE.InstancedMesh(g2x2x1, floorMaterial, 1000), 
        'floor1x2x2': new THREE.InstancedMesh(g1x2x2, floorMaterial, 1000),
        'light': new THREE.InstancedMesh(g1x1, baseEmissiveMaterial, 200)
    };

    const counts = { 
        'wall1x1x1':0, 'wall2x1x2':0, 'wall2x2x1':0, 'wall1x2x2':0, 
        'broken1x1x1':0, 'broken2x1x2':0, 'broken2x2x1':0, 'broken1x2x2':0, 
        'floor1x1x1':0, 'floor2x1x2':0, 'floor2x2x1':0, 'floor1x2x2':0, 
        'light':0 
    };

    const maxCounts = {};
    for (const k in meshes) { 
        meshes[k].castShadow = true; 
        meshes[k].receiveShadow = true; 
        meshes[k].frustumCulled = true; 
        maxCounts[k] = meshes[k].count; 
        scene.add(meshes[k]); // <--- THIS LINE IS VITAL
    }

    const dummy = new THREE.Object3D();

    let pendingBounce = false; let pendingBounceBlock = null; let waterMesh = null;
    let waveTime = 0; 

    let coyoteTimer = 0; let wasGrounded = false; const COYOTE_TIME = 0.15; let smoothCamY = 0;

    const levelBodies = []; const levelMeshes = []; const levelLights = []; const levelConstraints = [];
    const dynamicSyncList = []; let interactiveBlocks = []; let interactiveTargets = [];
    const meshToBlock = new Map(); // O(1) lookup: mesh → block, rebuilt each level
    const dynamicRopes = []; const holograms = [];

    const activePlates = [];
    const activeDoors = [];

    const logicNodes = {
        inputs: new Array(10).fill(false), // Raw plate signals
        resolved: new Array(10).fill(false), // Final output after gates
        configs: {} // Gate definitions: { ch: { type: 'NOT', source: 1 } or { type: 'AND', sources: [1, 2] } }
    };

    function resolveLogic() {
        // 1. Initialize with raw inputs
        for (let i = 1; i <= 9; i++) logicNodes.resolved[i] = logicNodes.inputs[i];

        // 2. Run 3 passes to propagate signals through gates
        for (let pass = 0; pass < 3; pass++) {
            for (let ch in logicNodes.configs) {
                const cfg = logicNodes.configs[ch];
                const chIdx = parseInt(ch);
                if (cfg.type === 'NOT') {
                    logicNodes.resolved[chIdx] = !logicNodes.resolved[cfg.source];
                } else if (cfg.type === 'AND') {
                    logicNodes.resolved[chIdx] = logicNodes.resolved[cfg.sources[0]] && logicNodes.resolved[cfg.sources[1]];
                }
            }
        }
    }

    let currentGoal = null; let currentGreenBlock = null;
    let exitMesh = null; let currentParams = null; let grabbedBlock = null;
    const RED_SCALE_MIN  = 0.3; const RED_SCALE_MAX  = 3.5;
    let rKeyTimer = 0; let isRKeyDown = false;

    const playerHRadius = 0.36;   
    const playerHalfH   = 0.78;   
    const playerRadius  = playerHRadius; 

    const playerBody = new CANNON.Body({ 
        mass: 60, material: playerMat, position: new CANNON.Vec3(0, 0, 0),
        fixedRotation: true, linearDamping: 0.0,
        collisionFilterGroup: CG_PLAYER, collisionFilterMask: CG_STATIC | CG_DYNAMIC | CG_ROPE, allowSleep: false 
    });
    playerBody.addShape(new CANNON.Cylinder(playerHRadius, playerHRadius, playerHalfH * 2, 8));
    playerBody.addShape(new CANNON.Sphere(playerHRadius * 0.9), new CANNON.Vec3(0, -playerHalfH + playerHRadius * 0.9, 0));
    playerBody.addShape(new CANNON.Sphere(playerHRadius * 0.85), new CANNON.Vec3(0,  playerHalfH - playerHRadius * 0.85, 0));
    world.addBody(playerBody);

    let pendingBounceVelocity = 0; // Add this variable above the listener

    const globalTiltThree = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.00, 0, 0.00));

    // --- GLOBAL CONSTANTS & CONFIGURATION ---
    const MAX_LEVELS = 10;
    const MAX_VOL_LIGHTS = 16;

    let isMontageCutscene = false;
    let expandAnimData = [];
    let expandAnimActive = false;
    let expandAnimTime = 0;

    const pointPosUniformArray = new Array(MAX_VOL_LIGHTS).fill(null).map(() => new THREE.Vector3());
    const pointColUniformArray = new Array(MAX_VOL_LIGHTS).fill(null).map(() => new THREE.Vector3());

    let activeChapter = 0;                       // 0=Ch1  1=Ch2  2=Ch3
    let chaptersUnlocked = [true, false, false]; // Ch1 always unlocked

    let isHubWorld  = false;
    const hubRuntime = new HubWorldRuntime();
    let hubProgress  = loadHubProgress();

    let isPaused = true; 
    let volBGM = 0.5; let volSFX = 0.5; let volDyn = 0.5;
    let gfx = { res: 0.75, shadows: 2, bloom: 1, ssao: 1, fxaa: 1, ssr: 0, particles: 2, volumetrics: 2 };
    let volAdv = { density: 0.003, radius: 25, brightness: 0.35 };
    let _prevShadowType = -1; // Tracks last applied shadow type to avoid full scene.traverse on every resize


    // ─────────────────────────────────────────────────────────────────────────────
    //  SHATTER — BGM PATTERNS
    //  16-second loop = 128 steps × 125 ms each
    //  Key: C pentatonic  [C4 D4 E4 G4 A4 | C5 D5 E5 G5 A5]
    //  Indices:            [ 0  1  2  3  4 |  5  6  7  8  9]
    // ─────────────────────────────────────────────────────────────────────────────

    const BGM_MELODY = [
        // Each note here is a "Half-note" or "Whole-note" (8-16 steps)
        [ 0,   2,  2.5 ],   // E4 - Long breath start
        [ 16,  3,  2.0 ],   // G4
        [ 32,  5,  3.0 ],   // C5 - Reaching up
        [ 48,  4,  2.0 ],   // A4 - Settling

        [ 64,  7,  3.5 ],   // E5 - Peak tone (sustains through the bridge)
        [ 80,  6,  2.5 ],   // D5
        [ 96,  4,  2.0 ],   // A4
        [ 112, 5,  3.0 ],   // C5 - Resolving loop back to E4
    ];

    const BGM_HARMONY = [
        // Slow, very soft pad-like notes that fill the gaps
        [ 8,   0,  3.0 ],   // C4 - Deep anchor
        [ 40,  2,  3.0 ],   // E4
        [ 72,  3,  3.0 ],   // G4
        [ 104, 0,  3.0 ],   // C4
    ];

    const BGM_BASS = [
        // Constant, soft pulse every 8 steps (Exactly 1.0 seconds)
        // This provides the "Constant Rhythm" without being distracting
        [ 0,   65.41,  0.8 ], // C2
        [ 8,   65.41,  0.8 ], 
        [ 16,  82.41,  0.8 ], // E2
        [ 24,  82.41,  0.8 ],
        [ 32,  87.31,  0.8 ], // F2
        [ 40,  87.31,  0.8 ],
        [ 48,  98.00,  0.8 ], // G2
        [ 56,  98.00,  0.8 ],
        [ 64,  65.41,  0.8 ], // C2
        [ 72,  65.41,  0.8 ],
        [ 80,  55.00,  0.8 ], // A1 (Low)
        [ 88,  55.00,  0.8 ],
        [ 96,  98.00,  0.8 ], // G2
        [ 104, 98.00,  0.8 ],
        [ 112, 65.41,  0.8 ], // C2
        [ 120, 65.41,  0.8 ],
    ];

    // ─────────────────────────────────────────────────────────────────────────────
    //  HARMONIC DEFINITIONS
    // ─────────────────────────────────────────────────────────────────────────────

    // Maps the BGM_BASS progression to specific indices in the penta[] array
    // penta: [C4, D4, E4, G4, A4 | C5, D5, E5, G5, A5]
    const CHORD_MAP = {
        'C':  [0, 2, 3, 5, 7, 8], // C, E, G notes
        'G':  [1, 3, 4, 6, 8, 9], // G, B(D), D, A notes
        'Am': [0, 2, 4, 5, 7, 9], // A, C, E notes
        'Em': [2, 3, 5, 7, 8],    // E, G, B notes
    };

    // Map each 8-step block (1 second) of the 128-step loop to a chord
    const PROGRESSION = [
        'C', 'G', 'Am', 'G',  'Am', 'Em', 'G', 'Am', // 0-63
        'C', 'G', 'Em', 'G',  'Am', 'C',  'G', 'C'    // 64-127
    ];

    const AudioSys = {
        ctx: null, masterGain: null, bgmGain: null, arpGain: null,
        blueGain: null, exitGain: null, textGain: null,
        focusElement: null, stepCount: 0,
        blueActiveUntil: 0, exitActiveUntil: 0,

        init() {
            if (this.ctx) return;
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();

            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 1.0;

            this.limiter = this.ctx.createDynamicsCompressor();
            this.limiter.threshold.value = -3.0;
            this.limiter.connect(this.ctx.destination);
            this.masterGain.connect(this.limiter);

            this.bgmGain  = this.ctx.createGain(); this.bgmGain.connect(this.masterGain);
            this.arpGain  = this.ctx.createGain(); this.arpGain.connect(this.masterGain);
            this.blueGain = this.ctx.createGain(); this.blueGain.connect(this.masterGain);
            this.exitGain = this.ctx.createGain(); this.exitGain.connect(this.masterGain);
            this.textGain = this.ctx.createGain(); this.textGain.gain.value = 1.0 * volSFX; this.textGain.connect(this.masterGain);

            this.reverbNode = this.ctx.createConvolver();
            this.reverbNode.buffer = this.createReverbBuffer(this.ctx, 2.5);
            this.reverbNode.connect(this.masterGain);

            // Arp and Melody go to Reverb for atmospheric glue
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

            // 1. DETERMINE CURRENT HARMONY
            const chordKey = PROGRESSION[Math.floor(beat / 8)];
            const safeIndices = CHORD_MAP[chordKey];
            const penta = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25, 783.99, 880.00];

            // 2. MAIN BGM (Melody, Harmony, Bass)
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

            // 3. ADAPTIVE ARPEGGIOS (Harmony focused)
            const targetArp = (this.focusElement ? 0.5 : 0.0) * volDyn;
            this.arpGain.gain.setTargetAtTime(targetArp, t, 0.2);

            if (this.focusElement && volDyn > 0) {
                // Pick a note from the "safe" chord tones based on the step
                const getChordNote = (offset = 0) => {
                    const idx = (s + offset) % safeIndices.length;
                    return penta[safeIndices[idx]];
                };

                switch(this.focusElement) {
                    case 'blue': // Fast, high shimmering (Every step)
                        this.playTone(getChordNote() * 2, 'sine', 0.2, 0.12 * volDyn, this.arpGain);
                        break;

                    case 'green': // Reflective, slow pulses (Every 2 steps)
                        if (s % 2 === 0) {
                            this.playTone(getChordNote(), 'sine', 0.8, 0.15 * volDyn, this.arpGain);
                        }
                        break;

                    case 'red': // Low, rhythmic "power" (Every 2 steps)
                        if (s % 2 === 0) {
                            this.playTone(getChordNote(s % 3) / 2, 'sawtooth', 0.3, 0.04 * volDyn, this.arpGain);
                            this.playTone(getChordNote(s % 2) / 2, 'triangle', 0.3, 0.06 * volDyn, this.arpGain);
                        }
                        break;

                    case 'yellow': // Syncopated stabs
                        if (s % 4 === 1 || s % 4 === 3) {
                            this.playTone(getChordNote() * 1.5, 'square', 0.05, 0.05 * volDyn, this.arpGain);
                        }
                        break;

                    case 'cyan': // Ethereal FM bell
                        if (s % 4 === 0) {
                            this.playFMTone(getChordNote() * 2, 2.14, 2, 0.6, 0.07 * volDyn, this.arpGain);
                        }
                        break;
                }
            }

            // 4. EFFECTS LAYERS
            if (this.blueActiveUntil && t < this.blueActiveUntil && volDyn > 0) {
                const bIdx = safeIndices[s % safeIndices.length];
                this.playTone(penta[bIdx] * 2, 'sine', 0.15, 0.08 * volDyn, this.blueGain);
            }
            if (this.exitActiveUntil && t < this.exitActiveUntil && volDyn > 0) {
                const eIdx = safeIndices[s % safeIndices.length];
                this.playTone(penta[eIdx], 'sine', 0.4, 0.02 * volDyn, this.exitGain);
            }
        },

        // ... (Keep existing playTone, playFMTone, createReverbBuffer, and SFX methods)
        playTone(freq, type, dur, vol, dest, startTime) {
            if (!this.ctx) return;
            const t = startTime !== undefined ? startTime : this.ctx.currentTime;
            const dst = dest || this.bgmGain;
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            o.type = type; o.frequency.value = freq;
            g.gain.setValueAtTime(vol, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + Math.max(dur, 0.05));
            o.connect(g); g.connect(dst); o.start(t); o.stop(t + Math.max(dur, 0.05));
        },

        playFMTone(carrierFreq, modRatio, modIndex, dur, vol, dest, startTime) {
            if (!this.ctx) return;
            const t = startTime !== undefined ? startTime : this.ctx.currentTime;
            const dst = dest || this.masterGain;
            const carrier = this.ctx.createOscillator();
            const modulator = this.ctx.createOscillator();
            const modGain = this.ctx.createGain();
            const g = this.ctx.createGain();
            carrier.type = 'sine'; carrier.frequency.value = carrierFreq;
            modulator.type = 'sine'; modulator.frequency.value = carrierFreq * modRatio;
            modGain.gain.setValueAtTime(carrierFreq * modIndex, t);
            modGain.gain.exponentialRampToValueAtTime(0.01, t + dur);
            g.gain.setValueAtTime(vol, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + dur);
            modulator.connect(modGain); modGain.connect(carrier.frequency);
            carrier.connect(g); g.connect(dst);
            modulator.start(t); modulator.stop(t + dur);
            carrier.start(t); carrier.stop(t + dur);
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

        grab()   { if (!this.ctx || volSFX <= 0) return; const t = this.ctx.currentTime; this.playTone(440, 'sine', 0.15, 0.05*volSFX, this.masterGain, t); this.playTone(880, 'sine', 0.15, 0.05*volSFX, this.masterGain, t+0.05); },
        drop()   { if (!this.ctx || volSFX <= 0) return; const t = this.ctx.currentTime; this.playTone(880, 'sine', 0.15, 0.05*volSFX, this.masterGain, t); this.playTone(440, 'sine', 0.15, 0.05*volSFX, this.masterGain, t+0.05); },
        playTextSound() { if (!this.ctx || volSFX <= 0) return; const t = this.ctx.currentTime; [440, 523.25, 659.25, 880, 1046.50, 1318.51].forEach((f, i) => this.playTone(f, 'sine', 0.4, 0.08*volSFX, this.textGain, t + i*0.06)); },
        triggerBlueBounce() { if (!this.ctx) return; const t = this.ctx.currentTime; this.blueGain.gain.cancelScheduledValues(t); this.blueGain.gain.setValueAtTime(0.6 * volDyn, t); this.blueGain.gain.exponentialRampToValueAtTime(0.001, t + 2.5); this.blueActiveUntil = t + 2.5; },
        triggerExitLayer() { if (!this.ctx) return; const t = this.ctx.currentTime; this.exitGain.gain.cancelScheduledValues(t); this.exitGain.gain.setValueAtTime(0, t); this.exitGain.gain.linearRampToValueAtTime(0.03 * volDyn, t + 1.0); this.exitGain.gain.exponentialRampToValueAtTime(0.001, t + 4.5); this.exitActiveUntil = t + 4.5; },           
        resize(delta) { if (!this.ctx || volSFX <= 0) return; const t = this.ctx.currentTime; const o = this.ctx.createOscillator(); const g = this.ctx.createGain(); o.type = 'sawtooth'; o.frequency.value = delta > 0 ? 300 : 150; g.gain.setValueAtTime(0.05*volSFX, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2); o.connect(g); g.connect(this.masterGain); o.start(t); o.stop(t + 0.2); },
    };

    // --- SAVE SYSTEM ---
    // ── CHAPTER DEFINITIONS ───────────────────────────────────────────────────
    function applyAtmosphere(chapterIdx) {
        const data = CHAPTERS[chapterIdx].env;

        // 1. Fog & Background
        scene.fog.color.setHex(data.fog);
        scene.fog.density = data.density;
        morningHorizon.setHex(data.fog);

        // 2. Sky Texture Regeneration/Swap
        if (skyMesh && skyMesh.material) {
            const cacheKey = data.skyStops.join('');
            if (!skyCache.has(cacheKey)) {
                // Generate only if it's not in cache
                skyCache.set(cacheKey, createSkyTexture(data.skyStops));
            }

            // Swap the map
            skyMesh.material.map = skyCache.get(cacheKey);
            skyMesh.material.needsUpdate = true;
        }

        // 3. Ambient & Sun
        hemiLight.color.setHex(data.hemi);
        hemiLight.groundColor.setHex(data.ground);
        sunLight.color.setHex(data.sun);
        sunLight.intensity = data.sunInt;
        sunLight.position.set(data.sunPos[0], data.sunPos[1], data.sunPos[2]);

        // 4. Fill
        fillLight.color.setHex(data.fill);
        fillLight.intensity = data.fillInt;
        fillLight.position.set(-data.sunPos[0], 8, -data.sunPos[2]);
    }

    function getLevelName(lvl) {
        return (CHAPTER_LEVEL_NAMES[activeChapter]||CHAPTER_LEVEL_NAMES[0])[lvl]||`LEVEL ${lvl+1}`;
    }

    const SaveSystem = {
        key: 'shatter_player_data',
        save() {
            const data = {
                currentLevel, activeChapter, chaptersUnlocked,
                gfx, volAdv, volBGM, volSFX, volDyn,
                sensitivity: controls ? controls.pointerSpeed : 1.0
            };
            saveHubProgress(hubProgress);
            localStorage.setItem(this.key, JSON.stringify(data));
        },
        load() {
            const raw = localStorage.getItem(this.key);
            if (!raw) return;
            try {
                const data = JSON.parse(raw);
                if (data.currentLevel !== undefined) currentLevel = data.currentLevel;
                // New format
                if (data.activeChapter !== undefined) activeChapter = data.activeChapter;
                if (data.chaptersUnlocked) chaptersUnlocked = data.chaptersUnlocked;
                // Backward compat with old save format
                else if (data.useV2Layout !== undefined || data.isChapter2Unlocked !== undefined) {
                    chaptersUnlocked[1] = !!(data.isChapter2Unlocked);
                    chaptersUnlocked[2] = !!(data.isChapter3Unlocked);
                    activeChapter = data.useV3Layout ? 2 : data.useV2Layout ? 1 : 0;
                }
                if (data.gfx) Object.assign(gfx, data.gfx);
                if (data.volAdv) Object.assign(volAdv, data.volAdv);
                if (data.volBGM !== undefined) volBGM = data.volBGM;
                if (data.volSFX !== undefined) volSFX = data.volSFX;
                if (data.volDyn !== undefined) volDyn = data.volDyn;
                document.getElementById('bgm-slider').value = volBGM;
                document.getElementById('sfx-slider').value = volSFX;
                document.getElementById('dyn-slider').value = volDyn;
                document.getElementById('set-res').value = gfx.res;
                document.getElementById('set-shadows').value = gfx.shadows;
                document.getElementById('set-volumetrics').value = gfx.volumetrics;
                document.getElementById('set-bloom').value = gfx.bloom;
                document.getElementById('set-ssao').value = gfx.ssao;
                document.getElementById('set-fxaa').value = gfx.fxaa;
                document.getElementById('set-ssr').value = gfx.ssr;
                document.getElementById('set-particles').value = gfx.particles;
                // Sync volAdv sliders
                document.getElementById('vol-density').value            = volAdv.density;
                document.getElementById('vol-density-val').textContent  = volAdv.density.toFixed(4);
                document.getElementById('vol-radius').value             = volAdv.radius;
                document.getElementById('vol-radius-val').textContent   = volAdv.radius;
                document.getElementById('vol-brightness').value         = volAdv.brightness;
                document.getElementById('vol-brightness-val').textContent = volAdv.brightness.toFixed(2);
                if (data.sensitivity) {
                    document.getElementById('sensitivity-slider').value = data.sensitivity;
                    document.getElementById('sens-val').innerText = data.sensitivity.toFixed(1);
                }
                // Sync the new toggle-button UI with loaded gfx values
                if (typeof syncToggleFromGfx === 'function') syncToggleFromGfx();
                hubProgress = loadHubProgress();
            } catch(e) { console.warn("Save data corrupted, resetting."); }
        }
    };


    // --- UI & EVENT LISTENERS ---
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.settings-content').forEach(c => c.classList.remove('active'));
            e.target.classList.add('active'); document.getElementById(e.target.dataset.target).classList.add('active');
        });
    });

    // ── TOGGLE BUTTONS (Video settings) ─────────────────────────────────────
    function setupToggleRow(rowId, hiddenSelectId) {
        const row = document.getElementById(rowId);
        const sel = document.getElementById(hiddenSelectId);
        if (!row || !sel) return;
        row.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                row.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                sel.value = btn.dataset.val;
            });
        });
    }
    setupToggleRow('toggle-volumetrics', 'set-volumetrics');
    setupToggleRow('toggle-bloom',       'set-bloom');
    setupToggleRow('toggle-ssao',        'set-ssao');
    setupToggleRow('toggle-fxaa',        'set-fxaa');
    setupToggleRow('toggle-ssr',         'set-ssr');

    // Helper to sync toggle buttons from gfx values (called after loading saves)
    function syncToggleFromGfx() {
        function syncRow(rowId, val) {
            const row = document.getElementById(rowId);
            if (!row) return;
            row.querySelectorAll('.toggle-btn').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.val) === val);
            });
        }
        syncRow('toggle-volumetrics', gfx.volumetrics);
        syncRow('toggle-bloom',       gfx.bloom);
        syncRow('toggle-ssao',        gfx.ssao);
        syncRow('toggle-fxaa',        gfx.fxaa);
        syncRow('toggle-ssr',         gfx.ssr);
    }

    // ── GRAPHIC PRESETS ──────────────────────────────────────────────────────
    const GFX_PRESETS = {
        potato: { res:0.5,  shadows:0, bloom:0, ssao:0, fxaa:0, ssr:0, particles:0, volumetrics:0 },
        low:    { res:0.5,  shadows:1, bloom:0, ssao:0, fxaa:1, ssr:0, particles:1, volumetrics:0 },
        medium: { res:0.75, shadows:2, bloom:1, ssao:1, fxaa:1, ssr:0, particles:2, volumetrics:2 },
        high:   { res:1.0,  shadows:3, bloom:1, ssao:1, fxaa:1, ssr:0, particles:2, volumetrics:2 },
        ultra:  { res:1.0,  shadows:4, bloom:1, ssao:1, fxaa:1, ssr:0, particles:2, volumetrics:2 },
    };
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const preset = GFX_PRESETS[btn.dataset.preset];
            if (!preset) return;
            document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Apply preset values to all selects
            document.getElementById('set-res').value       = preset.res;
            document.getElementById('set-shadows').value   = preset.shadows;
            document.getElementById('set-particles').value = preset.particles;
            document.getElementById('set-volumetrics').value = preset.volumetrics;
            document.getElementById('set-bloom').value     = preset.bloom;
            document.getElementById('set-ssao').value      = preset.ssao;
            document.getElementById('set-fxaa').value      = preset.fxaa;
            document.getElementById('set-ssr').value       = preset.ssr;
            // Sync toggle buttons
            Object.assign(gfx, preset);
            syncToggleFromGfx();
        });
    });

    const sensSlider = document.getElementById('sensitivity-slider'); const sensVal = document.getElementById('sens-val');
    sensSlider.addEventListener('input', e => { controls.pointerSpeed = parseFloat(e.target.value); sensVal.innerText = parseFloat(e.target.value).toFixed(1); });

    const bgmSlider = document.getElementById('bgm-slider'); const bgmVal = document.getElementById('bgm-val');
    bgmSlider.addEventListener('input', e => { volBGM = parseFloat(e.target.value); if (AudioSys.bgmGain) AudioSys.bgmGain.gain.value = 0.25 * volBGM; bgmVal.innerText = Math.round(volBGM * 100) + '%'; });

    const dynSlider = document.getElementById('dyn-slider'); const dynVal = document.getElementById('dyn-val');
    dynSlider.addEventListener('input', e => { volDyn = parseFloat(e.target.value); dynVal.innerText = Math.round(volDyn * 100) + '%'; });

    const sfxSlider = document.getElementById('sfx-slider'); const sfxVal = document.getElementById('sfx-val');
    sfxSlider.addEventListener('input', e => { volSFX = parseFloat(e.target.value); sfxVal.innerText = Math.round(volSFX * 100) + '%'; });

    // ── VOLUMETRICS ADVANCED SLIDERS ──────────────────────────────────────────
    const _applyVolAdv = () => {
        if (volumetricPass) {
            volumetricPass.material.uniforms.scattering.value    = volAdv.density;
            volumetricPass.material.uniforms.volRadiusSq.value   = volAdv.radius * volAdv.radius;
            volumetricPass.material.uniforms.volBrightness.value = volAdv.brightness;
        }
        SaveSystem.save();
    };
    document.getElementById('vol-density').addEventListener('input', e => {
        volAdv.density = parseFloat(e.target.value);
        document.getElementById('vol-density-val').textContent = volAdv.density.toFixed(4);
        _applyVolAdv();
    });
    document.getElementById('vol-radius').addEventListener('input', e => {
        volAdv.radius = parseFloat(e.target.value);
        document.getElementById('vol-radius-val').textContent = volAdv.radius;
        _applyVolAdv();
    });
    document.getElementById('vol-brightness').addEventListener('input', e => {
        volAdv.brightness = parseFloat(e.target.value);
        document.getElementById('vol-brightness-val').textContent = volAdv.brightness.toFixed(2);
        _applyVolAdv();
    });

    function applyGraphics() {
        gfx.res = parseFloat(document.getElementById('set-res').value) || 0.75;
        gfx.shadows = parseInt(document.getElementById('set-shadows').value);
        gfx.bloom = parseInt(document.getElementById('set-bloom').value);
        gfx.ssao = parseInt(document.getElementById('set-ssao').value);
        gfx.fxaa = parseInt(document.getElementById('set-fxaa').value);
        gfx.ssr = parseInt(document.getElementById('set-ssr').value);
        gfx.particles = parseInt(document.getElementById('set-particles').value);
        gfx.volumetrics = parseInt(document.getElementById('set-volumetrics').value);

        // FIX: Set pixelRatio BEFORE resizing any targets.
        // Previously pixelRatio changed after the composer was already sized, so
        // the renderer drew at a different physical size than its render targets.
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        renderer.setPixelRatio(dpr * gfx.res);
        renderer.setSize(window.innerWidth, window.innerHeight);

        // FIX: composer.setSize() uses getPixelRatio() internally and resizes
        // ALL registered passes (SSAO, SSR, TAA, bloom, volumetric) to the
        // same physical pixel dimensions. Calling ssrPass.setSize() separately
        // with different (CSS-only-scaled) dimensions was the primary cause of
        // the "Attachment has zero size" framebuffer errors.
        composer.setSize(window.innerWidth, window.innerHeight);

        // FIX: depthCaptureTarget was never resized in applyGraphics, only in
        // the resize handler, so it fell out of sync whenever gfx.res changed.
        const physW = Math.max(1, renderer.domElement.width);
        const physH = Math.max(1, renderer.domElement.height);
        depthCaptureTarget.setSize(physW, physH);

        const pomScale = gfx.pom === 1 ? 0.04 : 0.0;
        wallMaterial.userData.parallaxScale.value = pomScale;
        floorMaterial.userData.parallaxScale.value = pomScale;

        // TAA is resized automatically by composer.setSize() above.

        if (gfx.shadows === 0) {
            renderer.shadowMap.enabled = false;
            if (sunLight) sunLight.castShadow = false;
        } else {
            renderer.shadowMap.enabled = true;
            if (sunLight) {
                sunLight.castShadow = true;

                // Map UI value to Resolution and Filtering
                switch (gfx.shadows) {
                    case 1: // Low
                        sunLight.shadow.mapSize.set(512, 512);
                        renderer.shadowMap.type = THREE.BasicShadowMap;
                        sunLight.shadow.bias = -0.005;
                        break;
                    case 2: // Medium
                        sunLight.shadow.mapSize.set(1024, 1024);
                        renderer.shadowMap.type = THREE.PCFShadowMap;
                        sunLight.shadow.bias = -0.001;
                        break;
                    case 3: // High
                        sunLight.shadow.mapSize.set(2048, 2048);
                        renderer.shadowMap.type = THREE.PCFShadowMap;
                        sunLight.shadow.bias = -0.0005;
                        break;
                    case 4: // Ultra
                        sunLight.shadow.mapSize.set(4096, 4096);
                        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
                        sunLight.shadow.bias = -0.0001;
                        break;
                }

                // CRITICAL: Force Three.js to re-init the shadow map 
                // otherwise mapSize changes won't be visible.
                if (sunLight.shadow.map) {
                    sunLight.shadow.map.dispose();
                    sunLight.shadow.map = null;
                }
            }
        }

        // Update materials only when shadow map type changed — avoids a full scene.traverse on every resize/settings call
        if (_prevShadowType !== renderer.shadowMap.type) {
            _prevShadowType = renderer.shadowMap.type;
            scene.traverse((child) => {
                if (child.isMesh) child.material.needsUpdate = true;
            });
        }

        if(bloomPass) bloomPass.enabled = gfx.bloom === 1;
        if(ssaoPass) ssaoPass.enabled = gfx.ssao === 1;
        if(smaaPass) { smaaPass.enabled = gfx.fxaa === 1; }
        if(ssrPass) ssrPass.enabled = gfx.ssr === 1;

        if(volumetricPass) volumetricPass.enabled = (gfx.volumetrics === 2);

        // Show/hide advanced volumetrics section based on toggle
        const volAdvSection = document.getElementById('vol-adv-section');
        if (volAdvSection) volAdvSection.classList.toggle('visible', gfx.volumetrics === 2);

        // Push volAdv values into shader uniforms
        if (volumetricPass) {
            volumetricPass.material.uniforms.scattering.value    = volAdv.density;
            volumetricPass.material.uniforms.volRadiusSq.value   = volAdv.radius * volAdv.radius;
            volumetricPass.material.uniforms.volBrightness.value = volAdv.brightness;
        }

        if(dustMesh) {
            if(gfx.particles === 0) dustMesh.visible = false;
            else { dustMesh.visible = true; dustMat.opacity = gfx.particles === 1 ? 0.15 : 0.35; }
        }
        SaveSystem.save(); 
    }

    const btnSettings = document.getElementById('btn-show-settings'); const btnLevels = document.getElementById('btn-show-levels');
    const btnHideSettings = document.getElementById('btn-hide-settings'); const instDiv = document.getElementById('instructions');
    const settingsDiv = document.getElementById('settings-panel'); const btnResume = document.getElementById('btn-resume');

    btnResume.addEventListener('click', (e) => { e.stopPropagation(); controls.lock(); });

    function openSettings(e) {
        e.stopPropagation(); instDiv.style.display = 'none'; settingsDiv.style.display = 'flex';
        if(document.getElementById('main-menu').style.display !== 'none') { document.getElementById('blocker').style.display = 'flex'; document.getElementById('main-menu').style.display = 'none'; }
    }
    btnSettings.addEventListener('click', openSettings);
    btnHideSettings.addEventListener('click', (e) => {
        e.stopPropagation(); applyGraphics(); settingsDiv.style.display = 'none';
        if (fromMainMenu) {
            fromMainMenu = false;
            document.getElementById('blocker').style.display = 'none';
            document.getElementById('main-menu').style.display = 'flex';
            document.getElementById('main-menu').style.opacity = '1';
        } else if(!AudioSys.ctx) {
            document.getElementById('blocker').style.display = 'none'; document.getElementById('main-menu').style.display = 'flex';
        } else { instDiv.style.display = 'flex'; }
    });

    // --- RESET PROGRESS LOGIC ---
    const btnReset = document.getElementById('btn-reset-data');
    const confirmPopup = document.getElementById('confirm-popup');
    const btnConfirmReset = document.getElementById('btn-confirm-reset');
    const btnCancelReset = document.getElementById('btn-cancel-reset');

    // Show confirmation
    btnReset.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmPopup.style.display = 'flex';
    });

    // Hide confirmation
    btnCancelReset.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmPopup.style.display = 'none';
    });

    // Perform actual reset
    btnConfirmReset.addEventListener('click', (e) => {
        // 1. Clear LocalStorage
        localStorage.removeItem(SaveSystem.key);

        // 2. Clear application state (optional since we reload)
        currentLevel = 0;
        chaptersUnlocked = [true, false, false];
        activeChapter = 0;
        clearHubProgress();
        hubProgress = defaultHubProgress();

        // 3. Force page reload to return to the clean Main Menu state
        window.location.reload();
    });

    function populateLevelList() {
        clearCurrentLevel();
        const list = document.getElementById('level-select-list'); list.innerHTML = '';

        if (isViewingCustomLevels) {
            // Render Custom Levels
            document.getElementById('preview-title').innerText = "CUSTOM LEVEL";
            document.getElementById('ls-chapter-title-badge').textContent = '— CUSTOM LEVELS —';

            // Add "NEW LEVEL" Card
            const newCard = document.createElement('div');
            newCard.className = 'list-card';
            newCard.style.borderLeftColor = 'rgba(68,255,170,0.5)';
            newCard.innerHTML = `<div class="lc-info"><span class="lc-num">EDITOR</span><span class="lc-name" style="color:#44ffaa;">+ CREATE NEW LEVEL</span></div>`;
            newCard.addEventListener('click', () => { loadCustomLevelToEditor(-1); });
            list.appendChild(newCard);

            // Render the 99 slots
            for (let i = 0; i < 99; i++) {
                const data = customLevels[i];
                const card = document.createElement('div');
                card.className = 'list-card' + (currentLevel === `CUSTOM_${i}` ? ' current-selection' : '');
                const stateText = data ? "SAVED DATA" : "EMPTY";
                const color = data ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.2)";
                const dotHtml = data ? `<div class="lc-status-dot"></div>` : '';
                card.innerHTML = `<div class="lc-info"><span class="lc-num">SLOT ${i+1}</span><span class="lc-name" style="color:${color}">${stateText}</span></div>${dotHtml}`;

                if (data) {
                    card.addEventListener('mouseenter', () => {
                        document.querySelectorAll('.list-card').forEach(c => c.classList.remove('previewing'));
                        card.classList.add('previewing');
                        document.getElementById('preview-title').innerText = `SLOT ${i+1}`;
                        document.getElementById('ls-preview-meta').textContent = 'NOW PREVIEWING';
                        previewTargetLvl = `CUSTOM_${i}`;
                        clearTimeout(previewDebounce);
                        previewDebounce = setTimeout(() => { if (isPreviewMode && previewTargetLvl === `CUSTOM_${i}`) buildLevel(`CUSTOM_${i}`, true); }, 150);
                    });
                    card.addEventListener('click', () => { previewTargetLvl = `CUSTOM_${i}`; launchFromPreview(); });
                }
                list.appendChild(card);
            }
        } else {
            // Render Normal Campaign Levels
            const ch = CHAPTERS[activeChapter];

            // Update right panel theming for this chapter
            document.getElementById('ls-chapter-title-badge').textContent = ch.title || ch.name;
            document.getElementById('ls-chapter-title-badge').style.setProperty('--ch-chip-color', ch.chip);
            document.getElementById('ls-chapter-title-badge').style.setProperty('--ch-chip-border', ch.chipBorder);
            document.getElementById('ls-chapter-title-badge').style.setProperty('--ch-chip-shadow', ch.chipShadow || 'none');

            for (let i = 0; i < MAX_LEVELS; i++) {
                const card = document.createElement('div');
                const savedData = JSON.parse(localStorage.getItem('shatter_player_data') || '{}');
                const savedCh  = savedData.activeChapter || 0;
                const savedLvl = savedData.currentLevel  || 0;
 
                const isCompleted = (activeChapter < savedCh) || (activeChapter === savedCh && i < savedLvl);
                const isCurrent   = (activeChapter === savedCh && i === savedLvl);
 
                // Hub lock check
                const hubStatus = getLevelSelectStatus(activeChapter, i, hubRuntime.active ? hubRuntime : null);
                const isLocked  = hubStatus.locked;
                const gateColor = hubStatus.gateColor
                    ? '#' + new THREE.Color(hubStatus.gateColor).getHexString()
                    : '#888';
 
                card.className = 'list-card';
                if (isCompleted) card.classList.add('completed');
                if (isCurrent)   card.classList.add('current-selection');
                if (isLocked)    card.classList.add('hub-locked');
 
                const dotHtml = isCompleted
                    ? `<div class="lc-status-dot"></div>`
                    : isCurrent
                        ? `<div class="lc-current-dot"></div>`
                        : isLocked
                            ? `<span style="font-size:12px;opacity:0.4">🔒</span>`
                            : '';
 
                const gateChip = (!isLocked && hubStatus.gateName)
                    ? `<span style="font-size:9px;letter-spacing:2px;color:${gateColor};opacity:0.65;margin-top:2px;display:block">${hubStatus.gateName}</span>`
                    : '';
 
                card.innerHTML = `
                    <div class="lc-info">
                        <span class="lc-num">LEVEL ${i + 1}</span>
                        <span class="lc-name" style="${isLocked ? 'color:rgba(255,255,255,0.2)' : ''}">${getLevelName(i)}</span>
                        ${gateChip}
                    </div>${dotHtml}`;
 
                if (!isLocked) {
                    card.addEventListener('mouseenter', () => {
                        document.querySelectorAll('.list-card').forEach(c => c.classList.remove('previewing'));
                        card.classList.add('previewing');
                        document.getElementById('preview-title').innerText = getLevelName(i);
                        document.getElementById('ls-preview-meta').textContent =
                            isCompleted ? 'COMPLETED' : isCurrent ? 'CURRENT LEVEL' : 'NOW PREVIEWING';
                        previewTargetLvl = i;
                        clearTimeout(previewDebounce);
                        previewDebounce = setTimeout(() => {
                            if (isPreviewMode && previewTargetLvl === i) buildLevel(i, true);
                        }, 150);
                    });
                    card.addEventListener('click', () => { previewTargetLvl = i; launchFromPreview(); });
                } else {
                    card.style.cursor = 'not-allowed';
                    card.title = `Open ${hubStatus.gateName || 'the gate'} in THE NEXUS first`;
                }
 
                list.appendChild(card);
            }
        }
    }

    // ── DYNAMIC CHAPTER BUTTONS ──────────────────────────────────────────────
    function rebuildChapterButtons() {
        const row = document.getElementById('chapter-toggle-row');
        const unlockedCount = chaptersUnlocked.filter(Boolean).length;

        // Toggle visibility for features that require Chapter 2+
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

            // Set CSS variables for stunning dynamic hover/active states
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

    // ── DYNAMIC LEVEL LIST ───────────────────────────────────────────────────

    function launchFromPreview() {
        const wasFromMainMenu = fromMainMenu;
        fromMainMenu = false;
        document.getElementById('level-select-overlay').style.display = 'none'; currentLevel = previewTargetLvl; isPreviewMode = false;
        if (wasFromMainMenu) AudioSys.init();
        const fo = document.getElementById('fade-overlay'); fo.style.transition = 'opacity 0.3s ease-in-out'; fo.style.opacity = '1';
        setTimeout(() => {
            isTransitioning = false; buildLevel(currentLevel, false);
            fo.style.transition = 'opacity 0.4s ease-in-out'; fo.style.opacity = '0';
            setTimeout(() => { isTransitioning = false; }, 400);
        }, 350);
        setTimeout(() => controls.lock(), 500);
    }   

    document.getElementById('btn-custom-levels').addEventListener('click', () => {
        isViewingCustomLevels = !isViewingCustomLevels;
        const btn = document.getElementById('btn-custom-levels');

        if (isViewingCustomLevels) {
            btn.innerText = "CAMPAIGN";
            btn.classList.add('is-user');
        } else {
            btn.innerText = "USER LEVELS";
            btn.classList.remove('is-user');
        }

        document.getElementById('btn-edit-level').style.display = isViewingCustomLevels ? 'none' : 'inline-block';

        rebuildChapterButtons();
        populateLevelList();
    });

    btnLevels.addEventListener('click', (e) => {
        fromMainMenu = false;
        e.stopPropagation(); 
        document.getElementById('blocker').style.display = 'none';

        isViewingCustomLevels = false; // Reset to campaign when opened
        const customBtn = document.getElementById('btn-custom-levels');
        customBtn.innerText = "USER LEVELS";
        customBtn.classList.remove('is-user');

        // Safely exit editor mode and clear all ghost blocks / custom data
        if (isEditorMode || isPlayingCustom) {
            isEditorMode = false;
            isPlayingCustom = false;
            editorSceneGroup.visible = false;
            ghostMesh.visible = false;
            document.getElementById('editor-hud').style.display = 'none'; document.getElementById('editor-hotbar').style.display = 'none';

            world.removeBody(editorPhysicsFloor);
            world.removeBody(editorStaticBody);

            customSolidBlocks.clear();
            customEntities.clear();
            customDestruction.length = 0;
            updateEditorVisuals(); // Zeroes out the ghost block instanced meshes
        }

        rebuildChapterButtons();
        populateLevelList(); 
        document.getElementById('preview-title').innerText = getLevelName(currentLevel);
        isPreviewMode = true; 
        document.getElementById('level-select-overlay').style.display = 'flex'; 
        document.getElementById('level-select-overlay').style.opacity = '1';
        buildLevel(currentLevel, true);
    });

    document.getElementById('level-select-back').addEventListener('click', () => {
        document.getElementById('level-select-overlay').style.display = 'none'; isPreviewMode = false;
        if (fromMainMenu) {
            fromMainMenu = false;
            document.getElementById('main-menu').style.display = 'flex';
            document.getElementById('main-menu').style.opacity = '1';
        } else {
            buildLevel(currentLevel, false); document.getElementById('blocker').style.display = 'flex';
        }
    });

    document.getElementById('level-select-watch-cutscene').addEventListener('click', () => {
        document.getElementById('level-select-overlay').style.display = 'none'; 
        isPreviewMode = false;
        if (fromMainMenu) {
            fromMainMenu = false;
            document.getElementById('main-menu').style.display = 'flex';
            document.getElementById('main-menu').style.opacity = '1';
        }
        showEndingSequence();
    });

    function createSkyTexture(stops) {
        const S = 2048;
        const c = document.createElement('canvas');
        c.width = S; c.height = S;
        const ctx = c.getContext('2d');

        // ─── SEEDED RNG ───────────────────────────────────────────────
        const getNoise = (x, y, seed = 2024) => {
            // Standard hash-function to get a 0-1 float based on position
            const h = Math.imul(x, 1597334677) ^ Math.imul(y, 3812341205) ^ Math.imul(seed, 1351540027);
            return ((Math.imul(h ^ (h >>> 15), h | 1) >>> 0) / 4294967296);
        };

        // ─── SEEDED/RESETTABLE RNG ───────────────────────────────────────────
        let _s = 2024;
        const rng = () => {
            _s = Math.imul(1597334677, _s);
            _s = ((_s ^ (_s >>> 16)) * 1597334677) | 0;
            return (((_s ^ (_s >>> 16)) >>> 0) / 4294967296);
        };
        // Function to force the RNG to a specific starting point
        const setSeed = (val) => { _s = val | 0; };

        const lerp  = (a, b, t) => a + (b - a) * t;
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // ─── BASE GRADIENT ────────────────────────────────────────────
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

        // Anti-banding dither
        const ditherData = ctx.getImageData(0, 0, S, S);
        for (let y = 0; y < S; y++) {
            for (let x = 0; x < S; x++) {
                const i = (y * S + x) * 4;
                // Use (x % S) to ensure the noise at x=0 matches x=2048
                const n = (getNoise(x % S, y) - 0.5) * 5;
                ditherData.data[i]   = clamp(ditherData.data[i]   + n, 0, 255);
                ditherData.data[i+1] = clamp(ditherData.data[i+1] + n, 0, 255);
                ditherData.data[i+2] = clamp(ditherData.data[i+2] + n, 0, 255);
            }
        }
        ctx.putImageData(ditherData, 0, 0);

        // ─── CORE PRIMITIVES ──────────────────────────────────────────

        // Seamless horizontal wrap
        const wrapped = (fn, x, pad = 350) => {
            // Draw the main object
            fn(x);

            // Draw the wrap-around clones
            if (x + pad > S) {
                fn(x - S);
            }
            if (x - pad < 0) {
                fn(x + S);
            }
        };

        // Soft elliptical blob — blend mode is scoped via save/restore
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
            ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
        };

        // Wrapped version of blob
        const blobW = (x, y, rx, ry, angle, r, g, b, alpha, blend = 'screen') =>
            wrapped((wx) => blob(wx, y, rx, ry, angle, r, g, b, alpha, blend), x, rx + 80);

        // Scatter N blobs around a centre point with polar spread
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


        // ══════════════════════════════════════════════════════════════
        //  BRANCH A — DEEP SPACE  (chapter 3)
        // ══════════════════════════════════════════════════════════════
        if (activeChapter === 2) {

            // ── L0: Large-scale cosmic colour wash ────────────────────
            // Huge, ultra-faint tonal regions that stop the sky being flat black
            const cosmicWashes = [
                { x: 0.15, y: 0.28, r: 680, cr: 12, cg: 8,  cb: 45, a: 0.22 },
                { x: 0.72, y: 0.60, r: 750, cr: 38, cg: 10, cb: 32, a: 0.18 },
                { x: 0.45, y: 0.82, r: 600, cr: 8,  cg: 28, cb: 55, a: 0.20 },
                { x: 0.88, y: 0.20, r: 520, cr: 30, cg: 8,  cb: 50, a: 0.16 },
                { x: 0.30, y: 0.60, r: 640, cr: 5,  cg: 18, cb: 35, a: 0.14 },
            ];
            cosmicWashes.forEach(w => {
                blobW(w.x * S, w.y * S, w.r, w.r * 0.7, rng() * Math.PI, w.cr, w.cg, w.cb, w.a, 'screen');
            });

            // ── L1: Milky Way — 4 nested passes (wide→tight, faint→bright) ─
            // Each pass is a ribbon of overlapping elliptical blobs
            const mwCurve = (t) =>
                S * 0.47
                + Math.sin(t * Math.PI * 1.8 + 0.45) * S * 0.135
                + Math.cos(t * Math.PI * 3.3 + 1.10) * S * 0.038;

            const mwPasses = [
                // wide outer halo — very faint
                { n: 280, sxH: 650, syH: 310, rMin: 120, rMax: 450, aMin: 0.004, aMax: 0.010,
                  pal: [[190,210,255],[225,215,255],[255,228,205]] },
                // mid halo — slightly warmer
                { n: 360, sxH: 300, syH: 155, rMin:  60, rMax: 240, aMin: 0.009, aMax: 0.018,
                  pal: [[255,242,215],[255,224,188],[212,232,255],[255,215,228]] },
                // inner bright band
                { n: 280, sxH: 130, syH:  68, rMin:  30, rMax: 130, aMin: 0.013, aMax: 0.030,
                  pal: [[255,250,230],[255,238,210],[235,244,255]] },
            ];
            mwPasses.forEach(pass => {
                for (let i = 0; i < pass.n; i++) {
                    const t   = rng();
                    const cy  = mwCurve(t);
                    const dx  = (rng() - 0.5) * pass.sxH;
                    const dy  = (rng() - 0.5) * pass.syH;
                    const rx  = pass.rMin + rng() * (pass.rMax - pass.rMin);
                    const ry  = rx * (0.28 + rng() * 0.55);
                    const al  = pass.aMin + rng() * (pass.aMax - pass.aMin);
                    const [cr, cg, cb] = pass.pal[Math.floor(rng() * pass.pal.length)];
                    blobW(t * S + dx, cy + dy, rx, ry, rng() * Math.PI * 0.35, cr, cg, cb, al);
                }
            });

            // ── L2: Nebulae — completely reworked organic system ──────
            //
            // Each nebula is built from 4 layered passes:
            //   A) wide diffuse outer shell  (very low alpha)
            //   B) mid-body organic blobs    (medium alpha, varied shape)
            //   C) inner bright filaments    (thin elongated wisps)
            //   D) ionised core glow         (optional bright centre)
            //
            // Colour types map loosely to real emission lines:
            //   Ha=red, OIII=teal, refl=blue, SII=violet, remnant=gold

            const NEBULA_TYPES = [
                { body: [[252,55,68],[242,88,58],[255,115,78]],
                  outer:[[172,28,38],[195,55,38]],  glow:[255,95,75]   }, // Hα emission
                { body: [[38,205,185],[55,222,195],[72,195,175]],
                  outer:[[18,142,125],[28,162,135]], glow:[55,215,195]  }, // OIII teal
                { body: [[65,125,252],[85,152,252],[105,172,252]],
                  outer:[[35,75,195],[48,95,205]],  glow:[95,155,252]  }, // Reflection blue
                { body: [[195,55,248],[175,38,215],[215,75,248]],
                  outer:[[135,28,175],[155,38,195]], glow:[205,75,248]  }, // SII violet
                { body: [[252,155,38],[248,138,55],[235,168,48]],
                  outer:[[175,88,18],[195,108,28]],  glow:[252,165,55]  }, // Supernova remnant
            ];

            // Generate nebula seed list
            const nebulae = Array.from({ length: 11 }, () => ({
                cx:    rng() * S,
                cy:    rng() * S,
                r:     160 + rng() * 360,
                rot:   rng() * Math.PI * 2,
                type:  NEBULA_TYPES[Math.floor(rng() * NEBULA_TYPES.length)],
                hasCore: rng() > 0.38,
            }));

            nebulae.forEach(neb => {
                const { cx, cy, r, rot, type } = neb;

                // Pass A — wide diffuse outer shell
                for (let p = 0; p < 55; p++) {
                    const a   = rng() * Math.PI * 2;
                    const d   = Math.pow(rng(), 0.38) * r * 1.55;
                    const px  = cx + Math.cos(a + rot) * d;
                    const py  = cy + Math.sin(a + rot) * d * (0.38 + rng() * 0.38);
                    const bRx = 55 + rng() * r * 0.75;
                    const bRy = bRx * (0.22 + rng() * 0.62);
                    const [cr,cg,cb] = type.outer[Math.floor(rng() * type.outer.length)];
                    blobW(px, py, bRx, bRy, rng() * Math.PI, cr, cg, cb, 0.005 + rng() * 0.012);
                }

                // Pass B — mid organic body blobs
                for (let p = 0; p < 90; p++) {
                    const a   = rng() * Math.PI * 2;
                    const d   = Math.pow(rng(), 0.52) * r;
                    const px  = cx + Math.cos(a + rot) * d;
                    const py  = cy + Math.sin(a + rot) * d * (0.42 + rng() * 0.38);
                    const bRx = 22 + rng() * r * 0.42;
                    const bRy = bRx * (0.20 + rng() * 0.68);
                    const [cr,cg,cb] = type.body[Math.floor(rng() * type.body.length)];
                    blobW(px, py, bRx, bRy, rng() * Math.PI, cr, cg, cb, 0.008 + rng() * 0.018);
                }

                // Pass C — thin inner filaments / wisps
                for (let p = 0; p < 28; p++) {
                    const a   = rng() * Math.PI * 2;
                    const d   = Math.pow(rng(), 0.72) * r * 0.65;
                    const px  = cx + Math.cos(a + rot) * d;
                    const py  = cy + Math.sin(a + rot) * d * 0.45;
                    // Very elongated — gives the wispy filament look
                    const bRx = 8 + rng() * r * 0.22;
                    const bRy = bRx * (0.04 + rng() * 0.18);
                    const [cr,cg,cb] = type.body[0];
                    blobW(px, py, bRx, bRy, a + rot + (rng() - 0.5) * 0.6, cr, cg, cb, 0.016 + rng() * 0.028);
                }

                // Pass D — ionised glow at core
                if (neb.hasCore) {
                    const ox = cx + (rng() - 0.5) * r * 0.28;
                    const oy = cy + (rng() - 0.5) * r * 0.18;
                    const [cr,cg,cb] = type.glow;
                    blobW(ox, oy, r * 0.14, r * 0.07, rng() * Math.PI, cr, cg, cb, 0.022 + rng() * 0.024);
                    // Tiny hot star-like point at very centre
                    blobW(ox, oy, r * 0.028, r * 0.028, 0, 255, 255, 255, 0.55);
                }
            });

            // ── L4: Starfield — 3 depth tiers ─────────────────────────
            // Far (Tiny, neutral white/gray)
            for (let i = 0; i < 10000; i++) {
                const px = rng() * S, py = rng() * S;
                const r  = 0.1 + rng() * 0.52;
                const al = 0.05 + rng() * 0.26;
                // Most are pure white, 5% have a tiny cool tint
                const col = rng() > 0.95 ? '235,240,255' : '255,255,255';
                ctx.fillStyle = `rgba(${col},${al})`;
                ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
            }
            // Mid (90% white, rare subtle tints)
            for (let i = 0; i < 2200; i++) {
                const px = rng() * S, py = rng() * S;
                const r  = 0.42 + rng() * 1.08;
                const al = 0.14 + rng() * 0.48;
                const t  = rng();
                // Colors are now almost 255,255,255 with only ~5-10 point difference
                const col = t > 0.95 ? '255,245,235' : t > 0.90 ? '240,245,255' : '255,255,255';
                ctx.fillStyle = `rgba(${col},${al})`;
                ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
            }
            // Near (Bright, very desaturated halos)
            for (let i = 0; i < 320; i++) {
                const px = rng() * S, py = rng() * S;
                const r  = 0.85 + rng() * 2.6;
                const al = 0.52 + rng() * 0.48;
                const t  = rng();
                // Subtle warmth or coolness, mostly white
                const [sr, sg, sb] = t > 0.9 ? [255,250,245] : t > 0.8 ? [245,250,255] : [255,255,255];
                ctx.fillStyle = `rgba(${sr},${sg},${sb},${al})`;
                ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
                if (r > 1.9) {
                    const hg = ctx.createRadialGradient(px, py, 0, px, py, r * 4.8);
                    hg.addColorStop(0, `rgba(${sr},${sg},${sb},0.10)`);
                    hg.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.fillStyle = hg;
                    ctx.beginPath(); ctx.arc(px, py, r * 4.8, 0, Math.PI * 2); ctx.fill();
                }
            }

            // ── L5: Galaxies — logarithmic spirals, 3 types ───────────
            //
            // Spiral: logarithmic arm math, per-arm dust lanes, HII knots
            // Edge-on: disk gradient + separate dust lane stripe + bulge
            // Elliptical: Sérsic n≈4 de Vaucouleurs profile

            const drawGalaxy = (gx, gy, opts) => {
                const {
                    scale = 1,
                    rot = 0,
                    tilt = 0.4,
                    tR = 255, tG = 210, tB = 170,
                    type = 'spiral',
                    arms = 2
                } = opts;

                ctx.save();
                ctx.translate(gx, gy);
                ctx.rotate(rot);

                // Helper for galaxy components
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
                    // 1. Central Bulge (Older, yellower stars)
                    gBlob(0, 0, 15 * scale, 15 * scale * tilt, 255, 230, 200, 0.6);
                    gBlob(0, 0, 40 * scale, 40 * scale * tilt, tR, tG, tB, 0.15);

                    // 2. Logarithmic Spiral Arms
                    for (let arm = 0; arm < arms; arm++) {
                        const armOffset = (arm / arms) * Math.PI * 2;
                        const steps = 120;
                        for (let j = 0; j < steps; j++) {
                            const t = j / steps;
                            const theta = t * 7 + armOffset; // tightness of wrap
                            const r = Math.pow(t, 0.7) * 90 * scale;
                            const px = Math.cos(theta) * r;
                            const py = Math.sin(theta) * r * tilt;

                            // Base star mist
                            const size = (1 - t) * 25 * scale + 5;
                            gBlob(px, py, size, size, tR, tG, tB, 0.04 * (1 - t));

                            // HII Regions (Pink/Blue star-forming knots)
                            if (rng() > 0.92) {
                                const isPink = rng() > 0.4;
                                const kr = isPink ? 255 : 150;
                                const kg = isPink ? 150 : 200;
                                const kb = isPink ? 200 : 255;
                                gBlob(px + (rng() - 0.5) * 5, py + (rng() - 0.5) * 5, 
                                      4 * scale, 4 * scale, kr, kg, kb, 0.3);
                            }
                        }
                    }
                } 

                ctx.restore();
            };

            // Scatter 24 galaxies across sky
            const TINTS = [
                [252,212,168],[202,222,252],[252,188,128],[172,208,252],
                [252,218,142],[222,182,252],[192,252,225],[252,198,198],
                [255,245,215],[215,235,255],
            ];
            for (let i = 0; i < 24; i++) {
                const gx = rng() * S, gy = rng() * S;
                const [tR, tG, tB] = TINTS[Math.floor(rng() * TINTS.length)];
                const typeR = rng();
                const type  = typeR > 0.80 ? 'elliptical' : typeR > 0.64 ? 'edgeon' : 'spiral';

                const opts = {
                    scale: 0.28 + rng() * 2.65,
                    rot:   rng() * Math.PI * 2,
                    tilt:  0.22 + rng() * 0.58,
                    tR, tG, tB, type,
                    arms: type === 'spiral' ? (rng() > 0.42 ? 2 : 3) : 2,
                };

                // 1. Create a unique seed for THIS specific galaxy
                const galaxySeed = Math.floor(rng() * 1000000);

                wrapped((wx) => {
                    // 2. Reset RNG so the primary and the wrap-around draw use IDENTICAL numbers
                    setSeed(galaxySeed); 
                    drawGalaxy(wx, gy, opts);
                }, gx, 320);
            }

            // ── L9: Final large-scale colour modulation ────────────────
            // Multiply toning gives distant regions depth (prevents flat look)
            [
                { x: 0.18, y: 0.22, r: 480, col: 'rgba(8,0,52,0.28)'  },
                { x: 0.78, y: 0.62, r: 560, col: 'rgba(0,12,42,0.24)' },
                { x: 0.50, y: 0.50, r: 680, col: 'rgba(22,6,32,0.18)' },
                { x: 0.08, y: 0.82, r: 400, col: 'rgba(0,22,28,0.22)' },
            ].forEach(w => {
                wrapped((wx) => {
                    ctx.globalCompositeOperation = 'multiply';
                    const g = ctx.createRadialGradient(wx, w.y * S, 0, wx, w.y * S, w.r);
                    g.addColorStop(0, w.col); g.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(wx, w.y * S, w.r, 0, Math.PI * 2); ctx.fill();
                }, w.x * S, w.r);
            });
            ctx.globalCompositeOperation = 'screen';

        } else if (activeChapter === 1) {
            // ══════════════════════════════════════════════════════════════
            //  BRANCH B — STRATOSPHERE / TWILIGHT (chapter 2)
            // ══════════════════════════════════════════════════════════════

            // ── Vol.1: Twilight Sky Glow ─────────────────────────────
            // Gentle cyan/purple washes
            const twilightWashes = [
                { x: 0.2, y: 0.6, r: 600, cr: 40, cg: 90,  cb: 150, a: 0.15 },
                { x: 0.8, y: 0.65, r: 700, cr: 60, cg: 40, cb: 120, a: 0.12 },
                { x: 0.5, y: 0.7, r: 800, cr: 50, cg: 120, cb: 180, a: 0.18 },
            ];
            twilightWashes.forEach(w => {
                blobW(w.x * S, w.y * S, w.r, w.r * 0.4, 0, w.cr, w.cg, w.cb, w.a, 'screen');
            });

            // ── Vol.2: Starfield (Visible through thin atmosphere) ────
            // Dense starfield that completely fades out near the atmospheric horizon
            for (let i = 0; i < 4500; i++) {
                const px = rng() * S, py = rng() * S;
                const fade = Math.pow(Math.max(0, 1.0 - (py / S)), 1.5);
                const baseAl = 0.05 + rng() * 0.45;
                const al = baseAl * fade;
                if (al < 0.02) continue;

                const r = 0.2 + rng() * 0.9;
                const col = rng() > 0.85 ? '255,245,235' : '235,245,255';
                ctx.fillStyle = `rgba(${col},${al})`;
                ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();

                // Add slight halo to bigger stars
                if (r > 0.8 && rng() > 0.5) {
                    ctx.fillStyle = `rgba(${col},${al * 0.2})`;
                    ctx.beginPath(); ctx.arc(px, py, r * 3, 0, Math.PI * 2); ctx.fill();
                }
            }

            // ── Vol.3: Auroral Bands (Seamless Wraparound) ────────────
            ctx.globalCompositeOperation = 'screen';
            for (let p = 0; p < 3; p++) {
                // Integer frequencies guarantee seamless wrapping
                const freq1 = Math.floor(2 + rng() * 2); 
                const freq2 = Math.floor(3 + rng() * 3);
                const phase1 = rng() * Math.PI * 2;
                const phase2 = rng() * Math.PI * 2;

                // Layer 0: Greenish, Layer 1: Cyan/Blue, Layer 2: Violet/Pink
                const [cr, cg, cb] = p === 0 ? [55, 230, 160] : 
                                     p === 1 ? [40, 160, 240] : 
                                               [160, 60, 220];

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
                    const ry = 120 + rng() * 180; // tall pillars
                    const al = 0.015 + rng() * 0.02;

                    // Main tall glowing pillar
                    blobW(x, y, rx, ry, 0, cr, cg, cb, al, 'screen');

                    // Bright concentrated base to simulate the edge of the auroral curtain
                    if (rng() > 0.3) {
                        blobW(x, y + ry * 0.4, rx * 0.8, ry * 0.15, 0, cr, cg, cb, al * 1.5, 'screen');
                    }
                }
            }

            // ── Vol.4: Noctilucent Clouds (High altitude) ─────────────
            // Thin, electric-blue wisps scattered horizontally
            const nlcY = S * 0.68;
            for (let i = 0; i < 220; i++) {
                const cx = rng() * S;
                const cy = nlcY + (rng() - 0.5) * S * 0.18;
                const rx = 60 + rng() * 300;
                const ry = rx * (0.008 + rng() * 0.022); // extremely stretched horizontally
                const ang = (rng() - 0.5) * 0.08;
                const al = 0.012 + rng() * 0.025;
                // Mix of ice-blue and pearl-white
                const [cr,cg,cb] = rng() > 0.4 ? [180, 225, 255] : [220, 235, 255];
                blobW(cx, cy, rx, ry, ang, cr, cg, cb, al, 'screen');
            }

            // ── Vol.5: Horizon Atmospheric Haze ───────────────────────
            // Crisper, cooler atmospheric transition into twilight
            const hGrad = ctx.createLinearGradient(0, S * 0.55, 0, S);
            hGrad.addColorStop(0, 'rgba(120,180,255,0)');
            hGrad.addColorStop(0.3, 'rgba(80,150,220,0.06)');
            hGrad.addColorStop(0.7, 'rgba(40,100,180,0.15)');
            hGrad.addColorStop(1, 'rgba(15,45,95,0.25)');
            ctx.fillStyle = hGrad;
            ctx.fillRect(0, S * 0.55, S, S * 0.45);

        } else {
            // ══════════════════════════════════════════════════════════
            //  BRANCH C — ATMOSPHERIC SKY  (chapter 1)
            //  Reworked with 6 volumetric depth layers
            // ══════════════════════════════════════════════════════════

            // ── Vol.1: Upper-atmosphere scattering tints ───────────────
            // Very faint coloured patches — simulates Rayleigh/Mie scatter
            for (let i = 0; i < 7; i++) {
                const hy = rng() * S * 0.38;
                const hx = rng() * S;
                const hr = 280 + rng() * 580;
                const al = 0.018 + rng() * 0.032;
                const t  = rng();
                const [cr,cg,cb] = t > 0.58 ? [175,198,238] : t > 0.28 ? [218,198,238] : [238,218,208];
                blobW(hx, hy, hr, hr * 0.15, 0, cr, cg, cb, al, 'screen');
            }

            // ── Vol.2: Stars — upper portion only, fade toward horizon ─
            for (let i = 0; i < 445; i++) {
                const px   = rng() * S;
                const py   = rng() * S * 0.50;
                const fade = Math.pow(1.0 - py / (S * 0.50), 2.8);
                const al   = fade * (0.06 + rng() * 0.52);
                if (al < 0.045) continue;
                const r = 0.28 + rng() * 1.05;
                ctx.globalCompositeOperation = 'screen';
                ctx.fillStyle = `rgba(222,235,255,${al})`;
                ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
            }

            // ── Vol.3: High-altitude cirrus — very thin, wispy, distant ─
            // Gives a "far away" feeling above the cumulus layer
            const cirrusY = S * (0.28 + rng() * 0.10);
            for (let i = 0; i < 145; i++) {
                const cx  = rng() * S;
                const cy  = cirrusY + (rng() - 0.5) * S * 0.11;
                const rx  = 55 + rng() * 295;
                const ry  = rx * (0.025 + rng() * 0.095); // ultra-thin streaks
                const ang = (rng() - 0.5) * 0.38;
                const al  = 0.014 + rng() * 0.026;
                const t   = rng();
                const [cr,cg,cb] = t > 0.5 ? [212,202,228] : [228,218,238];
                blobW(cx, cy, rx, ry, ang, cr, cg, cb, al, 'screen');
            }

            // ── Vol.4: Mid-altitude altocumulus ────────────────────────
            // Smaller, more regular puffs — clearly above the main clouds
            const altoY = S * (0.37 + rng() * 0.06);
            for (let i = 0; i < 20; i++) {
                const clx = rng() * S;
                const cly = altoY + (rng() - 0.5) * S * 0.06;
                const clR = 48 + rng() * 92;
                for (let p = 0; p < 18; p++) {
                    const ang  = rng() * Math.PI * 2;
                    const dist = Math.pow(rng(), 0.58) * clR;
                    const px   = clx + Math.cos(ang) * dist;
                    const py   = cly + Math.sin(ang) * dist * 0.22;
                    const rx   = 20 + rng() * 48;
                    const ry   = rx * (0.32 + rng() * 0.32);
                    const al   = 0.022 + rng() * 0.032;
                    const [cr,cg,cb] = rng() > 0.5 ? [198,182,208] : [208,192,218];
                    blobW(px, py, rx, ry, rng() * Math.PI, cr, cg, cb, al, 'screen');
                }
            }

            // ── Vol.5: Main cumulus layer — 3-pass (shadow/body/lit top) ─
            // The primary depth driver: shadow base → mid body → sunlit crown
            const clusters = [];
            for (let i = 0; i < 30; i++) {
                clusters.push({
                    x:     rng() * S,
                    y:     (0.40 + rng() * 0.30) * S,
                    r:     138 + rng() * 215,
                    depth: rng(), // 0=far/small, 1=near/large
                });
            }
            // Paint far clusters first so near ones overdraw them
            clusters.sort((a, b) => a.depth - b.depth);

            clusters.forEach(cl => {
                const ds  = 0.48 + cl.depth * 0.52;
                const cnt = Math.floor(55 * ds) + 18;
                const by  = cl.y;

                // Shadow / dark volumetric base — gives impression of thickness
                cloudPuff(cl.x, by + 18, cl.r, 0.38,
                    52, 46, 68, 0.020, 0.032, 55 * ds, 52 * ds, [0.32, 0.42],
                    Math.floor(cnt * 0.42), 'source-over');

                // Mid-tone body (warm grey-lavender)
                cloudPuff(cl.x, by, cl.r, 0.30,
                    188 + rng() * 18, 150 + rng() * 18, 148 + rng() * 18,
                    0.026, 0.036, 58 * ds, 52 * ds, [0.35, 0.44],
                    cnt, 'source-over');

                // Sunlit crown — screen blend, warm peach-cream
                cloudPuff(cl.x, by - 28, cl.r * 0.78, 0.20,
                    255, 215, 182, 0.034, 0.048, 44 * ds, 38 * ds, [0.28, 0.38],
                    Math.floor(cnt * 0.48), 'screen');
            });

            // ── Vol.6: Atmospheric sun haze + horizon colour wash ──────
            const sunX = S * 0.72, sunY = S * 0.64;
            ctx.globalCompositeOperation = 'screen';

            // Multi-radius sun corona
            [[S * 0.58, 0.09], [S * 0.32, 0.08], [S * 0.17, 0.07], [S * 0.08, 0.055]].forEach(([radius, alpha]) => {
                wrapped((wx) => {
                    const g = ctx.createRadialGradient(wx, sunY, 0, wx, sunY, radius);
                    g.addColorStop(0,    `rgba(255,215,178,${alpha})`);
                    g.addColorStop(0.28, `rgba(255,198,158,${alpha * 0.52})`);
                    g.addColorStop(0.68, `rgba(238,178,138,${alpha * 0.18})`);
                    g.addColorStop(1,    'rgba(0,0,0,0)');
                    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(wx, sunY, radius, 0, Math.PI * 2); ctx.fill();
                }, sunX);
            });

            // Full-width warm horizon band
            const horizGrad = ctx.createLinearGradient(0, S * 0.52, 0, S);
            horizGrad.addColorStop(0,    'rgba(255,200,158,0)');
            horizGrad.addColorStop(0.28, 'rgba(255,185,138,0.050)');
            horizGrad.addColorStop(0.72, 'rgba(238,168,128,0.030)');
            horizGrad.addColorStop(1,    'rgba(0,0,0,0)');
            ctx.fillStyle = horizGrad;
            ctx.fillRect(0, S * 0.52, S, S * 0.48);
        }

        // ─── UNIVERSAL: SEAMLESS FILM GRAIN ───
        ctx.globalCompositeOperation = 'overlay';
        for (let i = 0; i < 7500; i++) {
            // We want the Grain to be "fixed" to the coordinates
            const nx = Math.floor(rng() * S); 
            const ny = Math.floor(rng() * S);
            const ns = 0.38 + rng() * 1.25;

            // Ensure that if it's near the right edge, we draw it on the left too
            const drawGrain = (tx) => {
                ctx.fillStyle = `rgba(255,255,255,${0.025 + rng() * 0.038})`;
                ctx.fillRect(tx, ny, ns, ns);
            };

            drawGrain(nx);
            if (nx + ns > S) drawGrain(nx - S); // Simple wrap for grain
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(0,0,0,0.055)';
        for (let i = 0; i < 3000; i++) { ctx.fillRect(rng() * S, rng() * S, 1, 1); }
        ctx.globalCompositeOperation = 'source-over';

        // ─── TEXTURE ──────────────────────────────────────────────────
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace    = THREE.SRGBColorSpace;
        tex.wrapS         = THREE.RepeatWrapping;
        tex.wrapT         = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = true;
        tex.minFilter     = THREE.LinearMipmapLinearFilter;
        tex.magFilter     = THREE.LinearFilter;
        tex.anisotropy    = 4;
        return tex;
    }

    const skyCache = new Map();

    function createWaterNormalTexture({ size = 512, strength = 6 } = {}) { // Increased default strength
        const TWO_PI = Math.PI * 2;
        const waves = [
            { fx: 3,  fy: 2,  w: 0.45, phase: 0.00 },
            { fx: 2,  fy: -4, w: 0.30, phase: 1.10 },
            { fx: 7,  fy: 5,  w: 0.14, phase: 0.60 },
            { fx: -6, fy: 8,  w: 0.10, phase: 2.20 },
            { fx: 5,  fy: -3, w: 0.08, phase: 1.80 },
            { fx: 13, fy: 11, w: 0.04, phase: 0.40 },
            { fx: -9, fy: 14, w: 0.03, phase: 3.00 },
            { fx: 11, fy: -7, w: 0.02, phase: 1.50 },
        ];

        function heightAt(u, v) {
            let h = 0;
            for (const { fx, fy, w, phase } of waves) {
                h += Math.sin(u * TWO_PI * fx + v * TWO_PI * fy + phase) * w;
            }
            return h;
        }

        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(size, size);
        const px = imageData.data;
        const inv = 1 / size;

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
                px[i    ] = (rnx * 0.5 + 0.5) * 255 | 0;   
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

    const skyGeo = new THREE.SphereGeometry(450, 32, 32); // Increased size slightly
    const skyMesh = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ 
        map: createSkyTexture(CHAPTERS[0].env.skyStops), 
        side: THREE.BackSide, 
        fog: false,
        toneMapped: false // Prevents the HDR exposure from blowing the painted colors to pure white
    }));
    scene.add(skyMesh); // CRITICAL: Actually add the sky to the scene

    // --- RENDER PASSES & EFFECT COMPOSER ---
    const renderTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { 
        type: THREE.HalfFloatType, samples: 0
    }); 

    const depthCaptureTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight);
    depthCaptureTarget.depthTexture = new THREE.DepthTexture(window.innerWidth, window.innerHeight);
    depthCaptureTarget.depthTexture.type = THREE.UnsignedIntType;
    const depthTexture = depthCaptureTarget.depthTexture;

    const composer = new EffectComposer(renderer, renderTarget);
    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
    ssaoPass.kernelRadius = 1.2; ssaoPass.minDistance = 0.001; ssaoPass.maxDistance = 0.025;

    // Three.js SSAOPass uses texture2D(sampler, uv, -100.0) to force mip 0 via a
    // large negative bias. On Windows, ANGLE (WebGL→D3D) clamps bias to [-16, 15.99]
    // and emits warning X4713 for every such call (typically 7 per frame).
    // Replacing with textureLod(sampler, uv, 0.0) is semantically identical — both
    // sample mip level 0 — but avoids the HLSL compiler warning entirely.
    (function patchSSAOBias(pass) {
        const fix = (mat) => {
            if (!mat || !mat.fragmentShader) return;
            mat.fragmentShader = mat.fragmentShader.replace(
                /texture2D\s*\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*-\s*100\.0\s*\)/g,
                'textureLod($1, $2, 0.0)'
            );
            mat.needsUpdate = true;
        };
        // SSAOPass exposes these material references directly in Three.js r160
        ['ssaoMaterial', 'normalMaterial', 'blurMaterial', 'depthRenderMaterial'].forEach(k => fix(pass[k]));
    })(ssaoPass);

    // Decals live on layer 1. During SSAO's normal/depth pass we temporarily
    // restrict the camera to layer 0 only, so decals cast no AO shadow.
    (function patchSSAOLayers(pass) {
        const _origRender = pass.render.bind(pass);
        pass.render = function(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
            const savedMask = this.camera.layers.mask;
            this.camera.layers.set(0); // see only layer 0 — decals (layer 1) invisible
            _origRender(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
            this.camera.layers.mask = savedMask; // restore so normal rendering still sees decals
        };
    })(ssaoPass);

    composer.addPass(ssaoPass);

    const ssrPass = new OptimizedSSRPass(scene, camera, window.innerWidth, window.innerHeight);

    // You can tweak performance parameters easily:
    ssrPass.maxSteps = 64;         // Raymarch loop count (Performance vs Quality)
    ssrPass.thickness = 0.5;       // How thick geometry is assumed to be to prevent rays shooting through
    ssrPass.maxDistance = 90.0;    // How far reflections go
    ssrPass.opacity = 1.0;         // Visibility of reflection
    ssrPass.setSize(window.innerWidth, window.innerHeight);

    composer.addPass(ssrPass);

    const VolumetricShader = {
        uniforms: {
            tDiffuse:                      { value: null },
            tDepth:                        { value: null },
            cameraProjectionMatrixInverse: { value: new THREE.Matrix4() },
            cameraMatrixWorld:             { value: new THREE.Matrix4() },

            pointLightsPos:                { value: pointPosUniformArray },
            pointLightsColor:              { value: pointColUniformArray },
            pointLightCount:               { value: 0 },
            scattering:                    { value: 0.003 },
            maxDistance:                   { value: 90.0 },
            volRadiusSq:                   { value: 625.0 },
            volBrightness:                 { value: 0.35  },
            time:                          { value: 0.0 }
        },
        vertexShader: `
            out vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            precision highp float;
            precision highp sampler2D;

            uniform sampler2D tDiffuse;
            uniform sampler2D tDepth;
            uniform mat4 cameraProjectionMatrixInverse;
            uniform mat4 cameraMatrixWorld;

            #define MAX_POINT_LIGHTS 16
            uniform vec3 pointLightsPos[MAX_POINT_LIGHTS];
            uniform vec3 pointLightsColor[MAX_POINT_LIGHTS];
            uniform int pointLightCount;

            uniform float scattering;
            uniform float maxDistance;
            uniform float volRadiusSq;
            uniform float volBrightness;
            uniform float time;
            in vec2 vUv;
            layout(location = 0) out vec4 fragColor;

            const int STEPS = 8;

            vec3 WorldPosFromDepth(vec2 uv, float depth) {
                vec4 ndc  = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
                vec4 view = cameraProjectionMatrixInverse * ndc;
                view /= view.w;
                return (cameraMatrixWorld * view).xyz;
            }

            float IGN(vec2 pixel, float frame) {
                pixel += frame * vec2(47.0, 17.0);
                return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
            }

            vec3 colorGrade(vec3 col) {
                col = col + vec3(0.004, 0.002, 0.003) * (1.0 - col);
                col = pow(max(col, 0.0), 1.0 / vec3(0.97, 0.98, 1.02));
                col = col * vec3(1.04, 1.01, 0.98);
                return col;
            }

            void main() {
                float depth = texture(tDepth, vUv).r;

                // ── 1. SKY EARLY-OUT ─────────────────────────────────────────────
                // Sky pixels skip all ray marching, blur, and shadow work entirely.
                if (depth >= 0.9999) {
                    fragColor = vec4(colorGrade(texture(tDiffuse, vUv).rgb), 1.0);
                    return;
                }

                vec3 cameraPos = cameraMatrixWorld[3].xyz;
                vec3 worldPos  = WorldPosFromDepth(vUv, depth);
                vec3 rayDir    = worldPos - cameraPos;
                float rayLen   = length(rayDir);
                rayDir        /= rayLen;

                // ── 2. ADAPTIVE BLUR ────────────────────────────────────────────
                // Near geometry: 1 sample + chroma shift (saves 7 texture fetches).
                // Far geometry: full 8-tap blur.
                vec2 center = vUv - 0.5;
                float aberrationStrength = 0.0008 + length(center) * 0.003;
                vec2 aberrOffset = center * aberrationStrength;

                float blurFactor = smoothstep(18.0, 65.0, rayLen) * 2.2;
                vec4 baseColor;

                if (blurFactor < 0.01) {
                    // Fast path: near geometry — single sample per channel
                    baseColor   = texture(tDiffuse, vUv);
                    baseColor.r = texture(tDiffuse, vUv + aberrOffset).r;
                    baseColor.b = texture(tDiffuse, vUv - aberrOffset).b;
                } else {
                    // Full path: 8-tap box blur + chromatic aberration
                    vec2 texel = 1.0 / vec2(textureSize(tDiffuse, 0));
                    vec2 o0 = vec2( texel.x,  texel.y) * blurFactor;
                    vec2 o1 = vec2(-texel.x,  texel.y) * blurFactor;
                    vec2 o2 = vec2( texel.x, -texel.y) * blurFactor;
                    vec2 o3 = vec2(-texel.x, -texel.y) * blurFactor;

                    vec4 rp = (texture(tDiffuse, vUv + aberrOffset + o0) +
                            texture(tDiffuse, vUv + aberrOffset + o1) +
                            texture(tDiffuse, vUv + aberrOffset + o2) +
                            texture(tDiffuse, vUv + aberrOffset + o3)) * 0.25;

                    vec4 rn = (texture(tDiffuse, vUv - aberrOffset + o0) +
                            texture(tDiffuse, vUv - aberrOffset + o1) +
                            texture(tDiffuse, vUv - aberrOffset + o2) +
                            texture(tDiffuse, vUv - aberrOffset + o3)) * 0.25;

                    baseColor   = rp;
                    baseColor.g = (rp.g + rn.g) * 0.5;
                    baseColor.b = rn.b;
                }

                // ── 3. VOLUMETRIC SETUP ──────────────────────────────────────────
                float marchDist = min(rayLen, maxDistance);
                float stepSize  = marchDist / float(STEPS);
                float stepWeight = scattering * stepSize;

                float dither     = IGN(gl_FragCoord.xy, floor(mod(time * 60.0, 128.0)));
                vec3  currentPos = cameraPos + rayDir * (stepSize * dither);

                int  nLights = min(pointLightCount, MAX_POINT_LIGHTS);
                vec3 totalVolumetric = vec3(0.0);

                for (int i = 0; i < STEPS; i++) {
                    // ── 5. POINT LIGHTS — skip loop entirely when none exist ────
                    if (nLights > 0) {
                        for (int j = 0; j < nLights; j++) {
                            vec3  toLight = pointLightsPos[j] - currentPos;
                            float distSq  = dot(toLight, toLight);
                            if (distSq < volRadiusSq) {
                                float atten = smoothstep(volRadiusSq, 0.0, distSq)
                                            / (0.5 + distSq * 0.05);
                                totalVolumetric += pointLightsColor[j] * (atten * volBrightness * stepWeight);
                            }
                        }
                    }

                    currentPos += rayDir * stepSize;
                }

                // ── COMPOSITE ────────────────────────────────────────────────────
                vec3 litColor = baseColor.rgb + totalVolumetric;

                litColor = colorGrade(litColor);

                float vignette = 1.0 - smoothstep(0.45, 1.15, length(center) * 1.35);
                litColor *= (0.88 + 0.12 * vignette);

                fragColor = vec4(litColor, baseColor.a);
            }
        `
    };

    const volumetricPass = new ShaderPass(VolumetricShader);
    volumetricPass.material.glslVersion = THREE.GLSL3;
    volumetricPass.material.uniforms.tDepth.value = depthTexture;
    composer.addPass(volumetricPass);

    const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 
        0.22,  // Strength: Lowered (from 0.32) to make the glow more subtle
        1.15,  // Radius: Increased (from 0.65) to make the glow spread out and "soften"
        0.94   // Threshold: Slightly higher (from 0.82) so only the brightest highlights bleed
    );
    composer.addPass(bloomPass);
    const smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
    composer.addPass(smaaPass);
    composer.addPass(new OutputPass());

    // PHYSICS: Infinite Flat Floor so the player can walk around while editing
    const editorPhysicsFloor = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Plane(),
        material: defaultMat,
        collisionFilterGroup: CG_STATIC,
        collisionFilterMask: CG_PLAYER | CG_DYNAMIC
    });
    editorPhysicsFloor.quaternion.setFromEuler(-Math.PI / 2, 0, 0); // Face UP
    editorPhysicsFloor.position.set(0, -0.5, 0);

    // PHYSICS: Ghost block collision for the Editor
    const editorStaticBody = new CANNON.Body({
        mass: 0,
        material: defaultMat,
        collisionFilterGroup: CG_STATIC,
        collisionFilterMask: CG_PLAYER | CG_DYNAMIC
    });
    editorStaticBody.quaternion.set(globalTiltThree.x, globalTiltThree.y, globalTiltThree.z, globalTiltThree.w);

    // --- DYNAMIC LIGHTING SETUP ---
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.0);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    sunLight.position.set(20, 18, -40);
    sunLight.castShadow = true;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 150;
    const shadowDist = 60;
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

    function createWindZone(pos, size, direction, strength = 15) {
        // direction should be a normalized THREE.Vector3
        const zone = {
            pos: pos.clone().applyQuaternion(globalTiltThree),
            size: size, // THREE.Vector3 representing half-extents
            dir: direction.clone().applyQuaternion(globalTiltThree),
            strength: strength,
            // Visuals
            particles: null
        };

        // Create particles for the wind
        const pCount = Math.floor(size.x * size.y * size.z * 2);
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array(pCount * 3);
        const life = new Float32Array(pCount);

        for(let i=0; i<pCount; i++) {
            positions[i*3] = (Math.random() - 0.5) * size.x * 2;
            positions[i*3+1] = (Math.random() - 0.5) * size.y * 2;
            positions[i*3+2] = (Math.random() - 0.5) * size.z * 2;
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
        // Orient particles to face wind direction
        zone.particles.lookAt(zone.pos.clone().add(zone.dir));

        scene.add(zone.particles);
        windZones.push(zone);
    }

    playerBody.addEventListener("collide", (e) => {
        if (grabbedBlock && grabbedBlock.body === e.body) return;
        for(let i=0; i<interactiveBlocks.length; i++) {
            if (interactiveBlocks[i].body === e.body && interactiveBlocks[i].type === 'blue') {
                const contact = e.contact;
                const normalY = contact ? ((contact.bi === playerBody) ? -contact.ni.y : contact.ni.y) : 0;
                if (normalY > 0.5) {
                    pendingBounce = true; 
                    pendingBounceBlock = interactiveBlocks[i]; 

                    // NEW: Capture the raw force of the impact!
                    pendingBounceVelocity = contact ? Math.abs(contact.getImpactVelocityAlongNormal()) : 0;

                    AudioSys.triggerBlueBounce();
                }
                break;
            }
        }
    });

    function createHologram(text, pos) {
        const W = 1024, H = 256;
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(0,10,30,0.78)'; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2);
        ctx.strokeStyle = 'rgba(0,200,255,0.08)'; ctx.lineWidth = 1;
        for (let y = 20; y < H; y += 32) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

        const borderGrad = ctx.createLinearGradient(0,0,W,0);
        borderGrad.addColorStop(0,'rgba(0,255,255,0.0)');
        borderGrad.addColorStop(0.1,'rgba(0,255,255,0.7)');
        borderGrad.addColorStop(0.9,'rgba(0,255,255,0.7)');
        borderGrad.addColorStop(1,'rgba(0,255,255,0.0)');
        ctx.strokeStyle = borderGrad; ctx.lineWidth = 2;
        ctx.strokeRect(8, 8, W-16, H-16);

        const cornerLen = 28, cOff = 8;
        ctx.strokeStyle = 'rgba(0,255,255,0.9)'; ctx.lineWidth = 3;
        [[cOff,cOff,1,1],[W-cOff,cOff,-1,1],[cOff,H-cOff,1,-1],[W-cOff,H-cOff,-1,-1]].forEach(([x,y,dx,dy]) => {
            ctx.beginPath(); ctx.moveTo(x+dx*cornerLen,y); ctx.lineTo(x,y); ctx.lineTo(x,y+dy*cornerLen); ctx.stroke();
        });

        ctx.font = 'bold 22px "Courier New", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

        const lines = text.split('\n');
        const lineHeight = 32;
        const startY = H/2 - ((lines.length - 1) * lineHeight) / 2;

        ctx.shadowColor = '#00ffff'; ctx.shadowBlur = 40; ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#00ffff'; 
        lines.forEach((line, i) => ctx.fillText(line, W/2, startY + i * lineHeight + 2));

        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
        ctx.fillStyle = '#ccffff'; 
        lines.forEach((line, i) => ctx.fillText(line, W/2, startY + i * lineHeight));

        let maxTw = 0;
        lines.forEach(line => { maxTw = Math.max(maxTw, ctx.measureText(line).width); });
        const tw = maxTw;

        ctx.strokeStyle = 'rgba(0,255,255,0.4)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(W/2-tw/2-20, H/2-45); ctx.lineTo(W/2+tw/2+20, H/2-45); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(W/2-tw/2-20, H/2+45); ctx.lineTo(W/2+tw/2+20, H/2+45); ctx.stroke();

        const tex = new THREE.CanvasTexture(canvas); tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;

        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
        const sprite = new THREE.Sprite(mat); sprite.scale.set(7.0, 1.75, 1);
        const basePos = pos.clone().applyQuaternion(globalTiltThree);
        sprite.position.copy(basePos); sprite.position.y -= 2.0; scene.add(sprite);

        const light = new THREE.PointLight(0x00ccff, 0.0, 4);
        light.position.copy(basePos); light.position.y -= 1.5; scene.add(light);

        const baseGeo = new THREE.PlaneGeometry(7.0, 0.06);
        const baseMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending });
        const baseMesh = new THREE.Mesh(baseGeo, baseMat);

        return { sprite, basePos, light, baseMesh, baseMat };
    }

    // --- BRONZE GEAR & RACK MATERIALS ---
    const bronzeMat = new THREE.MeshStandardMaterial({ 
        color: 0xc27a3e, metalness: 1.0, roughness: 0.35
    });
    const darkSteelMat = new THREE.MeshStandardMaterial({ 
        color: 0x2a2a2a, metalness: 0.9, roughness: 0.6 
    });

    // --- PROCEDURAL GEAR GENERATOR ---
    const RACK_PITCH = 0.2042; // Distance between teeth on the pillar
    const PITCH_MODIFIER = 0.0325; // Ratio for radius per tooth

    function buildGearGeo(teethCount) {
        const pitchR = teethCount * PITCH_MODIFIER;
        const outerR = pitchR + 0.06;
        const innerR = pitchR - 0.06;
        const shape = new THREE.Shape();
        const totalPoints = teethCount * 2;
        const aOffset = (Math.PI * 2) / (teethCount * 8); // Flattens the top of the teeth

        for (let i = 0; i < totalPoints; i++) {
            const r = (i % 2 === 0) ? outerR : innerR;
            const a = (i / totalPoints) * Math.PI * 2;
            if (i === 0) {
                shape.moveTo(Math.cos(a - aOffset)*r, Math.sin(a - aOffset)*r);
                shape.lineTo(Math.cos(a + aOffset)*r, Math.sin(a + aOffset)*r);
            } else {
                shape.lineTo(Math.cos(a - aOffset)*r, Math.sin(a - aOffset)*r);
                shape.lineTo(Math.cos(a + aOffset)*r, Math.sin(a + aOffset)*r);
            }
        }
        shape.closePath();

        // Axle hole
        const axleHole = new THREE.Path();
        axleHole.absarc(0, 0, Math.max(0.1, pitchR * 0.25), 0, Math.PI * 2, true);
        shape.holes.push(axleHole);

        const geo = new THREE.ExtrudeGeometry(shape, { 
            depth: 0.15, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.02, curveSegments: 1 
        });
        geo.center(); // Center natively in the XY plane (spins around Z natively)
        return { geo, pitchR };
    }

    // Pre-build 4 distinct sizes for our asymmetrical design
    const gearXS = buildGearGeo(8);  // R = 0.260
    const gearS  = buildGearGeo(10); // R = 0.325
    const gearM  = buildGearGeo(14); // R = 0.455
    const gearL  = buildGearGeo(18); // R = 0.585

    function createPressurePlate(data) {
        const group = new THREE.Group();
        const pos = new THREE.Vector3(data.x, data.y, data.z).applyQuaternion(globalTiltThree);
        group.position.copy(pos);
        group.quaternion.copy(globalTiltThree);

        const baseGroup = new THREE.Group();
        group.add(baseGroup);

        const centralCollar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 1.4), darkSteelMat);
        centralCollar.position.y = 0.3;
        baseGroup.add(centralCollar);

        // ==========================================
        // 2. THE 4 GEARS (Different sizes, perfectly aligned)
        // ==========================================
        const gears = [];
        const axleGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.6, 8);
        axleGeo.rotateX(Math.PI/2); // Align for Z-axis natively

        // Pillar half-width is 0.5. Distance = 0.5 + pitchR.
        // Dir +1 or -1 fixes the rotation direction relative to the sinking rack
        const gearConfigs = [
            { type: gearS,  axis: 'z', offset: [0.5 + gearS.pitchR, 0],   ry: 0,         dir: 1 },  // Right (+X)
            { type: gearL,  axis: 'z', offset: [-0.5 - gearL.pitchR, 0],  ry: 0,         dir: -1 }, // Left (-X)
            { type: gearM,  axis: 'x', offset: [0, 0.5 + gearM.pitchR],   ry: Math.PI/2, dir: 1 },  // Front (+Z)
            { type: gearXS, axis: 'x', offset: [0, -0.5 - gearXS.pitchR], ry: Math.PI/2, dir: -1 }  // Back (-Z)
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

            // Calculate tooth alignment offset (half a tooth pitch)
            const toothOffset = (Math.PI * 2) / (cfg.type.geo.parameters ? cfg.type.geo.parameters.options.depth : 24);

            gears.push({ 
                mesh: gMesh, 
                axis: cfg.axis, 
                dir: cfg.dir, 
                pitchR: cfg.type.pitchR,
                baseAngle: toothOffset 
            });
        });

        // ==========================================
        // 3. THE SINKING TOOTHED RACK
        // ==========================================
        const movingGroup = new THREE.Group();
        movingGroup.position.y = 1.4; // Elevated state
        group.add(movingGroup);

        // Top Cap (The Cradle)
        const topCap = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.2, 2.45), darkSteelMat);
        topCap.castShadow = true;
        movingGroup.add(topCap);

        // Pillar Base
        const pillarGeo = new THREE.BoxGeometry(1.0, 1.8, 1.0);
        const pillar = new THREE.Mesh(pillarGeo, wallMaterial);
        pillar.position.y = -0.9;
        movingGroup.add(pillar);

        // Generate the horizontal rack teeth
        const ribGeo = new THREE.BoxGeometry(1.15, 0.08, 1.15); // Extends past the 1.0 pillar
        for (let y = -1.8; y <= 0.0; y += RACK_PITCH) {
            const rib = new THREE.Mesh(ribGeo, darkSteelMat);
            rib.position.y = y;
            movingGroup.add(rib);
        }

        // Energy Lens & Core
        const lensGeo = new THREE.BoxGeometry(1.8, 0.15, 1.8);
        const lensMat = new THREE.MeshPhysicalMaterial({
            color: 0x111111, emissive: 0x000000,
            transparent: true, opacity: 0.65, 
            roughness: 0.05, metalness: 0.85 // High metalness fakes reflections cleanly
        });

        const lens = new THREE.Mesh(lensGeo, lensMat);
        lens.position.y = 0.1; 
        movingGroup.add(lens);

        const coreGeo = new THREE.BoxGeometry(0.8, 1.5, 0.8);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, blending: THREE.AdditiveBlending });
        const core = new THREE.Mesh(coreGeo, coreMat);
        core.position.y = -0.7;
        movingGroup.add(core);

        const pLight = new THREE.PointLight(0xffffff, 0, 8);
        pLight.position.y = 1.0;
        movingGroup.add(pLight);

        // ==========================================
        // 4. PHYSICS
        // ==========================================
        const body = new CANNON.Body({
            mass: 0, type: CANNON.Body.KINEMATIC,
            shape: new CANNON.Box(new CANNON.Vec3(0.8, 0.1, 0.8)) 
        });
        body.position.set(pos.x, pos.y + 1.4, pos.z);
        body.quaternion.set(globalTiltThree.x, globalTiltThree.y, globalTiltThree.z, globalTiltThree.w);
        world.addBody(body);
        levelBodies.push(body);

        scene.add(group);

        activePlates.push({
            group: movingGroup, body: body, basePos: pos,
            gears: gears, lensMat: lensMat, coreMat: coreMat, light: pLight,
            channel: data.channel, progress: 0
        });
        levelMeshes.push(group);
    }

    function createGlassDoor(data) {
        const group = new THREE.Group();
        const basePos = new THREE.Vector3(data.x, data.y, data.z).applyQuaternion(globalTiltThree);
        group.position.copy(basePos);

        // 1. Apply Local Rotation based on Normal
        if (data.normal) {
            const n = new THREE.Vector3(data.normal.x, data.normal.y, data.normal.z).normalize();
            const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
            group.quaternion.copy(q);
        }
        // 2. Apply Global Tilt on top
        group.quaternion.premultiply(globalTiltThree);

        const w = data.width || 3;
        const h = data.height || 3;
        const dist = data.moveDist || 2.8;

        // 3. Create Visuals - Industrial Frame
        const frameThickness = 0.2;
        const frameDepth = 0.3;
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.8, roughness: 0.4 });

        const frameTop = new THREE.Mesh(new THREE.BoxGeometry(w, frameThickness, frameDepth), frameMat);
        frameTop.position.y = (h / 2) - (frameThickness / 2);

        const frameBottom = new THREE.Mesh(new THREE.BoxGeometry(w, frameThickness, frameDepth), frameMat);
        frameBottom.position.y = -(h / 2) + (frameThickness / 2);

        const sideHeight = h - (frameThickness * 2);
        const frameLeft = new THREE.Mesh(new THREE.BoxGeometry(frameThickness, sideHeight, frameDepth), frameMat);
        frameLeft.position.x = -(w / 2) + (frameThickness / 2);

        const frameRight = new THREE.Mesh(new THREE.BoxGeometry(frameThickness, sideHeight, frameDepth), frameMat);
        frameRight.position.x = (w / 2) - (frameThickness / 2);

        group.add(frameTop, frameBottom, frameLeft, frameRight);

        // 4. Tinted Glass Pane
        const paneW = w - (frameThickness * 2);
        const paneH = sideHeight;
        const glassGeo = new THREE.BoxGeometry(paneW, paneH, 0.05);
        const glassMat = new THREE.MeshStandardMaterial({ 
            color: 0x44aaff, emissive: 0x002244, transparent: true, opacity: 0.45, roughness: 0.1, metalness: 0.8, depthWrite: false
        });
        const pane = new THREE.Mesh(glassGeo, glassMat);
        group.add(pane);

        // 5. Glowing Sci-Fi Edges
        const edgesGeo = new THREE.EdgesGeometry(glassGeo);
        const edgesMat = new THREE.LineBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
        pane.add(new THREE.LineSegments(edgesGeo, edgesMat));

        // 6. Reinforcement Bars
        const barGeo = new THREE.BoxGeometry(paneW, 0.06, 0.15);
        const barMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.9, roughness: 0.5 });
        const bar1 = new THREE.Mesh(barGeo, barMat); bar1.position.y = paneH / 6;
        const bar2 = new THREE.Mesh(barGeo, barMat); bar2.position.y = -paneH / 6;
        group.add(bar1, bar2);

        scene.add(group);

        // 7. Physics
        const body = new CANNON.Body({
            mass: 0, type: CANNON.Body.KINEMATIC,
            shape: new CANNON.Box(new CANNON.Vec3(w/2, h/2, 0.15))
        });
        body.position.copy(basePos);
        body.quaternion.copy(group.quaternion); // Matches visual orientation perfectly
        world.addBody(body);

        // 8. Calculate Directional Vector natively aligned to the door's rotation
        const moveDir = new THREE.Vector3();
        if (data.dir === 'left')  moveDir.set(-dist, 0, 0);
        if (data.dir === 'right') moveDir.set( dist, 0, 0);
        if (data.dir === 'up')    moveDir.set(0,  dist, 0);
        if (data.dir === 'down')  moveDir.set(0, -dist, 0);

        moveDir.applyQuaternion(group.quaternion);

        activeDoors.push({ group, body, basePos, channel: data.channel, moveVector: moveDir, progress: 0 });
    }

    const activeFields = [];

    function createAeroFilter(data) {
        const group = new THREE.Group();
        const pos = new THREE.Vector3(data.x, data.y, data.z).applyQuaternion(globalTiltThree);
        group.position.copy(pos);
        group.quaternion.copy(globalTiltThree);

        const w = data.w || 3;
        const h = data.h || 3;

        // 1. Dark Industrial Frame
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.8, roughness: 0.5 });
        const frameT = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, 0.25), frameMat); frameT.position.y = h/2;
        const frameB = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, 0.25), frameMat); frameB.position.y = -h/2;
        const frameL = new THREE.Mesh(new THREE.BoxGeometry(0.15, h, 0.25), frameMat); frameL.position.x = -w/2;
        const frameR = new THREE.Mesh(new THREE.BoxGeometry(0.15, h, 0.25), frameMat); frameR.position.x = w/2;
        group.add(frameT, frameB, frameL, frameR);

        // 2. Translucent Core Plane
        const segX = Math.round(w * 1.5);
        const segY = Math.round(h * 1.5);
        const gridGeo = new THREE.PlaneGeometry(w, h, segX, segY);

        const baseMat = new THREE.MeshBasicMaterial({ 
            color: 0x00ffff, transparent: true, opacity: 0.15, 
            depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide 
        });
        const baseMesh = new THREE.Mesh(gridGeo, baseMat);
        group.add(baseMesh);

        // 3. Glowing Laser Net (Edges)
        const edges = new THREE.EdgesGeometry(gridGeo);
        const lineMat = new THREE.LineBasicMaterial({ 
            color: 0x00ffff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending 
        });
        const gridLines = new THREE.LineSegments(edges, lineMat);
        group.add(gridLines);

        if (data.normal) {
            const target = new THREE.Vector3(data.x + data.normal.x, data.y + data.normal.y, data.z + data.normal.z);
            group.lookAt(target.applyQuaternion(globalTiltThree));
        }
        scene.add(group);

        // 4. Physics Body
        const body = new CANNON.Body({
            mass: 0,
            shape: new CANNON.Box(new CANNON.Vec3(w/2, h/2, 0.25)),
            collisionFilterGroup: 16, 
            collisionFilterMask: 0 
        });
        body.position.copy(pos);
        body.quaternion.copy(group.quaternion);
        world.addBody(body);

        activeFields.push({ 
            type: 'aero', group, body, channel: data.channel, active: false,
            baseMesh: baseMesh, gridLines: gridLines // Exported for animation toggle
        });
    }

    function createOneWayField(data) {
        const group = new THREE.Group();
        const pos = new THREE.Vector3(data.x, data.y, data.z).applyQuaternion(globalTiltThree);
        group.position.copy(pos);
        group.quaternion.copy(globalTiltThree);

        const w = data.w || 3;
        const h = data.h || 3;

        // 1. Top & Bottom Mounting Brackets
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.9, roughness: 0.3 });
        const frameT = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, 0.2), frameMat); frameT.position.y = h/2;
        const frameB = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, 0.2), frameMat); frameB.position.y = -h/2;
        group.add(frameT, frameB);

        // 2. Hard-Light Shield Plane
        const shieldMat = new THREE.MeshBasicMaterial({ 
            color: 0xffaa00, transparent: true, opacity: 0.25, 
            depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide 
        });
        const shieldMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), shieldMat);
        group.add(shieldMesh);

        // 3. Holographic Flow Arrows (Grid)
        const arrowGroup = new THREE.Group();
        const shaftGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.3, 4);
        shaftGeo.rotateX(Math.PI / 2); // Point along Z
        const headGeo = new THREE.ConeGeometry(0.08, 0.15, 4);
        headGeo.rotateX(Math.PI / 2);
        headGeo.translate(0, 0, 0.15); // Move head to tip of shaft

        const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending });

        // Generate a grid of arrows
        const stepX = w / 3;
        const stepY = h / 3;
        for(let ax = -w/2 + stepX/2; ax < w/2; ax += stepX) {
            for(let ay = -h/2 + stepY/2; ay < h/2; ay += stepY) {
                const shaft = new THREE.Mesh(shaftGeo, arrowMat);
                const head = new THREE.Mesh(headGeo, arrowMat);
                shaft.position.set(ax, ay, 0);
                head.position.set(ax, ay, 0);
                arrowGroup.add(shaft, head);
            }
        }

        // Flip arrows based on inversion setting
        if (data.inverted) arrowGroup.rotation.y = Math.PI;
        group.add(arrowGroup);

        if (data.normal) {
            const target = new THREE.Vector3(data.x + data.normal.x, data.y + data.normal.y, data.z + data.normal.z);
            group.lookAt(target.applyQuaternion(globalTiltThree));
        }
        scene.add(group);

        // 4. Physics Body
        const body = new CANNON.Body({
            mass: 0,
            shape: new CANNON.Box(new CANNON.Vec3(w/2, h/2, 0.05)),
            collisionFilterGroup: CG_STATIC,
            collisionFilterMask: CG_PLAYER | CG_DYNAMIC
        });
        body.position.copy(pos);
        body.quaternion.copy(group.quaternion); 
        world.addBody(body);

        activeFields.push({ 
            type: 'oneway', group, body, shieldMesh, arrowGroup,
            channel: data.channel, inverted: data.inverted || false, active: true 
        });
    }

    // Define the geometry and material ONCE globally to save memory and boost FPS
    const sharedRopeGeo = new THREE.CylinderGeometry(0.04, 0.04, 1, 6);
    sharedRopeGeo.rotateX(Math.PI / 2); // <--- THIS FIXES THE SIDEWAYS ROPES
    const sharedRopeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9, metalness: 0.1 });

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
                mass: (i === 0 || i === segments) ? 0 : 0.8,
                shape: new CANNON.Sphere(0.1),
                position: new CANNON.Vec3(pos.x, pos.y, pos.z),
                linearDamping: 0.5, angularDamping: 0.5
            });
            world.addBody(body);
            bodies.push(body);
            levelBodies.push(body);

            if (i > 0) {
                world.addConstraint(new CANNON.DistanceConstraint(bodies[i-1], bodies[i], segLen));

                // Use the pre-rotated geometry here
                const mesh = new THREE.Mesh(sharedRopeGeo, sharedRopeMat);
                scene.add(mesh);
                segMeshes.push(mesh);
            }
        }
        dynamicRopes.push({ bodies, segmentMeshes: segMeshes });
    }

    function getLevelParams(lvl) {
        // ── HUB WORLD ─────────────────────────────────────────────────────────
        if (lvl === HUB_LEVEL_INDEX) {
            return getHubWorldParams();
        }
        // Load a saved custom level
        if (typeof lvl === 'string' && lvl.startsWith('CUSTOM_')) {
            const slot = parseInt(lvl.replace('CUSTOM_', ''));
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

            // Re-Link Components
            if (data.plates) data.plates.forEach(p => builder.addPlate(p.x, p.y, p.z, p.channel));
            if (data.doors) data.doors.forEach(d => builder.addDoor(d.x, d.y, d.z, d));

            // Re-Link Fields (Aero and One-Way)
            if (data.fields) data.fields.forEach(f => {
                if (f.type === 'aero') 
                    builder.addAeroFilter(f.x, f.y, f.z, f.channel, f.w, f.h, f.normal);
                if (f.type === 'oneway') 
                    builder.addOneWayField(f.x, f.y, f.z, f.channel, f.inverted, f.w, f.h, f.normal);
            });

            // Re-Link Logic Wiring
            if (data.logic) {
                for (let ch in data.logic) {
                    const l = data.logic[ch];
                    // Map both old 'sources' and new 'operands' format
                    const ops = l.operands || l.sources || [];
                    builder.addLogicGate(parseInt(ch), l.type, ops);
                }
            }

            return builder.build();
        }

        // --- FIX: LOADING ACTIVE SCRATCHPAD FROM EDITOR ---
        if (lvl === 'CUSTOM') {
            const builder = new LevelBuilder(999, "CUSTOM LEVEL")
                .setBounds(15, 20, 15)
                .setSpawn(customSpawn.x, customSpawn.y, customSpawn.z)
                .setExit(customExit.x, customExit.y, customExit.z)
                .setCutscene(null);

            if (customWaterY !== undefined) builder.setWater(customWaterY);

            builder.addCustomLogic((x, y, z) => customSolidBlocks.has(`${x},${y},${z}`));

            customEntities.forEach(ent => {
                if (PHYSICAL_BLOCK_TYPES.has(ent.type)) {
                    const opts = ent.type === 'red' ? { startScale: ent.startScale } : {};
                    builder.addEntity(ent.type, ent.x, ent.y, ent.z, opts);
                }
            });

            customDestruction.forEach(bomb => builder.addDestructionZone(bomb.cx, bomb.cy, bomb.cz, 4, 7));
            customLights.forEach(l => builder.addLight(l.x, l.y, l.z, l.color, l.intensity, l.radius));
            customPlates.forEach(p => builder.addPlate(p.x, p.y, p.z, p.channel));
            customDoors.forEach(d => builder.addDoor(d.x, d.y, d.z, d));

            // Map Fields for Editor Playtest
            customFields.forEach(f => {
                if (f.type === 'aero') builder.addAeroFilter(f.x, f.y, f.z, f.channel, f.w, f.h, f.normal);
                if (f.type === 'oneway') builder.addOneWayField(f.x, f.y, f.z, f.channel, f.inverted, f.w, f.h, f.normal);
            });

            // Map Logic Gate Object to builder Array
            for (let ch in logicNodes.configs) {
                const l = logicNodes.configs[ch];
                builder.addLogicGate(parseInt(ch), l.type, l.operands || l.sources);
            }

            return builder.build();
        }

        if (lvl === 'CUSTOM') {
            const builder = new LevelBuilder(999, "CUSTOM LEVEL")
                .setBounds(15, 20, 15)
                .setSpawn(customSpawn.x, customSpawn.y, customSpawn.z)
                .setExit(customExit.x, customExit.y, customExit.z)
                .addDestructionZone(0, 0, 0, 0, 0) // No hole - fully enclosed chamber
                .setCutscene(null);

            if (customWaterY !== undefined) builder.setWater(customWaterY);

            // Add all custom solid blocks
            builder.addCustomLogic((x, y, z) => {
                return customSolidBlocks.has(`${x},${y},${z}`);
            });

            // --- ADD THIS LOOP HERE ---
            for (let ch in logicNodes.configs) {
                const l = logicNodes.configs[ch];
                builder.addLogicGate(parseInt(ch), l.type, l.operands || l.sources);
            }

            // Add all custom entities
            customEntities.forEach(ent => {
                // ONLY add to addEntity if it's a physical block type (red, blue, etc)
                // Wall, Spawn, and Exit are handled separately by evaluateSolid or markers
                if (PHYSICAL_BLOCK_TYPES.has(ent.type)) {
                    const opts = {};
                    if (ent.type === 'red' && ent.startScale !== undefined) opts.startScale = ent.startScale;
                    builder.addEntity(ent.type, ent.x, ent.y, ent.z, opts);
                }
            });

            // Add all custom destruction zones
            customDestruction.forEach(bomb => {
                builder.addDestructionZone(bomb.cx, bomb.cy, bomb.cz, 4, 7);
            });

            // Add all custom lights
            customLights.forEach(light => {
                builder.addLight(light.x, light.y, light.z, light.color, light.intensity, light.radius);
            });

            customPlates.forEach(p => builder.addPlate(p.x, p.y, p.z, p.channel));
            customDoors.forEach(d => builder.addDoor(d.x, d.y, d.z, d));

            // ADD THIS:
            customFields.forEach(f => {
                if (f.type === 'aero') builder.addAeroFilter(f.x, f.y, f.z, f.channel, f.w, f.h, f.normal);
                if (f.type === 'oneway') builder.addOneWayField(f.x, f.y, f.z, f.channel, f.inverted, f.w, f.h, f.normal);
            });

            return builder.build();
        }
        switch (activeChapter) {
            case 1:  return getLevelParamsV2(lvl);
            case 2:  return getLevelParamsV3(lvl);
            default: return getLevelParamsV1(lvl);
        }
    }

    // Helper function to easily carve enclosed rooms out of solid rock
    const roomBox = (x, y, z, w, h, d) => (x <= -w || x >= w || z <= -d || z >= d || y <= 0 || y >= h);

    // ── CHAPTER 1: THE FUNDAMENTALS ──────────────────────────────────────────
    function getLevelParamsV1(lvl) {
        const builder = new LevelBuilder(lvl, LEVEL_NAMES[lvl]);

        switch (lvl) {
            case 0: // THE ATRIUM
                return builder.setBounds(10, 12, 20).setSpawn(0, 2, -16).setExit(0, 6, 15).setCutscene('wakeup')
                    .addHologram("AWAKEN\n[ WASD ] Move  •  [ SPACE ] Jump", 0, 3, -13)
                    .addCustomLogic((x, y, z) => { 
                        if (roomBox(x, y, z, 8, 10, 18)) return true; 
                        if (z >= -18 && z <= -13 && Math.abs(x) <= 3 && y <= 1) return true; // Start
                        if (z >= -9 && z <= -2 && Math.abs(x) <= 3 && y <= 3) return true;   // Mid
                        if (z >= 2 && z <= 18 && Math.abs(x) <= 3 && y <= 5) return true;    // Goal
                        return false; 
                    }).build();

            case 1: // THE CORRIDOR (Original Hardcoded Array Restored)
                return builder.setBounds(7, 14, 17)
                    .setSpawn(0, 2, -12)
                    .setExit(0, 5, 12)
                    .addEntity('green', 0, 2, 0)
                    .addDestructionZone(0, 8, -9, 4, 7)
                    .addLight(0, 3, 0, 0xffeedd, 9, 8)
                    .addCustomLogic((() => {
                        // High-performance closure for grid lookups
                        const solids = new Set(["-6,0,-16","-6,0,-15","-6,0,-14","-6,0,-13","-6,0,-12","-6,0,-11","-6,0,-10","-6,0,-9","-6,0,-8","-6,0,-7","-6,0,-6","-6,0,-5","-6,0,-4","-6,0,-3","-6,0,-2","-6,0,-1","-6,0,0","-6,0,1","-6,0,2","-6,0,3","-6,0,4","-6,0,5","-6,0,6","-6,0,7","-6,0,8","-6,0,9","-6,0,10","-6,0,11","-6,0,12","-6,0,13","-6,0,14","-6,0,15","-6,0,16","-5,0,-16","-5,0,-15","-5,0,-14","-5,0,-13","-5,0,-12","-5,0,-11","-5,0,-10","-5,0,-9","-5,0,-8","-5,0,-7","-5,0,-6","-5,0,-5","-5,0,-4","-5,0,-3","-5,0,-2","-5,0,-1","-5,0,0","-5,0,1","-5,0,2","-5,0,3","-5,0,4","-5,0,5","-5,0,6","-5,0,7","-5,0,8","-5,0,9","-5,0,10","-5,0,11","-5,0,12","-5,0,13","-5,0,14","-5,0,15","-5,0,16","-5,1,-15","-5,1,-14","-5,1,-13","-5,1,-12","-5,1,-11","-5,1,-10","-5,1,-9","-5,1,-8","-5,1,-7","-5,1,-6","-5,1,-5","-5,1,-4","-5,1,-3","-5,1,-2","-5,1,-1","-5,1,0","-5,1,1","-5,1,2","-5,1,3","-5,1,4","-5,1,5","-5,1,6","-5,1,7","-5,1,8","-5,1,9","-5,1,10","-5,1,11","-5,1,12","-5,1,13","-5,1,14","-5,1,15","-5,2,-15","-5,2,-14","-5,2,-13","-5,2,-12","-5,2,-11","-5,2,-10","-5,2,-9","-5,2,-8","-5,2,-7","-5,2,-6","-5,2,-5","-5,2,-4","-5,2,-3","-5,2,-2","-5,2,-1","-5,2,0","-5,2,1","-5,2,2","-5,2,3","-5,2,4","-5,2,5","-5,2,6","-5,2,7","-5,2,8","-5,2,9","-5,2,10","-5,2,11","-5,2,12","-5,2,13","-5,2,14","-5,2,15","-5,3,-15","-5,3,-14","-5,3,-13","-5,3,-12","-5,3,-11","-5,3,-10","-5,3,-9","-5,3,-8","-5,3,-7","-5,3,-6","-5,3,-5","-5,3,-4","-5,3,-3","-5,3,-2","-5,3,-1","-5,3,0","-5,3,1","-5,3,2","-5,3,3","-5,3,4","-5,3,5","-5,3,6","-5,3,7","-5,3,8","-5,3,9","-5,3,10","-5,3,11","-5,3,12","-5,3,13","-5,3,14","-5,3,15","-5,4,-15","-5,4,-14","-5,4,-13","-5,4,-12","-5,4,-11","-5,4,-10","-5,4,-9","-5,4,-8","-5,4,-7","-5,4,-5","-5,4,-4","-5,4,-3","-5,4,-2","-5,4,-1","-5,4,0","-5,4,1","-5,4,2","-5,4,3","-5,4,4","-5,4,5","-5,4,6","-5,4,7","-5,4,8","-5,4,9","-5,4,10","-5,4,11","-5,4,12","-5,4,13","-5,4,14","-5,4,15","-5,5,-15","-5,5,-14","-5,5,-13","-5,5,-12","-5,5,-11","-5,5,-10","-5,5,-9","-5,5,-8","-5,5,-7","-5,5,-6","-5,5,-5","-5,5,-4","-5,5,-3","-5,5,-2","-5,5,-1","-5,5,0","-5,5,1","-5,5,2","-5,5,3","-5,5,4","-5,5,5","-5,5,6","-5,5,7","-5,5,8","-5,5,9","-5,5,10","-5,5,11","-5,5,12","-5,5,13","-5,5,14","-5,5,15","-5,6,-15","-5,6,-14","-5,6,-13","-5,6,-12","-5,6,-11","-5,6,-10","-5,6,-9","-5,6,-8","-5,6,-7","-5,6,-6","-5,6,-5","-5,6,-4","-5,6,-3","-5,6,-2","-5,6,-1","-5,6,0","-5,6,1","-5,6,2","-5,6,3","-5,6,4","-5,6,5","-5,6,6","-5,6,7","-5,6,8","-5,6,9","-5,6,10","-5,6,11","-5,6,12","-5,6,13","-5,6,14","-5,6,15","-5,7,-15","-5,7,-14","-5,7,-13","-5,7,-12","-5,7,-11","-5,7,-10","-5,7,-9","-5,7,-8","-5,7,-7","-5,7,-6","-5,7,-5","-5,7,-4","-5,7,-3","-5,7,-2","-5,7,-1","-5,7,0","-5,7,1","-5,7,2","-5,7,3","-5,7,4","-5,7,5","-5,7,6","-5,7,7","-5,7,8","-5,7,9","-5,7,10","-5,7,11","-5,7,12","-5,7,13","-5,7,14","-5,7,15","-5,8,-15","-5,8,-14","-5,8,-13","-5,8,-12","-5,8,-11","-5,8,-10","-5,8,-9","-5,8,-8","-5,8,-7","-5,8,-6","-5,8,-5","-5,8,-4","-5,8,-3","-5,8,-2","-5,8,-1","-5,8,0","-5,8,1","-5,8,2","-5,8,3","-5,8,4","-5,8,5","-5,8,6","-5,8,7","-5,8,8","-5,8,9","-5,8,10","-5,8,11","-5,8,12","-5,8,13","-5,8,14","-5,8,15","-5,9,-15","-5,9,-14","-5,9,-13","-5,9,-12","-5,9,-11","-5,9,-10","-5,9,-9","-5,9,-8","-5,9,-7","-5,9,-6","-5,9,-5","-5,9,-4","-5,9,-3","-5,9,-2","-5,9,-1","-5,9,0","-5,9,1","-5,9,2","-5,9,3","-5,9,4","-5,9,5","-5,9,6","-5,9,7","-5,9,8","-5,9,9","-5,9,10","-5,9,11","-5,9,12","-5,9,13","-5,9,14","-5,9,15","-5,10,-15","-5,10,-14","-5,10,-13","-5,10,-12","-5,10,-11","-5,10,-10","-5,10,-9","-5,10,-8","-5,10,-7","-5,10,-6","-5,10,-5","-5,10,-4","-5,10,-3","-5,10,-2","-5,10,-1","-5,10,0","-5,10,1","-5,10,2","-5,10,3","-5,10,4","-5,10,5","-5,10,6","-5,10,7","-5,10,8","-5,10,9","-5,10,10","-5,10,11","-5,10,12","-5,10,13","-5,10,14","-5,10,15","-5,11,-15","-5,11,-14","-5,11,-13","-5,11,-12","-5,11,-11","-5,11,-10","-5,11,-9","-5,11,-8","-5,11,-7","-5,11,-6","-5,11,-5","-5,11,-4","-5,11,-3","-5,11,-2","-5,11,-1","-5,11,0","-5,11,1","-5,11,2","-5,11,3","-5,11,4","-5,11,5","-5,11,6","-5,11,7","-5,11,8","-5,11,9","-5,11,10","-5,11,11","-5,11,12","-5,11,13","-5,11,14","-5,11,15","-5,12,-15","-5,12,-14","-5,12,-13","-5,12,-12","-5,12,-11","-5,12,-10","-5,12,-9","-5,12,-8","-5,12,-7","-5,12,-6","-5,12,-5","-5,12,-4","-5,12,-3","-5,12,-2","-5,12,-1","-5,12,0","-5,12,1","-5,12,2","-5,12,3","-5,12,4","-5,12,5","-5,12,6","-5,12,7","-5,12,8","-5,12,9","-5,12,10","-5,12,11","-5,12,12","-5,12,13","-5,12,14","-5,12,15","-4,0,-16","-4,0,-15","-4,0,-14","-4,0,-13","-4,0,-12","-4,0,-11","-4,0,-10","-4,0,-9","-4,0,-8","-4,0,-7","-4,0,-6","-4,0,-5","-4,0,-4","-4,0,-3","-4,0,-2","-4,0,-1","-4,0,0","-4,0,1","-4,0,2","-4,0,3","-4,0,4","-4,0,5","-4,0,6","-4,0,7","-4,0,8","-4,0,9","-4,0,10","-4,0,11","-4,0,12","-4,0,13","-4,0,14","-4,0,15","-4,0,16","-4,1,-15","-4,1,-14","-4,1,-13","-4,1,-12","-4,1,-11","-4,1,-10","-4,1,-9","-4,1,-8","-4,1,-7","-4,1,-6","-4,1,-5","-4,1,-4","-4,1,-1","-4,1,0","-4,1,1","-4,1,4","-4,1,5","-4,1,6","-4,1,7","-4,1,8","-4,1,9","-4,1,10","-4,1,11","-4,1,12","-4,1,13","-4,1,14","-4,1,15","-4,2,-15","-4,2,-14","-4,2,-13","-4,2,-12","-4,2,-11","-4,2,-10","-4,2,-9","-4,2,-8","-4,2,-7","-4,2,-6","-4,2,-5","-4,2,-4","-4,2,-1","-4,2,0","-4,2,1","-4,2,4","-4,2,5","-4,2,6","-4,2,7","-4,2,8","-4,2,9","-4,2,10","-4,2,11","-4,2,12","-4,2,13","-4,2,14","-4,2,15","-4,3,-15","-4,3,-14","-4,3,-13","-4,3,-12","-4,3,-11","-4,3,-10","-4,3,-9","-4,3,-8","-4,3,-7","-4,3,-6","-4,3,-5","-4,3,-4","-4,3,-1","-4,3,0","-4,3,1","-4,3,4","-4,3,5","-4,3,6","-4,3,7","-4,3,8","-4,3,9","-4,3,10","-4,3,11","-4,3,12","-4,3,13","-4,3,14","-4,3,15","-4,4,-15","-4,4,-14","-4,4,-13","-4,4,-12","-4,4,-11","-4,4,-10","-4,4,-9","-4,4,-8","-4,4,-7","-4,4,-5","-4,4,-4","-4,4,-1","-4,4,0","-4,4,1","-4,4,4","-4,4,5","-4,4,6","-4,4,7","-4,4,8","-4,4,9","-4,4,10","-4,4,11","-4,4,12","-4,4,13","-4,4,14","-4,4,15","-4,5,-15","-4,5,-14","-4,5,-13","-4,5,-12","-4,5,-11","-4,5,-10","-4,5,-9","-4,5,-8","-4,5,-7","-4,5,-6","-4,5,-5","-4,5,-4","-4,5,-1","-4,5,0","-4,5,1","-4,5,4","-4,5,5","-4,5,6","-4,5,7","-4,5,8","-4,5,9","-4,5,10","-4,5,11","-4,5,12","-4,5,13","-4,5,14","-4,5,15","-4,6,-15","-4,6,-14","-4,6,-13","-4,6,-12","-4,6,-11","-4,6,-10","-4,6,-9","-4,6,-8","-4,6,-7","-4,6,-6","-4,6,-5","-4,6,-4","-4,6,-1","-4,6,0","-4,6,1","-4,6,4","-4,6,5","-4,6,6","-4,6,7","-4,6,8","-4,6,9","-4,6,10","-4,6,11","-4,6,12","-4,6,13","-4,6,14","-4,6,15","-4,7,-15","-4,7,-14","-4,7,-13","-4,7,-12","-4,7,-11","-4,7,-10","-4,7,-9","-4,7,-8","-4,7,-7","-4,7,-6","-4,7,-5","-4,7,-4","-4,7,-3","-4,7,-2","-4,7,-1","-4,7,0","-4,7,1","-4,7,2","-4,7,3","-4,7,4","-4,7,5","-4,7,6","-4,7,7","-4,7,8","-4,7,9","-4,7,10","-4,7,11","-4,7,12","-4,7,13","-4,7,14","-4,7,15","-4,8,-15","-4,8,-14","-4,8,-13","-4,8,-12","-4,8,-11","-4,8,-10","-4,8,-9","-4,8,-8","-4,8,-7","-4,8,-6","-4,8,-5","-4,8,-4","-4,8,-3","-4,8,-2","-4,8,-1","-4,8,0","-4,8,1","-4,8,2","-4,8,3","-4,8,4","-4,8,5","-4,8,6","-4,8,7","-4,8,8","-4,8,9","-4,8,10","-4,8,11","-4,8,13","-4,8,14","-4,8,15","-4,9,-15","-4,9,-14","-4,9,-13","-4,9,-12","-4,9,-11","-4,9,-10","-4,9,-9","-4,9,-8","-4,9,-7","-4,9,-6","-4,9,-5","-4,9,-4","-4,9,-3","-4,9,-2","-4,9,-1","-4,9,0","-4,9,1","-4,9,2","-4,9,3","-4,9,4","-4,9,5","-4,9,6","-4,9,7","-4,9,8","-4,9,9","-4,9,10","-4,9,11","-4,9,12","-4,9,13","-4,9,14","-4,9,15","-4,10,-15","-4,10,-14","-4,10,-13","-4,10,-12","-4,10,-11","-4,10,-10","-4,10,-9","-4,10,-8","-4,10,-7","-4,10,-6","-4,10,-5","-4,10,-4","-4,10,-3","-4,10,-2","-4,10,-1","-4,10,0","-4,10,1","-4,10,2","-4,10,3","-4,10,4","-4,10,5","-4,10,6","-4,10,7","-4,10,8","-4,10,9","-4,10,10","-4,10,11","-4,10,12","-4,10,13","-4,10,14","-4,10,15","-4,11,-15","-4,11,-14","-4,11,-13","-4,11,-12","-4,11,-11","-4,11,-10","-4,11,-9","-4,11,-8","-4,11,-7","-4,11,-6","-4,11,-5","-4,11,-4","-4,11,-3","-4,11,-2","-4,11,-1","-4,11,0","-4,11,1","-4,11,2","-4,11,3","-4,11,4","-4,11,5","-4,11,6","-4,11,7","-4,11,8","-4,11,9","-4,11,10","-4,11,11","-4,11,12","-4,11,13","-4,11,14","-4,11,15","-4,12,-15","-4,12,-14","-4,12,-13","-4,12,-12","-4,12,-11","-4,12,-10","-4,12,-9","-4,12,-8","-4,12,-7","-4,12,-6","-4,12,-5","-4,12,-4","-4,12,-3","-4,12,-2","-4,12,-1","-4,12,0","-4,12,1","-4,12,2","-4,12,3","-4,12,4","-4,12,5","-4,12,6","-4,12,7","-4,12,8","-4,12,9","-4,12,10","-4,12,11","-4,12,12","-4,12,13","-4,12,14","-4,12,15","-3,0,-16","-3,0,-15","-3,0,-14","-3,0,-13","-3,0,-12","-3,0,-11","-3,0,-10","-3,0,-9","-3,0,-8","-3,0,-7","-3,0,-6","-3,0,-5","-3,0,-4","-3,0,-3","-3,0,-2","-3,0,-1","-3,0,0","-3,0,1","-3,0,2","-3,0,3","-3,0,4","-3,0,5","-3,0,6","-3,0,7","-3,0,8","-3,0,9","-3,0,10","-3,0,11","-3,0,12","-3,0,13","-3,0,14","-3,0,15","-3,0,16","-3,1,-15","-3,1,-14","-3,1,-13","-3,1,-12","-3,1,-11","-3,1,-10","-3,1,-9","-3,1,-8","-3,1,-7","-3,1,-6","-3,1,-5","-3,1,-4","-3,1,4","-3,1,5","-3,1,6","-3,1,7","-3,1,8","-3,1,9","-3,1,10","-3,1,11","-3,1,12","-3,1,13","-3,1,14","-3,1,15","-3,2,-15","-3,2,-14","-3,2,9","-3,2,10","-3,2,11","-3,2,12","-3,2,13","-3,2,14","-3,2,15","-3,3,-15","-3,3,-14","-3,3,9","-3,3,10","-3,3,11","-3,3,12","-3,3,13","-3,3,14","-3,3,15","-3,4,-15","-3,4,-14","-3,4,9","-3,4,10","-3,4,11","-3,4,12","-3,4,13","-3,4,14","-3,4,15","-3,5,-15","-3,5,-14","-3,5,14","-3,5,15","-3,6,-15","-3,6,-14","-3,6,14","-3,6,15","-3,7,-15","-3,7,-14","-3,7,14","-3,7,15","-3,8,-15","-3,8,-14","-3,8,14","-3,8,15","-3,9,-15","-3,9,-14","-3,9,-13","-3,9,-12","-3,9,-11","-3,9,-10","-3,9,-9","-3,9,-8","-3,9,-7","-3,9,-6","-3,9,-5","-3,9,-4","-3,9,-3","-3,9,-2","-3,9,-1","-3,9,0","-3,9,1","-3,9,2","-3,9,3","-3,9,4","-3,9,5","-3,9,6","-3,9,7","-3,9,8","-3,9,9","-3,9,10","-3,9,11","-3,9,12","-3,9,13","-3,9,14","-3,9,15","-3,10,-15","-3,10,-14","-3,10,-13","-3,10,-12","-3,10,-11","-3,10,-10","-3,10,-9","-3,10,-8","-3,10,-7","-3,10,-6","-3,10,-5","-3,10,-4","-3,10,-3","-3,10,-2","-3,10,-1","-3,10,0","-3,10,1","-3,10,2","-3,10,3","-3,10,4","-3,10,5","-3,10,6","-3,10,7","-3,10,8","-3,10,9","-3,10,10","-3,10,11","-3,10,12","-3,10,13","-3,10,14","-3,10,15","-3,11,-15","-3,11,-14","-3,11,-13","-3,11,-12","-3,11,-11","-3,11,-10","-3,11,-9","-3,11,-8","-3,11,-7","-3,11,-6","-3,11,-5","-3,11,-4","-3,11,-3","-3,11,-2","-3,11,-1","-3,11,0","-3,11,1","-3,11,2","-3,11,3","-3,11,4","-3,11,5","-3,11,6","-3,11,7","-3,11,8","-3,11,9","-3,11,10","-3,11,11","-3,11,12","-3,11,13","-3,11,14","-3,11,15","-3,12,-15","-3,12,-14","-3,12,-13","-3,12,-12","-3,12,-11","-3,12,-10","-3,12,-9","-3,12,-8","-3,12,-7","-3,12,-6","-3,12,-5","-3,12,-4","-3,12,-3","-3,12,-2","-3,12,-1","-3,12,0","-3,12,1","-3,12,2","-3,12,3","-3,12,4","-3,12,5","-3,12,6","-3,12,7","-3,12,8","-3,12,9","-3,12,10","-3,12,11","-3,12,12","-3,12,13","-3,12,14","-3,12,15","-2,0,-16","-2,0,-15","-2,0,-14","-2,0,-13","-2,0,-12","-2,0,-11","-2,0,-10","-2,0,-9","-2,0,-8","-2,0,-7","-2,0,-6","-2,0,-5","-2,0,-4","-2,0,-3","-2,0,-2","-2,0,-1","-2,0,0","-2,0,1","-2,0,2","-2,0,3","-2,0,4","-2,0,5","-2,0,6","-2,0,7","-2,0,8","-2,0,9","-2,0,10","-2,0,11","-2,0,12","-2,0,13","-2,0,14","-2,0,15","-2,0,16","-2,1,-15","-2,1,-14","-2,1,-13","-2,1,-12","-2,1,-11","-2,1,-10","-2,1,-9","-2,1,-8","-2,1,-7","-2,1,-6","-2,1,-5","-2,1,-4","-2,1,4","-2,1,5","-2,1,6","-2,1,7","-2,1,8","-2,1,9","-2,1,10","-2,1,11","-2,1,12","-2,1,13","-2,1,14","-2,1,15","-2,2,-15","-2,2,-14","-2,2,9","-2,2,10","-2,2,11","-2,2,12","-2,2,13","-2,2,14","-2,2,15","-2,3,-15","-2,3,-14","-2,3,9","-2,3,10","-2,3,11","-2,3,12","-2,3,13","-2,3,14","-2,3,15","-2,4,-15","-2,4,-14","-2,4,9","-2,4,10","-2,4,11","-2,4,12","-2,4,13","-2,4,14","-2,4,15","-2,5,-15","-2,5,-14","-2,5,14","-2,5,15","-2,6,-15","-2,6,-14","-2,6,14","-2,6,15","-2,7,-15","-2,7,-14","-2,7,14","-2,7,15","-2,8,-15","-2,8,-14","-2,8,14","-2,8,15","-2,9,-15","-2,9,-14","-2,9,-13","-2,9,-12","-2,9,-11","-2,9,-10","-2,9,-9","-2,9,-8","-2,9,-7","-2,9,-6","-2,9,-5","-2,9,-4","-2,9,-3","-2,9,-2","-2,9,-1","-2,9,0","-2,9,1","-2,9,2","-2,9,3","-2,9,4","-2,9,5","-2,9,6","-2,9,7","-2,9,8","-2,9,9","-2,9,10","-2,9,11","-2,9,12","-2,9,13","-2,9,14","-2,9,15","-2,10,-15","-2,10,-14","-2,10,-13","-2,10,-12","-2,10,-11","-2,10,-10","-2,10,-9","-2,10,-8","-2,10,-7","-2,10,-6","-2,10,-5","-2,10,-4","-2,10,-3","-2,10,-2","-2,10,-1","-2,10,0","-2,10,1","-2,10,2","-2,10,3","-2,10,4","-2,10,5","-2,10,6","-2,10,7","-2,10,8","-2,10,9","-2,10,10","-2,10,11","-2,10,12","-2,10,13","-2,10,14","-2,10,15","-2,11,-15","-2,11,-14","-2,11,-13","-2,11,-12","-2,11,-11","-2,11,-10","-2,11,-9","-2,11,-8","-2,11,-7","-2,11,-6","-2,11,-5","-2,11,-4","-2,11,-3","-2,11,-2","-2,11,-1","-2,11,0","-2,11,1","-2,11,2","-2,11,3","-2,11,4","-2,11,5","-2,11,6","-2,11,7","-2,11,8","-2,11,9","-2,11,10","-2,11,11","-2,11,12","-2,11,13","-2,11,14","-2,11,15","-2,12,-15","-2,12,-14","-2,12,-13","-2,12,-12","-2,12,-11","-2,12,-10","-2,12,-9","-2,12,-8","-2,12,-7","-2,12,-6","-2,12,-5","-2,12,-4","-2,12,-3","-2,12,-2","-2,12,-1","-2,12,0","-2,12,1","-2,12,2","-2,12,3","-2,12,4","-2,12,5","-2,12,6","-2,12,7","-2,12,8","-2,12,9","-2,12,10","-2,12,11","-2,12,12","-2,12,13","-2,12,14","-2,12,15","-1,0,-16","-1,0,-15","-1,0,-14","-1,0,-13","-1,0,-12","-1,0,-11","-1,0,-10","-1,0,-9","-1,0,-8","-1,0,-7","-1,0,-6","-1,0,-5","-1,0,-4","-1,0,-3","-1,0,-2","-1,0,-1","-1,0,0","-1,0,1","-1,0,2","-1,0,3","-1,0,4","-1,0,5","-1,0,6","-1,0,7","-1,0,8","-1,0,9","-1,0,10","-1,0,11","-1,0,12","-1,0,13","-1,0,14","-1,0,15","-1,0,16","-1,1,-15","-1,1,-14","-1,1,-13","-1,1,-12","-1,1,-11","-1,1,-10","-1,1,-9","-1,1,-8","-1,1,-7","-1,1,-6","-1,1,-5","-1,1,-4","-1,1,4","-1,1,5","-1,1,6","-1,1,7","-1,1,8","-1,1,9","-1,1,10","-1,1,11","-1,1,12","-1,1,13","-1,1,14","-1,1,15","-1,2,-15","-1,2,-14","-1,2,9","-1,2,10","-1,2,11","-1,2,12","-1,2,13","-1,2,14","-1,2,15","-1,3,-15","-1,3,-14","-1,3,9","-1,3,10","-1,3,11","-1,3,12","-1,3,13","-1,3,14","-1,3,15","-1,4,-15","-1,4,-14","-1,4,9","-1,4,10","-1,4,11","-1,4,12","-1,4,13","-1,4,14","-1,4,15","-1,5,-15","-1,5,-14","-1,5,14","-1,5,15","-1,6,-15","-1,6,-14","-1,6,14","-1,6,15","-1,7,-15","-1,7,-14","-1,7,14","-1,7,15","-1,8,-15","-1,8,-14","-1,8,14","-1,8,15","-1,9,-15","-1,9,-14","-1,9,-13","-1,9,-12","-1,9,-11","-1,9,-10","-1,9,-9","-1,9,-8","-1,9,-7","-1,9,-6","-1,9,-5","-1,9,-4","-1,9,-3","-1,9,-2","-1,9,-1","-1,9,0","-1,9,1","-1,9,2","-1,9,3","-1,9,4","-1,9,5","-1,9,6","-1,9,7","-1,9,8","-1,9,9","-1,9,10","-1,9,11","-1,9,12","-1,9,13","-1,9,14","-1,9,15","-1,10,-15","-1,10,-14","-1,10,-13","-1,10,-12","-1,10,-11","-1,10,-10","-1,10,-9","-1,10,-8","-1,10,-7","-1,10,-6","-1,10,-5","-1,10,-4","-1,10,-3","-1,10,-2","-1,10,-1","-1,10,0","-1,10,1","-1,10,2","-1,10,3","-1,10,4","-1,10,5","-1,10,6","-1,10,7","-1,10,8","-1,10,9","-1,10,10","-1,10,11","-1,10,12","-1,10,13","-1,10,14","-1,10,15","-1,11,-15","-1,11,-14","-1,11,-13","-1,11,-12","-1,11,-11","-1,11,-10","-1,11,-9","-1,11,-8","-1,11,-7","-1,11,-6","-1,11,-5","-1,11,-4","-1,11,-3","-1,11,-2","-1,11,-1","-1,11,0","-1,11,1","-1,11,2","-1,11,3","-1,11,4","-1,11,5","-1,11,6","-1,11,7","-1,11,8","-1,11,9","-1,11,10","-1,11,11","-1,11,12","-1,11,13","-1,11,14","-1,11,15","-1,12,-15","-1,12,-14","-1,12,-13","-1,12,-12","-1,12,-11","-1,12,-10","-1,12,-9","-1,12,-8","-1,12,-7","-1,12,-6","-1,12,-5","-1,12,-4","-1,12,-3","-1,12,-2","-1,12,-1","-1,12,0","-1,12,1","-1,12,2","-1,12,3","-1,12,4","-1,12,5","-1,12,6","-1,12,7","-1,12,8","-1,12,9","-1,12,10","-1,12,11","-1,12,12","-1,12,13","-1,12,14","-1,12,15","0,0,-16","0,0,-15","0,0,-14","0,0,-13","0,0,-12","0,0,-11","0,0,-10","0,0,-9","0,0,-8","0,0,-7","0,0,-6","0,0,-5","0,0,-4","0,0,-3","0,0,-2","0,0,-1","0,0,0","0,0,1","0,0,2","0,0,3","0,0,4","0,0,5","0,0,6","0,0,7","0,0,8","0,0,9","0,0,10","0,0,11","0,0,12","0,0,13","0,0,14","0,0,15","0,0,16","0,1,-15","0,1,-14","0,1,-13","0,1,-12","0,1,-11","0,1,-10","0,1,-9","0,1,-8","0,1,-7","0,1,-6","0,1,-5","0,1,-4","0,1,4","0,1,5","0,1,6","0,1,7","0,1,8","0,1,9","0,1,10","0,1,11","0,1,12","0,1,13","0,1,14","0,1,15","0,2,-15","0,2,-14","0,2,9","0,2,10","0,2,11","0,2,12","0,2,13","0,2,14","0,2,15","0,3,-15","0,3,-14","0,3,9","0,3,10","0,3,11","0,3,12","0,3,13","0,3,14","0,3,15","0,4,-15","0,4,-14","0,4,9","0,4,10","0,4,11","0,4,12","0,4,13","0,4,14","0,4,15","0,5,-15","0,5,-14","0,5,14","0,5,15","0,6,-15","0,6,-14","0,6,14","0,6,15","0,7,-15","0,7,-14","0,7,14","0,7,15","0,8,-15","0,8,-14","0,8,14","0,8,15","0,9,-15","0,9,-14","0,9,-13","0,9,-12","0,9,-11","0,9,-10","0,9,-9","0,9,-8","0,9,-7","0,9,-6","0,9,-5","0,9,-4","0,9,-3","0,9,-2","0,9,-1","0,9,0","0,9,1","0,9,2","0,9,3","0,9,4","0,9,5","0,9,6","0,9,7","0,9,8","0,9,9","0,9,10","0,9,11","0,9,12","0,9,13","0,9,14","0,9,15","0,10,-15","0,10,-14","0,10,-13","0,10,-12","0,10,-11","0,10,-10","0,10,-9","0,10,-8","0,10,-7","0,10,-6","0,10,-5","0,10,-4","0,10,-3","0,10,-2","0,10,-1","0,10,0","0,10,1","0,10,2","0,10,3","0,10,4","0,10,5","0,10,6","0,10,7","0,10,8","0,10,9","0,10,10","0,10,11","0,10,12","0,10,13","0,10,14","0,10,15","0,11,-15","0,11,-14","0,11,-13","0,11,-12","0,11,-11","0,11,-10","0,11,-9","0,11,-8","0,11,-7","0,11,-6","0,11,-5","0,11,-4","0,11,-3","0,11,-2","0,11,-1","0,11,0","0,11,1","0,11,2","0,11,3","0,11,4","0,11,5","0,11,6","0,11,7","0,11,8","0,11,9","0,11,10","0,11,11","0,11,12","0,11,13","0,11,14","0,11,15","0,12,-15","0,12,-14","0,12,-13","0,12,-12","0,12,-11","0,12,-10","0,12,-9","0,12,-8","0,12,-7","0,12,-6","0,12,-5","0,12,-4","0,12,-3","0,12,-2","0,12,-1","0,12,0","0,12,1","0,12,2","0,12,3","0,12,4","0,12,5","0,12,6","0,12,7","0,12,8","0,12,9","0,12,10","0,12,11","0,12,12","0,12,13","0,12,14","0,12,15","1,0,-16","1,0,-15","1,0,-14","1,0,-13","1,0,-12","1,0,-11","1,0,-10","1,0,-9","1,0,-8","1,0,-7","1,0,-6","1,0,-5","1,0,-4","1,0,-3","1,0,-2","1,0,-1","1,0,0","1,0,1","1,0,2","1,0,3","1,0,4","1,0,5","1,0,6","1,0,7","1,0,8","1,0,9","1,0,10","1,0,11","1,0,12","1,0,13","1,0,14","1,0,15","1,0,16","1,1,-15","1,1,-14","1,1,-13","1,1,-12","1,1,-11","1,1,-10","1,1,-9","1,1,-8","1,1,-7","1,1,-6","1,1,-5","1,1,-4","1,1,4","1,1,5","1,1,6","1,1,7","1,1,8","1,1,9","1,1,10","1,1,11","1,1,12","1,1,13","1,1,14","1,1,15","1,2,-15","1,2,-14","1,2,9","1,2,10","1,2,11","1,2,12","1,2,13","1,2,14","1,2,15","1,3,-15","1,3,-14","1,3,9","1,3,10","1,3,11","1,3,12","1,3,13","1,3,14","1,3,15","1,4,-15","1,4,-14","1,4,9","1,4,10","1,4,11","1,4,12","1,4,13","1,4,14","1,4,15","1,5,-15","1,5,-14","1,5,14","1,5,15","1,6,-15","1,6,-14","1,6,14","1,6,15","1,7,-15","1,7,-14","1,7,14","1,7,15","1,8,-15","1,8,-14","1,8,14","1,8,15","1,9,-15","1,9,-14","1,9,-13","1,9,-12","1,9,-11","1,9,-10","1,9,-9","1,9,-8","1,9,-7","1,9,-6","1,9,-5","1,9,-4","1,9,-3","1,9,-2","1,9,-1","1,9,0","1,9,1","1,9,2","1,9,3","1,9,4","1,9,5","1,9,6","1,9,7","1,9,8","1,9,9","1,9,10","1,9,11","1,9,12","1,9,13","1,9,14","1,9,15","1,10,-15","1,10,-14","1,10,-13","1,10,-12","1,10,-11","1,10,-10","1,10,-9","1,10,-8","1,10,-7","1,10,-6","1,10,-5","1,10,-4","1,10,-3","1,10,-2","1,10,-1","1,10,0","1,10,1","1,10,2","1,10,3","1,10,4","1,10,5","1,10,6","1,10,7","1,10,8","1,10,9","1,10,10","1,10,11","1,10,12","1,10,13","1,10,14","1,10,15","1,11,-15","1,11,-14","1,11,-13","1,11,-12","1,11,-11","1,11,-10","1,11,-9","1,11,-8","1,11,-7","1,11,-6","1,11,-5","1,11,-4","1,11,-3","1,11,-2","1,11,-1","1,11,0","1,11,1","1,11,2","1,11,3","1,11,4","1,11,5","1,11,6","1,11,7","1,11,8","1,11,9","1,11,10","1,11,11","1,11,12","1,11,13","1,11,14","1,11,15","1,12,-15","1,12,-14","1,12,-13","1,12,-12","1,12,-11","1,12,-10","1,12,-9","1,12,-8","1,12,-7","1,12,-6","1,12,-5","1,12,-4","1,12,-3","1,12,-2","1,12,-1","1,12,0","1,12,1","1,12,2","1,12,3","1,12,4","1,12,5","1,12,6","1,12,7","1,12,8","1,12,9","1,12,10","1,12,11","1,12,12","1,12,13","1,12,14","1,12,15","2,0,-16","2,0,-15","2,0,-14","2,0,-13","2,0,-12","2,0,-11","2,0,-10","2,0,-9","2,0,-8","2,0,-7","2,0,-6","2,0,-5","2,0,-4","2,0,-3","2,0,-2","2,0,-1","2,0,0","2,0,1","2,0,2","2,0,3","2,0,4","2,0,5","2,0,6","2,0,7","2,0,8","2,0,9","2,0,10","2,0,11","2,0,12","2,0,13","2,0,14","2,0,15","2,0,16","2,1,-15","2,1,-14","2,1,-13","2,1,-12","2,1,-11","2,1,-10","2,1,-9","2,1,-8","2,1,-7","2,1,-6","2,1,-5","2,1,-4","2,1,4","2,1,5","2,1,6","2,1,7","2,1,8","2,1,9","2,1,10","2,1,11","2,1,12","2,1,13","2,1,14","2,1,15","2,2,-15","2,2,-14","2,2,9","2,2,10","2,2,11","2,2,12","2,2,13","2,2,14","2,2,15","2,3,-15","2,3,-14","2,3,9","2,3,10","2,3,11","2,3,12","2,3,13","2,3,14","2,3,15","2,4,-15","2,4,-14","2,4,9","2,4,10","2,4,11","2,4,12","2,4,13","2,4,14","2,4,15","2,5,-15","2,5,-14","2,5,14","2,5,15","2,6,-15","2,6,-14","2,6,14","2,6,15","2,7,-15","2,7,-14","2,7,14","2,7,15","2,8,-15","2,8,-14","2,8,14","2,8,15","2,9,-15","2,9,-14","2,9,-13","2,9,-12","2,9,-11","2,9,-10","2,9,-9","2,9,-8","2,9,-7","2,9,-6","2,9,-5","2,9,-4","2,9,-3","2,9,-2","2,9,-1","2,9,0","2,9,1","2,9,2","2,9,3","2,9,4","2,9,5","2,9,6","2,9,7","2,9,8","2,9,9","2,9,10","2,9,11","2,9,12","2,9,13","2,9,14","2,9,15","2,10,-15","2,10,-14","2,10,-13","2,10,-12","2,10,-11","2,10,-10","2,10,-9","2,10,-8","2,10,-7","2,10,-6","2,10,-5","2,10,-4","2,10,-3","2,10,-2","2,10,-1","2,10,0","2,10,1","2,10,2","2,10,3","2,10,4","2,10,5","2,10,6","2,10,7","2,10,8","2,10,9","2,10,10","2,10,11","2,10,12","2,10,13","2,10,14","2,10,15","2,11,-15","2,11,-14","2,11,-13","2,11,-12","2,11,-11","2,11,-10","2,11,-9","2,11,-8","2,11,-7","2,11,-6","2,11,-5","2,11,-4","2,11,-3","2,11,-2","2,11,-1","2,11,0","2,11,1","2,11,2","2,11,3","2,11,4","2,11,5","2,11,6","2,11,7","2,11,8","2,11,9","2,11,10","2,11,11","2,11,12","2,11,13","2,11,14","2,11,15","2,12,-15","2,12,-14","2,12,-13","2,12,-12","2,12,-11","2,12,-10","2,12,-9","2,12,-8","2,12,-7","2,12,-6","2,12,-5","2,12,-4","2,12,-3","2,12,-2","2,12,-1","2,12,0","2,12,1","2,12,2","2,12,3","2,12,4","2,12,5","2,12,6","2,12,7","2,12,8","2,12,9","2,12,10","2,12,11","2,12,12","2,12,13","2,12,14","2,12,15","3,0,-16","3,0,-15","3,0,-14","3,0,-13","3,0,-12","3,0,-11","3,0,-10","3,0,-9","3,0,-8","3,0,-7","3,0,-6","3,0,-5","3,0,-4","3,0,-3","3,0,-2","3,0,-1","3,0,0","3,0,1","3,0,2","3,0,3","3,0,4","3,0,5","3,0,6","3,0,7","3,0,8","3,0,9","3,0,10","3,0,11","3,0,12","3,0,13","3,0,14","3,0,15","3,0,16","3,1,-15","3,1,-14","3,1,-13","3,1,-12","3,1,-11","3,1,-10","3,1,-9","3,1,-8","3,1,-7","3,1,-6","3,1,-5","3,1,-4","3,1,4","3,1,5","3,1,6","3,1,7","3,1,8","3,1,9","3,1,10","3,1,11","3,1,12","3,1,13","3,1,14","3,1,15","3,2,-15","3,2,-14","3,2,9","3,2,10","3,2,11","3,2,12","3,2,13","3,2,14","3,2,15","3,3,-15","3,3,-14","3,3,9","3,3,10","3,3,11","3,3,12","3,3,13","3,3,14","3,3,15","3,4,-15","3,4,-14","3,4,9","3,4,10","3,4,11","3,4,12","3,4,13","3,4,14","3,4,15","3,5,-15","3,5,-14","3,5,14","3,5,15","3,6,-15","3,6,-14","3,6,14","3,6,15","3,7,-15","3,7,-14","3,7,14","3,7,15","3,8,-15","3,8,-14","3,8,14","3,8,15","3,9,-15","3,9,-14","3,9,-13","3,9,-12","3,9,-11","3,9,-10","3,9,-9","3,9,-8","3,9,-7","3,9,-6","3,9,-5","3,9,-4","3,9,-3","3,9,-2","3,9,-1","3,9,0","3,9,1","3,9,2","3,9,3","3,9,4","3,9,5","3,9,6","3,9,7","3,9,8","3,9,9","3,9,10","3,9,11","3,9,12","3,9,13","3,9,14","3,9,15","3,10,-15","3,10,-14","3,10,-13","3,10,-12","3,10,-11","3,10,-10","3,10,-9","3,10,-8","3,10,-7","3,10,-6","3,10,-5","3,10,-4","3,10,-3","3,10,-2","3,10,-1","3,10,0","3,10,1","3,10,2","3,10,3","3,10,4","3,10,5","3,10,6","3,10,7","3,10,8","3,10,9","3,10,10","3,10,11","3,10,12","3,10,13","3,10,14","3,10,15","3,11,-15","3,11,-14","3,11,-13","3,11,-12","3,11,-11","3,11,-10","3,11,-9","3,11,-8","3,11,-7","3,11,-6","3,11,-5","3,11,-4","3,11,-3","3,11,-2","3,11,-1","3,11,0","3,11,1","3,11,2","3,11,3","3,11,4","3,11,5","3,11,6","3,11,7","3,11,8","3,11,9","3,11,10","3,11,11","3,11,12","3,11,13","3,11,14","3,11,15","3,12,-15","3,12,-14","3,12,-13","3,12,-12","3,12,-11","3,12,-10","3,12,-9","3,12,-8","3,12,-7","3,12,-6","3,12,-5","3,12,-4","3,12,-3","3,12,-2","3,12,-1","3,12,0","3,12,1","3,12,2","3,12,3","3,12,4","3,12,5","3,12,6","3,12,7","3,12,8","3,12,9","3,12,10","3,12,11","3,12,12","3,12,13","3,12,14","3,12,15","4,0,-16","4,0,-15","4,0,-14","4,0,-13","4,0,-12","4,0,-11","4,0,-10","4,0,-9","4,0,-8","4,0,-7","4,0,-6","4,0,-5","4,0,-4","4,0,-3","4,0,-2","4,0,-1","4,0,0","4,0,1","4,0,2","4,0,3","4,0,4","4,0,5","4,0,6","4,0,7","4,0,8","4,0,9","4,0,10","4,0,11","4,0,12","4,0,13","4,0,14","4,0,15","4,0,16","4,1,-15","4,1,-14","4,1,-13","4,1,-12","4,1,-11","4,1,-10","4,1,-9","4,1,-8","4,1,-7","4,1,-6","4,1,-5","4,1,-4","4,1,-1","4,1,0","4,1,1","4,1,4","4,1,5","4,1,6","4,1,7","4,1,8","4,1,9","4,1,10","4,1,11","4,1,12","4,1,13","4,1,14","4,1,15","4,2,-15","4,2,-14","4,2,-13","4,2,-12","4,2,-11","4,2,-10","4,2,-9","4,2,-8","4,2,-7","4,2,-6","4,2,-5","4,2,-4","4,2,-1","4,2,0","4,2,1","4,2,4","4,2,5","4,2,6","4,2,7","4,2,8","4,2,9","4,2,10","4,2,11","4,2,12","4,2,13","4,2,14","4,2,15","4,3,-15","4,3,-14","4,3,-13","4,3,-12","4,3,-11","4,3,-9","4,3,-8","4,3,-7","4,3,-6","4,3,-5","4,3,-4","4,3,0","4,3,1","4,3,4","4,3,5","4,3,6","4,3,7","4,3,8","4,3,9","4,3,10","4,3,11","4,3,12","4,3,13","4,3,14","4,3,15","4,4,-15","4,4,-14","4,4,-13","4,4,-12","4,4,-11","4,4,-10","4,4,-9","4,4,-8","4,4,-7","4,4,-6","4,4,-5","4,4,-4","4,4,-1","4,4,0","4,4,1","4,4,4","4,4,5","4,4,6","4,4,7","4,4,8","4,4,9","4,4,10","4,4,11","4,4,12","4,4,13","4,4,14","4,4,15","4,5,-15","4,5,-14","4,5,-13","4,5,-12","4,5,-11","4,5,-10","4,5,-9","4,5,-8","4,5,-7","4,5,-6","4,5,-5","4,5,-4","4,5,-1","4,5,0","4,5,1","4,5,4","4,5,5","4,5,6","4,5,7","4,5,8","4,5,9","4,5,10","4,5,11","4,5,12","4,5,13","4,5,14","4,5,15","4,6,-15","4,6,-14","4,6,-13","4,6,-12","4,6,-11","4,6,-10","4,6,-9","4,6,-8","4,6,-7","4,6,-6","4,6,-5","4,6,-4","4,6,-1","4,6,0","4,6,1","4,6,4","4,6,5","4,6,6","4,6,7","4,6,8","4,6,9","4,6,10","4,6,11","4,6,12","4,6,13","4,6,14","4,6,15","4,7,-15","4,7,-14","4,7,-13","4,7,-12","4,7,-11","4,7,-10","4,7,-9","4,7,-8","4,7,-7","4,7,-6","4,7,-5","4,7,-4","4,7,-3","4,7,-2","4,7,-1","4,7,0","4,7,1","4,7,2","4,7,3","4,7,4","4,7,5","4,7,6","4,7,7","4,7,8","4,7,9","4,7,10","4,7,11","4,7,12","4,7,13","4,7,14","4,7,15","4,8,-15","4,8,-14","4,8,-13","4,8,-12","4,8,-11","4,8,-10","4,8,-9","4,8,-8","4,8,-7","4,8,-6","4,8,-5","4,8,-4","4,8,-3","4,8,-2","4,8,-1","4,8,0","4,8,1","4,8,2","4,8,3","4,8,4","4,8,5","4,8,6","4,8,7","4,8,8","4,8,9","4,8,10","4,8,11","4,8,12","4,8,13","4,8,14","4,8,15","4,9,-15","4,9,-14","4,9,-13","4,9,-12","4,9,-11","4,9,-10","4,9,-9","4,9,-8","4,9,-7","4,9,-6","4,9,-5","4,9,-4","4,9,-3","4,9,-2","4,9,-1","4,9,0","4,9,1","4,9,2","4,9,3","4,9,4","4,9,5","4,9,6","4,9,7","4,9,8","4,9,9","4,9,10","4,9,11","4,9,12","4,9,13","4,9,14","4,9,15","4,10,-15","4,10,-14","4,10,-13","4,10,-12","4,10,-11","4,10,-10","4,10,-9","4,10,-8","4,10,-7","4,10,-6","4,10,-5","4,10,-4","4,10,-3","4,10,-2","4,10,-1","4,10,0","4,10,1","4,10,2","4,10,3","4,10,4","4,10,5","4,10,6","4,10,7","4,10,8","4,10,9","4,10,10","4,10,11","4,10,12","4,10,13","4,10,14","4,10,15","4,11,-15","4,11,-14","4,11,-13","4,11,-12","4,11,-11","4,11,-10","4,11,-9","4,11,-8","4,11,-7","4,11,-6","4,11,-5","4,11,-4","4,11,-3","4,11,-2","4,11,-1","4,11,0","4,11,1","4,11,2","4,11,3","4,11,4","4,11,5","4,11,6","4,11,7","4,11,8","4,11,9","4,11,10","4,11,11","4,11,12","4,11,13","4,11,14","4,11,15","4,12,-15","4,12,-14","4,12,-13","4,12,-12","4,12,-11","4,12,-10","4,12,-9","4,12,-8","4,12,-7","4,12,-6","4,12,-5","4,12,-4","4,12,-3","4,12,-2","4,12,-1","4,12,0","4,12,1","4,12,2","4,12,3","4,12,4","4,12,5","4,12,6","4,12,7","4,12,8","4,12,9","4,12,10","4,12,11","4,12,12","4,12,13","4,12,14","4,12,15","5,0,-16","5,0,-15","5,0,-14","5,0,-13","5,0,-12","5,0,-11","5,0,-10","5,0,-9","5,0,-8","5,0,-7","5,0,-6","5,0,-5","5,0,-4","5,0,-3","5,0,-2","5,0,-1","5,0,0","5,0,1","5,0,2","5,0,3","5,0,4","5,0,5","5,0,6","5,0,7","5,0,8","5,0,9","5,0,10","5,0,11","5,0,12","5,0,13","5,0,14","5,0,15","5,0,16","5,1,-15","5,1,-14","5,1,-13","5,1,-12","5,1,-11","5,1,-10","5,1,-9","5,1,-8","5,1,-7","5,1,-6","5,1,-5","5,1,-4","5,1,-3","5,1,-2","5,1,-1","5,1,0","5,1,1","5,1,2","5,1,3","5,1,4","5,1,5","5,1,6","5,1,7","5,1,8","5,1,9","5,1,10","5,1,11","5,1,12","5,1,13","5,1,14","5,1,15","5,2,-15","5,2,-14","5,2,-13","5,2,-12","5,2,-11","5,2,-10","5,2,-9","5,2,-8","5,2,-7","5,2,-6","5,2,-5","5,2,-4","5,2,-3","5,2,-2","5,2,-1","5,2,0","5,2,1","5,2,2","5,2,3","5,2,4","5,2,5","5,2,6","5,2,7","5,2,8","5,2,9","5,2,10","5,2,11","5,2,12","5,2,13","5,2,14","5,2,15","5,3,-15","5,3,-14","5,3,-13","5,3,-12","5,3,-11","5,3,-9","5,3,-8","5,3,-7","5,3,-6","5,3,-5","5,3,-4","5,3,-3","5,3,-2","5,3,-1","5,3,0","5,3,1","5,3,2","5,3,3","5,3,4","5,3,5","5,3,6","5,3,7","5,3,8","5,3,9","5,3,10","5,3,11","5,3,12","5,3,13","5,3,14","5,3,15","5,4,-15","5,4,-14","5,4,-13","5,4,-12","5,4,-11","5,4,-10","5,4,-9","5,4,-8","5,4,-7","5,4,-6","5,4,-5","5,4,-4","5,4,-3","5,4,-2","5,4,-1","5,4,0","5,4,1","5,4,2","5,4,3","5,4,4","5,4,5","5,4,6","5,4,7","5,4,8","5,4,9","5,4,10","5,4,11","5,4,12","5,4,13","5,4,14","5,4,15","5,5,-15","5,5,-14","5,5,-13","5,5,-12","5,5,-11","5,5,-10","5,5,-9","5,5,-8","5,5,-7","5,5,-6","5,5,-5","5,5,-4","5,5,-3","5,5,-2","5,5,-1","5,5,0","5,5,1","5,5,2","5,5,3","5,5,4","5,5,5","5,5,6","5,5,7","5,5,8","5,5,9","5,5,10","5,5,11","5,5,12","5,5,13","5,5,14","5,5,15","5,6,-15","5,6,-14","5,6,-13","5,6,-12","5,6,-11","5,6,-10","5,6,-9","5,6,-8","5,6,-7","5,6,-6","5,6,-5","5,6,-4","5,6,-3","5,6,-2","5,6,-1","5,6,0","5,6,1","5,6,2","5,6,3","5,6,4","5,6,5","5,6,6","5,6,7","5,6,8","5,6,9","5,6,10","5,6,11","5,6,12","5,6,13","5,6,14","5,6,15","5,7,-15","5,7,-14","5,7,-13","5,7,-12","5,7,-11","5,7,-10","5,7,-9","5,7,-8","5,7,-7","5,7,-6","5,7,-5","5,7,-4","5,7,-3","5,7,-2","5,7,-1","5,7,0","5,7,1","5,7,2","5,7,3","5,7,4","5,7,5","5,7,6","5,7,7","5,7,8","5,7,9","5,7,10","5,7,11","5,7,12","5,7,13","5,7,14","5,7,15","5,8,-15","5,8,-14","5,8,-13","5,8,-12","5,8,-11","5,8,-10","5,8,-9","5,8,-8","5,8,-7","5,8,-6","5,8,-5","5,8,-4","5,8,-3","5,8,-2","5,8,-1","5,8,0","5,8,1","5,8,2","5,8,3","5,8,4","5,8,5","5,8,6","5,8,7","5,8,8","5,8,9","5,8,10","5,8,11","5,8,12","5,8,13","5,8,14","5,8,15","5,9,-15","5,9,-14","5,9,-13","5,9,-12","5,9,-11","5,9,-10","5,9,-9","5,9,-8","5,9,-7","5,9,-6","5,9,-5","5,9,-4","5,9,-3","5,9,-2","5,9,-1","5,9,0","5,9,1","5,9,2","5,9,3","5,9,4","5,9,5","5,9,6","5,9,7","5,9,8","5,9,9","5,9,10","5,9,11","5,9,12","5,9,13","5,9,14","5,9,15","5,10,-15","5,10,-14","5,10,-13","5,10,-12","5,10,-11","5,10,-10","5,10,-9","5,10,-8","5,10,-7","5,10,-6","5,10,-5","5,10,-4","5,10,-3","5,10,-2","5,10,-1","5,10,0","5,10,1","5,10,2","5,10,3","5,10,4","5,10,5","5,10,6","5,10,7","5,10,8","5,10,9","5,10,10","5,10,11","5,10,12","5,10,13","5,10,14","5,10,15","5,11,-15","5,11,-14","5,11,-13","5,11,-12","5,11,-11","5,11,-10","5,11,-9","5,11,-8","5,11,-7","5,11,-6","5,11,-5","5,11,-4","5,11,-3","5,11,-2","5,11,-1","5,11,0","5,11,1","5,11,2","5,11,3","5,11,4","5,11,5","5,11,6","5,11,7","5,11,8","5,11,9","5,11,10","5,11,11","5,11,12","5,11,13","5,11,14","5,11,15","5,12,-15","5,12,-14","5,12,-13","5,12,-12","5,12,-11","5,12,-10","5,12,-9","5,12,-8","5,12,-7","5,12,-6","5,12,-5","5,12,-4","5,12,-3","5,12,-2","5,12,-1","5,12,0","5,12,1","5,12,2","5,12,3","5,12,4","5,12,5","5,12,6","5,12,7","5,12,8","5,12,9","5,12,10","5,12,11","5,12,12","5,12,13","5,12,14","5,12,15","6,0,-16","6,0,-15","6,0,-14","6,0,-13","6,0,-12","6,0,-11","6,0,-10","6,0,-9","6,0,-8","6,0,-7","6,0,-6","6,0,-5","6,0,-4","6,0,-3","6,0,-2","6,0,-1","6,0,0","6,0,1","6,0,2","6,0,3","6,0,4","6,0,5","6,0,6","6,0,7","6,0,8","6,0,9","6,0,10","6,0,11","6,0,12","6,0,13","6,0,14","6,0,15","6,0,16","0,2,4","1,2,5","0,2,5","-1,2,5","0,3,4","0,4,4","-1,5,4","-1,4,4","-1,3,5","1,5,4","1,5,5","1,4,4","-1,5,5","-1,4,5","0,4,5","0,3,5","1,3,5","1,4,5","1,6,4","1,6,5","1,7,5","1,8,5","0,7,5","0,7,4","0,8,5","0,8,4","-1,8,5","-1,6,4","-1,7,5","-1,6,5","3,5,9","3,8,9","3,7,9","3,6,9","-3,8,9","-3,7,9","-3,6,9","-3,5,9","3,5,13","3,6,13","3,7,13","3,8,13","-3,8,13","-3,7,13","-3,6,13","-3,5,13","-4,8,12","2,1,3","1,1,3","0,1,3","-2,1,3","-1,1,3","1,1,2","1,1,1","1,1,0","1,1,-1","1,1,-2","1,1,-3","2,1,-3","-1,1,0","-1,1,2","-1,1,1","-2,1,-3","-1,1,-3","-1,1,-2","-1,1,-1","0,1,2","0,1,1","0,1,0","0,1,-1","0,1,-2","0,1,-3","0,6,5","0,6,4","4,3,-1","4,3,-10","-4,4,-6"]);
                        return (x, y, z) => solids.has(x + ',' + y + ',' + z);
                    })()).build();

            case 2: // THE SHAFTS
                return builder.setBounds(10, 25, 18).setSpawn(0, 2, -15).setExit(0, 16, 15)
                    .addHologram("TOOLS ARE MOBILE\nBring the foundation with you.", 0, 3, -12)
                    .addEntity('blue', 0, 2, -8) 
                    .addCustomLogic((x, y, z) => {
                        if (roomBox(x, y, z, 8, 22, 17)) return true;
                        if (z < -2 && y <= 1) return true;
                        if (z >= 0 && z <= 8 && ((y >= 6 && y <= 7) || (Math.abs(x) <= 2 && y <= 6))) return true;
                        if (z > -2 && z < 14 && y <= 0) return false; // Void pit
                        if (z > 12 && y >= 14 && y <= 15) return true;
                        return y <= 0;
                    }).build();

            case 3: // THE PENTHOUSE
                return builder.setBounds(8, 18, 8).setSpawn(0, 2, 6).setExit(0, 12.5, 6)
                    .addHologram("RED BLOCK: Look & [SCROLL WHEEL] to Scale", 0, 2.5, 4)
                    .addEntity('red', 0, 1.45, 1.5, { startScale: 2.9 })
                    .addCustomLogic((x, y, z) => { 
                        if (roomBox(x, y, z, 7, 18, 8)) return true;
                        if (x >= -2 && x <= 2 && z >= 3 && z <= 7 && y <= 5) return false; 
                        if (x >= -1 && x <= 1 && z >= 1 && z <= 2 && y <= 4) return false; 
                        if (x >= -5 && x <= 5 && z >= -7 && z <= 0) { 
                            if (x >= -2 && x <= 2) { let stairY = Math.min(6, Math.max(0, -z * 1.2)); if (y > stairY) return false; } 
                            else { if (y > 6) return false; } 
                        } 
                        if (x >= -5 && x <= 5 && z >= 1 && z <= 7 && y > 6) { 
                            if (x >= -2 && x <= 2 && z >= 5 && z <= 7 && y <= 11) return true; return false; 
                        } 
                        return true; 
                    }).build();

            case 4: // THE WELL
                return builder.setBounds(10, 15, 20).setSpawn(0, 7, -16).setExit(0, 7, 15)
                    .addEntity('yellow', 0, 7, -12).setWater(3.5, { color: 0x003366, distortionScale: 1.8 })
                    .addCustomLogic((x, y, z) => {
                        if (roomBox(x, y, z, 9, 14, 18)) return true;
                        if (Math.abs(z) >= 5 && y <= 6) return true; // Start and Exit ledges
                        if (x <= -6 && x >= -9 && z > -5 && z <= 1 && y <= Math.floor(1 - z) + 1 && y <= 6) return true; // Recovery stairs
                        return y <= 0;
                    }).build();

            case 5: // THE TOWER
                return builder.setBounds(12, 30, 12).setSpawn(0, 2, -10).setExit(0, 25, 0)
                    .addHologram("Expansion builds bridges.", 0, 3, -7)
                    .addEntity('red', 0, 2, -4, { startScale: 1.0 })
                    .addCustomLogic((x, y, z) => {
                        const r = Math.sqrt(x*x + z*z);
                        if (r >= 11 || y >= 29) return true; // Outer Shell
                        if (r <= 3 && y <= 24) return true;  // Center Pillar

                        // Winding broken spiral of ledges
                        if (r > 3 && r < 7) {
                            if (x > 0 && z > 0 && y <= 6) return true; // Ledge 1
                            if (x < 0 && z > 0 && y > 8 && y <= 12) return true; // Ledge 2
                            if (x < 0 && z < 0 && y > 14 && y <= 18) return true; // Ledge 3
                            if (x > 0 && z < 0 && y > 20 && y <= 24) return true; // Ledge 4
                        }
                        if (r < 11 && y <= 0) return false; // Bottomless pit around spawn
                        if (r > 8 && r < 11 && z < -4 && y <= 1) return true; // Spawn ledge
                        return false; 
                    }).build();

            case 6: // THE TUNNEL

            case 7: // THE LEDGES
                return builder.setBounds(6, 20, 10).setSpawn(0, 2, -8).setExit(0, 16, 8)
                    .addHologram("Combine your tools to reach the summit.", 0, 2.5, -5)
                    .addEntity('red', 0, 2, -2, { startScale: 1.5 }).addEntity('blue', 0, 9, 2)
                    .addCustomLogic((x, y, z) => { 
                        if (roomBox(x, y, z, 5, 20, 9)) return true; 
                        if (z >= 0 && z <= 4 && y <= 8) return true; // Mid ledge
                        if (y < 15 && z >= 6) return true; // High ledge
                        return y <= 0;
                    }).build();

            case 8: // THE CROSSING
                return builder.setBounds(9, 17, 13).setSpawn(0, 10, -9).setExit(0, 10, 9)
                    .addEntity('yellow', 3, 3, 4).addEntity('yellow', -3, 3, 4)
                    .addDestructionZone(-6, 7, -2, 4, 7).addDestructionZone(6, 11, -5, 4, 7)
                    .addCustomLogic((x, y, z) => {
                        if (roomBox(x, y, z, 8, 16, 12)) return true;
                        if (z < -5 && y <= 8) return true; // Spawn balcony
                        if (z > 5 && y <= 9) return true;  // Exit balcony
                        return y <= 0;
                    }).build();

            case 9: // THE ROTUNDA
                return builder.setBounds(12, 30, 12).setSpawn(0, 2, -9).setExit(0, 25, 0)
                    .addEntity('blue', 0, 2, -4).addEntity('red', 4, 2, 0).addEntity('yellow', -4, 2, 0)
                    .addCustomLogic((x, y, z) => { 
                        const r = Math.sqrt(x*x + z*z);
                        if (r >= 10 || y >= 29) return true; // Outer cylinder shell
                        if (r <= 2 && y <= 24) return true; // Center pillar
                        if (r > 6 && r < 10 && y < 20) return Math.sin(x*0.5) * Math.cos(z*0.5) > 0; // Broken spiral
                        return y <= 0; 
                    }).build();

            default: return builder.build();
        }
    }

    // ── CHAPTER 2: THE ARCHIVE ───────────────────────────────────────────────
    function getLevelParamsV2(lvl) {
        const builder = new LevelBuilder(lvl, LEVEL_NAMES[10 + lvl]); 
        switch (lvl) {
            case 0: // THE SPIRAL
                return builder.setBounds(12, 20, 12)
                    .setSpawn(8, 2, 8) // Moved spawn to the far corner
                    .setExit(0, 2, 0)
                    .setCutscene('flyover')

                    // --- THE ONLY CUBE ---
                    .addEntity('gray', 8, 2, 8)

                    // --- DOOR 1 (East Corridor - Ground Level) ---
                    .addPlate(6, 0, 3, 1)
                    .addDoor(6, 3, -1, { channel: 1, dir: 'left', width: 6, height: 6, moveDist: 5.8, normal: {x:0, y:0, z:1} })

                    // --- DOOR 2 (North Corridor - Mid Ramp) ---
                    .addPlate(2, 2, -6, 2)
                    .addDoor(-3, 7, -6, { channel: 2, dir: 'left', width: 6, height: 6, moveDist: 5.8, normal: {x:1, y:0, z:0} })

                    // --- DOOR 3 (West Corridor - High Balcony) ---
                    .addPlate(-6, 6, -1, 3)
                    .addDoor(-6, 9, 4, { channel: 3, dir: 'left', width: 6, height: 6, moveDist: 5.8, normal: {x:0, y:0, z:-1} })

                    // --- THE MASTER PLATE ---
                    .addPlate(3, 0, 7, 4) 
                    // Changed y from 3 to 9 so it properly rests on the high balcony (y=6)
                    .addDoor(0, 9, 3, { channel: 4, dir: 'up', width: 4, height: 6, moveDist: 5.8, normal: {x:0, y:0, z:1} })

                    // --- ATMOSPHERIC LIGHTING ---
                    .addLight(6, 6, 7, 0xffaa44, 4, 15)        
                    .addLight(6, 6, -6, 0xffffff, 3, 15)       
                    .addLight(-6, 11, -6, 0xffffff, 3, 15)     
                    .addLight(-6, 11, 6, 0x44aaff, 3.5, 15)    
                    .addLight(0, 6, 8, 0x44ffaa, 4, 12)        
                    .addLight(0, 5, 0, 0xaaddff, 6, 15)        

                    // --- HIGH DESTRUCTION ZONE ---
                    // Moved way up to the ceiling at Y=10 to clear the central passage
                    .addDestructionZone(0, 18, 0, 5, 8)

                    // --- SPACIOUS SPIRAL ARCHITECTURE ---
                    .addCustomLogic((x, y, z) => {
                        if (y <= 0 || y >= 11) return true; // Floor and Ceiling
                        if (x > 9 || x < -9 || z > 9 || z < -9) return true; // Outer Shell

                        // Center Core
                        if (x >= -3 && x <= 3 && z >= -3 && z <= 3) {
                            // Clear exit interior and core passage
                            if (x >= -2 && x <= 2 && z >= -2 && z <= 3 && y <= 9) {
                                // --- THE SECOND MISSING WALL ---
                                // Seal the ground floor under the high-balcony door to prevent walking straight into the exit
                                if (z === 3 && y <= 6) return true; 
                                return false; 
                            }
                            return true;
                        }

                        // Spiral Ramps
                        if (z >= -9 && z <= -4) {
                            let stairY = Math.floor((6 - x) / 2); 
                            if (y <= Math.max(0, Math.min(6, stairY))) return true;
                        }
                        if (x >= -9 && x <= -4 && y <= 6) return true;
                        if (z >= 4 && z <= 9 && x >= -9 && x <= 0 && y <= 6) return true;

                        // --- THE FIRST MISSING WALL ---
                        // Seals the East corridor gap above Door 1
                        if (x >= 3 && x <= 9 && z === -1 && y >= 6) return true;

                        // Seals the East corridor gap above Door 1 
                        if (x >= 3 && x <= 9 && z === -1 && y >= 6) return true;

                        return false;
                    }).build();

            case 1: // THE INTERLOCK - TRUE LOGIC EDITION
                return builder.setBounds(6, 12, 20)
                    .setSpawn(0, 2, 16)
                    .setExit(0, 2, -14)
                    .setCutscene('flyover')

                    // --- DESTRUCTION ZONE (Moved far outside to prevent shattering) ---
                    .addDestructionZone(100, 100, 100, 1, 1) 

                    // --- THE ONLY TWO BLOCKS ---
                    .addEntity('gray', -2.5, 2, 14)
                    .addEntity('green', 2.5, 2, 14)

                    // --- THE AIRLOCK LOGIC SETUP ---
                    .addPlate(0, 1, 12, 1) // Plate 1 (In Spawn Room)
                    .addPlate(0, 1, 4, 2)  // Plate 2 (In the Middle Airlock)

                    // Gate 1: Slides LEFT into the wall. Opens if Plate 1 is pressed.
                    .addDoor(0, 3, 8, { channel: 1, dir: 'left', width: 4.5, height: 6, moveDist: 4.5 })

                    // Gate 2: Slides RIGHT into the wall. Opens if Plate 2 is pressed AND Plate 1 is EMPTY.
                    .addLogicGate(4, 'NOT', [1])       // Ch 4 = True when Plate 1 is empty
                    .addLogicGate(5, 'AND', [2, 4])    // Ch 5 = Plate 2 AND (NOT Plate 1)
                    .addDoor(0, 3, 0, { channel: 5, dir: 'right', width: 4.5, height: 6, moveDist: 4.5 })

                    // --- ARCHITECTURAL LIGHTING ---
                    .addLight(0, 8, 14, 0xffeedd, 3, 15)  // Warm start room
                    .addLight(0, 8, 4, 0xaaddff, 2, 12)   // Cool blue airlock
                    .addLight(0, 8, -10, 0x44ffaa, 3, 15) // Green exit vault

                    .addCustomLogic((x, y, z) => {
                        const absX = Math.abs(x);
                        const absZ = Math.abs(z);

                        // 1. The Outer Shell (Brutalist thick walls)
                        if (absX > 5 || absZ > 18 || y > 10) return true;

                        // 2. The Floor
                        if (y <= 1) return true;

                        // 3. WALL 1: The First Door Frame (Z = 8)
                        if (z === 8) {
                            // Hole is exactly 4 units wide and 6 units high
                            if (absX <= 2 && y <= 6) return false; 
                            return true;
                        }

                        // 4. WALL 2: The Second Door Frame (Z = 0)
                        if (z === 0) {
                            if (absX <= 2 && y <= 6) return false; 
                            return true;
                        }

                        // 5. Brutalist Ribs (Adds architectural depth to the walls)
                        if (absX === 5 && (z === 16 || z === 12 || z === 4 || z === -4 || z === -12)) {
                            return true;
                        }

                        return y <= 0;
                    }).build();
            case 2: // THE TUBE - VERTICAL ARCHITECTURE
                return builder.setBounds(7, 19, 7)
                    .setSpawn(0, 1, 5) // Spawns player on the top floor
                    .setExit(0, 10, -5)  // Exit is on the bottom floor, behind the one-way field
                    .setCutscene('flyover')

                    .addDestructionZone(100, 100, 100, 1, 1) 

                    // --- THE ONLY CUBE ---
                    // Push it down the central hole
                    .addEntity('gray', 0, 10, -4)

                    // --- THE BOTTOM PLATE ---
                    // Located inside the empty pillar on the ground floor
                    .addPlate(0, 0, 0, 1) 

                    // --- DOOR ACCESS (Bottom Floor +Z Side) ---
                    // Method: addDoor(x, y, z, { channel, dir, width, height, moveDist, normal })
                    .addDoor(0, 4, 2, { 
                        channel: 1, 
                        dir: 'up', 
                        width: 3, 
                        height: 8, 
                        moveDist: 7.8, 
                        normal: {x:0, y:0, z:1} 
                    })

                    // --- THE ONE-WAY FIELD (Bottom Floor -Z Side) ---
                    // Method: addOneWayField(x, y, z, channel, inverted, w, h, normal)
                    // Note: Using channel 9 (dummy) so it's always active, normal {z:1} faces INWARD.
                    .addOneWayField(0, 4, -2, 9, false, 3, 8, {x:0, y:0, z:1})

                    // --- TUBE ATMOSPHERICS ---
                    .addLight(0, 14, 0, 0xaaddff, 5, 15)   
                    .addLight(0, 5, 0, 0xffaa44, 4, 12)    
                    .addLight(0, 5, 5, 0xffffff, 4, 12)    
                    .addLight(0, 5, -5, 0x44ffaa, 4, 12)   

                    // --- GEOMETRY ARCHITECTURE ---
                    .addCustomLogic((x, y, z) => {
                        const absX = Math.abs(x);
                        const absZ = Math.abs(z);

                        // 1. Level Bounds & Outer Shell 
                        if (absX > 6 || absZ > 6 || y >= 18 || y <= 0) return true;

                        // 2. The Mid-Floor Divider 
                        if (y === 9) {
                            if (absX <= 1 && absZ <= 1) return false; 
                            return true;
                        }

                        // 3. The Central Empty Pillar (Bottom floor only: y 1 to 8)
                        if (y >= 1 && y <= 8) {
                            if (absX <= 2 && absZ <= 2) {
                                if (absX <= 1 && absZ <= 1) return false; // Tube hollow
                                if (z === 2 && absX <= 1) return false;   // Door slot
                                if (z === -2 && absX <= 1) return false;  // One-way slot
                                return true;
                            }
                        }
                        return false;
                    }).build();
            default: return builder.build();
        }
    }

    // ── CHAPTER 3: THE CITADEL ───────────────────────────────────────────────
    function getLevelParamsV3(lvl) {
        const builder = new LevelBuilder(lvl, LEVEL_NAMES[20 + lvl]); 
        switch (lvl) {
            default: return builder.build();
        }
    }

    function clearCurrentLevel() {
        for (let k in counts) { 
            counts[k] = 0; 
            if (meshes[k]) {
                meshes[k].count = 0; 
                meshes[k].instanceMatrix.needsUpdate = true;
            } 
        }
        levelBodies.forEach(b => world.removeBody(b)); levelBodies.length = 0;
        levelConstraints.forEach(c => world.removeConstraint(c)); levelConstraints.length = 0;

        // --- ADDED: CLEANUP PLATES ---
        activePlates.forEach(p => {
            world.removeBody(p.body);
            scene.remove(p.group);
            // Dispose specific cloned materials
            if (p.lensMat) p.lensMat.dispose();
            if (p.coreMat) p.coreMat.dispose();
        });
        activePlates.length = 0;

        // --- ADDED: CLEANUP DOORS ---
        activeDoors.forEach(d => {
            world.removeBody(d.body);
            scene.remove(d.group);
            // Traverse door group to dispose of unique glass materials
            d.group.traverse(child => {
                if (child.material) child.material.dispose();
            });
        });
        activeDoors.length = 0;

        // --- UPDATED: RESET LOGIC ENGINE & FIELDS ---
        logicNodes.inputs.fill(false);
        logicNodes.resolved.fill(false);
        if (!isEditorMode && !isPlayingCustom) {
            logicNodes.configs = {};
        }

        activeFields.forEach(f => {
            world.removeBody(f.body);
            scene.remove(f.group);
            // Clean up materials to prevent memory leaks
            if (f.mesh && f.mesh.material) f.mesh.material.dispose();
            if (f.arrow && f.arrow.material) f.arrow.material.dispose();
        });
        activeFields.length = 0;

        _activeDecorationMeshes.forEach(m => scene.remove(m)); _activeDecorationMeshes.length = 0;

        levelGeometries.forEach(g => g.dispose()); levelGeometries.length = 0;
        levelMaterials.forEach(m => m.dispose());  levelMaterials.length = 0;

        levelMeshes.forEach(m => { scene.remove(m); }); levelMeshes.length = 0;
        levelLights.forEach(l => { scene.remove(l); }); levelLights.length = 0;

        // ... rest of your existing function ...
        if (typeof _lightSortArray !== 'undefined') {
            for (let i = 0; i < _lightSortArray.length; i++) _lightSortArray[i].light = null;
        }

        dynamicRopes.forEach(r => { r.segmentMeshes.forEach(mesh => { scene.remove(mesh); }); });
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
            currentGoal.traverse(obj => { if (obj.geometry) obj.geometry.dispose(); if (obj.material) obj.material.dispose(); });
        }

        holograms.forEach(h => { scene.remove(h.sprite); h.sprite.material.map.dispose(); h.sprite.material.dispose(); 
            if (h.light) scene.remove(h.light); if (h.baseMesh) scene.remove(h.baseMesh);
        }); holograms.length = 0;

        wallLightPanelMesh.count = 0; wallLightPanelCount = 0;

        levelLights.forEach(l => scene.remove(l));
        levelLights.length = 0;

        dynamicSyncList.length = 0;

        interactiveBlocks.length = 0; interactiveTargets.length = 0;
        meshToBlock.clear();
        grabbedBlock = null; exitMesh = null; waterMesh = null; currentGoal = null; currentGreenBlock = null;
        pendingBounce = false; pendingBounceBlock = null; AudioSys.focusElement = null;

        // Guard: purge any undefined/null children THREE may have accumulated
        // (caused by removing objects mid-traversal elsewhere in the codebase)
        scene.children = scene.children.filter(Boolean);

        const coreObjects = [];
        scene.traverse((obj) => { if (obj.userData && obj.userData.core) { coreObjects.push(obj); } });
        coreObjects.forEach(obj => scene.remove(obj));
    }

    const bgGroup = new THREE.Group();
    scene.add(bgGroup);

    // 1. Procedural Internal Fracture Texture
    function createProceduralCrystalTexture() {
        const size = 1024;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        
        // Base mid-tone
        ctx.fillStyle = '#808080';
        ctx.fillRect(0, 0, size, size);

        // Draw sharp, intersecting linear gradients to simulate internal stress fractures
        for (let i = 0; i < 200; i++) {
            const x = Math.random() * size;
            const y = Math.random() * size;
            const length = 50 + Math.random() * 300;
            const angle = Math.random() * Math.PI * 2;
            
            const x2 = x + Math.cos(angle) * length;
            const y2 = y + Math.sin(angle) * length;

            const grad = ctx.createLinearGradient(x, y, x2, y2);
            const intensity = Math.random();
            grad.addColorStop(0, `rgba(255, 255, 255, ${intensity * 0.5})`);
            grad.addColorStop(1, `rgba(0, 0, 0, ${intensity * 0.5})`);
            
            ctx.fillStyle = grad;
            
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x2, y2);
            ctx.lineTo(x + (Math.random() - 0.5) * length, y + (Math.random() - 0.5) * length);
            ctx.fill();
        }
        
        const texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        // Stretch vertically so the fractures travel up the crystal shaft
        texture.repeat.set(1, 3); 
        
        return texture;
    }

    // ── CRYSTAL STRUCTURE FACTORY ─────────────────────────────────────────────
    // Creates an InstancedMesh of hexagonal crystals arranged in clusters.
    //
    // pos             – THREE.Vector3  – world-space anchor for the cluster field
    // spreadRadius    – number         – how far clusters scatter around pos (XZ plane)
    // clusterCount    – number         – how many crystal clusters to generate
    // crystalsPerCluster – number      – spires per cluster
    // hueCenter       – 0-1            – centre HSL hue for color variation
    // hueRange        – 0-1            – total hue variation around hueCenter
    // options         – object         – overrides for scale / tilt behaviour:
    //   mainHeightMin/Max   – height range for the tallest crystal in each cluster
    //   sideHeightMin/Max   – height range for secondary crystals
    //   thicknessMin/Max    – XZ scale range (equal for hex cross-section)
    //   depthVariance       – how many units below pos.y clusters can embed
    //   tiltMain            – max radians of tilt for the primary crystal
    //   tiltSide            – max radians of outward splay for secondary crystals
    function createCrystalStructure(pos, spreadRadius, clusterCount, crystalsPerCluster, hueCenter, hueRange, options) {
        const opts = Object.assign({
            mainHeightMin: 100, mainHeightMax: 350,
            sideHeightMin: 30,  sideHeightMax: 100,
            thicknessMin: 60,   thicknessMax: 75,
            depthVariance: 18,
            tiltMain: 0.2,
            tiltSide: 0.6
        }, options);

        const crystalTexture = createProceduralCrystalTexture();

        // Hexagonal prism tapering to a point at the top
        const crystalGeo = new THREE.CylinderGeometry(0, 0.5, 1, 6);
        crystalGeo.translate(0, 0.5, 0); // pivot at base

        const crystalMat = new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            flatShading: true,          // keeps facets sharp — critical for the look
            transparent: true,
            opacity: 0.85,
            transmission: 0.9,
            ior: 2.2,
            thickness: 15.0,
            clearcoat: 1.0,
            clearcoatRoughness: 0.0,
            metalness: 0.1,
            roughness: 0.2,
            roughnessMap: crystalTexture // simulates cloudy internal fractures
        });

        const totalInstances = clusterCount * crystalsPerCluster;
        const mesh = new THREE.InstancedMesh(crystalGeo, crystalMat, totalInstances);
        mesh.userData.mega = true;

        const _d = new THREE.Object3D();
        const _col = new THREE.Color();
        let idx = 0;

        for (let c = 0; c < clusterCount; c++) {
            // Scatter clusters around pos in XZ
            const angle  = Math.random() * Math.PI * 2;
            const dist   = spreadRadius * (0.2 + Math.random() * 0.8);
            const cx     = pos.x + Math.cos(angle) * dist;
            const cz     = pos.z + Math.sin(angle) * dist;
            const cy     = pos.y - Math.random() * opts.depthVariance;

            const clusterHue = hueCenter + (Math.random() - 0.5) * hueRange;

            for (let i = 0; i < crystalsPerCluster; i++) {
                _d.position.set(cx, cy, cz);
                _d.rotation.set(0, 0, 0);

                const isMain = (i === 0);
                if (isMain) {
                    // Primary spire — nearly vertical with subtle wobble
                    _d.rotateX((Math.random() - 0.5) * opts.tiltMain);
                    _d.rotateZ((Math.random() - 0.5) * opts.tiltMain);
                } else {
                    // Secondary spires — splay outward like a blooming flower
                    const tiltDir = Math.random() * Math.PI * 2;
                    const tiltAmt = (opts.tiltSide * 0.5) + Math.random() * (opts.tiltSide * 0.5);
                    _d.rotation.y = tiltDir;
                    _d.rotateZ(tiltAmt);
                }
                _d.rotateY(Math.random() * Math.PI * 2); // random face rotation

                const thickness = opts.thicknessMin + Math.random() * (opts.thicknessMax - opts.thicknessMin);
                const height = isMain
                    ? opts.mainHeightMin + Math.random() * (opts.mainHeightMax - opts.mainHeightMin)
                    : opts.sideHeightMin + Math.random() * (opts.sideHeightMax - opts.sideHeightMin);

                _d.scale.set(thickness, height, thickness);
                _d.updateMatrix();
                mesh.setMatrixAt(idx, _d.matrix);

                const hue        = clusterHue + (Math.random() - 0.5) * 0.05;
                const saturation = 0.6 + Math.random() * 0.4;
                const lightness  = 0.4 + Math.random() * 0.4;
                _col.setHSL(hue, saturation, lightness);
                mesh.setColorAt(idx, _col);

                idx++;
            }
        }

        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

        return mesh;
    }

    // 2. The Main Function — populates the far background with crystal fields
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

        // Single large InstancedMesh — 70 clusters × 8 crystals = 560 instances
        const megaMesh = createCrystalStructure(
            new THREE.Vector3(0, -65, 0), // anchor deep underground at world origin
            220,  // scatter radius 80-260 units from centre
            70,   // clusters
            8,    // crystals per cluster
            0.55, // hue centre (cyan-teal)
            0.45, // wide hue range (cyan → amethyst)
            {
                mainHeightMin: 100, mainHeightMax: 350,
                sideHeightMin: 30,  sideHeightMax: 100,
                thicknessMin: 60,   thicknessMax: 75,
                depthVariance: 18,
                tiltMain: 0.2,
                tiltSide: 0.6
            }
        );

        bgGroup.add(megaMesh);
    }

    const waterNormalTex = createWaterNormalTexture();

    function buildLevel(lvlIndex, isPreview = false, isReset = false, keepPos = false) {            
        const rng = splitmix32(5); 
        clearCurrentLevel(); 
        // createMegaStructures();
        currentParams = getLevelParams(lvlIndex);

        // Tear down any previous hub
        if (hubRuntime.active) hubRuntime.dispose();
        isHubWorld = (lvlIndex === HUB_LEVEL_INDEX);

        // Spawn level lights declared via builder.addLight()
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

        // Spawn decoration props for custom levels (not during preview)
        if ((lvlIndex === 'CUSTOM' || (typeof lvlIndex === 'string' && lvlIndex.startsWith('CUSTOM_'))) && !isPreview) {
            // For CUSTOM_ slots, load decorations from saved data
            if (typeof lvlIndex === 'string' && lvlIndex.startsWith('CUSTOM_')) {
                const slot = parseInt(lvlIndex.replace('CUSTOM_', ''));
                const savedData = customLevels[slot];
                if (savedData && savedData.decorations) {
                    const savedDecs = customDecorations;
                    customDecorations = savedData.decorations;
                    spawnCustomDecorations();
                    customDecorations = savedDecs;
                }
            } else {
                spawnCustomDecorations();
            }
        }
        // Reset logic configs before loading level-specific ones
        logicNodes.configs = {}; 
        if (currentParams.logic) {
            currentParams.logic.forEach(l => {
                logicNodes.configs[l.ch] = { 
                    type: l.type, 
                    source: l.operands ? l.operands[0] : null, 
                    sources: l.operands || [],
                    operands: l.operands || [] // keeping both for compatibility
                };
            });
        }

        if (currentParams.cutscene && !isPreview && !isReset) {
            const mainMenu = document.getElementById('main-menu');
            if (mainMenu && mainMenu.style.display === 'none') {
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
            if(!isPreview && !isMontageCutscene) { 
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

        // Build new winds from params
        if (currentParams.winds && !isPreview) {
            currentParams.winds.forEach(wData => {
                const wind = {
                    pos: wData.pos.clone().applyQuaternion(globalTiltThree),
                    size: wData.size.clone(),
                    dir: wData.dir.clone().applyQuaternion(globalTiltThree),
                    strength: wData.strength,
                };

                // Create Visual Wind Streams (Lines instead of Points)
                const lineCount = Math.floor(wData.size.x * wData.size.y * wData.size.z * 2.5);
                const geo = new THREE.BufferGeometry();
                const posArray = new Float32Array(lineCount * 6); // 2 verts per line
                const opacities = new Float32Array(lineCount * 2);
                const speeds = new Float32Array(lineCount);

                for(let i=0; i<lineCount; i++) {
                    let x = (Math.random()-0.5) * wData.size.x * 2;
                    let y = (Math.random()-0.5) * wData.size.y * 2;
                    let z = (Math.random()-0.5) * wData.size.z * 2;

                    let len = 0.5 + (Math.random() * wData.strength * 0.1);

                    posArray[i*6+0] = x; posArray[i*6+1] = y; posArray[i*6+2] = z;
                    posArray[i*6+3] = x; posArray[i*6+4] = y; posArray[i*6+5] = z - len; // Extrude back

                    opacities[i*2+0] = 0.0; // Head fades out
                    opacities[i*2+1] = Math.random() * 0.5 + 0.2; // Tail is visible

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
                wind.speeds = speeds; // Store speeds for animation

                scene.add(wind.visuals);
                activeWinds.push(wind);
            });
        }

        if(!isPreview) document.getElementById('level-title').innerText = currentParams.name;

        applyAtmosphere(activeChapter);

        const grid = new Map();
        const bX = currentParams.bounds.x, bY = currentParams.bounds.y, bZ = currentParams.bounds.z;

        for (let x = -bX - 1; x <= bX + 1; x++) {
            for (let y = -1; y <= bY + 1; y++) {
                for (let z = -bZ - 1; z <= bZ + 1; z++) {
                    if (currentParams.isSolid(x, y, z)) grid.set(`${x},${y},${z}`, { x, y, z, exposed: [] });
                }
            }
        }

        const neighbors = [ {dx:1,dy:0,dz:0},{dx:-1,dy:0,dz:0},{dx:0,dy:1,dz:0},{dx:0,dy:-1,dz:0},{dx:0,dy:0,dz:1},{dx:0,dy:0,dz:-1} ];
        const finalVisible = []; 
        // Build destruction zone list: use level params or fall back to single top-center hole
        const destroyZones = (currentParams.destructionZones && currentParams.destructionZones.length > 0)
            ? currentParams.destructionZones
            : [{ cx: 0, cy: bY * 0.82, cz: 0, innerRadius: 8, outerRadius: 11 }];

        grid.forEach(blk => {
            let isExp = false;
            for (let n of neighbors) { 
                if (!grid.has(`${blk.x+n.dx},${blk.y+n.dy},${blk.z+n.dz}`)) { blk.exposed.push(n); isExp = true; } 
            }
            if (isExp) {
                // Find closest destruction zone
                let minDist = Infinity;
                let closestInner = 8, closestOuter = 11;
                let noise = Math.sin(blk.x * 2.5) * Math.cos(blk.z * 2.5) * 1.5;
                for (const dz of destroyZones) {
                    const dx = blk.x - dz.cx, dy = blk.y - dz.cy, ddzz = blk.z - dz.cz;
                    const d = Math.sqrt(dx*dx + dy*dy + ddzz*ddzz) + noise;
                    if (d < minDist) { minDist = d; closestInner = dz.innerRadius; closestOuter = dz.outerRadius; }
                }

                if (minDist < closestInner) { 
                    if (rng() < 0.65) { grid.delete(`${blk.x},${blk.y},${blk.z}`); return; } 
                    blk.isBroken = true; 
                } else if (minDist < closestOuter) {
                    if (rng() < 0.4) blk.isBroken = true; 
                }
                finalVisible.push(blk);
            }
        });

        const visMap = new Map(); 
        finalVisible.forEach(b => visMap.set(`${b.x},${b.y},${b.z}`, b));
        const merged = new Set(); 
        const blocksToRender = [];
        const ceilingAnchors = []; 
        const wallAnchors = []; 
        const topSurfaces = [];

        finalVisible.forEach(b => {
            if (b.y >= 8 && b.exposed.some(n => n.dy === -1)) ceilingAnchors.push(new THREE.Vector3(b.x, b.y - 0.5, b.z).applyQuaternion(globalTiltThree));
            else if (b.y < 8 && b.y > 2 && b.exposed.some(n => n.dx !== 0 || n.dz !== 0)) wallAnchors.push(new THREE.Vector3(b.x, b.y, b.z).applyQuaternion(globalTiltThree));
            if (!b.isBroken && b.exposed.some(n => n.dy === 1)) topSurfaces.push(new THREE.Vector3(b.x, b.y + 0.5, b.z).applyQuaternion(globalTiltThree));

            let key = `${b.x},${b.y},${b.z}`; 
            if (merged.has(key)) return;

            let placed2x2 = false;
            if (rng() < 0.5) {
                let k2 = `${b.x+1},${b.y},${b.z}`, k3 = `${b.x},${b.y},${b.z+1}`, k4 = `${b.x+1},${b.y},${b.z+1}`;
                if (visMap.has(k2) && !merged.has(k2) && visMap.has(k3) && !merged.has(k3) && visMap.has(k4) && !merged.has(k4)) {
                    merged.add(key).add(k2).add(k3).add(k4);
                    blocksToRender.push({ type: '2x1x2', x: b.x+0.5, y: b.y, z: b.z+0.5, isBroken: b.isBroken || visMap.get(k2).isBroken || visMap.get(k3).isBroken || visMap.get(k4).isBroken }); placed2x2 = true;
                } else {
                    k2 = `${b.x+1},${b.y},${b.z}`; k3 = `${b.x},${b.y+1},${b.z}`; k4 = `${b.x+1},${b.y+1},${b.z}`;
                    if (visMap.has(k2) && !merged.has(k2) && visMap.has(k3) && !merged.has(k3) && visMap.has(k4) && !merged.has(k4)) {
                        merged.add(key).add(k2).add(k3).add(k4);
                        blocksToRender.push({ type: '2x2x1', x: b.x+0.5, y: b.y+0.5, z: b.z, isBroken: b.isBroken || visMap.get(k2).isBroken || visMap.get(k3).isBroken || visMap.get(k4).isBroken }); placed2x2 = true;
                    } else {
                        k2 = `${b.x},${b.y},${b.z+1}`; k3 = `${b.x},${b.y+1},${b.z}`; k4 = `${b.x},${b.y+1},${b.z+1}`;
                        if (visMap.has(k2) && !merged.has(k2) && visMap.has(k3) && !merged.has(k3) && visMap.has(k4) && !merged.has(k4)) {
                            merged.add(key).add(k2).add(k3).add(k4);
                            blocksToRender.push({ type: '1x2x2', x: b.x, y: b.y+0.5, z: b.z+0.5, isBroken: b.isBroken || visMap.get(k2).isBroken || visMap.get(k3).isBroken || visMap.get(k4).isBroken }); placed2x2 = true;
                        }
                    }
                }
            }
            if (!placed2x2) blocksToRender.push({ type: '1x1x1', x: b.x, y: b.y, z: b.z, isBroken: b.isBroken, exposed: b.exposed });
        });

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
            let rx=0, ry=0, rz=0;
            let scaleVal = 1.0;

            if (blk.isBroken) {
                if (rng() > 0.3) { 
                    _v1.y -= rng() * 0.3; 
                    _v1.x += (rng()-0.5)*0.25;
                    _v1.z += (rng()-0.5)*0.25;
                    rx = (rng()-0.5)*0.3; ry = (rng()-0.5)*0.1; rz = (rng()-0.5)*0.3; 
                    scaleVal = 0.85 + rng() * 0.15;
                }
            } else {
                _v1.add(_v2.set((rng()-0.5)*0.08, (rng()-0.5)*0.08, (rng()-0.5)*0.08)); 
                rx = (rng()-0.5)*0.03; ry = (rng()-0.5)*0.03; rz = (rng()-0.5)*0.03;
            }

            _v1.applyQuaternion(globalTiltThree); 
            _q1.setFromEuler(new THREE.Euler(rx, ry, rz)).premultiply(globalTiltThree);
            dummy.position.copy(_v1); 
            dummy.quaternion.copy(_q1); 
            dummy.scale.setScalar(scaleVal); 
            dummy.updateMatrix();

            let meshType = 'wall';
            if (blk.y <= 0) {
                meshType = 'floor'; 
            } else if (blk.isBroken) {
                meshType = 'broken';
            }

            let meshKey = meshType + blk.type;
            if (meshes[meshKey] && counts[meshKey] < maxCounts[meshKey]) {
                if (isMontageCutscene) {
                    expandAnimData.push({
                        meshKey: meshKey,
                        index: counts[meshKey],
                        pos: dummy.position.clone(),
                        quat: dummy.quaternion.clone(),
                        targetScale: scaleVal,
                        dist: Math.sqrt(blk.x*blk.x + blk.y*blk.y + blk.z*blk.z)
                    });
                }
                meshes[meshKey].setMatrixAt(counts[meshKey]++, dummy.matrix);
            }

            if(!isPreview) staticTileBody.addShape(shapes[blk.type], new CANNON.Vec3(physGX, physGY, physGZ));

            // Volumetric Light Cones (Improved Visuals)
            if (!blk.isBroken && blk.type === '1x1x1' && blk.y > 2 && blk.y < 8 && blk.exposed && blk.exposed.length === 1 && blk.exposed[0].dy === 0 && rng() > 0.96) {
                const norm = blk.exposed[0]; 
                const lightPos = _v2.set(blk.x + norm.dx * 0.4, blk.y, blk.z + norm.dz * 0.4).applyQuaternion(globalTiltThree);

                const panelDummy = new THREE.Object3D();
                panelDummy.position.copy(lightPos).addScaledVector(new THREE.Vector3(norm.dx, 0, norm.dz), 0.02);
                panelDummy.lookAt(panelDummy.position.x + norm.dx, panelDummy.position.y, panelDummy.position.z + norm.dz);

                // Minor random panel deformations for a worn aesthetic
                panelDummy.updateMatrix();
                if (wallLightPanelCount < 200) { wallLightPanelMesh.setMatrixAt(wallLightPanelCount++, panelDummy.matrix); }

                // Color theme shifted by active chapter + slight random variation
                const baseColors = [0xffeedd, 0xffddaa, 0xccffff];
                const chColor = new THREE.Color(baseColors[activeChapter] || 0xffeedd);
                chColor.lerp(new THREE.Color(0xffffff), rng() * 0.4);

                const pLight = addVolumetricPointLight(
                    lightPos.clone().addScaledVector(new THREE.Vector3(norm.dx, 0, norm.dz), 0.8), // Pushed out further
                    chColor.getHex(),
                    2.5 + (rng() * 1.0), // Variable intensity
                    12.0 + (rng() * 8.0) // Variable dropoff
                );
            }

            // User Placed Lights
            if (currentParams.lightPositions) {
                for (const lp of currentParams.lightPositions) {
                    if (lp.x === blk.x && lp.y === blk.y && lp.z === blk.z) {
                        const norm = blk.exposed[0]; 
                        const lightPos = _v2.set(blk.x + norm.dx * 0.48, blk.y, blk.z + norm.dz * 0.48).applyQuaternion(globalTiltThree);

                        const panelDummy = new THREE.Object3D();
                        panelDummy.position.copy(lightPos).addScaledVector(new THREE.Vector3(norm.dx, 0, norm.dz), 0.04);
                        panelDummy.lookAt(panelDummy.position.x + norm.dx, panelDummy.position.y, panelDummy.position.z + norm.dz);
                        panelDummy.updateMatrix();
                        if (wallLightPanelCount < 200) { wallLightPanelMesh.setMatrixAt(wallLightPanelCount++, panelDummy.matrix); }

                        const pLight = addVolumetricPointLight(
                            lightPos.clone().addScaledVector(new THREE.Vector3(norm.dx, 0, norm.dz), 0.6),
                            0xffeedd,
                            3.5,      
                            16.0
                        );
                    }
                }
            }
        });

        if(!isPreview) { 
            world.addBody(staticTileBody); 
            levelBodies.push(staticTileBody); 
        }

        for (const k in meshes) { 
            meshes[k].count = counts[k]; 
            meshes[k].instanceMatrix.needsUpdate = true; 
            if(counts[k] > 0) meshes[k].computeBoundingSphere(); 
        }

        wallLightPanelMesh.count = wallLightPanelCount; 
        wallLightPanelMesh.instanceMatrix.needsUpdate = true;

        // =====================================================================
        // DECAL SYSTEM – stains, cracks, and sector markings break up tiling
        // =====================================================================
        if (!isPreview) {
            // ── Create / reuse shared canvas textures (once per session) ─────────
            if (!window._decalTextures) {
                const makeCtx = (w, h) => {
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    return [c, c.getContext('2d')];
                };

                // Improved Noise: Adds grit and micro-porosity to the dark stains
                const addNoise = (ctx, w, h) => {
                    const id = ctx.getImageData(0, 0, w, h);
                    const d  = id.data;
                    for (let i = 0; i < d.length; i += 4) {
                        if (d[i+3] < 2) continue; 
                        const n = (Math.random() - 0.5) * 30; // Subtle value jitter
                        d[i]   = Math.min(40, Math.max(0, d[i]   + n));
                        d[i+1] = Math.min(40, Math.max(0, d[i+1] + n));
                        d[i+2] = Math.min(40, Math.max(0, d[i+2] + n));
                        // Micro-porosity: small alpha-punches make it look absorbed into stone
                        if (Math.random() > 0.92) d[i+3] *= 0.5;
                    }
                    ctx.putImageData(id, 0, 0);
                };

                const buildStain = (cfg) => {
                    const S = 512, H = S / 2;
                    const [sc, sctx] = makeCtx(S, S);
                    sctx.clearRect(0, 0, S, S);

                    // ── Layer 1: Core Absorption (Fractal Edge) ──────────────
                    for (let i = 0; i < cfg.anchors; i++) {
                        const cx = H + (Math.random()-0.5) * cfg.spread * S;
                        const cy = H + (Math.random()-0.5) * cfg.spread * S;
                        const baseR = cfg.minR + Math.random() * cfg.rangeR;

                        for (let j = 0; j < 12; j++) {
                            const ang = Math.random() * Math.PI * 2;
                            const off = Math.random() * baseR * 0.4;
                            const rx = baseR * (0.7 + Math.random() * 0.4);
                            const ry = rx * (cfg.minAsp + Math.random() * cfg.rangeAsp);
                            const rot = Math.random() * Math.PI;

                            const g = sctx.createRadialGradient(0, 0, 0, 0, 0, rx);
                            // Dark-only Coffee Ring: Edge is pitch black, center is dark gray
                            g.addColorStop(0,   cfg.mid);
                            g.addColorStop(0.8, cfg.dark); 
                            g.addColorStop(1,   'rgba(0,0,0,0)');

                            sctx.save();
                            sctx.translate(cx + Math.cos(ang)*off, cy + Math.sin(ang)*off);
                            sctx.rotate(rot);
                            sctx.scale(1, ry/rx);
                            sctx.fillStyle = g;
                            sctx.globalAlpha = 0.25; 
                            sctx.beginPath(); sctx.arc(0, 0, rx, 0, Math.PI*2); sctx.fill();
                            sctx.restore();
                        }
                    }

                    // ── Layer 2: Erosion (Uneven concrete absorption) ───────
                    sctx.globalCompositeOperation = 'destination-out';
                    for (let i = 0; i < 35; i++) {
                        const ex = Math.random() * S, ey = Math.random() * S;
                        const er = 4 + Math.random() * 25;
                        const eg = sctx.createRadialGradient(ex, ey, 0, ex, ey, er);
                        eg.addColorStop(0, `rgba(255,255,255,${0.2 + Math.random()*0.4})`);
                        eg.addColorStop(1, 'rgba(255,255,255,0)');
                        sctx.fillStyle = eg;
                        sctx.beginPath(); sctx.arc(ex, ey, er, 0, Math.PI*2); sctx.fill();
                    }
                    sctx.globalCompositeOperation = 'source-over';

                    // ── Layer 3: Pores & Drips ──────────────────────────────
                    sctx.lineCap = 'round';
                    for (let t = 0; t < cfg.tendrils; t++) {
                        const sx = H + (Math.random()-0.5)*0.5*S;
                        const sy = H + (Math.random()-0.5)*0.5*S;
                        const len = cfg.tendrilLen * (0.6 + Math.random());
                        sctx.strokeStyle = cfg.streak;
                        sctx.lineWidth = 0.8 + Math.random() * cfg.tendrilW;
                        sctx.globalAlpha = 0.4;
                        sctx.beginPath();
                        sctx.moveTo(sx, sy);
                        sctx.lineTo(sx, sy + len); // Vertical gravity drips
                        sctx.stroke();
                    }

                    addNoise(sctx, S, S);
                    const tex = new THREE.CanvasTexture(sc);
                    tex.anisotropy = 4;
                    return tex;
                };

                // Dark grayscale only (Values 0-35)
                const SEEP_CONFIGS = [
                    // 0 – Heavy Dampness (Near Black)
                    { anchors:3, spread:0.18, minR:45, rangeR:55, minAsp:0.8, rangeAsp:0.2,
                      satellites:15, satR:10, tendrils:5, tendrilLen:60, tendrilW:2.5, 
                      dark:'rgba(2,2,2,1.0)', mid:'rgba(12,12,12,0.6)', streak:'rgba(0,0,0,0.5)' },

                    // 1 – Broad Grime Wash (Deep Charcoal)
                    { anchors:2, spread:0.3, minR:70, rangeR:90, minAsp:0.9, rangeAsp:0.1,
                      satellites:8, satR:20, tendrils:2, tendrilLen:40, tendrilW:1.5, 
                      dark:'rgba(10,10,10,0.8)', mid:'rgba(18,18,18,0.4)', streak:'rgba(5,5,5,0.3)' },

                    // 2 – Vertical Oil Leak (Pitch Black, high density)
                    { anchors:4, spread:0.1, minR:15, rangeR:25, minAsp:0.2, rangeAsp:0.4,
                      satellites:10, satR:8, tendrils:14, tendrilLen:130, tendrilW:3, 
                      dark:'rgba(0,0,0,1.0)', mid:'rgba(5,5,5,0.8)', streak:'rgba(0,0,0,0.8)' },

                    // 3 – Soot/Carbon Build (Previously light, now deep soot)
                    { anchors:6, spread:0.4, minR:30, rangeR:40, minAsp:0.7, rangeAsp:0.3,
                      satellites:25, satR:6, tendrils:0, tendrilLen:0, tendrilW:0, 
                      dark:'rgba(4,4,4,1.0)', mid:'rgba(14,14,14,0.5)', streak:'rgba(2,2,2,0.4)' },

                    // 4 – Porous Pitting (Deep concrete holes)
                    { anchors:8, spread:0.5, minR:5, rangeR:15, minAsp:0.5, rangeAsp:0.5,
                      satellites:50, satR:4, tendrils:6, tendrilLen:25, tendrilW:1.2, 
                      dark:'rgba(0,0,0,1.0)', mid:'rgba(8,8,8,0.9)', streak:'rgba(0,0,0,0.7)' },

                    // 5 – Cold Industrial Sludge (Deep dark teal-gray)
                    { anchors:3, spread:0.25, minR:55, rangeR:65, minAsp:0.7, rangeAsp:0.3,
                      satellites:12, satR:15, tendrils:8, tendrilLen:70, tendrilW:2.2, 
                      dark:'rgba(5,7,9,0.9)', mid:'rgba(12,14,16,0.5)', streak:'rgba(2,3,4,0.4)' },

                    // 6 – Mold Core (Slightly blue-tinted void)
                    { anchors:5, spread:0.2, minR:35, rangeR:45, minAsp:0.6, rangeAsp:0.4,
                      satellites:30, satR:12, tendrils:3, tendrilLen:40, tendrilW:2.0, 
                      dark:'rgba(1,1,3,1.0)', mid:'rgba(8,8,12,0.6)', streak:'rgba(0,0,0,0.5)' },

                    // 7 – Corroded Slime (Previously warm, now dark burnt-umber black)
                    { anchors:3, spread:0.2, minR:50, rangeR:70, minAsp:0.7, rangeAsp:0.3,
                      satellites:15, satR:18, tendrils:5, tendrilLen:55, tendrilW:2.0, 
                      dark:'rgba(8,6,4,0.9)', mid:'rgba(16,14,12,0.5)', streak:'rgba(6,4,2,0.4)' },
                ];

                const stainTextures = SEEP_CONFIGS.map(cfg => buildStain(cfg));
                window._decalTextures = { stainTextures };
            }

            const dt = window._decalTextures;

            // One-off MeshBasicMaterial, sits flush on surface
            const mkDecalMat = (tex, opacity) => {
                const m = new THREE.MeshBasicMaterial({
                    map: tex, transparent: true, opacity,
                    depthWrite: false,
                    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
                    blending: THREE.NormalBlending,
                    side: THREE.DoubleSide
                });
                levelMaterials.push(m);
                return m;
            };

            // Place a plane decal correctly oriented to its surface normal + global tilt
            const placeDecal = (geo, mat, rawPos, faceNormal, rollRad = 0) => {
                const faceVec = new THREE.Vector3(faceNormal.dx||0, faceNormal.dy||0, faceNormal.dz||0).normalize();
                const alignQ  = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), faceVec);
                const rollQ   = new THREE.Quaternion().setFromAxisAngle(faceVec, rollRad);
                const localQ  = rollQ.multiply(alignQ);
                localQ.premultiply(globalTiltThree);

                const mesh = new THREE.Mesh(geo, mat);
                mesh.position.copy(new THREE.Vector3(rawPos.x, rawPos.y, rawPos.z).applyQuaternion(globalTiltThree));
                mesh.quaternion.copy(localQ);
                mesh.renderOrder = 1;
                mesh.layers.set(1); // exclude from SSAO (see camera layer patch)
                mesh.matrixAutoUpdate = false;
                mesh.updateMatrix();
                scene.add(mesh);
                levelMeshes.push(mesh);
                levelGeometries.push(geo);
            };

            let decalCount = 0;
            const MAX_DECALS = 120;
            const T = dt.stainTextures;

            finalVisible.forEach(b => {
                if (b.isBroken || decalCount >= MAX_DECALS) return;

                b.exposed.forEach(n => {
                    if (decalCount >= MAX_DECALS) return;
                    const roll = rng();

                    // ── Floor stains – top face, y ≤ 1 ────────────────────────────
                    if (n.dy === 1 && b.y <= 1 && roll < 0.22) {
                        decalCount++;
                        const v   = Math.floor(rng() * T.length);
                        const sz  = 0.7 + rng() * 1.2;
                        const geo = new THREE.PlaneGeometry(sz, sz * (0.7 + rng() * 0.6));

                        // Change the "0.55 + rng()*0.30" to something lower like "0.20 + rng()*0.20"
                        placeDecal(geo, mkDecalMat(T[v], 0.20 + rng() * 0.20),
                            { x: b.x+(rng()-0.5)*0.5, y: b.y+0.502, z: b.z+(rng()-0.5)*0.5 },
                            { dy: 1 }, rng()*Math.PI*2);

                    // ── Wall stains – side face, y ≥ 3 ────────────────────────────
                    } else if (n.dy === 0 && b.y >= 3 && b.y <= 9 && roll < 0.10) {
                        decalCount++;
                        const v   = Math.floor(rng() * T.length);
                        const nx  = n.dx, nz = n.dz;
                        const w   = 0.6 + rng()*1.0;
                        const h   = 0.5 + rng()*1.1;
                        const geo = new THREE.PlaneGeometry(w, h);

                        // Change the "0.45 + rng()*0.30" to something lower like "0.15 + rng()*0.20"
                        placeDecal(geo, mkDecalMat(T[v], 0.15 + rng() * 0.20),
                            {
                                x: b.x + nx*0.502 + (rng()-0.5)*(nz!==0?0.5:0),
                                y: b.y + (rng()-0.5)*0.35,
                                z: b.z + nz*0.502 + (rng()-0.5)*(nx!==0?0.5:0)
                            },
                            { dx: nx, dy: 0, dz: nz }, (rng()-0.5)*0.35);
                    }
                });
            });
        }
        // =====================================================================
        // END DECAL SYSTEM
        // =====================================================================

        const ropeSegGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 5);
        ropeSegGeo.rotateX(Math.PI / 2); 
        dynamicRopes._sharedGeo = ropeSegGeo; 


        // ==========================================
        // DYNAMIC BLOCKS & DAMAGE SYSTEM HOOKS
        // ==========================================
        currentParams.blocks.forEach(bData => {
            const config = blockConfigs[bData.type]; 

            // SAFETY CHECK: Skip if this isn't a dynamic/interactive block type
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

            if(bData.type === 'yellow' || bData.type === 'big_yellow') { body.type = CANNON.Body.KINEMATIC; }

            _q1.setFromEuler(new THREE.Euler(rng(), rng(), rng())).premultiply(globalTiltThree); 
            body.quaternion.set(_q1.x, _q1.y, _q1.z, _q1.w); 

            if(!isPreview) {
                body.addEventListener("collide", (e) => { 
                    // Resolve which interactive block was hit, and how hard.
                    // These were previously referenced but never declared, breaking all
                    // block-on-block mechanics (cyan swap, blue overcharge).
                    const hitBlock = interactiveBlocks.find(b => b.body === e.body) || null;
                    const relVel = e.contact ? Math.abs(e.contact.getImpactVelocityAlongNormal()) : 0;

                    // CHAPTER 3: BLUE OVERCHARGE MECHANIC
                    if (hitBlock && hitBlock.type === 'blue') {
                        if (body.type !== CANNON.Body.KINEMATIC) {
                            body.velocity.y = hitBlock.overcharged ? 40 : 21;

                            // Massive momentum (heavy red block falling) overcharges the pad
                            if (relVel > 12 && body.mass > 100) {
                                hitBlock.overcharged = true;
                                hitBlock.mat.emissive.setHex(0xffffff); // Flash bright white
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
                body, mesh, mat, 
                scale: isRed ? startScale : undefined, 
                initialPos: initPos, 
                initialScale: startScale, 
                hasBeenGrabbed: false 
            };

            interactiveBlocks.push(blockObj); 
            meshToBlock.set(mesh, blockObj);
            interactiveTargets.push(mesh);
            if (bData.type === 'green') currentGreenBlock = blockObj;

            if(isPreview) { 
                mesh.position.copy(_v1); 
                mesh.quaternion.copy(_q1); 
                mesh.updateMatrix(); 
            }
        });

        // Exit/Goal setup
        const exitPos = currentParams.exit; 
        currentGoal = createGoal(exitPos.x, exitPos.y, exitPos.z, currentParams.lockedExit);
        scene.add(currentGoal); 
        currentGoal.quaternion.copy(globalTiltThree);

        // Water Shader Setup — triggered by level params waterY
        if (currentParams.waterY !== undefined) {
            const wOpts = currentParams.waterOptions || {};
            const WAVES = {
                A: new THREE.Vector4( 1.0,  0.3, 0.04, 4.0 ),
                B: new THREE.Vector4( 0.4,  1.0, 0.03, 2.5 ),
                C: new THREE.Vector4(-0.7,  0.8, 0.02, 1.5 ),
                D: new THREE.Vector4( 0.2, -0.9, 0.01, 1.0 ),
            };

            waveTime = 0; 

            const waterGeometry = new THREE.PlaneGeometry(60, 60, 128, 128);
            waterNormalTex.repeat.set(4, 4);

            waterMesh = new Water(waterGeometry, {
                textureWidth:    512, // Higher res reflections
                textureHeight:   512,
                waterNormals:    waterNormalTex,
                sunDirection:    sunLight.position.clone().normalize(),
                sunColor:        0xffffff, // Brighter sun hit
                waterColor:      wOpts.color || 0x002a4a, // Deeper base color
                distortionScale: wOpts.distortionScale || 3.5, // More distortion
                fog:             scene.fog !== undefined,
                alpha:           wOpts.alpha || 0.88,
            });

            waterMesh.rotation.x = -Math.PI / 2;
            waterMesh.position.y =  currentParams.waterY;
            waterMesh.receiveShadow = true;

            waterMesh.material.onBeforeCompile = (shader) => {
                shader.uniforms.waveA    = { value: WAVES.A };
                shader.uniforms.waveB    = { value: WAVES.B };
                shader.uniforms.waveC    = { value: WAVES.C };
                shader.uniforms.waveD    = { value: WAVES.D };
                shader.uniforms.waveTime = { value: 0 };
                waterMesh.userData.waveShader = shader;

                shader.vertexShader = `
                    uniform vec4 waveA;
                    uniform vec4 waveB;
                    uniform vec4 waveC;
                    uniform vec4 waveD;
                    uniform float waveTime;
                    vec3 gerstner(vec4 wave, vec3 p) {
                        float k  = 6.28318 / wave.w;           
                        float c  = sqrt(9.81 / k);             
                        vec2  d  = normalize(wave.xy);
                        float f  = k * (dot(d, p.xz) - c * waveTime);
                        float a  = wave.z / k;                 
                        return vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
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
            };

            const wm = waterMesh.material;
            wm.transparent = true;
            wm.depthWrite  = false;
            wm.side        = THREE.FrontSide;

            if (wm.uniforms.alpha)           wm.uniforms.alpha.value           = 0.88;
            if (wm.uniforms.distortionScale) wm.uniforms.distortionScale.value = 1.8;
            if (wm.uniforms.size)            wm.uniforms.size.value            = 4.0;

            scene.add(waterMesh);
            levelMeshes.push(waterMesh);
        }

        if (currentParams.holograms && !isPreview) {
            currentParams.holograms.forEach(h => { holograms.push(createHologram(h.text, h.pos)); });
        }

        if (!keepPos) {
            _v1.copy(currentParams.spawn).applyQuaternion(globalTiltThree);
            playerBody.position.set(_v1.x, _v1.y, _v1.z); 
            playerBody.velocity.set(0,0,0); 
            playerBody.angularVelocity.set(0,0,0);
            smoothCamY = _v1.y + playerHalfH * 0.85; 

            if(!isPreview) {
                const center = new THREE.Vector3(0, smoothCamY, 0);
                const spawnPos = new THREE.Vector3(_v1.x, smoothCamY, _v1.z);
                camera.position.lerpVectors(spawnPos, center, 0.2); 
            } else {
                previewAngle = currentMontageIdx * Math.PI / 2;
            }
        } else {
            smoothCamY = playerBody.position.y + playerHalfH * 0.85;
        }

        cubeCamera.position.copy(currentParams.spawn).applyQuaternion(globalTiltThree);
        cubeCamera.position.y += 4.0; 

        // Environment mapping updates
        interactiveTargets.forEach(mesh => mesh.visible = false);
        dustMesh.visible = false;
        sparkMesh.visible = false;

        cubeCamera.update(renderer, scene);

        interactiveTargets.forEach(mesh => mesh.visible = true);
        if (gfx.particles > 0) dustMesh.visible = true;
        sparkMesh.visible = true;

        if (scene.environment) scene.environment.dispose();
        scene.environment = pmremGenerator.fromCubemap(cubeRenderTarget.texture).texture;

        // Cutscene / Montage setups
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

        // ── HUB WORLD RUNTIME INIT ────────────────────────────────────────────
        if (isHubWorld && !isPreview) {
            hubRuntime.init(
                scene,
                createCrystalStructure,
                hubProgress,
                {
                    onEnterGate: (gateId, ch, _firstLvl) => {
                        if (isTransitioning) return;
    
                        const gate = GATE_BY_ID[gateId];
                        // Store return info
                        hubProgress.returnGateId  = gateId;
                        hubProgress.returnChapter = activeChapter;
                        hubProgress.returnLevel   = currentLevel;
                        saveHubProgress(hubProgress);
    
                        // Find first incomplete level in gate
                        const nextLvl = gate.levels.find((l, i) =>
                            !hubProgress.completedLevels[`${gateId}_${i}`]
                        ) ?? gate.levels[0];
    
                        activeChapter = gate.ch;
                        currentLevel  = nextLvl;
                        SaveSystem.save();
    
                        const fo = document.getElementById('fade-overlay');
                        fo.style.transition = 'opacity 0.4s ease-in-out'; fo.style.opacity = 1;
                        setTimeout(() => {
                            buildLevel(currentLevel, false);
                            fo.style.transition = 'opacity 0.4s ease-in-out'; fo.style.opacity = 0;
                        }, 420);
                    },
                }
            );
        }
    }

    function createGoal(x, y, z, isLocked) {
        const goalGroup = new THREE.Group(); goalGroup.position.set(x, y, z);
        const col = isLocked ? 0xff0000 : 0x00ffff;

        const coreGeo = new THREE.OctahedronGeometry(0.25);
        const core = new THREE.Mesh(coreGeo, new THREE.MeshPhysicalMaterial({ 
            color: col, emissive: col, emissiveIntensity: 3, toneMapped: false,
            roughness: 0.1, metalness: 0.8, clearcoat: 1.0 
        }));

        const shellGeo = new THREE.IcosahedronGeometry(0.45, 1);
        const shellMat = new THREE.MeshBasicMaterial({ color: col, wireframe: true, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending });
        const shell = new THREE.Mesh(shellGeo, shellMat);

        core.add(shell);
        goalGroup.add(core);
        goalGroup.userData.core = core;
        goalGroup.userData.shell = shell;
        goalGroup.userData.isLocked = isLocked || false;

        return goalGroup;
    }

    const montageLevels = [1, 4, 5, 7, 9];
    let currentMontageIdx = 0;

    function showEndingSequence() {
        isPreviewMode = true;
        controls.unlock();

        // Hide UI elements
        document.getElementById('crosshair').style.opacity = '0';
        document.getElementById('blocker').style.display = 'none';
        document.getElementById('scale-hud').style.opacity = '0';

        // Reset ending overlay state so it's fresh
        const endOvr = document.getElementById('ending-overlay');
        const endTitle = document.getElementById('ending-title');
        const prompt = document.getElementById('ending-prompt');
        const lines = document.querySelectorAll('.ending-line');

        endOvr.classList.remove('visible');
        endTitle.style.opacity = '0';
        prompt.classList.remove('lit');
        lines.forEach(l => l.classList.remove('lit'));

        // Start the fade
        const fo = document.getElementById('fade-overlay');
        fo.style.transition = 'opacity 1s ease-in-out';
        fo.style.opacity = '1';

        isCutscene = true; 
        cutsceneType = 'montage'; 

        // Start the montage after the fade completes
        setTimeout(() => {
            currentMontageIdx = 0;
            playMontageStep();
        }, 1200);
    }

    function playMontageStep() {
        if (currentMontageIdx >= montageLevels.length) {
            // Which chapter just ended?
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
            setTimeout(() => {
                playMontageStep();
            }, 800);
        }, 3200); 
    }

    // ── CHAPTER 3 CUTSCENE ───────────────────────────────────────────────────
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

        for(let i=2; i<lines.length; i++) {
            lines[i].style.display = 'none';
        }

        prompt.innerText = "— ENTER —";

        endOvr.classList.add('visible');
        const fo = document.getElementById('fade-overlay');
        fo.style.opacity = '0'; 

        // Animate the chapter title
        setTimeout(() => { endTitle.style.opacity = '1'; }, 400);
        setTimeout(() => { lines[0].classList.add('lit'); lines[0].style.color = ''; }, 1200);
        setTimeout(() => { lines[1].classList.add('lit'); lines[1].style.color = ''; }, 2200);
        setTimeout(() => { prompt.classList.add('lit'); }, 3500);

        // Glitchy flicker effect on the title
        let glitchCount = 0;
        const glitchInterval = setInterval(() => {
            if (++glitchCount > 6) { clearInterval(glitchInterval); endTitle.style.opacity = '1'; return; }
            endTitle.style.opacity = glitchCount % 2 === 0 ? '1' : '0.3';
        }, 180);
        setTimeout(() => clearInterval(glitchInterval), 1500);

        const dismiss = () => {
            endOvr.classList.remove('visible');
            endTitle.style.opacity = '0';
            lines.forEach(l => { l.classList.remove('lit'); l.style.color = ''; l.style.display = 'none'; lines[0].style.display = 'block'; });
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
                setTimeout(() => {
                    const ch3Btn = document.querySelector('.ch-toggle-btn[data-ch="2"]');
                    if (ch3Btn) { ch3Btn.classList.add('unlock-anim'); }
                }, 100);

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

                setTimeout(() => {
                    document.querySelector('.ch-toggle-btn[data-ch="2"]')?.classList.remove('unlock-anim');
                    // Restore lines for normal use
                    for(let i=0; i<lines.length; i++) lines[i].style.display = 'block';
                }, 2500);
            }, 500);
        };
        prompt.addEventListener('click', dismiss);
    }

    // ── FINAL ENDING (after ch3) ─────────────────────────────────────────────
    function showFinalEndingTitle() {
        const endOvr = document.getElementById('ending-overlay');
        const endTitle = document.getElementById('ending-title');
        const lines = document.querySelectorAll('.ending-line');
        const prompt = document.getElementById('ending-prompt');
        const ch = CHAPTERS[activeChapter];

        endTitle.innerText = ch.title + " — COMPLETE";
        endTitle.style.fontSize = "18px";
        endTitle.style.letterSpacing = "8px";

        ch.ending.forEach((txt, i) => {
            if (lines[i]) { lines[i].innerText = txt; lines[i].style.display = 'block'; lines[i].style.color = ''; }
        });
        for (let i = ch.ending.length; i < lines.length; i++) {
            if (lines[i]) lines[i].style.display = 'none';
        }

        prompt.innerText = "— RETURN —";

        endOvr.classList.add('visible');
        const fo = document.getElementById('fade-overlay');
        fo.style.opacity = '0';

        setTimeout(() => { endTitle.style.opacity = '1'; }, 400);
        ch.ending.forEach((_, i) => {
            setTimeout(() => { if(lines[i]) lines[i].classList.add('lit'); }, 1400 + i * 900);
        });
        setTimeout(() => { prompt.classList.add('lit'); }, 1400 + ch.ending.length * 900 + 800);

        const dismiss = () => {
            endOvr.classList.remove('visible');
            endTitle.style.opacity = '0';
            lines.forEach(l => l.classList.remove('lit'));
            prompt.classList.remove('lit');
            prompt.removeEventListener('click', dismiss);
            fo.style.transition = 'opacity 0.4s ease-in-out';
            fo.style.opacity = '1';
            setTimeout(() => {
                isPreviewMode = true; isTransitioning = false; isCutscene = false;
                currentLevel = 0;
                buildLevel(0, true);
                populateLevelList();
                document.getElementById('preview-title').innerText = getLevelName(0);
                const lsOverlay = document.getElementById('level-select-overlay');
                lsOverlay.style.display = 'flex'; lsOverlay.style.opacity = '0';
                lsOverlay.style.transition = 'opacity 0.8s ease-in-out';
                setTimeout(() => { lsOverlay.style.opacity = '1'; fo.style.transition = 'opacity 0.8s ease-in-out'; fo.style.opacity = '0'; }, 100);
            }, 500);
        };
        prompt.addEventListener('click', dismiss);
    }

    function showChapter2Title() {
        const endOvr = document.getElementById('ending-overlay');
        const endTitle = document.getElementById('ending-title');
        const lines = document.querySelectorAll('.ending-line');
        const prompt = document.getElementById('ending-prompt');

        endTitle.innerText = "CHAPTER 2";
        endTitle.style.fontSize = "36px";
        endTitle.style.letterSpacing = "15px";

        lines[0].innerText = "THE DESCENT";
        lines[0].style.fontSize = "16px";
        lines[0].style.color = "rgba(160,200,240,0.0)"; 

        for(let i=1; i<lines.length; i++) {
            lines[i].style.display = 'none';
        }

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
                // Animate the newly revealed ch2 button
                setTimeout(() => {
                    const ch2Btn = document.querySelector('.ch-toggle-btn[data-ch="1"]');
                    if (ch2Btn) ch2Btn.classList.add('unlock-anim');
                }, 100);

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

                setTimeout(() => {
                    endTitle.innerText = "THE ROTUNDA — COMPLETE";
                    endTitle.style.fontSize = "18px";
                    endTitle.style.letterSpacing = "8px";
                    lines[0].innerText = "You have passed through every chamber.";
                    lines[0].style.fontSize = "13px";
                    for(let i=1; i<lines.length; i++) {
                        lines[i].style.display = 'block';
                    }
                    document.querySelector('.ch-toggle-btn[data-ch="1"]')?.classList.remove('unlock-anim');
                }, 2500);
            }, 500);
        };
        prompt.addEventListener('click', dismiss);
    }

    function _showGateClearScreen(gate, onDismiss) {
        const col = '#' + new THREE.Color(gate.color).getHexString();
        const rewardHtml = gate.reward
            ? `<p style="color:${col};letter-spacing:4px;margin-top:16px">✦ CUBE MASTERED: ${gate.reward.toUpperCase()}</p>`
            : '';
 
        const el = document.createElement('div');
        el.style.cssText = `
            position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;
            justify-content:center;color:#fff;font-family:monospace;z-index:9999;
            background:rgba(0,0,0,0.88);text-align:center;
        `;
        el.innerHTML = `
            <p style="font-size:10px;letter-spacing:8px;color:rgba(255,255,255,0.3)">GATE CLEARED</p>
            <h1 style="font-size:48px;letter-spacing:8px;color:${col};margin:8px 0">${gate.name}</h1>
            <p style="font-size:13px;letter-spacing:5px;color:rgba(255,255,255,0.5)">${gate.subtitle}</p>
            ${rewardHtml}
            <p id="_gcs-dismiss" style="margin-top:40px;font-size:11px;letter-spacing:6px;
               color:rgba(255,255,255,0.3);cursor:pointer">[RETURN TO THE NEXUS]</p>
        `;
        document.body.appendChild(el);
 
        const dismiss = () => { el.remove(); onDismiss(); };
        document.getElementById('_gcs-dismiss').addEventListener('click', dismiss);
        setTimeout(dismiss, 9000); // auto-dismiss
    }

    function completeLevel() {
        if (isTransitioning) return;
        isTransitioning = true;
        AudioSys.triggerExitLayer();
 
        const overlay = document.getElementById('fade-overlay');
        overlay.style.transition = 'opacity 0.6s ease-in-out';
        overlay.style.opacity = 1;
 
        // ── HUB GATE context ──────────────────────────────────────────────
        if (hubProgress.returnGateId) {
            // Mark current level complete
            hubRuntime.onLevelComplete(activeChapter, currentLevel);
            saveHubProgress(hubProgress);
 
            const gate = GATE_BY_ID[hubProgress.returnGateId];
 
            // Is there another unfinished level in this gate?
            const nextSlot = gate.levels.findIndex((l, i) =>
                !hubProgress.completedLevels[`${gate.id}_${i}`]
            );
 
            if (nextSlot !== -1) {
                // Load next level inside the gate
                currentLevel = gate.levels[nextSlot];
                SaveSystem.save();
                setTimeout(() => {
                    buildLevel(currentLevel, false);
                    overlay.style.transition = 'opacity 0.4s ease-in-out';
                    overlay.style.opacity = 0;
                    setTimeout(() => { isTransitioning = false; }, 400);
                }, 600);
            } else {
                // Gate fully cleared — show reward screen then return to hub
                setTimeout(() => {
                    isTransitioning = false;
                    _showGateClearScreen(gate, () => {
                        hubProgress.returnGateId = null;
                        saveHubProgress(hubProgress);
                        activeChapter = hubProgress.returnChapter;
                        currentLevel  = 0;
                        buildLevel(HUB_LEVEL_INDEX, false);
                    });
                }, 600);
            }
            return;
        }
 
        // ── Standard campaign flow ────────────────────────────────────────
        if (currentLevel === 9) {
            if (activeChapter < 2) {
                chaptersUnlocked[activeChapter + 1] = true;
            }
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
            overlay.style.transition = 'opacity 0.4s ease-in-out';
            overlay.style.opacity = 0;
            setTimeout(() => { isTransitioning = false; }, 400);
        }, 800);
    }

    function triggerLevelTransition(isReset = false) {
        if (isTransitioning) return;
        if(!isReset) { completeLevel(); return; }

        isTransitioning = true; 
        const overlay = document.getElementById('fade-overlay'), title = document.getElementById('level-title');
        overlay.style.transition = 'opacity 0.4s ease-in-out'; overlay.style.opacity = 1;
        title.classList.remove('visible'); title.classList.add('swap-out');

        setTimeout(() => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                buildLevel(currentLevel, false, true);
                title.style.transition = 'none'; title.classList.remove('swap-out'); title.classList.add('swap-in'); void title.offsetWidth;
                title.style.transition = 'opacity 0.4s ease, transform 0.4s ease'; title.classList.remove('swap-in'); title.classList.add('visible');
                AudioSys.playTextSound();
                setTimeout(() => { overlay.style.opacity = 0; title.classList.remove('visible'); title.classList.add('swap-out'); setTimeout(() => { isTransitioning = false; }, 400); }, 1500); 
            }));
        }, 450); 
    }

    function loadCustomLevelToEditor(slotIndex) {
        currentCustomSlot = slotIndex;
        const data = slotIndex >= 0 ? customLevels[slotIndex] : null;

        document.getElementById('level-select-overlay').style.display = 'none';
        document.getElementById('editor-hud').style.display = 'block'; 
        document.getElementById('editor-hotbar').style.display = 'flex';

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

        if(data) { 
            customSpawn = data.spawn || {x:0, y:2, z:0};
            customExit = data.exit || {x:0, y:5, z:-8};
            customWaterY = data.waterY;
            if(data.solids) data.solids.forEach(k => customSolidBlocks.add(k));
            if(data.entities) data.entities.forEach(([k,v]) => customEntities.set(k, v));
            if(data.destruction) customDestruction = data.destruction;
            if(data.lights) customLights = data.lights;
            if(data.plates) customPlates = data.plates;
            if(data.doors) customDoors = data.doors;
            if(data.fields) customFields = data.fields;
            else customFields = [];  // ← moved outside the brace-less if, still inside if(data)
            if(data.decorations) customDecorations = data.decorations;
            else customDecorations = [];
        } else {
            customSpawn = {x:0, y:2, z:0};
            customExit = {x:0, y:5, z:-8};
            customWaterY = undefined;
        }

        logicNodes.configs = {};
        // ↓ Guard with if(data) — data is null for new levels
        if (data && data.logic) {
            logicNodes.configs = JSON.parse(JSON.stringify(data.logic));
        }

        logicNodes.configs = {}; 
        if (data.logic) {
            // Deep clone the logic so editing doesn't mess with the original until we save
            logicNodes.configs = JSON.parse(JSON.stringify(data.logic));
        }

        updateEditorVisuals();
        clearCurrentLevel();
        world.addBody(editorPhysicsFloor);

        playerBody.position.set(customSpawn.x, Math.max(customSpawn.y + 2, 4), customSpawn.z);
        playerBody.velocity.set(0,0,0);
        setTimeout(() => controls.lock(), 100);
    }

    document.getElementById('btn-edit-level').addEventListener('click', () => {
        // Check if we are editing an existing custom level slot, or sampling a campaign level
        if (typeof previewTargetLvl === 'string' && previewTargetLvl.startsWith('CUSTOM_')) {
            loadCustomLevelToEditor(parseInt(previewTargetLvl.replace('CUSTOM_', '')));
            return;
        }

        // Normal campaign level sampling into scratchpad
        currentCustomSlot = -1;
        document.getElementById('level-select-overlay').style.display = 'none';
        document.getElementById('editor-hud').style.display = 'block'; 
        document.getElementById('editor-hotbar').style.display = 'flex';

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
        customFields.length = 0; // <--- WIPE OLD FIELDS WHEN SAMPLING NEW LEVEL
        customWaterY = undefined;

        const params = getLevelParams(previewTargetLvl);
        customSpawn = { x: Math.round(params.spawn.x), y: Math.round(params.spawn.y), z: Math.round(params.spawn.z) };
        customExit = { x: Math.round(params.exit.x), y: Math.round(params.exit.y), z: Math.round(params.exit.z) };
        const b = params.bounds;
        for(let x = -b.x; x <= b.x; x++) {
            for(let y = 0; y <= b.y; y++) {
                for(let z = -b.z; z <= b.z; z++) {
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
        updateEditorVisuals();

        // 3. Setup Physics/Player (Flat Floor Mode)
        clearCurrentLevel();
        world.addBody(editorPhysicsFloor); // Add infinite floor

        // Start player high enough so they drop safely onto the flat plane
        playerBody.position.set(0, 4, 0);
        playerBody.velocity.set(0,0,0);

        setTimeout(() => controls.lock(), 100);
    });

    function exportLevelCode() {
        let bX = 5, bY = 5, bZ = 5;

        // Calculate necessary bounds with a little padding
        customSolidBlocks.forEach(k => {
            let [x, y, z] = k.split(',').map(Number);
            bX = Math.max(bX, Math.abs(x) + 1);
            bY = Math.max(bY, y + 2);
            bZ = Math.max(bZ, Math.abs(z) + 1);
        });

        let out = `return builder.setBounds(${bX}, ${bY}, ${bZ})\n`;
        out += `    .setSpawn(${customSpawn.x}, ${customSpawn.y}, ${customSpawn.z})\n`;
        out += `    .setExit(${customExit.x}, ${customExit.y}, ${customExit.z})\n`;

        customEntities.forEach(ent => {
            if (ent.type === 'red' && ent.startScale !== undefined && ent.startScale !== 1.0) {
                out += `    .addEntity('${ent.type}', ${ent.x}, ${ent.y}, ${ent.z}, { startScale: ${ent.startScale} })\n`;
            } else {
                out += `    .addEntity('${ent.type}', ${ent.x}, ${ent.y}, ${ent.z})\n`;
            }
        });

        customDestruction.forEach(bomb => {
            out += `    .addDestructionZone(${bomb.cx}, ${bomb.cy}, ${bomb.cz}, 4, 7)\n`;
        });

        customLights.forEach(light => {
            const hexStr = '0x' + light.color.toString(16).padStart(6, '0');
            out += `    .addLight(${light.x}, ${light.y}, ${light.z}, ${hexStr}, ${light.intensity}, ${light.radius})\n`;
        });

        customPlates.forEach(p => {
            out += `    .addPlate(${p.x}, ${p.y}, ${p.z}, ${p.channel})\n`;
        });
        customDoors.forEach(d => {
            out += `    .addDoor(${d.x}, ${d.y}, ${d.z}, { channel: ${d.channel}, dir: '${d.dir}', width: ${d.width}, height: ${d.height}, moveDist: ${d.moveDist} })\n`;
        });

        // Convert set of blocks to a JSON array string
        const arrStr = JSON.stringify(Array.from(customSolidBlocks));

        out += `    .addCustomLogic((() => {\n`;
        out += `        // High-performance closure for grid lookups\n`;
        out += `        const solids = new Set(${arrStr});\n`;
        out += `        return (x, y, z) => solids.has(x + ',' + y + ',' + z);\n`;
        out += `    })()).build();`;

        // Copy to clipboard and show HUD notification
        navigator.clipboard.writeText(out).then(() => {
            const scaleHud = document.getElementById('scale-hud');
            scaleHud.textContent = "LEVEL CODE COPIED TO CLIPBOARD";
            scaleHud.style.opacity = '1';
            clearTimeout(scaleHudTimeout);
            scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 2500);
        }).catch(err => console.error("Clipboard error:", err));
    }

    let pKeyHeld = false;
    let pKeyTimer = null;
    let ignoreNextPKeyUp = false;

    document.addEventListener('keydown', e => {
        // PRESS OR HOLD P LOGIC
        if (e.code === 'KeyP' && !e.repeat) {
            pKeyHeld = true;
            if (isEditorMode && !isPlayingCustom) {
                // Start timer to check if user is Holding the key
                pKeyTimer = setTimeout(() => {
                    pKeyTimer = null;
                    ignoreNextPKeyUp = true; // Prevent triggering 'Quick Test' when they let go

                    isEditorMode = false;
                    isPlayingCustom = true;
                    editorSceneGroup.visible = false;
                    ghostMesh.visible = false;
                    document.getElementById('editor-hud').style.display = 'none'; document.getElementById('editor-hotbar').style.display = 'none';

                    world.removeBody(editorPhysicsFloor); 
                    world.removeBody(editorStaticBody);

                    buildLevel('CUSTOM', false, false, false); // False = Teleport to Spawn

                    // Show popup text
                    const scaleHud = document.getElementById('scale-hud');
                    scaleHud.textContent = "FULL TEST STARTED";
                    scaleHud.style.opacity = '1';
                    clearTimeout(scaleHudTimeout);
                    scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 1200);
                }, 500); // 500ms = Hold threshold
            }
        }

        // SAVE LEVEL
        if (e.code === 'KeyK' && !e.repeat && isEditorMode && !isPlayingCustom) {
            let slot = currentCustomSlot;
            if (slot === -1) {
                slot = customLevels.findIndex(l => l === null);
                if (slot === -1) slot = 0; // overwrite slot 1 if completely full
                currentCustomSlot = slot;
            }

            const data = {
                spawn: customSpawn, exit: customExit, 
                solids: Array.from(customSolidBlocks),
                entities: Array.from(customEntities.entries()),
                destruction: customDestruction, lights: customLights,
                plates: customPlates, doors: customDoors, waterY: customWaterY,
                fields: customFields, // <--- SAVES FIELDS
                logic: logicNodes.configs,
                decorations: customDecorations, // <--- SAVES DECORATIONS
            };
            customLevels[slot] = data;
            localStorage.setItem('shatter_custom_levels', JSON.stringify(customLevels));

            const scaleHud = document.getElementById('scale-hud');
            scaleHud.textContent = `SAVED TO SLOT ${slot + 1}`;
            scaleHud.style.opacity = '1';
            clearTimeout(scaleHudTimeout);
            scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 2000);
        }

        // EXPORT LEVEL CODE
        if (e.code === 'KeyC' && !e.repeat) {
            if (isEditorMode && !isPlayingCustom) {
                exportLevelCode();
            }
        }

        // TOOL SELECTION
        if (isEditorMode && !isPlayingCustom) {
            if (e.code === 'Digit1') setEditorTool('wall');
            if (e.code === 'Digit2') setEditorTool('blue');
            if (e.code === 'Digit3') setEditorTool('red');
            if (e.code === 'Digit4') setEditorTool('green');
            if (e.code === 'Digit5') setEditorTool('yellow');
            if (e.code === 'Digit6') setEditorTool('bomb');
            if (e.code === 'Digit7') setEditorTool('spawn');
            if (e.code === 'Digit8') setEditorTool('exit');
            if (e.code === 'Digit9') setEditorTool('big_yellow');
            if (e.code === 'Digit0') setEditorTool('gray');
            if (e.code === 'KeyL') setEditorTool('logic');

            if (e.code === 'Tab') {
                e.preventDefault();
                if (!isTabSelectorOpen) openToolSelector();
            }
        }
    });

    function setEditorTool(tool) {
        editorTool = tool;
        document.getElementById('editor-tool-display').innerText = "TOOL: " + tool.toUpperCase().replace('_', ' ');
        const toolColor = (tool === 'light') ? lightColor : (TOOL_COLORS[tool] || 0x44ffaa);
        ghostMesh.material.color.setHex(toolColor);
        // Sync hotbar highlight
        document.querySelectorAll('.hotbar-slot').forEach(el => {
            el.classList.toggle('active', el.dataset.tool === tool);
        });
        // Sync tool selector highlight
        document.querySelectorAll('.ts-item').forEach(el => {
            el.classList.toggle('selected', el.dataset.tool === tool);
            el.classList.remove('hovered');
        });
    }

    const EDITOR_TOOLS_LIST = [
        { tool: 'wall',       label: 'Wall',      key: '1', category: 'build' },
        { tool: 'room',       label: 'Hollow Room', key: '-', category: 'build' },
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
        // DECORATION
        { tool: 'decor_rubble',    label: 'Rubble',         key: '-', category: 'decor' },
        { tool: 'decor_shattered', label: 'Shattered Slab', key: '-', category: 'decor' },
        { tool: 'decor_pipes',     label: 'Industrial Pipe', key: '-', category: 'decor' },
        { tool: 'decor_pillar',    label: 'Broken Pillar',  key: '-', category: 'decor' },
        { tool: 'decor_bush',      label: 'Bush',           key: '-', category: 'decor' },
        { tool: 'decor_fern',      label: 'Fern',           key: '-', category: 'decor' },
        { tool: 'decor_tree',      label: 'Tree',           key: '-', category: 'decor' },
        { tool: 'decor_vine_hanging', label: 'Hanging Vine', key: '-', category: 'decor' },
        { tool: 'decor_vine_creeping', label: 'Creeping Vine', key: '-', category: 'decor' },
    ];

    function hexToCSS(hex) {
        return '#' + hex.toString(16).padStart(6, '0');
    }

    // ── TOOL PARAMS PANEL LOGIC ──
    const TOOLS_WITH_PARAMS = new Set(['red', 'light', 'plate', 'door', 'room', 'logic', 'aero', 'oneway']);
    const LIGHT_COLOR_PRESETS = [
        { hex: 0xffffff, label: 'White'    },
        { hex: 0xfff5cc, label: 'Warm'     },
        { hex: 0xffddaa, label: 'Candle'   },
        { hex: 0xffeedd, label: 'Sunlight' },
        { hex: 0xaaddff, label: 'Cool'     },
        { hex: 0x6699ff, label: 'Blue'     },
        { hex: 0xff6644, label: 'Red'      },
        { hex: 0x44ffaa, label: 'Teal'     },
        { hex: 0xff44ff, label: 'Purple'   },
        { hex: 0xffaa00, label: 'Amber'    },
    ];

    // Build light color preset swatches
    (function initLightPresets() {
        const container = document.getElementById('light-presets');
        LIGHT_COLOR_PRESETS.forEach(({ hex, label }) => {
            const sw = document.createElement('div');
            sw.className = 'lp-swatch' + (hex === lightColor ? ' active' : '');
            sw.style.background = hexToCSS(hex);
            sw.style.color = hexToCSS(hex);
            sw.title = label;
            sw.addEventListener('click', (e) => {
                e.stopPropagation();
                lightColor = hex;
                document.querySelectorAll('.lp-swatch').forEach(s => s.classList.remove('active'));
                sw.classList.add('active');
                document.getElementById('tp-light-color-pick').value = hexToCSS(hex);
                // Update ghost mesh color if light tool is active
                if (editorTool === 'light') ghostMesh.material.color.setHex(hex);
            });
            container.appendChild(sw);
        });
    })();

    // Custom color picker
    document.getElementById('tp-light-color-pick').addEventListener('input', e => {
        const hex = parseInt(e.target.value.replace('#',''), 16);
        lightColor = hex;
        document.querySelectorAll('.lp-swatch').forEach(s => s.classList.remove('active'));
        if (editorTool === 'light') ghostMesh.material.color.setHex(hex);
    });

    // Intensity slider
    document.getElementById('tp-light-intensity').addEventListener('input', e => {
        lightIntensity = parseFloat(e.target.value);
        document.getElementById('tp-light-intensity-val').textContent = lightIntensity.toFixed(1);
    });

    // Radius slider
    document.getElementById('tp-light-radius').addEventListener('input', e => {
        lightRadius = parseFloat(e.target.value);
        document.getElementById('tp-light-radius-val').textContent = lightRadius.toFixed(1);
    });

    // Red scale
    document.getElementById('tp-red-scale').addEventListener('input', e => {
        redStartScale = parseFloat(e.target.value);
        document.getElementById('tp-red-scale-val').textContent = redStartScale.toFixed(1);
    });

    // Light Radius
    document.getElementById('tp-light-radius').addEventListener('input', e => {
        lightRadius = parseFloat(e.target.value);
        document.getElementById('tp-light-radius-val').textContent = lightRadius.toFixed(1);
    });

    // Pressure Plate Channel
    document.getElementById('tp-plate-ch').addEventListener('input', e => {
        editorChannel = parseInt(e.target.value);
        document.getElementById('tp-plate-ch-val').textContent = editorChannel;
        updateLogicVisualizer(); // Live wire preview while dragging
    });

    // Door Channel
    document.getElementById('tp-door-ch').addEventListener('input', e => {
        editorChannel = parseInt(e.target.value);
        document.getElementById('tp-door-ch-val').textContent = editorChannel;
        updateLogicVisualizer(); // Live wire preview while dragging
    });

    let editorFieldInverted = false;

    // Aero Channel Slider
    document.getElementById('tp-aero-ch').addEventListener('input', e => {
        editorChannel = parseInt(e.target.value);
        document.getElementById('tp-aero-ch-val').textContent = editorChannel;
        updateLogicVisualizer();
    });

    // One-Way Channel Slider
    document.getElementById('tp-oneway-ch').addEventListener('input', e => {
        editorChannel = parseInt(e.target.value);
        document.getElementById('tp-oneway-ch-val').textContent = editorChannel;
        updateLogicVisualizer();
    });

    // One-Way Inversion Toggle
    document.querySelectorAll('#toggle-oneway-inv .toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#toggle-oneway-inv .toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            editorFieldInverted = (btn.dataset.inv === 'true');
        });
    });

    let selectedLogicChannel = 1;

    // Sync Target Channel
    document.getElementById('tp-logic-out').addEventListener('input', e => {
        selectedLogicChannel = parseInt(e.target.value);
        document.getElementById('tp-logic-out-val').textContent = selectedLogicChannel;
        // Load existing config for this channel into UI
        const cfg = logicNodes.configs[selectedLogicChannel] || { type: 'NONE', source: selectedLogicChannel };
        updateLogicUIFromConfig(cfg);
    });

    // Gate Type Toggles
    document.querySelectorAll('#toggle-logic-type .toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#toggle-logic-type .toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            saveCurrentLogicStep();
        });
    });

    // Source A/B Sliders
    document.getElementById('tp-logic-a').addEventListener('input', e => {
        document.getElementById('tp-logic-a-val').textContent = e.target.value;
        saveCurrentLogicStep();
    });
    document.getElementById('tp-logic-b').addEventListener('input', e => {
        document.getElementById('tp-logic-b-val').textContent = e.target.value;
        saveCurrentLogicStep();
    });

    function saveCurrentLogicStep() {
        const type = document.querySelector('#toggle-logic-type .toggle-btn.active').dataset.type;
        const srcA = parseInt(document.getElementById('tp-logic-a').value);
        const srcB = parseInt(document.getElementById('tp-logic-b').value);

        if (type === 'NONE') {
            delete logicNodes.configs[selectedLogicChannel];
        } else {
            logicNodes.configs[selectedLogicChannel] = { 
                type: type, 
                source: srcA, 
                sources: [srcA, srcB] 
            };
        }

        // Visibility logic
        document.getElementById('logic-inputs-row').style.display = (type === 'NONE') ? 'none' : 'block';
        document.getElementById('logic-b-row').style.display = (type === 'AND') ? 'grid' : 'none';
        updateLogicVisualizer();
    }

    function updateLogicUIFromConfig(cfg) {
        document.querySelectorAll('#toggle-logic-type .toggle-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.type === cfg.type);
        });
        document.getElementById('tp-logic-a').value = cfg.source || 1;
        document.getElementById('tp-logic-a-val').textContent = cfg.source || 1;
        document.getElementById('tp-logic-b').value = (cfg.sources ? cfg.sources[1] : 2);
        document.getElementById('tp-logic-b-val').textContent = (cfg.sources ? cfg.sources[1] : 2);
        saveCurrentLogicStep();
    }

    // Door Direction Toggle
    document.querySelectorAll('#toggle-door-dir .toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#toggle-door-dir .toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            editorDoorDir = btn.dataset.dir; // stores 'left', 'right', 'up', or 'down'
        });
    });

    // Hollow Room Dimensions (X, Y, Z)
    ['x', 'y', 'z'].forEach(axis => {
        const el = document.getElementById('tp-room-' + axis);
        if (el) {
            el.addEventListener('input', e => {
                roomDim[axis] = parseInt(e.target.value);
                document.getElementById(`tp-room-${axis}-val`).textContent = roomDim[axis];

                // Instant visual update for the ghost mesh as you drag
                if (editorTool === 'room' && ghostMesh.visible) {
                    ghostMesh.scale.set(roomDim.x, roomDim.y, roomDim.z);
                }
            });
        }
    });

    function updateParamsPanel(tool, commit) {
        const panel = document.getElementById('tool-params-panel');
        const dot   = document.getElementById('tp-dot');
        const title = document.getElementById('tp-title');

        if (!TOOLS_WITH_PARAMS.has(tool)) {
            panel.classList.remove('visible');
            return;
        }

        panel.classList.add('visible');
        const color = TOOL_COLORS[tool] || 0xffffff;
        dot.style.background = hexToCSS(color);
        dot.style.color = hexToCSS(color);

        // Hide all sections first
        document.querySelectorAll('.tp-section').forEach(s => s.classList.remove('visible'));

        // Show the relevant one
        const sec = document.getElementById('tp-section-' + tool);
        if (sec) sec.classList.add('visible');

        if (tool === 'red') {
            title.textContent = 'RED CUBE — PARAMETERS';
            document.getElementById('tp-red-scale').value = redStartScale;
            document.getElementById('tp-red-scale-val').textContent = redStartScale.toFixed(1);
        } else if (tool === 'light') {
            title.textContent = 'LIGHT — PARAMETERS';
            document.getElementById('tp-light-intensity').value = lightIntensity;
            document.getElementById('tp-light-intensity-val').textContent = lightIntensity.toFixed(1);
            document.getElementById('tp-light-radius').value = lightRadius;
            document.getElementById('tp-light-radius-val').textContent = lightRadius.toFixed(1);
        } else if (tool === 'plate') {
            title.textContent = 'PRESSURE PLATE — LINKING';
            document.getElementById('tp-plate-ch').value = editorChannel;
            document.getElementById('tp-plate-ch-val').textContent = editorChannel;
        } else if (tool === 'door') {
            title.textContent = 'GLASS DOOR — LINKING';
            document.getElementById('tp-door-ch').value = editorChannel;
            document.getElementById('tp-door-ch-val').textContent = editorChannel;
            document.getElementById('tp-door-w').value = editorDoorWidth;
            document.getElementById('tp-door-w-val').textContent = editorDoorWidth.toFixed(1);
            document.getElementById('tp-door-h').value = editorDoorHeight;
            document.getElementById('tp-door-h-val').textContent = editorDoorHeight.toFixed(1);
            document.getElementById('tp-door-dist').value = editorDoorMoveDist;
            document.getElementById('tp-door-dist-val').textContent = editorDoorMoveDist.toFixed(1);
            ghostMesh.scale.set(editorDoorWidth, editorDoorHeight, 0.2);
            // Sync the orientation button visual
            document.querySelectorAll('#toggle-door-dir .toggle-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.dir === editorDoorDir);
            });
        } else if (tool === 'room') {
            title.textContent = 'HOLLOW ROOM — DIMENSIONS';
            ['x', 'y', 'z'].forEach(axis => {
                document.getElementById('tp-room-' + axis).value = roomDim[axis];
                document.getElementById(`tp-room-${axis}-val`).textContent = roomDim[axis];
            });
        } else if (tool === 'logic') {
            title.textContent = 'CHANNEL LOGIC — WIRING';
            const cfg = logicNodes.configs[selectedLogicChannel] || { type: 'NONE' };
            updateLogicUIFromConfig(cfg);
        } else if (tool === 'aero') {
            title.textContent = 'AERO FILTER — LINKING';
            document.getElementById('tp-aero-ch').value = editorChannel;
            document.getElementById('tp-aero-ch-val').textContent = editorChannel;
        } else if (tool === 'oneway') {
            title.textContent = 'ONE-WAY FIELD — CONFIG';
            document.getElementById('tp-oneway-ch').value = editorChannel;
            document.getElementById('tp-oneway-ch-val').textContent = editorChannel;
            document.querySelectorAll('#toggle-oneway-inv .toggle-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.inv === String(editorFieldInverted));
            });
        }
    }

    // ── PROCEDURAL TEXTURE GENERATOR ─────────────────────────────────────────────
    const _procTextures = {}; 

    function _getNoiseTexture(type = 'concrete') {
        if (_procTextures[type]) return _procTextures[type];
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(size, size);
        for (let i = 0; i < imgData.data.length; i += 4) {
            let val;
            if (type === 'wood') {
                const y = Math.floor((i / 4) / size);
                val = (Math.random() * 50 + Math.sin(y * 0.1 + Math.random()) * 100 + 105) | 0;
            } else if (type === 'rust') {
                val = Math.random() > 0.6 ? 255 : (Math.random() * 100 | 0);
            } else {
                val = (Math.random() * 255) | 0;
            }
            imgData.data[i] = imgData.data[i+1] = imgData.data[i+2] = val;
            imgData.data[i+3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        _procTextures[type] = tex;
        return tex;
    }

    // ── UTILITIES ────────────────────────────────────────────────────────────────
    function _makeRng(seed) {
        let s = seed;
        return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
    }

    function _deformGeometry(geometry, rng, intensity) {
        geometry.computeVertexNormals();
        const pos = geometry.attributes.position;
        const norm = geometry.attributes.normal;
        for (let i = 0; i < pos.count; i++) {
            const push = (rng() - 0.5) * intensity;
            pos.setXYZ(i, pos.getX(i) + norm.getX(i) * push, pos.getY(i) + norm.getY(i) * push, pos.getZ(i) + norm.getZ(i) * push);
        }
        geometry.computeVertexNormals();
    }

    // ── PROP BUILDERS ────────────────────────────────────────────────────────────

    function buildDecoRubble(rng = _makeRng(77)) {
        const group = new THREE.Group();
        const mat1 = typeof wallMaterial !== 'undefined' ? wallMaterial : new THREE.MeshStandardMaterial({ color: 0x7a7065, roughness: 1.0 });
        const mat2 = typeof brokenMaterial !== 'undefined' ? brokenMaterial : new THREE.MeshStandardMaterial({ color: 0x66605a, roughness: 1.0 });
        const count = 12 + Math.floor(rng() * 8); 
        for (let i = 0; i < count; i++) {
            const radius = 0.08 + rng() * 0.35;
            const geo = new THREE.DodecahedronGeometry(radius, 1);
            _deformGeometry(geo, rng, radius * 0.3); 
            const mesh = new THREE.Mesh(geo, rng() > 0.4 ? mat1 : mat2);
            mesh.scale.set(1 + rng() * 0.6, 0.4 + rng() * 0.6, 1 + rng() * 0.6);
            const dist = rng() * 1.6;
            const angle = rng() * Math.PI * 2;
            mesh.position.set(Math.cos(angle) * dist, -0.5 + (radius * mesh.scale.y * 0.5), Math.sin(angle) * dist);
            mesh.rotation.set(rng() * 6, rng() * 6, rng() * 6);
            mesh.castShadow = mesh.receiveShadow = true;
            group.add(mesh);
        }
        return group;
    }

    function buildDecoShattered(rng = _makeRng(42)) {
        const group = new THREE.Group();
        const matWall = typeof wallMaterial !== 'undefined' ? wallMaterial : new THREE.MeshStandardMaterial({ color: 0x8a847c, roughness: 0.95 });
        const w = 1.2 + rng() * 0.4, h = 1.8 + rng() * 0.6;
        const slabGeo = new THREE.BoxGeometry(w, h, 0.25, 4, 4, 2);
        _deformGeometry(slabGeo, rng, 0.08);
        const slab = new THREE.Mesh(slabGeo, matWall);
        slab.position.set(0, h * 0.45 - 0.5, 0);
        slab.rotation.set((rng()-0.5)*0.3, (rng()-0.5)*0.4, (rng()-0.5)*0.6);
        slab.castShadow = slab.receiveShadow = true;
        group.add(slab);
        const rebarMat = new THREE.MeshStandardMaterial({ color: 0x4a2a20, metalness: 0.8 });
        for (let i = 0; i < 5; i++) {
            const curve = new THREE.QuadraticBezierCurve3(
                new THREE.Vector3((rng()-0.5)*w, (rng()-0.5)*h, 0),
                new THREE.Vector3((rng()-0.5)*w, rng()*h, 0.2),
                new THREE.Vector3((rng()-0.5)*w, h, 0.5)
            );
            const rebar = new THREE.Mesh(new THREE.TubeGeometry(curve, 6, 0.012, 4), rebarMat);
            slab.add(rebar);
        }
        group.add(buildDecoRubble(rng));
        return group;
    }

    function buildDecoPipes(rng = _makeRng(88)) {
        const group = new THREE.Group();
        const pipeMat = new THREE.MeshStandardMaterial({ color: 0x3d4745, roughness: 0.7, metalness: 0.6 });
        for (let i = 0; i < 3; i++) {
            const r = 0.05 + rng() * 0.04;
            const h = 0.8 + rng() * 1.5;
            const start = new THREE.Vector3((rng()-0.5), -0.5, (rng()-0.5));
            const curve = new THREE.QuadraticBezierCurve3(start, new THREE.Vector3(start.x, h*0.5, start.z), new THREE.Vector3(start.x + rng(), h, start.z + rng()));
            const pipe = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, r, 8), pipeMat);
            pipe.castShadow = true;
            group.add(pipe);
        }
        return group;
    }

    function buildDecoPillar(rng = _makeRng(19)) {
        const group = new THREE.Group();
        const r = 0.25 + rng() * 0.1, h = 1.0 + rng() * 2.0;
        const colGeo = new THREE.CylinderGeometry(r*0.8, r, h, 8, 5);
        _deformGeometry(colGeo, rng, 0.05);
        const col = new THREE.Mesh(colGeo, typeof wallMaterial !== 'undefined' ? wallMaterial : new THREE.MeshStandardMaterial({ color: 0x93908a }));
        col.position.y = (h / 2) - 0.5;
        col.castShadow = col.receiveShadow = true;
        group.add(col);
        group.add(buildDecoRubble(rng));
        return group;
    }

    function buildDecoBush(rng = _makeRng(55)) {
        const group = new THREE.Group();
        const leafColors = [0x274e1d, 0x346328, 0x1d3a14, 0x417833];
        const stemMat = new THREE.MeshStandardMaterial({ color: 0x3d2c20 });
        for (let i = 0; i < 15; i++) {
            const r = 0.2 + rng() * 0.4;
            const geo = new THREE.IcosahedronGeometry(r, 1);
            _deformGeometry(geo, rng, r * 0.3);
            const mat = new THREE.MeshStandardMaterial({ color: leafColors[Math.floor(rng() * leafColors.length)], roughness: 0.8, flatShading: true });
            const cluster = new THREE.Mesh(geo, mat);
            const a = rng() * Math.PI * 2, d = rng() * 0.7;
            cluster.position.set(Math.cos(a)*d, 0.2 + rng()*0.8, Math.sin(a)*d);
            cluster.scale.set(1, 0.7, 1);
            cluster.castShadow = true;
            group.add(cluster);
        }
        return group;
    }

    // ── OPTIMIZED FERN ───────────────────────────────────────────────────────────
    function buildDecoFern(rng = _makeRng(33)) {
        const group = new THREE.Group();
        const leafColors = [0x2a541c, 0x366b26, 0x224516];
        const frondCount = 8 + Math.floor(rng() * 6);
        const frondMat = new THREE.MeshStandardMaterial({ color: leafColors[1], roughness: 0.8, side: THREE.DoubleSide });

        for (let i = 0; i < frondCount; i++) {
            const angle = (i / frondCount) * Math.PI * 2 + (rng() - 0.5) * 0.4;
            const length = 0.8 + rng() * 0.7;
            const curve = new THREE.QuadraticBezierCurve3(
                new THREE.Vector3(0, -0.45, 0),
                new THREE.Vector3(Math.cos(angle) * length * 0.2, length * 0.8, Math.sin(angle) * length * 0.2),
                new THREE.Vector3(Math.cos(angle) * length, length * 0.1, Math.sin(angle) * length)
            );

            const stemGeo = new THREE.TubeGeometry(curve, 12, 0.015, 5, false);
            group.add(new THREE.Mesh(stemGeo, frondMat));

            const leavesPerFrond = 10 + Math.floor(rng() * 5);
            const frondLeaves = [];
            for (let j = 1; j < leavesPerFrond; j++) {
                const t = j / leavesPerFrond;
                const pos = curve.getPoint(t);
                const tangent = curve.getTangent(t);
                const size = (1.0 - t) * 0.25;
                
                const leafGeo = new THREE.PlaneGeometry(size, size * 1.5);
                leafGeo.translate(0, size * 0.5, 0);
                const lMesh = new THREE.Mesh(leafGeo);
                lMesh.position.copy(pos);
                lMesh.lookAt(pos.clone().add(tangent));
                lMesh.rotateZ(Math.PI / 2);
                lMesh.rotateX(0.5);
                lMesh.updateMatrix();
                frondLeaves.push(lMesh.geometry.clone().applyMatrix4(lMesh.matrix));
                
                lMesh.rotateX(-1.0);
                lMesh.updateMatrix();
                frondLeaves.push(lMesh.geometry.clone().applyMatrix4(lMesh.matrix));
            }
            const mergedLeaves = THREE.BufferGeometryUtils.mergeGeometries(frondLeaves);
            const leafMesh = new THREE.Mesh(mergedLeaves, frondMat);
            leafMesh.castShadow = true;
            group.add(leafMesh);
        }
        return group;
    }

    // ── VINE VARIANTS ────────────────────────────────────────────────────────────
    function _buildVineBase(rng, points, leafCount, colorBase) {
        const group = new THREE.Group();
        const curve = new THREE.CatmullRomCurve3(points);
        const tubeGeo = new THREE.TubeGeometry(curve, 24, 0.02, 5, false);
        const vineMat = new THREE.MeshStandardMaterial({ color: colorBase, roughness: 0.9 });
        const vineTube = new THREE.Mesh(tubeGeo, vineMat);
        vineTube.castShadow = true;
        group.add(vineTube);

        const leaves = [];
        const leafMat = new THREE.MeshStandardMaterial({ color: colorBase, roughness: 0.8, side: THREE.DoubleSide });
        for (let i = 0; i < leafCount; i++) {
            const t = rng();
            const pos = curve.getPoint(t);
            const tangent = curve.getTangent(t);
            const lSize = 0.05 + rng() * 0.1;
            const lGeo = new THREE.BoxGeometry(lSize, 0.01, lSize);
            const lMesh = new THREE.Mesh(lGeo);
            lMesh.position.copy(pos);
            lMesh.lookAt(pos.clone().add(tangent));
            lMesh.rotation.z += rng() * Math.PI;
            lMesh.updateMatrix();
            leaves.push(lGeo.clone().applyMatrix4(lMesh.matrix));
        }
        const mergedLeaves = THREE.BufferGeometryUtils.mergeGeometries(leaves);
        group.add(new THREE.Mesh(mergedLeaves, leafMat));
        return group;
    }

    function buildDecoVineHanging(rng = _makeRng(101)) {
        const points = [new THREE.Vector3(0, 0.5, 0)];
        let lastP = points[0].clone();
        for(let i=0; i<6; i++) {
            lastP.add(new THREE.Vector3((rng()-0.5)*0.8, -0.4 - rng()*0.4, (rng()-0.5)*0.8));
            points.push(lastP.clone());
        }
        return _buildVineBase(rng, points, 25, 0x2d451a);
    }

    function buildDecoVineCreeping(rng = _makeRng(202)) {
        const points = [new THREE.Vector3(0, -0.48, 0)];
        let lastP = points[0].clone();
        for(let i=0; i<6; i++) {
            lastP.add(new THREE.Vector3((rng()-0.5)*1.5, (rng()-0.5)*0.1, (rng()-0.5)*1.5));
            points.push(lastP.clone());
        }
        return _buildVineBase(rng, points, 30, 0x38541c);
    }

    function buildDecoTree(rng = _makeRng(99)) {
        const group = new THREE.Group();
        const trunkH = 3 + rng()*2, trunkR = 0.2;
        const trunkGeo = new THREE.CylinderGeometry(trunkR*0.5, trunkR, trunkH, 8, 4);
        _deformGeometry(trunkGeo, rng, 0.05);
        const trunk = new THREE.Mesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x423224 }));
        trunk.position.y = trunkH/2 - 0.5;
        trunk.castShadow = true;
        group.add(trunk);
        for (let i = 0; i < 15; i++) {
            const r = 0.8 + rng();
            const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), new THREE.MeshStandardMaterial({ color: 0x1e4215, flatShading: true }));
            leaf.position.set((rng()-0.5)*1.5, trunkH + (rng()-0.5), (rng()-0.5)*1.5);
            leaf.scale.set(1, 0.5, 1);
            leaf.castShadow = true;
            group.add(leaf);
        }
        return group;
    }

    // Map from type string to builder function
    const DECOR_BUILDERS = {
        decor_rubble:    buildDecoRubble,
        decor_shattered: buildDecoShattered,
        decor_vine_hanging: buildDecoVineHanging,
        decor_vine_creeping: buildDecoVineCreeping,
        decor_pipes:     buildDecoPipes,
        decor_pillar:    buildDecoPillar,
        decor_bush:      buildDecoBush,
        decor_fern:      buildDecoFern,
        decor_tree:      buildDecoTree,
    };

    // ── 3-D PREVIEW CANVAS RENDERER ───────────────────────────────────────────
    // Renders each decoration prop into a small canvas data-URL once on load.
    const DECOR_PREVIEW_URLS = {};
    (function generateDecorationPreviews() {
        try {
            const SIZE = 128;
            const pvRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
            pvRenderer.setSize(SIZE, SIZE);
            pvRenderer.setPixelRatio(1.5);
            pvRenderer.toneMapping = THREE.ACESFilmicToneMapping;
            pvRenderer.toneMappingExposure = 1.35;
            pvRenderer.shadowMap.enabled = false;

            const pvScene = new THREE.Scene();
            pvScene.background = null;

            // Warm 3-point lighting
            pvScene.add(new THREE.AmbientLight(0xfff0e8, 0.55));
            const sun = new THREE.DirectionalLight(0xfff5cc, 1.5);
            sun.position.set(3, 5, 4);
            pvScene.add(sun);
            const rim = new THREE.DirectionalLight(0x88ccff, 0.45);
            rim.position.set(-2, 1, -3);
            pvScene.add(rim);

            const pvCamera = new THREE.PerspectiveCamera(48, 1, 0.01, 100);

            const seeds = { decor_rubble: 77, decor_shattered: 42, decor_bush: 55, decor_fern: 33, decor_tree: 99 };
            Object.entries(DECOR_BUILDERS).forEach(([type, buildFn]) => {
                const mesh = buildFn(_makeRng(seeds[type] || 50));
                pvScene.add(mesh);

                // Auto-frame: compute bounding box and position camera
                const box = new THREE.Box3().setFromObject(mesh);
                const center = box.getCenter(new THREE.Vector3());
                const size3 = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size3.x, size3.y, size3.z);
                const dist = maxDim * 1.6;
                pvCamera.position.set(center.x + dist * 0.85, center.y + dist * 0.65, center.z + dist * 0.85);
                pvCamera.lookAt(center);
                pvCamera.updateProjectionMatrix();

                pvRenderer.render(pvScene, pvCamera);
                DECOR_PREVIEW_URLS[type] = pvRenderer.domElement.toDataURL('image/png');
                pvScene.remove(mesh);
            });

            pvRenderer.dispose();
        } catch(err) {
            console.warn('[Decor Previews] Could not generate 3D previews:', err);
        }
    })();

    // ── DECORATION SPAWNING (in-game mesh creation) ───────────────────────────
    const _activeDecorationMeshes = [];

    function spawnCustomDecorations() {
        // Clean up any previous decoration meshes
        _activeDecorationMeshes.forEach(m => {
            scene.remove(m);
            m.traverse(c => { if (c.isMesh) { c.geometry.dispose(); } });
        });
        _activeDecorationMeshes.length = 0;

        customDecorations.forEach(dec => {
            const buildFn = DECOR_BUILDERS[dec.type];
            if (!buildFn) return;
            const rngSeed = Math.round(dec.x * 73 + dec.y * 37 + dec.z * 19) & 0xffffffff;
            const mesh = buildFn(_makeRng(rngSeed >>> 0));
            mesh.position.set(dec.x, dec.y, dec.z);
            mesh.rotation.y = dec.rotY || 0;
            scene.add(mesh);
            _activeDecorationMeshes.push(mesh);
        });
    }

    // ── BUILD HOTBAR (only shows the 10 number-keyed tools: 1–9 + 0) ──
    (function buildHotbar() {
        const hotbar = document.getElementById('editor-hotbar');
        EDITOR_TOOLS_LIST.filter(({ key }) => key !== '-').forEach(({ tool, label, key }) => {
            const slot = document.createElement('div');
            slot.className = 'hotbar-slot' + (tool === editorTool ? ' active' : '');
            slot.dataset.tool = tool;
            const swatch = document.createElement('div');
            swatch.className = 'hotbar-swatch';
            swatch.style.background = hexToCSS(TOOL_COLORS[tool]);
            const keyEl = document.createElement('div');
            keyEl.className = 'hotbar-key';
            keyEl.textContent = key;
            slot.appendChild(swatch);
            slot.appendChild(keyEl);
            hotbar.appendChild(slot);
        });
    })();

    // ── REWORKED TABBED TOOL SELECTOR ──
    let activeCategory = 'build'; // Default tab

    function buildToolSelector() {
        const hud = document.getElementById('tool-selector-hud');
        const grid = document.getElementById('tool-selector-grid');
        if (!hud || !grid) return;

        // 1. Create/Get Tab Bar
        let tabBar = hud.querySelector('.ts-tab-bar');
        if (!tabBar) {
            tabBar = document.createElement('div');
            tabBar.className = 'ts-tab-bar';
            tabBar.style.cssText = `display: flex; justify-content: center; gap: 10px; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid rgba(255,255,255,0.1);`;
            hud.insertBefore(tabBar, grid);
        }

        const categories = {
            'build': { label: 'STRUCTURE', icon: '🏗️' },
            'items': { label: 'OBJECTS', icon: '📦' },
            'logic': { label: 'MECHANISMS', icon: '⚡' },
            'util':  { label: 'UTILITY', icon: '🛠️' },
            'decor': { label: 'DECOR', icon: '🌿' }
        };

        // 2. Render Tabs
        tabBar.innerHTML = '';
        Object.entries(categories).forEach(([key, info]) => {
            const tabBtn = document.createElement('div');
            const isActive = activeCategory === key;
            tabBtn.style.cssText = `
                padding: 6px 12px; font-size: 10px; letter-spacing: 2px; cursor: pointer; border-radius: 4px; transition: all 0.2s;
                color: ${isActive ? '#fff' : 'rgba(255,255,255,0.4)'};
                background: ${isActive ? 'rgba(255,255,255,0.15)' : 'transparent'};
                border: 1px solid ${isActive ? 'rgba(255,255,255,0.2)' : 'transparent'};
            `;
            tabBtn.innerHTML = `<span style="margin-right:5px">${info.icon}</span> ${info.label}`;
            tabBtn.onclick = (e) => {
                e.stopPropagation();
                activeCategory = key;
                buildToolSelector(); // Re-render grid
            };
            tabBar.appendChild(tabBtn);
        });

        // 3. Render Grid
        grid.innerHTML = '';
        EDITOR_TOOLS_LIST.filter(t => t.category === activeCategory).forEach((toolObj) => {
            const item = document.createElement('div');
            const isSelected = toolObj.tool === editorTool;
            item.className = 'ts-item' + (isSelected ? ' selected' : '');
            item.dataset.tool = toolObj.tool;

            const isDecor = activeCategory === 'decor';
            const preview = isDecor && DECOR_PREVIEW_URLS[toolObj.tool]
                ? `<img src="${DECOR_PREVIEW_URLS[toolObj.tool]}" style="width:54px;height:54px;object-fit:contain;"/>`
                : `<div class="ts-swatch" style="background:${hexToCSS(TOOL_COLORS[toolObj.tool] || 0xffffff)}; width:30px; height:30px; border-radius:4px;"></div>`;

            item.innerHTML = `
                ${preview}
                <div class="ts-name" style="font-size:9px; margin-top:5px; font-weight:700;">${toolObj.label.toUpperCase()}</div>
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
                buildToolSelector(); // Refresh selection visual
                updateParamsPanel(toolObj.tool, true);
                closeToolSelector();
            };

            grid.appendChild(item);
        });
    }
    // Initialize once on script load
    buildToolSelector();

    function openToolSelector() {
        isTabSelectorOpen = true;
        
        // Find current tool's category and switch to it
        const currentToolData = EDITOR_TOOLS_LIST.find(t => t.tool === editorTool);
        if (currentToolData) activeCategory = currentToolData.category;
        
        // Refresh the UI
        buildToolSelector();
        
        document.getElementById('tool-selector-hud').classList.add('visible');
        updateParamsPanel(editorTool, true);
        controls.unlock();
    }

    function closeToolSelector(relock) {
        // Apply the selected item (clicked), or hovered item as fallback
        const selected = document.querySelector('.ts-item.selected');
        const hovered = document.querySelector('.ts-item.hovered');
        const toApply = selected || hovered;
        if (toApply) setEditorTool(toApply.dataset.tool);
        // Clear pending states
        document.querySelectorAll('.ts-item').forEach(el => {
            el.classList.remove('hovered');
            delete el.dataset.pendingSelect;
        });
        isTabSelectorOpen = false;
        document.getElementById('tool-selector-hud').classList.remove('visible');
        // Hide params panel when menu closes
        document.getElementById('tool-params-panel').classList.remove('visible');
        // Re-lock pointer and resume editor
        isPaused = false;
        document.getElementById('blocker').style.display = 'none';
        controls.lock();
    }

    function addEditorVisualMesh(x, y, z, tool) {
        const geo = new THREE.BoxGeometry(1, 1, 1);
        const mat = new THREE.MeshBasicMaterial({ color: TOOL_COLORS[tool], transparent: true, opacity: 0.6 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        mesh.userData = { key: `${x},${y},${z}`, type: tool };
        editorMeshesGroup.add(mesh);
    }

    const keys = { w: false, a: false, s: false, d: false, space: false, shift: false };
    document.addEventListener('keydown', e => {
        if (e.code === 'KeyW' || e.code === 'KeyZ' || e.code === 'ArrowUp') keys.w = true;
        if (e.code === 'KeyA' || e.code === 'KeyQ' || e.code === 'ArrowLeft') keys.a = true;
        if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.s = true;
        if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.d = true;
        if (e.code === 'Space' && !isTransitioning && !isCutscene && !isPaused) keys.space = true; 
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.shift = true;
        if (e.code === 'KeyR' && controls.isLocked && !isTransitioning && !isCutscene && !isPaused) isRKeyDown = true; 
    });
    document.addEventListener('keyup', e => {
        if (e.code === 'KeyW' || e.code === 'KeyZ' || e.code === 'ArrowUp') keys.w = false;
        if (e.code === 'KeyA' || e.code === 'KeyQ' || e.code === 'ArrowLeft') keys.a = false;
        if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.s = false;
        if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.d = false;
        if (e.code === 'Space') keys.space = false;
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') keys.shift = false;
        if (e.code === 'KeyR') { isRKeyDown = false; rKeyTimer = 0; document.getElementById('scale-hud').style.opacity = '0'; }

        // TAB RELEASE: close tool selector
        // if (e.code === 'Tab' && isTabSelectorOpen) {
        //     e.preventDefault();
        //    closeToolSelector();
        // }

        // KEY P RELEASE LOGIC
        if (e.code === 'KeyP') {
            pKeyHeld = false;

            if (ignoreNextPKeyUp) {
                ignoreNextPKeyUp = false;
                return; // Ignore because they just finished a "Hold"
            }

            if (isEditorMode && !isPlayingCustom) {
                // Released fast -> QUICK TEST
                if (pKeyTimer) {
                    clearTimeout(pKeyTimer);
                    pKeyTimer = null;

                    isEditorMode = false;
                    isPlayingCustom = true;
                    editorSceneGroup.visible = false;
                    ghostMesh.visible = false;
                    document.getElementById('editor-hud').style.display = 'none'; document.getElementById('editor-hotbar').style.display = 'none';

                    world.removeBody(editorPhysicsFloor); 
                    world.removeBody(editorStaticBody);

                    buildLevel('CUSTOM', false, false, true); // True = Keep Position

                    const scaleHud = document.getElementById('scale-hud');
                    scaleHud.textContent = "QUICK TEST";
                    scaleHud.style.opacity = '1';
                    clearTimeout(scaleHudTimeout);
                    scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 1000);
                }
            } 
            else if (!isEditorMode && isPlayingCustom) {
                // Pressing P while testing -> BACK TO EDIT
                isEditorMode = true;
                isPlayingCustom = false;
                clearCurrentLevel();                  
                world.addBody(editorPhysicsFloor);    
                world.addBody(editorStaticBody);    
                editorSceneGroup.visible = true;      
                document.getElementById('editor-hud').style.display = 'block'; document.getElementById('editor-hotbar').style.display = 'flex';


                // Stop momentum and prevent getting trapped under the floor
                playerBody.velocity.set(0,0,0);
                if (playerBody.position.y < 0) playerBody.position.set(0, 4, 0);

                const scaleHud = document.getElementById('scale-hud');
                scaleHud.textContent = "EDIT MODE";
                scaleHud.style.opacity = '1';
                clearTimeout(scaleHudTimeout);
                scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 1000);
            }
        }
    });

    const raycaster = new THREE.Raycaster(); const screenCenter = new THREE.Vector2(0, 0);
    let scaleHudTimeout = null;

    document.addEventListener('pointerdown', e => {
        isMouseDown = true;
        if (isPaused || isCutscene || document.pointerLockElement !== document.body) return;
        if (e.target !== document.body && e.target.tagName !== 'CANVAS') return;

        raycaster.setFromCamera(screenCenter, camera);

        if (isEditorMode && !isPlayingCustom) {
            raycaster.setFromCamera(screenCenter, camera);
            const hits = raycaster.intersectObjects(editorSceneGroup.children, false);

            // Find the first hit that actually has a face (ignore grid lines)
            let validHit = null;
            for (let i = 0; i < hits.length; i++) {
                if (hits[i].face) {
                    validHit = hits[i];
                    break;
                }
            }

            if (validHit) {
                const hit = validHit;
                const norm = hit.face.normal; // Capture the normal immediately

                if (editorTool === 'water') {
                    if (e.button === 0) customWaterY = Math.round(hit.point.y);
                    else if (e.button === 2) customWaterY = undefined;
                    updateEditorVisuals();
                    return;
                }

                if (e.button === 0) { // Left Click: PLACE
                    const p = hit.point.clone().add(norm.clone().multiplyScalar(0.5));
                    const gx = Math.round(p.x), gy = Math.round(p.y), gz = Math.round(p.z);
                    const key = `${gx},${gy},${gz}`;

                    if (editorTool === 'wall') { customSolidBlocks.add(key); }
                    else if (editorTool === 'room') {
                        const hx = Math.floor(roomDim.x / 2), hz = Math.floor(roomDim.z / 2);
                        for(let rx = -hx; rx <= hx; rx++) {
                            for(let ry = 0; ry < roomDim.y; ry++) {
                                for(let rz = -hz; rz <= hz; rz++) {
                                    if (rx === -hx || rx === hx || rz === -hz || rz === hz || ry === 0 || ry === roomDim.y - 1) {
                                        customSolidBlocks.add(`${gx + rx},${gy + ry},${gz + rz}`);
                                    }
                                }
                            }
                        }
                    }
                    else if (editorTool === 'bomb') customDestruction.push({cx: gx, cy: gy, cz: gz});
                    else if (editorTool === 'spawn') customSpawn = { x: gx, y: gy, z: gz };
                    else if (editorTool === 'exit') customExit = { x: gx, y: gy, z: gz };
                    else if (editorTool === 'light') {
                        customLights = customLights.filter(l => l.x !== gx || l.y !== gy || l.z !== gz);
                        customLights.push({ x: gx, y: gy, z: gz, color: lightColor, intensity: lightIntensity, radius: lightRadius });
                    }
                    else if (editorTool === 'plate') {
                        customPlates = customPlates.filter(p => p.x !== gx || p.y !== gy || p.z !== gz);
                        customPlates.push({ x: gx, y: gy, z: gz, channel: editorChannel });
                    } 
                    else if (editorTool === 'door') {
                        // Calculate movement direction based on normal
                        let travelDir = 'left';
                        if (Math.abs(norm.y) > 0.5) travelDir = norm.y > 0 ? 'up' : 'down';
                        else if (Math.abs(norm.x) > 0.5) travelDir = norm.x > 0 ? 'right' : 'left';
                        else travelDir = norm.z > 0 ? 'right' : 'left';

                        customDoors.push({ 
                            x: gx, y: gy, z: gz, 
                            channel: editorChannel, 
                            dir: travelDir,
                            width: editorDoorWidth, height: editorDoorHeight, moveDist: editorDoorMoveDist,
                            normal: {x: norm.x, y: norm.y, z: norm.z} 
                        });
                    }
                    else if (editorTool === 'aero' || editorTool === 'oneway') {
                        customFields = customFields.filter(f => f.x !== gx || f.y !== gy || f.z !== gz);
                        customFields.push({ 
                            type: editorTool, x: gx, y: gy, z: gz, 
                            channel: editorChannel, w: 3, h: 3, 
                            inverted: editorFieldInverted,
                            normal: {x: norm.x, y: norm.y, z: norm.z} 
                        });
                    }
                    else if (editorTool.startsWith('decor_')) {
                        // Remove any existing decoration at the same grid position
                        customDecorations = customDecorations.filter(d => d.x !== gx || d.y !== gy || d.z !== gz);
                        // Random rotation so repeated placements feel varied
                        const rotY = Math.floor(Math.random() * 4) * (Math.PI / 2) + (Math.random() - 0.5) * 0.6;
                        customDecorations.push({ type: editorTool, x: gx, y: gy, z: gz, rotY });
                    }
                    else {
                        const ent = { type: editorTool, x: gx, y: gy, z: gz };
                        if (editorTool === 'red') ent.startScale = redStartScale;
                        customEntities.set(key, ent);
                    }
                } 
                else if (e.button === 2 && hit.object.geometry.type !== 'PlaneGeometry') { // Right Click: REMOVE
                    const p = hit.point.clone().sub(norm.clone().multiplyScalar(0.5));
                    const gx = Math.round(p.x), gy = Math.round(p.y), gz = Math.round(p.z);
                    const tKey = `${gx},${gy},${gz}`;

                    customSolidBlocks.delete(tKey);
                    customEntities.delete(tKey);
                    customDestruction = customDestruction.filter(b => b.cx !== gx || b.cy !== gy || b.cz !== gz);
                    customLights = customLights.filter(l => l.x !== gx || l.y !== gy || l.z !== gz);
                    customPlates = customPlates.filter(p => p.x !== gx || p.y !== gy || p.z !== gz);
                    customDoors = customDoors.filter(d => d.x !== gx || d.y !== gy || d.z !== gz);
                    customFields = customFields.filter(f => f.x !== gx || f.y !== gy || f.z !== gz);
                    customDecorations = customDecorations.filter(d => d.x !== gx || d.y !== gy || d.z !== gz);
                }
                updateEditorVisuals();
            }
            return; 
        }

        if (e.button !== 0) return;

        let intersects = raycaster.intersectObjects(interactiveTargets);
        if (intersects.length > 0 && intersects[0].distance < 8) { 
            const obj = intersects[0].object; const block = meshToBlock.get(obj) ?? null;
            if(block) {
                grabbedBlock = block; grabbedBlock.hasBeenGrabbed = true; AudioSys.grab();
                if (grabbedBlock.type === 'yellow' || grabbedBlock.type === 'big_yellow') { grabbedBlock.body.type = CANNON.Body.DYNAMIC; grabbedBlock.body.updateMassProperties(); }
                grabbedBlock.body.wakeUp();
            }
            return; 
        }

        if (!grabbedBlock) {
            let closestDist = 2.5; let closestBody = null; const ray = raycaster.ray; const checkList = [...interactiveBlocks, ...dynamicSyncList];
            for(let i=0; i<checkList.length; i++) {
                const b = checkList[i]; _v1.set(b.body.position.x, b.body.position.y, b.body.position.z);
                if (distSq(camera.position, _v1) < 64) { 
                    const distToRay = ray.distanceSqToPoint(_v1); if(distToRay < closestDist) { closestDist = distToRay; closestBody = b; }
                }
            }
            if(closestBody) { 
                grabbedBlock = closestBody; if(grabbedBlock.hasBeenGrabbed !== undefined) grabbedBlock.hasBeenGrabbed = true;
                AudioSys.grab();
                if (grabbedBlock.type === 'yellow' || grabbedBlock.type === 'big_yellow') { grabbedBlock.body.type = CANNON.Body.DYNAMIC; grabbedBlock.body.updateMassProperties(); }
                grabbedBlock.body.wakeUp(); 
            }
        }
    });

    document.addEventListener('pointerup', e => { 
        isMouseDown = false;
        // Flush any deferred physics rebuild from drag-placing
        if (_editorPhysicsDirty && isEditorMode && !isPlayingCustom) {
            _editorPhysicsDirty = false;
            updateEditorVisuals();
        }
        if (e.button === 0) {
            if(grabbedBlock && !isPaused) {
                if (grabbedBlock.type === 'yellow' || grabbedBlock.type === 'big_yellow') { 
                    grabbedBlock.body.type = CANNON.Body.KINEMATIC; grabbedBlock.body.velocity.set(0,0,0); grabbedBlock.body.angularVelocity.set(0,0,0); 
                    grabbedBlock.body.quaternion.set(globalTiltThree.x, globalTiltThree.y, globalTiltThree.z, globalTiltThree.w); grabbedBlock.body.updateMassProperties(); 
                }
                grabbedBlock = null; AudioSys.drop();
            }
        }
    });

    // Speed limiter: max placement rate during drag (ms between placements)
    const EDITOR_PLACE_INTERVAL_MS = 80; // ~12 blocks/sec max while dragging
    let _lastEditorPlaceTime = 0;

    document.addEventListener('pointermove', e => {
        if (!isEditorMode || isPlayingCustom || !isMouseDown || editorTool !== 'wall') return;
        if (isPaused || document.pointerLockElement !== document.body) return;

        // --- SPEED LIMITER ---
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
            const hit = validHit;
            const norm = hit.face.normal;

            if (isLeftClick) {
                const p = hit.point.clone().add(norm.clone().multiplyScalar(0.5));
                const key = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
                if (!customSolidBlocks.has(key)) {
                    customSolidBlocks.add(key);
                    _lastEditorPlaceTime = _now;
                    updateEditorVisuals();
                }
            } 
            else if (isRightClick) {
                const p = hit.point.clone().sub(norm.clone().multiplyScalar(0.5));
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
    const rayResult = new CANNON.RaycastResult();

    function getAvailableSpace(block) {
        let maxS = RED_SCALE_MAX;
        for(let i=0; i<getSpaceAxes.length; i++) {
            const worldAxis = block.body.quaternion.vmult(getSpaceAxes[i]); const pos = block.body.position; let distPos = 10, distNeg = 10;
            world.raycastClosest(pos, new CANNON.Vec3(pos.x + worldAxis.x*10, pos.y + worldAxis.y*10, pos.z + worldAxis.z*10), { skipBackfaces: true, collisionFilterMask: CG_STATIC | CG_PLAYER }, rayResult);
            if (rayResult.hasHit) distPos = rayResult.distance;
            world.raycastClosest(pos, new CANNON.Vec3(pos.x - worldAxis.x*10, pos.y - worldAxis.y*10, pos.z - worldAxis.z*10), { skipBackfaces: true, collisionFilterMask: CG_STATIC | CG_PLAYER }, rayResult);
            if (rayResult.hasHit) distNeg = rayResult.distance;
            const available = (distPos + distNeg) - 0.12; if (available < maxS) maxS = available;
        }
        return maxS;
    }

    document.addEventListener('wheel', e => {
        // --- ADDED FOR ZOOM ---
        if (isPreviewMode) {
            // e.deltaY is positive when scrolling down, negative when scrolling up
            previewDistance += e.deltaY * 0.02; 

            // Clamp the zoom so the player doesn't go inside the floor or too far away
            previewDistance = Math.max(5, Math.min(45, previewDistance));
            return; // Don't run the Red block scaling logic while in preview
        }
        // --- END ZOOM LOGIC ---

        if (isPaused || !controls.isLocked || isTransitioning || isCutscene) return;
        raycaster.setFromCamera(screenCenter, camera);
        let redTargets = []; for(let i=0; i<interactiveBlocks.length; i++) { if(interactiveBlocks[i].type === 'red') redTargets.push(interactiveTargets[i]); }
        let intersects = raycaster.intersectObjects(redTargets);
        let block = null;
        if (intersects.length > 0 && intersects[0].distance < 15) { block = meshToBlock.get(intersects[0].object) ?? null; } 
        else {
            let closestDist = 4.0; const ray = raycaster.ray;
            for (let i=0; i<interactiveBlocks.length; i++) {
                const b = interactiveBlocks[i]; if (b.type !== 'red') continue;
                _v1.set(b.body.position.x, b.body.position.y, b.body.position.z);
                if (distSq(camera.position, _v1) < 100) { const d = ray.distanceSqToPoint(_v1); if (d < closestDist) { closestDist = d; block = b; } }
            }
        }

        if (block) {
            let deltaScale = e.deltaY < 0 ? 0.25 : -0.25; let maxS = getAvailableSpace(block);
            let targetScale = Math.max(RED_SCALE_MIN, Math.min(RED_SCALE_MAX, block.scale + deltaScale));
            if (deltaScale > 0 && targetScale > maxS) targetScale = Math.max(block.scale, maxS);

            if (Math.abs(targetScale - block.scale) > 0.001) {
                if (deltaScale > 0) {
                    let shift = new CANNON.Vec3();
                    for (let i = 0; i < world.contacts.length; i++) {
                        let c = world.contacts[i];
                        if (c.bi === block.body || c.bj === block.body) { let n = c.bi === block.body ? c.ni.clone() : c.ni.clone().scale(-1); shift.x -= n.x; shift.y -= n.y; shift.z -= n.z; }
                    }
                    if (shift.lengthSquared() > 0) { shift.normalize(); shift.scale(deltaScale / 2, shift); block.body.position.vadd(shift, block.body.position); }
                }
                block.scale = targetScale; block.mesh.scale.setScalar(targetScale); const half = targetScale * 0.5;
                block.body.removeShape(block.body.shapes[0]); block.body.addShape(new CANNON.Box(new CANNON.Vec3(half, half, half)));
                block.body.updateMassProperties(); block.body.wakeUp();
                block.mat.emissiveIntensity = 1.0; setTimeout(() => { if(block && block.mat) block.mat.emissiveIntensity = 0.6; }, 150);

                const scaleHud = document.getElementById('scale-hud'); scaleHud.textContent = `◆ SIZE ${Math.round(block.scale * 100)}% ◆`; scaleHud.style.opacity = '1';
                clearTimeout(scaleHudTimeout); scaleHudTimeout = setTimeout(() => scaleHud.style.opacity = '0', 1000); AudioSys.resize(deltaScale);
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

    function addVolumetricPointLight(pos, color, intensity, range) {
        const light = new THREE.PointLight(color, intensity, range);
        light.position.copy(pos);
        scene.add(light);
        levelLights.push(light);
        return light;
    }

    function updateEditorVisuals(forcePhysicsRebuild = false) {
        // 1. Reset Visual Instance Counts
        for (const key in editorInstancedMeshes) editorInstancedMeshes[key].count = 0;

        const placeInstance = (x, y, z, tool, scale = 1) => {
            const im = editorInstancedMeshes[tool];
            if (im && im.count < MAX_EDITOR_BLOCKS) {
                dummy.position.set(x, y, z);
                dummy.rotation.set(0,0,0);
                dummy.scale.setScalar(scale);
                dummy.updateMatrix();
                im.setMatrixAt(im.count++, dummy.matrix);
            }
        };

        // Batch render components
        customSolidBlocks.forEach(k => { const [x,y,z] = k.split(',').map(Number); placeInstance(x,y,z,'wall'); });
        customEntities.forEach(ent => placeInstance(ent.x, ent.y, ent.z, ent.type));
        customDestruction.forEach(b => placeInstance(b.cx, b.cy, b.cz, 'bomb'));
        customPlates.forEach(p => placeInstance(p.x, p.y, p.z, 'plate', 0.8));
        customDoors.forEach(d => placeInstance(d.x, d.y, d.z, 'door', 1.0));
        customFields.forEach(f => placeInstance(f.x, f.y, f.z, f.type, 1.0));
        customDecorations.forEach(d => placeInstance(d.x, d.y, d.z, d.type, 0.75));
        placeInstance(customSpawn.x, customSpawn.y, customSpawn.z, 'spawn');
        placeInstance(customExit.x, customExit.y, customExit.z, 'exit');

        // Update GPU Buffers
        for (const key in editorInstancedMeshes) {
            editorInstancedMeshes[key].instanceMatrix.needsUpdate = true;
        }

        // 2. Optimized Physics Sync (Deferred)
        if (isMouseDown && !forcePhysicsRebuild) {
            _editorPhysicsDirty = true; // Handle rebuild on mouseUp
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

    // ── LOGIC VISUALIZER ─────────────────────────────────────────────────────
    const logicVisualizerGroup = new THREE.Group();
    scene.add(logicVisualizerGroup);

    function updateLogicVisualizer() {
        // 1. Dispose and clear previous lines
        while (logicVisualizerGroup.children.length > 0) {
            const obj = logicVisualizerGroup.children[0];
            obj.geometry.dispose();
            // Materials are shared per-channel, dispose only once below
            logicVisualizerGroup.remove(obj);
        }

        // Only show in Editor Mode (not during play-test)
        if (!isEditorMode || isPlayingCustom) return;

        // 2. Map channels → source / target world positions
        const channels = Array.from({ length: 10 }, () => ({ sources: [], targets: [] }));

        // Sources: Pressure Plates
        customPlates.forEach(p => {
            channels[p.channel].sources.push(
                new THREE.Vector3(p.x, p.y + 0.5, p.z).applyQuaternion(globalTiltThree)
            );
        });

        // Targets: Doors
        customDoors.forEach(d => {
            channels[d.channel].targets.push(
                new THREE.Vector3(d.x, d.y, d.z).applyQuaternion(globalTiltThree)
            );
        });

        // Targets: Aero / One-Way Fields
        customFields.forEach(f => {
            channels[f.channel].targets.push(
                new THREE.Vector3(f.x, f.y, f.z).applyQuaternion(globalTiltThree)
            );
        });

        // 3. Draw glowing lines between every source → target on the same channel
        channels.forEach((ch, index) => {
            if (ch.sources.length === 0 || ch.targets.length === 0) return;

            const color = CHANNEL_COLORS[index];
            // One shared material per channel
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

    // ── END LOGIC VISUALIZER ─────────────────────────────────────────────────

    const clock = new Timer();
    const crosshairEl = document.getElementById('crosshair'); // cached to avoid per-frame DOM lookup
    let _frameCount = 0;
    let elapsedTime = 0; // accumulated seconds — replaces repeated Date.now() calls in animate

    function animate() {
        requestAnimationFrame(animate);
        _frameCount++;
        clock.update();
        const delta = Math.min(clock.getDelta(), 0.05);
        elapsedTime += delta;

        const activeCamera = isCutscene ? cutsceneCamera : camera;

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

        // --- REAL-TIME EDITOR PREVIEW ---
        // Throttled to every 2nd frame — ghost mesh position lags by <17ms, imperceptible
        if (isEditorMode && !isPlayingCustom && !isPaused && !isTabSelectorOpen && (_frameCount % 2 === 0)) {
            raycaster.setFromCamera(screenCenter, activeCamera);
            const hits = raycaster.intersectObjects(editorSceneGroup.children, false);

            let validHit = null;
            for (let i = 0; i < hits.length; i++) {
                if (hits[i].face) { validHit = hits[i]; break; }
            }

            // Inside animate() -> Editor Preview section
            if (validHit) {
                const hit = validHit;
                const norm = hit.face.normal;
                ghostMesh.visible = true;

                const p = hit.point.clone().add(norm.clone().multiplyScalar(0.5));
                ghostMesh.position.set(Math.round(p.x), Math.round(p.y), Math.round(p.z));

                // Default scale for most blocks
                ghostMesh.scale.set(1, 1, 1);

                if (['door', 'oneway', 'aero'].includes(editorTool)) {
                    if (editorTool === 'door') ghostMesh.scale.set(editorDoorWidth, editorDoorHeight, 0.2);
                    else ghostMesh.scale.set(3, 3, 0.5); // Preview size for fields

                    // Use proper lookAt based on the face normal
                    const target = ghostMesh.position.clone().add(norm);
                    ghostMesh.lookAt(target);
                } else {
                    ghostMesh.rotation.set(0, 0, 0);
                }
            }
        }

        // --- LOGIC VISUALIZER PULSE ---
        if (isEditorMode && !isPlayingCustom && logicVisualizerGroup.children.length > 0) {
            const _lvChildren = logicVisualizerGroup.children;
            for (let _lvi = 0; _lvi < _lvChildren.length; _lvi++) {
                const _line = _lvChildren[_lvi];
                _line.material.opacity = 0.3 + Math.sin(elapsedTime * 5 + _line.userData.phase) * 0.2;
            }
        }

        updateWater(delta);

        // --- UNDERWATER VISUAL EFFECTS ---
        if (currentParams && currentParams.waterY !== undefined) {
            const isUnderwater = activeCamera.position.y < currentParams.waterY;
            const chEnv = CHAPTERS[activeChapter].env;

            if (isUnderwater) {
                // Submerged: Deep blue/teal fog and background
                scene.fog.color.setHex(0x001a2d);
                scene.fog.density = 0.15; // Much thicker fog
                scene.background = new THREE.Color(0x00101a);
            } else {
                // Above Water: Restore chapter defaults
                scene.fog.color.setHex(chEnv.fog);
                scene.fog.density = chEnv.density;
                scene.background = morningHorizon; // or chEnv.sky
            }
        }

        // Safely sync listener to camera once AudioContext exists — throttled to every 3rd frame
        // (audio perception can't detect sub-50ms lag; saves 9 AudioParam writes per skipped frame)
        if (AudioSys.ctx && AudioSys.ctx.listener && _frameCount % 3 === 0) {
            const listener = AudioSys.ctx.listener;
            if (listener.positionX) {
                listener.positionX.value = activeCamera.position.x;
                listener.positionY.value = activeCamera.position.y;
                listener.positionZ.value = activeCamera.position.z;

                activeCamera.getWorldDirection(_dir);
                if(listener.forwardX) {
                    listener.forwardX.value = _dir.x;
                    listener.forwardY.value = _dir.y;
                    listener.forwardZ.value = _dir.z;
                    listener.upX.value = activeCamera.up.x;
                    listener.upY.value = activeCamera.up.y;
                    listener.upZ.value = activeCamera.up.z;
                }
            }
        }

        if (isPreviewMode) {
            // 1. Update rotation angle
            previewAngle += delta * 0.10; 

            // 2. Calculate the visual center of the level
            // We take half the height of the bounds and apply the Global Tilt
            const levelHeightCenter = currentParams.bounds.y * 0.5;
            const lookAtTarget = _v3.set(0, levelHeightCenter, 0).applyQuaternion(globalTiltThree);

            // 3. Position camera in an orbit around that specific target
            // We add the orbit offset to the lookAtTarget's coordinates
            activeCamera.position.set(
                lookAtTarget.x + Math.cos(previewAngle) * previewDistance, 
                lookAtTarget.y + (previewDistance * 0.5), // Elevated view
                lookAtTarget.z + Math.sin(previewAngle) * previewDistance
            ); 

            // 4. Force the camera to look at that calculated center point
            activeCamera.lookAt(lookAtTarget);

            // Keep your existing goal/sky logic below
            if(currentGoal) { 
                currentGoal.userData.core.rotation.y += 0.02; currentGoal.userData.core.rotation.z += 0.01; 
                if(currentGoal.userData.shell) { currentGoal.userData.shell.rotation.x -= 0.015; currentGoal.userData.shell.rotation.y -= 0.01; }
                currentGoal.userData.core.position.y = 1.0 + Math.sin(elapsedTime * 3 * 0.2) * 0.2; 
            }
            skyMesh.rotation.y += 0.0004;

        } else if (!isPaused || isCutscene) {
            if (isRKeyDown && controls.isLocked && !isTransitioning && !isCutscene && !isPaused) {
                rKeyTimer += delta; const scaleHud = document.getElementById('scale-hud');
                scaleHud.textContent = `RESETTING... ${Math.min(100, Math.floor((rKeyTimer/1)*100))}%`; scaleHud.style.opacity = '1'; clearTimeout(scaleHudTimeout);
                if (rKeyTimer >= 1) { isRKeyDown = false; rKeyTimer = 0; scaleHud.style.opacity = '0'; triggerLevelTransition(true); }
            } else if (rKeyTimer > 0) { rKeyTimer = 0; document.getElementById('scale-hud').style.opacity = '0'; }
            else {
                ghostMesh.visible = false;
                editorPreviewLight.intensity = 0;
            }

            world.step(1 / 60, delta, 2);
            skyMesh.rotation.y += 0.0004; const activeTime = elapsedTime * 3;
            // Hoist shared sin values — avoids N Math.sin calls per block per frame
            const _redEmissive  = 0.55 + Math.sin(activeTime * 4) * 0.25;
            const _cyanEmissive = 1.0  + Math.sin(activeTime * 3) * 0.5;

            // --- DUST PARTICLES ---
            if (dustMesh.visible) { dustMesh.rotation.y += delta * 0.02; dustMesh.position.y = Math.sin(activeTime * 0.2) * 2; dustMesh.updateMatrix(); }

            sparkMesh.rotation.y += delta * 0.05;
            sparkMat.opacity = (levelLights.length > 0) ? 0.4 + Math.sin(activeTime * 3.7) * 0.2 : 0.0;
            sparkMesh.position.set(playerBody.position.x, playerBody.position.y, playerBody.position.z);

            if (pendingBounce) {
                // Base bounce is 20. Add 20% of the fall impact speed for momentum
                // We cap the maximum at 40 so the player doesn't clip through ceilings.
                let bounceForce = Math.max(20, 20 + (pendingBounceVelocity * 0.32));
                playerBody.velocity.y = Math.min(40, bounceForce);

                // Nudge player above the pad so the next world.step() doesn't see an
                // active contact and fight the upward velocity with a corrective impulse.
                playerBody.position.y += 0.05;
                if (pendingBounceBlock) { 
                    let b = pendingBounceBlock; 
                    b.mat.emissiveIntensity = 2.5; 
                    setTimeout(() => { if (b && b.mat) b.mat.emissiveIntensity = 0.7; }, 300); 
                }

                // Reset our flags
                pendingBounce = false; 
                pendingBounceBlock = null;
                pendingBounceVelocity = 0; 
            }   

            // 1. Reset raw inputs
            logicNodes.inputs.fill(false);

            // 2. Check Plates (Updated to set logicNodes.inputs)
            activePlates.forEach(p => {
                let block = null;

                // Unified loop to find if a block is sitting on this specific plate
                for (let i = 0; i < interactiveBlocks.length; i++) {
                    const b = interactiveBlocks[i];
                    if (b.body.position.distanceTo(p.body.position) < 1.3 && b.body.position.y > p.body.position.y) { 
                        block = b; 
                        break; 
                    }
                }

                // If found, update the logic input for this channel
                if (block) {
                    logicNodes.inputs[p.channel] = true;
                }

                // --- Visual Animations (Gears & Siphoning) ---
                const targetProgress = block ? 1.0 : 0.0; 
                p.progress = THREE.MathUtils.lerp(p.progress, targetProgress, 0.08);

                const yOffset = 1.9 - (0.7 * p.progress);
                p.group.position.y = yOffset;

                // Sync Kinematic Physics body position with visual animation
                _v1.set(0, yOffset, 0).applyQuaternion(globalTiltThree);
                p.body.position.set(
                    p.basePos.x + _v1.x,
                    p.basePos.y + _v1.y,
                    p.basePos.z + _v1.z
                );

                // Physical Gear Simulation
                const linearTravel = 1.0 * p.progress;
                p.gears.forEach(g => {
                    const rotationAngle = (linearTravel / g.pitchR) * g.dir; 
                    const finalAngle = g.baseAngle + rotationAngle;
                    if (g.axis === 'z') g.mesh.rotation.z = finalAngle;
                    if (g.axis === 'x') g.mesh.rotation.x = finalAngle;
                });

                // Dynamic Energy Colors/Pulses
                if (block) {
                    const col = blockConfigs[block.type].mat.color;
                    const pulse = 0.8 + Math.sin(elapsedTime * 6) * 0.2;

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
                    // Dim the net when inactive
                    f.baseMesh.material.opacity = f.active ? 0.15 : 0.02;
                    f.gridLines.material.opacity = f.active ? 0.6 : 0.05;
                }

                if (f.type === 'oneway') {
                    // Toggle shield and holographic arrows
                    f.arrowGroup.visible = f.active;
                    f.shieldMesh.material.color.setHex(f.active ? 0xffaa00 : 0x333333);
                    f.shieldMesh.material.opacity = f.active ? 0.25 : 0.1;

                    // --- Keep the existing physics logic untouched ---
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

            // 3. Update Doors
            activeDoors.forEach(d => {
                // Pull the state from the resolved logic array
                const isOpen = logicNodes.resolved[d.channel] === true;

                d.progress = THREE.MathUtils.lerp(d.progress, isOpen ? 1 : 0, 0.05);

                // Optimization: Use pre-allocated _v1 instead of .clone() to save memory
                _v1.copy(d.moveVector).multiplyScalar(d.progress);

                d.group.position.copy(d.basePos).add(_v1);
                d.body.position.copy(d.group.position);
            });

            activeWinds.forEach(wind => {
                // 1. Visuals: Animate the high-speed lines
                const posAttr = wind.visuals.geometry.attributes.position;
                for (let i = 0; i < wind.speeds.length; i++) {
                    // Move both vertices of the line segment
                    posAttr.array[i*6+2] += delta * wind.speeds[i];
                    posAttr.array[i*6+5] += delta * wind.speeds[i];

                    // Loop back to the start if it passes the bounds
                    if (posAttr.array[i*6+2] > wind.size.z) {
                        let len = posAttr.array[i*6+2] - posAttr.array[i*6+5];
                        posAttr.array[i*6+2] = -wind.size.z;
                        posAttr.array[i*6+5] = -wind.size.z - len;
                    }
                }
                posAttr.needsUpdate = true;

                // 2. Physics check: Player
                _v1.set(playerBody.position.x - wind.pos.x, playerBody.position.y - wind.pos.y, playerBody.position.z - wind.pos.z);
                if (Math.abs(_v1.x) < wind.size.x && Math.abs(_v1.y) < wind.size.y && Math.abs(_v1.z) < wind.size.z) {

                    let isShielded = false;
                    const rayOrigin = playerBody.position;
                    _windRayDir.set(-wind.dir.x, -wind.dir.y, -wind.dir.z);
                    _windRayDest.set(rayOrigin.x + _windRayDir.x * 4, rayOrigin.y + _windRayDir.y * 4, rayOrigin.z + _windRayDir.z * 4);

                    world.raycastClosest(rayOrigin, _windRayDest, { 
                        collisionFilterMask: CG_DYNAMIC | 16, // Include Group 16 (Aero Filters)
                        skipBackfaces: true 
                    }, rayResult);

                    if (rayResult.hasHit) {
                        // Only shield if it's a block OR an ACTIVE Aero Filter
                        if (rayResult.body.collisionFilterGroup === CG_DYNAMIC) isShielded = true;
                        else {
                            const filter = activeFields.find(f => f.body === rayResult.body);
                            if (filter && filter.active) isShielded = true;
                        }
                    }

                    if (!isShielded) {
                        // Calculate falloff so wind is weaker at the edges
                        let edgeFalloffX = 1.0 - (Math.abs(_v1.x) / wind.size.x);
                        let edgeFalloffZ = 1.0 - (Math.abs(_v1.z) / wind.size.z);
                        let falloff = Math.min(edgeFalloffX, edgeFalloffZ);
                        falloff = Math.max(0.2, Math.min(1.0, falloff * 2.0)); // Smoother transition

                        _cannonImpulse.set(
                            (wind.dir.x) * wind.strength * 50 * falloff, 
                            (wind.dir.y) * wind.strength * 50 * falloff, 
                            (wind.dir.z) * wind.strength * 50 * falloff
                        );
                        playerBody.applyForce(_cannonImpulse, playerBody.position);

                        // Camera buffeting effect when in wind
                        activeCamera.rotation.z += (Math.random() - 0.5) * 0.005 * falloff;
                    }
                }

                // 3. Physics check: Dynamic Blocks
                interactiveBlocks.forEach(block => {
                    _v1.set(block.body.position.x - wind.pos.x, block.body.position.y - wind.pos.y, block.body.position.z - wind.pos.z);
                    if (Math.abs(_v1.x) < wind.size.x && Math.abs(_v1.y) < wind.size.y && Math.abs(_v1.z) < wind.size.z) {

                        // Red blocks distribute mass much better. Scale matters exponentially against wind.
                        const massScale = block.scale ? Math.pow((1 / block.scale), 2) : 1.0; 

                        let turbX = Math.sin(activeTime * 5 + block.body.id) * 0.1;
                        let turbZ = Math.cos(activeTime * 6 + block.body.id) * 0.1;

                        _cannonImpulse.set(
                            (wind.dir.x + turbX) * wind.strength * block.body.mass * massScale,
                            (wind.dir.y) * wind.strength * block.body.mass * massScale,
                            (wind.dir.z + turbZ) * wind.strength * block.body.mass * massScale
                        );
                        block.body.applyForce(_cannonImpulse, block.body.position);

                        // NEW: Aerodynamic Drag! 
                        // Heavily dampens rotation so blocks don't spin wildly when scraping against walls in the updraft.
                        block.body.angularVelocity.scale(0.99, block.body.angularVelocity);
                    }
                });
            });

            for (let i = 0; i < interactiveBlocks.length; i++) {
                const item = interactiveBlocks[i];
                if (item.type === 'red') item.mat.emissiveIntensity = _redEmissive;
                else if (item.type === 'cyan' || item.type === 'yellow') item.mat.emissiveIntensity = _cyanEmissive;
                if (item.body.position.y < -20) {
                    item.body.position.copy(item.initialPos); item.body.velocity.set(0,0,0); item.body.angularVelocity.set(0,0,0); item.hasBeenGrabbed = false;
                    if (item.type === 'red' && item.initialScale !== undefined) {
                        item.scale = item.initialScale; item.mesh.scale.setScalar(item.initialScale);
                        const half = item.initialScale * 0.5; item.body.removeShape(item.body.shapes[0]); item.body.addShape(new CANNON.Box(new CANNON.Vec3(half, half, half)));
                    }
                    if (item.type === 'yellow' || item.type === 'big_yellow') {
                        item.body.type = CANNON.Body.KINEMATIC; item.body.quaternion.set(globalTiltThree.x, globalTiltThree.y, globalTiltThree.z, globalTiltThree.w);
                    }
                    item.body.updateMassProperties(); item.body.wakeUp();
                    if (grabbedBlock === item) { grabbedBlock = null; AudioSys.drop(); }
                }
            }

            if (controls.isLocked && !isTransitioning) {

                // Throttle crosshair/audio raycast to improve performance
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

                    setTimeout(() => {
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
                    }, 150);
                }

                let currentlyGrounded = false;
                rayStart.copy(playerBody.position); rayEnd.copy(playerBody.position); rayEnd.y -= playerHalfH + 0.12;
                world.raycastClosest(rayStart, rayEnd, { skipBackfaces: true, collisionFilterMask: CG_STATIC | CG_DYNAMIC }, rayResult);
                currentlyGrounded = rayResult.hasHit;

                if (!currentlyGrounded) {
                    for (let i = 0; i < world.contacts.length; i++) {
                        let c = world.contacts[i];
                        if (c.bi === playerBody || c.bj === playerBody) { let normalY = (c.bi === playerBody) ? -c.ni.y : c.ni.y; if (normalY > 0.5) { currentlyGrounded = true; break; } }
                    }
                }

                wasGrounded = currentlyGrounded; if (currentlyGrounded) coyoteTimer = COYOTE_TIME; else coyoteTimer -= delta;

                activeCamera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize(); rgt.copy(fwd).cross(activeCamera.up).normalize();

                targetVel.set(0, 0, 0);
                if(!isCutscene) {
                    if (keys.w) targetVel.add(fwd); if (keys.s) targetVel.sub(fwd);
                    if (keys.d) targetVel.add(rgt); if (keys.a) targetVel.sub(rgt);
                }
                const isSprinting = keys.shift && currentlyGrounded && !isCutscene && targetVel.lengthSq() > 0;
                if (targetVel.lengthSq() > 0) targetVel.normalize().multiplyScalar(isSprinting ? 10 : 6.5);

                for (let i = 0; i < world.contacts.length; i++) {
                    const c = world.contacts[i]; let nx = 0, ny = 0, nz = 0; let contactRelY = 0;
                    if (c.bi === playerBody) { nx = -c.ni.x; ny = -c.ni.y; nz = -c.ni.z; contactRelY = c.ri.y; } else if (c.bj === playerBody) { nx = c.ni.x; ny = c.ni.y; nz = c.ni.z; contactRelY = c.rj.y; } else continue;
                    if (Math.abs(ny) > 0.5) continue; if (contactRelY < -0.3) continue;

                    let l = Math.sqrt(nx * nx + nz * nz); if (l > 0.0001) { nx /= l; nz /= l; } else continue;
                    const dot = targetVel.x * nx + targetVel.z * nz; if (dot < 0) { targetVel.x -= dot * nx; targetVel.z -= dot * nz; }
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
                    let jumpTarget = 11;
                    let requiredImpulse = jumpTarget - playerBody.velocity.y;
                    if (requiredImpulse > 0) {
                        playerBody.applyImpulse(_cannonImpulse2.set(0, requiredImpulse * playerBody.mass, 0), playerBody.position);
                    }
                    coyoteTimer = 0; 
                }

                if (waterMesh && currentParams && currentParams.waterY !== undefined) {
                    const waterSurface = currentParams.waterY;
                    const playerY = playerBody.position.y;
                    const submerged = playerY < waterSurface;   // feet below water
                    const headUnder = playerY + playerHalfH * 0.85 < waterSurface; // head under

                    if (submerged) {
                        // Buoyancy — push up proportional to submersion depth
                        const subDepth = Math.min(waterSurface - playerY, playerHalfH * 2);
                        const buoyancyForce = subDepth * 28 * playerBody.mass;
                        _cannonImpulse.set(0, buoyancyForce * delta, 0);
                        playerBody.applyForce(_cannonImpulse, playerBody.position);

                        // Strong water drag — kills excessive velocity
                        const drag = headUnder ? 0.18 : 0.10;
                        playerBody.applyImpulse(_cannonImpulse.set(
                            -playerBody.velocity.x * drag * playerBody.mass,
                            (playerBody.velocity.y < 0) ? -playerBody.velocity.y * drag * playerBody.mass : 0,
                            -playerBody.velocity.z * drag * playerBody.mass
                        ), playerBody.position);

                        // Space = swim up
                        if (keys.space) { 
                            playerBody.applyImpulse(_cannonImpulse2.set(0, 30 * delta * playerBody.mass, 0), playerBody.position);
                            coyoteTimer = 0; 
                        }
                    }
                }

                _v1.set(playerBody.position.x, playerBody.position.y + playerHalfH * 0.85, playerBody.position.z);
                activeCamera.position.lerp(_v1, 0.4);

                let targetFov = isSprinting ? 92 : (currentlyGrounded && speedSq > 1) ? 85 : 75;
                if (Math.abs(activeCamera.fov - targetFov) > 0.1) { activeCamera.fov += (targetFov - activeCamera.fov) * 0.1; activeCamera.updateProjectionMatrix(); }

                // --- REMOVE THE OLD DOUBLE-GOAL LOGIC AND REPLACE WITH THIS ---
                if (currentGoal) {
                    const goalIsLocked = currentGoal.userData.isLocked;

                    if (goalIsLocked) {
                        currentGoal.userData.core.material.color.setHex(0xff0000);
                        currentGoal.userData.core.material.emissive.setHex(0xff0000);
                    } else {
                        if (currentGreenBlock) {
                            // Green block level: Requires Green block at the goal
                            currentGoal.userData.core.material.color.setHex(0x00ffaa);
                            currentGoal.userData.core.material.emissive.setHex(0x00cc55);

                            if (distSq(currentGreenBlock.body.position, currentGoal.position) < 4.25) {
                                currentGoal.userData.core.material.emissive.setHex(0x00ff00);
                                triggerLevelTransition();
                            }
                        } else {
                            // Normal level: Requires Player at the goal
                            currentGoal.userData.core.material.color.setHex(0x00ffff);
                            currentGoal.userData.core.material.emissive.setHex(0x00ffff);

                            if (distSq(playerBody.position, currentGoal.position) < 3.25) {
                                triggerLevelTransition();
                            }
                        }
                    }
                }
            }

            for(let i=0; i<holograms.length; i++) {
                const holo = holograms[i]; const dist = distSq(playerBody.position, holo.basePos); const isActive = dist < 120; 
                const targetOpacity = isActive ? 1 : 0; const targetY = holo.basePos.y + (isActive ? 0.0 + Math.sin(activeTime * 2) * 0.05 : -1.0);
                const flicker = isActive ? 0.88 + Math.sin(activeTime * 17.3) * 0.06 + Math.sin(activeTime * 31.7) * 0.03 : 0;
                holo.sprite.material.opacity = THREE.MathUtils.lerp(holo.sprite.material.opacity, flicker, 0.1);
                holo.sprite.position.y = THREE.MathUtils.lerp(holo.sprite.position.y, targetY, 0.08);
                if (holo.light)    { holo.light.intensity = THREE.MathUtils.lerp(holo.light.intensity, isActive ? 1.0 : 0.0, 0.08); }
                if (holo.baseMat)  { holo.baseMat.opacity = THREE.MathUtils.lerp(holo.baseMat.opacity, isActive ? 0.6 : 0.0, 0.08); }
            }

            if (grabbedBlock) {
                _v3.set(0, 0, -3.5).applyMatrix4(activeCamera.matrixWorld); const bPos = grabbedBlock.body.position;
                _cannonV1.set(_v3.x - bPos.x, _v3.y - bPos.y, _v3.z - bPos.z);
                const strength = 12; grabbedBlock.body.velocity.set(_cannonV1.x * strength, _cannonV1.y * strength, _cannonV1.z * strength);
                grabbedBlock.body.angularVelocity.scale(0.9, grabbedBlock.body.angularVelocity);
            }

            for (let i = 0; i < interactiveBlocks.length; i++) {
                const item = interactiveBlocks[i];

                // NEW: Skip update if the damage system destroyed this block
                if (item.mesh.visible === false) continue; 

                // Water buoyancy for blocks
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
                        // Water drag on blocks
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

            for(let i = 0; i < dynamicRopes.length; i++) {
                const r = dynamicRopes[i]; let isSleeping = true;
                if(r.bodies[0].sleepState) { for(let b of r.bodies) { if(b.sleepState !== CANNON.Body.SLEEPING) isSleeping = false; } } else { isSleeping = false; }
                const dx = r.bodies[0].position.x - playerBody.position.x, dy = r.bodies[0].position.y - playerBody.position.y, dz = r.bodies[0].position.z - playerBody.position.z;

                if (dx*dx+dy*dy+dz*dz > 900) { 
                    r.segmentMeshes.forEach(m => m.visible = false);
                    if(r.bodies[0].sleepState) { for(let b of r.bodies) { if (b.sleepState !== CANNON.Body.SLEEPING) b.sleep(); } } continue; 
                }

                if(isSleeping) continue;

                for(let j = 0; j < r.segmentMeshes.length; j++) {
                    const mesh = r.segmentMeshes[j];
                    mesh.visible = true;
                    _v1.set(r.bodies[j].position.x, r.bodies[j].position.y, r.bodies[j].position.z);
                    _v2.set(r.bodies[j+1].position.x, r.bodies[j+1].position.y, r.bodies[j+1].position.z);
                    mesh.position.copy(_v1).lerp(_v2, 0.5);
                    mesh.lookAt(_v2);
                    mesh.scale.z = _v1.distanceTo(_v2);
                }
            }

            if (exitMesh) { exitMesh.rotation.y += 0.01; exitMesh.updateMatrix(); }

            // ── HUB WORLD FRAME UPDATE ────────────────────────────────────────────
            if (isHubWorld && hubRuntime.active && !isPaused && !isCutscene) {
                _v1.set(playerBody.position.x, playerBody.position.y, playerBody.position.z);
                hubRuntime.update(_v1, elapsedTime);
            }

            if (isCutscene) {
                if (cutsceneType !== 'montage') {
                    cutsceneTimer += delta * 2; let progress = cutsceneTimer / cutsceneDuration;
                    let ease = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
                    overlay.style.transition = 'none';

                    if (cutsceneType === 'wakeup') {
                        let lookAtPos = playerBody.position;
                        cutsceneCamera.position.set(lookAtPos.x, lookAtPos.y + playerHalfH * 0.1 + (ease * playerHalfH * 0.85), lookAtPos.z);
                        cutsceneCamera.rotation.set(-Math.PI / 2 + ease * (Math.PI / 2), 0, 0);
                    } 
                    else if (cutsceneType === 'flyover') {
                        let startPos = currentParams.flyCamStart || _v1.set(10, 15, 10); 
                        let endPos = _v2.set(playerBody.position.x, playerBody.position.y + playerHalfH * 0.85, playerBody.position.z);
                        let midPos = _vMid.lerpVectors(startPos, endPos, 0.5); midPos.y += 5; midPos.x += 4;
                        let t = ease; let mt = 1 - t;
                        cutsceneCamera.position.x = mt*mt*startPos.x + 2*mt*t*midPos.x + t*t*endPos.x; cutsceneCamera.position.y = mt*mt*startPos.y + 2*mt*t*midPos.y + t*t*endPos.y; cutsceneCamera.position.z = mt*mt*startPos.z + 2*mt*t*midPos.z + t*t*endPos.z;
                        let lookStart = currentParams.flyCamLook || _vL1.set(0, 5, 0); let lookEnd = _vL2.set(playerBody.position.x, playerBody.position.y + playerHalfH * 0.85, playerBody.position.z - 5);
                        _vLook.lerpVectors(lookStart, lookEnd, ease); cutsceneCamera.lookAt(_vLook); cutsceneCamera.rotation.z = Math.sin(t * Math.PI) *0.08;
                    }

                    if (progress < 0.1) { overlay.style.opacity = 1 - (progress / 0.1); } 
                    else if (progress > 0.9) { overlay.style.opacity = (progress - 0.9) / 0.1; } 
                    else { overlay.style.opacity = 0; }

                    if (progress >= 1.0) { isCutscene = false; isTransitioning = false; overlay.style.opacity = 0; document.getElementById('crosshair').style.opacity = '1'; }
                }
            }

            if(currentGoal) { 
                currentGoal.userData.core.rotation.y += 0.02; 
                currentGoal.userData.core.rotation.z += 0.01; 
                if (currentGoal.userData.shell) {
                    currentGoal.userData.shell.rotation.x -= 0.015;
                    currentGoal.userData.shell.rotation.y -= 0.01;
                }
                currentGoal.userData.core.position.y = 1.0 + Math.sin(activeTime * 0.2) * 0.2; 
            }
        }

        if (gfx.volumetrics === 2) {
            volumetricPass.material.uniforms.time.value = elapsedTime;

            // Zero-allocation sorting loop
            let lightCount = Math.min(levelLights.length, _lightSortArray.length);
            for (let i = 0; i < lightCount; i++) {
                _lightSortArray[i].light = levelLights[i];
                _lightSortArray[i].dist = levelLights[i].position.distanceToSquared(activeCamera.position);
            }

            // In-place insertion sort (blazing fast for N < 30, 0 GC)
            for (let i = 1; i < lightCount; i++) {
                let key = _lightSortArray[i];
                let j = i - 1;
                while (j >= 0 && _lightSortArray[j].dist > key.dist) {
                    _lightSortArray[j + 1] = _lightSortArray[j];
                    j = j - 1;
                }
                _lightSortArray[j + 1] = key;
            }

            // Fill the FIXED-LENGTH uniform arrays
            for (let i = 0; i < MAX_VOL_LIGHTS; i++) {
                if (i < lightCount) {
                    const l = _lightSortArray[i].light;
                    l.getWorldPosition(_worldPosVec);
                    pointPosUniformArray[i].copy(_worldPosVec);
                    pointColUniformArray[i].set(l.color.r, l.color.g, l.color.b).multiplyScalar(l.intensity);
                } else {
                    // Fill unused slots with zero
                    pointPosUniformArray[i].set(0, 0, 0);
                    pointColUniformArray[i].set(0, 0, 0);
                }
            }

            volumetricPass.material.uniforms.pointLightCount.value = Math.min(lightCount, MAX_VOL_LIGHTS);
        }

        // Ensure camera-dependent passes know which camera is active
        renderPass.camera = activeCamera;
        ssaoPass.camera = activeCamera;
        ssrPass.camera = activeCamera;

        // Depth pre-pass: render scene into depthCaptureTarget so the volumetric
        // ShaderPass has a real depth texture to reconstruct world positions from.
        // Camera matrix uniforms are also updated here every frame.
        if (gfx.volumetrics === 2) {
            renderer.setRenderTarget(depthCaptureTarget);
            renderer.render(scene, activeCamera);
            renderer.setRenderTarget(null);
            const volU = volumetricPass.material.uniforms;
            volU.cameraProjectionMatrixInverse.value.copy(activeCamera.projectionMatrixInverse);
            volU.cameraMatrixWorld.value.copy(activeCamera.matrixWorld);
        }

        composer.render();
    }

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
        cutsceneCamera.aspect = window.innerWidth / window.innerHeight; cutsceneCamera.updateProjectionMatrix();
        applyGraphics();
    });

    SaveSystem.load(); // <--- LOAD SAVES
    applyGraphics(); animate();