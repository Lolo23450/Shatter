import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// =======================================================
// SHADERS
// =======================================================

const vertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const ssrFragmentShader = `
    varying vec2 vUv;

    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform sampler2D tNormal;

    uniform mat4 projMatrix;
    uniform mat4 invProjMatrix;
    uniform vec2 resolution;

    uniform float maxDistance;
    uniform float thickness;
    uniform int maxSteps;
    uniform int binarySearchSteps;
    uniform float stride;

    vec3 getViewPos(vec2 uv, float depth) {
        vec4 clipSpace = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec4 viewSpace = invProjMatrix * clipSpace;
        return viewSpace.xyz / viewSpace.w;
    }

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
        float depth = texture2D(tDepth, vUv).r;
        if (depth >= 1.0) { discard; }

        vec3 viewPos = getViewPos(vUv, depth);
        vec3 normal = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0); 

        vec3 viewDir = normalize(viewPos);
        vec3 reflectDir = normalize(reflect(viewDir, normal));

        // Optimization & Artifact Fix: Don't trace rays pointing at the camera
        if (reflectDir.z > 0.0) { discard; }

        // Ray Bias: Move the start position slightly along the normal to prevent self-intersection
        vec3 rayPos = viewPos + normal * 0.05;
        
        // Jitter the step to turn banding into noise (which we blur later)
        float jitter = hash(vUv + fract(reflectDir.xy));
        vec3 rayStep = reflectDir * stride;
        rayPos += rayStep * jitter;
        
        vec2 hitUv = vec2(-1.0);
        bool hit = false;
        float finalDepthDiff = 0.0;

        for (int i = 0; i < 120; i++) {
            if(i >= maxSteps) break;
            rayPos += rayStep;

            vec4 clipPos = projMatrix * vec4(rayPos, 1.0);
            vec2 currentUv = (clipPos.xy / clipPos.w) * 0.5 + 0.5;

            if (currentUv.x < 0.0 || currentUv.x > 1.0 || currentUv.y < 0.0 || currentUv.y > 1.0) break;

            float sampledDepth = texture2D(tDepth, currentUv).r;
            vec3 sampledViewPos = getViewPos(currentUv, sampledDepth);

            float depthDiff = rayPos.z - sampledViewPos.z;

            // Better thickness logic: avoids hitting things too far behind
            if (depthDiff > 0.0 && depthDiff < thickness) {
                hit = true;
                hitUv = currentUv;
                finalDepthDiff = depthDiff;
                break;
            }
        }

        if (hit) {
            // Refine hit position
            vec3 vd = rayStep;
            for (int i = 0; i < 10; i++) {
                if (i >= binarySearchSteps) break;
                vd *= 0.5;
                vec4 clipPos = projMatrix * vec4(rayPos, 1.0);
                vec2 currentUv = (clipPos.xy / clipPos.w) * 0.5 + 0.5;
                float sDepth = texture2D(tDepth, currentUv).r;
                vec3 sPos = getViewPos(currentUv, sDepth);
                if (rayPos.z - sPos.z > 0.0) rayPos -= vd; else rayPos += vd;
                hitUv = currentUv;
            }

            // Artifact Reduction: Fade based on how deep the ray hit the geometry
            float thicknessFade = clamp(1.0 - (finalDepthDiff / thickness), 0.0, 1.0);
            
            // Fade at screen edges
            vec2 dUv = abs(hitUv - 0.5) * 2.0;
            float edgeFade = clamp(1.0 - max(dUv.x, dUv.y), 0.0, 1.0);
            edgeFade = smoothstep(0.0, 0.2, edgeFade);

            // Fade based on distance
            float dist = distance(viewPos, rayPos);
            float distFade = clamp(1.0 - (dist / maxDistance), 0.0, 1.0);

            vec3 color = texture2D(tColor, hitUv).rgb;
            gl_FragColor = vec4(color, edgeFade * distFade * thicknessFade);
        } else {
            gl_FragColor = vec4(0.0);
        }
    }
`;

const compositeFragmentShader = `
    varying vec2 vUv;
    uniform sampler2D tOriginal;
    uniform sampler2D tSSR;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float opacity;

    void main() {
        vec4 base = texture2D(tOriginal, vUv);
        float centerDepth = texture2D(tDepth, vUv).r;
        vec2 texelSize = 1.0 / resolution;

        // SMART DENOISE: 9-Tap Bilateral Filter
        vec4 ssrSum = vec4(0.0);
        float weightSum = 0.0;

        for(int x = -2; x <= 2; x++) {
            for(int y = -2; y <= 2; y++) {
                vec2 offset = vec2(float(x), float(y)) * texelSize * 1.5;
                vec4 sampleSSR = texture2D(tSSR, vUv + offset);
                float sampleDepth = texture2D(tDepth, vUv + offset).r;

                // Weight by depth similarity to prevent blurring across object edges
                float weight = 1.0 / (0.0001 + abs(centerDepth - sampleDepth) * 5000.0);
                weight *= (1.0 - length(vec2(x, y)) / 4.0); // Spatial weight
                
                ssrSum += sampleSSR * weight;
                weightSum += weight;
            }
        }

        vec4 ssr = ssrSum / max(weightSum, 0.00001);
        
        // Boost the visibility of the reflection
        vec3 reflection = ssr.rgb * ssr.a * opacity;
        
        // Additive blend
        gl_FragColor = vec4(base.rgb + reflection, base.a);
    }
`;

// =======================================================
// CLASS DEFINITION
// =======================================================

export class OptimizedSSRPass extends Pass {
    constructor(scene, camera, width = window.innerWidth, height = window.innerHeight) {
        super();
        this.scene = scene;
        this.camera = camera;

        this.params = {
            maxDistance: 15.0,
            thickness: 0.3,
            maxSteps: 80,
            binarySearchSteps: 6,
            stride: 0.2, // Length of each ray step
            opacity: 0.8
        };

        const depthTexture = new THREE.DepthTexture(width, height);
        this.gBufferTarget = new THREE.WebGLRenderTarget(width, height, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthTexture: depthTexture
        });

        this.normalMaterial = new THREE.MeshNormalMaterial();

        this.ssrTarget = new THREE.WebGLRenderTarget(width, height, {
            format: THREE.RGBAFormat
        });

        this.ssrMaterial = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader: ssrFragmentShader,
            uniforms: {
                tColor: { value: null },
                tDepth: { value: depthTexture },
                tNormal: { value: this.gBufferTarget.texture },
                projMatrix: { value: new THREE.Matrix4() },
                invProjMatrix: { value: new THREE.Matrix4() },
                resolution: { value: new THREE.Vector2(width, height) },
                maxDistance: { value: this.params.maxDistance },
                thickness: { value: this.params.thickness },
                maxSteps: { value: this.params.maxSteps },
                binarySearchSteps: { value: this.params.binarySearchSteps },
                stride: { value: this.params.stride }
            }
        });

        this.compositeMaterial = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader: compositeFragmentShader,
            uniforms: {
                tOriginal: { value: null },
                tSSR: { value: this.ssrTarget.texture },
                tDepth: { value: depthTexture },
                resolution: { value: new THREE.Vector2(width, height) },
                opacity: { value: this.params.opacity }
            }
        });

        this.ssrQuad = new FullScreenQuad(this.ssrMaterial);
        this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
    }

    setSize(width, height) {
        this.gBufferTarget.setSize(width, height);
        this.ssrTarget.setSize(width, height);
        this.ssrMaterial.uniforms.resolution.value.set(width, height);
        this.compositeMaterial.uniforms.resolution.value.set(width, height);
    }

    render(renderer, writeBuffer, readBuffer) {
        // 1. G-Buffer (Normals)
        const originalOverrideMaterial = this.scene.overrideMaterial;
        this.scene.overrideMaterial = this.normalMaterial;
        renderer.setRenderTarget(this.gBufferTarget);
        renderer.clear();
        renderer.render(this.scene, this.camera);
        this.scene.overrideMaterial = originalOverrideMaterial;

        // 2. SSR Trace
        this.ssrMaterial.uniforms.tColor.value = readBuffer.texture;
        this.ssrMaterial.uniforms.projMatrix.value.copy(this.camera.projectionMatrix);
        this.ssrMaterial.uniforms.invProjMatrix.value.copy(this.camera.projectionMatrixInverse);
        this.ssrMaterial.uniforms.maxDistance.value = this.params.maxDistance;
        this.ssrMaterial.uniforms.thickness.value = this.params.thickness;
        this.ssrMaterial.uniforms.stride.value = this.params.stride;

        renderer.setRenderTarget(this.ssrTarget);
        renderer.clear();
        this.ssrQuad.render(renderer);

        // 3. Composite
        this.compositeMaterial.uniforms.tOriginal.value = readBuffer.texture;
        this.compositeMaterial.uniforms.opacity.value = this.params.opacity;

        if (this.renderToScreen) {
            renderer.setRenderTarget(null);
        } else {
            renderer.setRenderTarget(writeBuffer);
            if (this.clear) renderer.clear();
        }
        this.compositeQuad.render(renderer);
    }
}