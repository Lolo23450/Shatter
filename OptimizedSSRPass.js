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
    uniform float strideZCutoff;
    uniform float jitterStrength;
    uniform float frame;

    vec3 getViewPos(vec2 uv, float depth) {
        vec4 clipSpace = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec4 viewSpace = invProjMatrix * clipSpace;
        return viewSpace.xyz / viewSpace.w;
    }

    // Improved Noise: Interleaved Gradient Noise (better spatial distribution than standard hash)
    float interleavedGradientNoise(vec2 n) {
        float f = 0.06711056 * n.x + 0.00583715 * n.y;
        return fract(52.9829189 * fract(f));
    }

    void main() {
        float depth = texture2D(tDepth, vUv).r;
        if (depth >= 1.0) {
            gl_FragColor = vec4(0.0);
            return;
        }

        vec3 viewPos = getViewPos(vUv, depth);
        vec3 normal = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);

        vec3 viewDir = normalize(viewPos);
        vec3 reflectDir = normalize(reflect(viewDir, normal));

        float backFacingFade = smoothstep(0.15, -0.15, reflectDir.z);
        if (backFacingFade <= 0.001) {
            gl_FragColor = vec4(0.0);
            return;
        }

        float grazing = clamp(dot(-viewDir, normal), 0.0, 1.0);
        float grazingFade = smoothstep(0.0, 0.2, grazing);

        vec3 rayPos = viewPos + normal * (0.02 + abs(viewPos.z) * 0.001);

        float adaptiveStride = stride * mix(1.0, 1.6, clamp(-viewPos.z / strideZCutoff, 0.0, 1.0));
        vec3 rayStep = reflectDir * adaptiveStride;

        float jitter = interleavedGradientNoise(gl_FragCoord.xy + frame);
        rayPos += rayStep * jitter * jitterStrength;

        vec2 hitUv = vec2(-1.0);
        bool hit = false;
        float finalDepthDiff = 0.0;
        float marchFade = 1.0;

        for (int i = 0; i < 160; i++) {
            if (i >= maxSteps) break;
            rayPos += rayStep;

            vec4 clipPos = projMatrix * vec4(rayPos, 1.0);
            if (clipPos.w <= 0.0) {
                marchFade = 0.0;
                break;
            }
            vec2 currentUv = (clipPos.xy / clipPos.w) * 0.5 + 0.5;

            vec2 edgeDist = min(currentUv, 1.0 - currentUv);
            float boundsFade = smoothstep(0.0, 0.08, min(edgeDist.x, edgeDist.y));
            if (boundsFade <= 0.001) {
                marchFade = 0.0;
                break;
            }
            marchFade = boundsFade;

            float sampledDepth = texture2D(tDepth, currentUv).r;
            if (sampledDepth >= 1.0) continue;

            vec3 sampledViewPos = getViewPos(currentUv, sampledDepth);
            float depthDiff = rayPos.z - sampledViewPos.z;

            if (depthDiff > 0.0 && depthDiff < thickness) {
                hit = true;
                hitUv = currentUv;
                finalDepthDiff = depthDiff;
                break;
            }
        }

        if (hit && marchFade > 0.0) {
            vec3 vd = rayStep;
            for (int i = 0; i < 12; i++) {
                if (i >= binarySearchSteps) break;
                vd *= 0.5;
                vec4 clipPos = projMatrix * vec4(rayPos, 1.0);
                if (clipPos.w <= 0.0) break;
                vec2 currentUv = (clipPos.xy / clipPos.w) * 0.5 + 0.5;
                float sDepth = texture2D(tDepth, currentUv).r;
                vec3 sPos = getViewPos(currentUv, sDepth);
                if (rayPos.z - sPos.z > 0.0) rayPos -= vd; else rayPos += vd;
                hitUv = currentUv;
            }

            float thicknessFade = clamp(1.0 - (finalDepthDiff / thickness), 0.0, 1.0);

            vec2 dUv = abs(hitUv - 0.5) * 2.0;
            float edgeFade = clamp(1.0 - max(dUv.x, dUv.y), 0.0, 1.0);
            edgeFade = smoothstep(0.0, 0.08, edgeFade);

            float dist = distance(viewPos, rayPos);
            float distFade = clamp(1.0 - (dist / maxDistance), 0.0, 1.0);
            distFade = smoothstep(0.0, 1.0, distFade);

            vec3 color = texture2D(tColor, hitUv).rgb;
            float alpha = edgeFade * distFade * thicknessFade * grazingFade * backFacingFade * marchFade;
            gl_FragColor = vec4(color, alpha);
        } else {
            gl_FragColor = vec4(0.0);
        }
    }
`;

// New: Horizontal Blur Pass (Step 1 of Separable Blur)
const blurFragmentShader = `
    varying vec2 vUv;
    uniform sampler2D tSSR;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float blurRadius;
    uniform float depthWeightSoftness;

    void main() {
        float centerDepth = texture2D(tDepth, vUv).r;
        if (centerDepth >= 1.0) {
            gl_FragColor = texture2D(tSSR, vUv);
            return;
        }

        vec2 texelSize = 1.0 / resolution;
        vec4 ssrSum = vec4(0.0);
        float weightSum = 0.0;

        // 9-tap horizontal separable blur
        for (int i = -4; i <= 4; i++) {
            vec2 offset = vec2(1.0, 0.0) * float(i) * texelSize * blurRadius;
            vec2 sampleUv = vUv + offset;
            
            vec4 sampleSSR = texture2D(tSSR, sampleUv);
            float sampleDepth = texture2D(tDepth, sampleUv).r;

            float depthWeight = 1.0 / (0.001 + abs(centerDepth - sampleDepth) * depthWeightSoftness);
            float spatialWeight = 1.0 - abs(float(i)) / 5.0;
            float weight = depthWeight * spatialWeight;

            ssrSum += sampleSSR * weight;
            weightSum += weight;
        }

        gl_FragColor = ssrSum / weightSum;
    }
`;

// Improved Composite: Handles Vertical Blur + Base Blending + Fresnel Application
const compositeFragmentShader = `
    varying vec2 vUv;
    uniform sampler2D tOriginal;
    uniform sampler2D tSSR; 
    uniform sampler2D tDepth;
    uniform sampler2D tNormal;
    uniform mat4 invProjMatrix;
    uniform vec2 resolution;
    uniform float opacity;
    uniform float fresnelPower;
    uniform float blurRadius;
    uniform float depthWeightSoftness;

    vec3 getViewPos(vec2 uv, float depth) {
        vec4 clipSpace = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec4 viewSpace = invProjMatrix * clipSpace;
        return viewSpace.xyz / viewSpace.w;
    }

    void main() {
        vec4 base = texture2D(tOriginal, vUv);
        float centerDepth = texture2D(tDepth, vUv).r;

        if (centerDepth >= 1.0) {
            gl_FragColor = base;
            return;
        }

        vec2 texelSize = 1.0 / resolution;
        vec4 ssrSum = vec4(0.0);
        float weightSum = 0.0;

        // 9-tap vertical separable blur
        for (int i = -4; i <= 4; i++) {
            vec2 offset = vec2(0.0, 1.0) * float(i) * texelSize * blurRadius;
            vec2 sampleUv = vUv + offset;
            
            vec4 sampleSSR = texture2D(tSSR, sampleUv);
            float sampleDepth = texture2D(tDepth, sampleUv).r;

            float depthWeight = 1.0 / (0.001 + abs(centerDepth - sampleDepth) * depthWeightSoftness);
            float spatialWeight = 1.0 - abs(float(i)) / 5.0;
            float weight = depthWeight * spatialWeight;

            ssrSum += sampleSSR * weight;
            weightSum += weight;
        }

        vec4 ssr = ssrSum / weightSum;

        // Apply physical Fresnel response (previously missing logic!)
        vec3 viewPos = getViewPos(vUv, centerDepth);
        vec3 viewDir = normalize(viewPos);
        vec3 normal = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
        
        float fresnel = pow(clamp(1.0 - dot(-viewDir, normal), 0.0, 1.0), fresnelPower);
        float finalOpacity = mix(opacity * 0.3, opacity, fresnel); // Forward vs Grazing angle opacity

        vec3 reflection = ssr.rgb * ssr.a * finalOpacity;
        vec3 result = base.rgb + reflection / (1.0 + reflection * 0.35);

        gl_FragColor = vec4(result, base.a);
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
        this._frame = 0;

        this.params = {
            maxDistance: 15.0,
            thickness: 0.45,
            maxSteps: 64,
            binarySearchSteps: 7,
            stride: 0.12,
            strideZCutoff: 25.0,
            jitterStrength: 0.35,
            opacity: 0.8,
            fresnelPower: 5.0,
            blurRadius: 1.5, // Reduced multiplier because separable blur spreads well
            depthWeightSoftness: 350.0,
            resolutionScale: 0.75
        };

        const traceWidth = Math.max(1, Math.floor(width * this.params.resolutionScale));
        const traceHeight = Math.max(1, Math.floor(height * this.params.resolutionScale));

        const depthTexture = new THREE.DepthTexture(width, height);
        depthTexture.type = THREE.UnsignedIntType;

        this.gBufferTarget = new THREE.WebGLRenderTarget(width, height, {
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
            depthTexture: depthTexture
        });

        this.normalMaterial = new THREE.MeshNormalMaterial();

        const rtOptions = {
            format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            type: THREE.HalfFloatType
        };

        this.ssrTarget = new THREE.WebGLRenderTarget(traceWidth, traceHeight, rtOptions);
        
        // New render target for separated horizontal blur
        this.blurTarget = new THREE.WebGLRenderTarget(traceWidth, traceHeight, rtOptions);

        this.ssrMaterial = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader: ssrFragmentShader,
            uniforms: {
                tColor: { value: null },
                tDepth: { value: depthTexture },
                tNormal: { value: this.gBufferTarget.texture },
                projMatrix: { value: new THREE.Matrix4() },
                invProjMatrix: { value: new THREE.Matrix4() },
                resolution: { value: new THREE.Vector2(traceWidth, traceHeight) },
                maxDistance: { value: this.params.maxDistance },
                thickness: { value: this.params.thickness },
                maxSteps: { value: this.params.maxSteps },
                binarySearchSteps: { value: this.params.binarySearchSteps },
                stride: { value: this.params.stride },
                strideZCutoff: { value: this.params.strideZCutoff },
                jitterStrength: { value: this.params.jitterStrength },
                frame: { value: 0 }
            }
        });

        this.blurMaterial = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader: blurFragmentShader,
            uniforms: {
                tSSR: { value: this.ssrTarget.texture },
                tDepth: { value: depthTexture },
                resolution: { value: new THREE.Vector2(traceWidth, traceHeight) },
                blurRadius: { value: this.params.blurRadius },
                depthWeightSoftness: { value: this.params.depthWeightSoftness }
            }
        });

        this.compositeMaterial = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader: compositeFragmentShader,
            uniforms: {
                tOriginal: { value: null },
                tSSR: { value: this.blurTarget.texture }, // Takes blurred image
                tDepth: { value: depthTexture },
                tNormal: { value: this.gBufferTarget.texture }, // Needed for fresnel
                invProjMatrix: { value: new THREE.Matrix4() }, // Needed for fresnel
                resolution: { value: new THREE.Vector2(traceWidth, traceHeight) },
                opacity: { value: this.params.opacity },
                fresnelPower: { value: this.params.fresnelPower },
                blurRadius: { value: this.params.blurRadius },
                depthWeightSoftness: { value: this.params.depthWeightSoftness }
            }
        });

        this.ssrQuad = new FullScreenQuad(this.ssrMaterial);
        this.blurQuad = new FullScreenQuad(this.blurMaterial);
        this.compositeQuad = new FullScreenQuad(this.compositeMaterial);

        this._fullWidth = width;
        this._fullHeight = height;
    }

    setSize(width, height) {
        this._fullWidth = width;
        this._fullHeight = height;

        const traceWidth = Math.max(1, Math.floor(width * this.params.resolutionScale));
        const traceHeight = Math.max(1, Math.floor(height * this.params.resolutionScale));

        this.gBufferTarget.setSize(width, height);
        this.ssrTarget.setSize(traceWidth, traceHeight);
        this.blurTarget.setSize(traceWidth, traceHeight);
        
        this.ssrMaterial.uniforms.resolution.value.set(traceWidth, traceHeight);
        this.blurMaterial.uniforms.resolution.value.set(traceWidth, traceHeight);
        this.compositeMaterial.uniforms.resolution.value.set(traceWidth, traceHeight);
    }

    updateResolutionScale() {
        this.setSize(this._fullWidth, this._fullHeight);
    }

    dispose() {
        this.gBufferTarget.dispose();
        this.ssrTarget.dispose();
        this.blurTarget.dispose();
        this.normalMaterial.dispose();
        this.ssrMaterial.dispose();
        this.blurMaterial.dispose();
        this.compositeMaterial.dispose();
        this.ssrQuad.dispose();
        this.blurQuad.dispose();
        this.compositeQuad.dispose();
    }

    render(renderer, writeBuffer, readBuffer) {
        this._frame++;

        const originalOverrideMaterial = this.scene.overrideMaterial;
        const originalClearColor = new THREE.Color();
        renderer.getClearColor(originalClearColor);
        const originalClearAlpha = renderer.getClearAlpha();

        // 1. G-Buffer Pass
        this.scene.overrideMaterial = this.normalMaterial;
        renderer.setRenderTarget(this.gBufferTarget);
        renderer.setClearColor(0x7f7fff, 1.0);
        renderer.clear();
        renderer.render(this.scene, this.camera);
        this.scene.overrideMaterial = originalOverrideMaterial;
        renderer.setClearColor(originalClearColor, originalClearAlpha);

        // 2. SSR Tracing Pass
        const su = this.ssrMaterial.uniforms;
        su.tColor.value = readBuffer.texture;
        su.projMatrix.value.copy(this.camera.projectionMatrix);
        su.invProjMatrix.value.copy(this.camera.projectionMatrixInverse);
        su.maxDistance.value = this.params.maxDistance;
        su.thickness.value = this.params.thickness;
        su.maxSteps.value = this.params.maxSteps;
        su.binarySearchSteps.value = this.params.binarySearchSteps;
        su.stride.value = this.params.stride;
        su.strideZCutoff.value = this.params.strideZCutoff;
        su.jitterStrength.value = this.params.jitterStrength;
        su.frame.value = this._frame;

        renderer.setRenderTarget(this.ssrTarget);
        renderer.clear();
        this.ssrQuad.render(renderer);

        // 3. Horizontal Blur Pass
        this.blurMaterial.uniforms.blurRadius.value = this.params.blurRadius;
        this.blurMaterial.uniforms.depthWeightSoftness.value = this.params.depthWeightSoftness;
        renderer.setRenderTarget(this.blurTarget);
        renderer.clear();
        this.blurQuad.render(renderer);

        // 4. Vertical Blur & Final Composite Pass
        const cu = this.compositeMaterial.uniforms;
        cu.tOriginal.value = readBuffer.texture;
        cu.invProjMatrix.value.copy(this.camera.projectionMatrixInverse);
        cu.opacity.value = this.params.opacity;
        cu.fresnelPower.value = this.params.fresnelPower;
        cu.blurRadius.value = this.params.blurRadius;
        cu.depthWeightSoftness.value = this.params.depthWeightSoftness;

        if (this.renderToScreen) {
            renderer.setRenderTarget(null);
        } else {
            renderer.setRenderTarget(writeBuffer);
            if (this.clear) renderer.clear();
        }
        this.compositeQuad.render(renderer);
    }
}