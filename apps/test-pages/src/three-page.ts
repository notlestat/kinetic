// A three.js scene for Kinetic's 3D capture tests: a ShaderMaterial mesh that
// spins at a steady rate, a camera driven by scroll, fog, shadows, tone mapping,
// a big point cloud (its positions are too large for scene.json) and an
// EffectComposer with a RenderPass and an OutputPass. Nothing is put on window:
// Kinetic finds the scene through three.js's own __THREE_DEVTOOLS__ events.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";

const canvas = document.querySelector<HTMLCanvasElement>("#scene");
if (!canvas) throw new Error("missing #scene");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // r187 removed PCFSoftShadowMap.

const scene = new THREE.Scene();
scene.background = new THREE.Color("#0a2540");
scene.fog = new THREE.Fog("#0a2540", 8, 20);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.name = "Camera";

const hero = new THREE.Mesh(
  new THREE.TorusKnotGeometry(1, 0.32, 128, 16),
  new THREE.ShaderMaterial({
    name: "HeroGlow",
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color("#635bff") },
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      varying vec3 vNormal;
      void main() {
        float rim = pow(1.0 - abs(vNormal.z), 2.0);
        float pulse = 0.5 + 0.5 * sin(uTime * 2.0);
        gl_FragColor = vec4(uColor * (0.6 + rim * pulse), 1.0);
      }
    `,
  }),
);
hero.name = "Hero";
hero.castShadow = true;
scene.add(hero);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: "#1c3d5a" }));
ground.name = "Ground";
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1.6;
ground.receiveShadow = true;
scene.add(ground);

// 5000 points: 15000 position numbers, above the size scene.json keeps.
const starPositions = new Float32Array(5000 * 3);
for (let i = 0; i < starPositions.length; i++) starPositions[i] = Math.sin(i * 12.9898) * 10;
const starGeometry = new THREE.BufferGeometry();
starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: "#80e9ff", size: 0.03 }));
stars.name = "Stars";
scene.add(stars);

const fill = new THREE.AmbientLight("#ffffff", 0.4);
fill.name = "Fill";
scene.add(fill);
const key = new THREE.DirectionalLight("#ffffff", 2);
key.name = "Key";
key.position.set(3, 5, 2);
key.castShadow = true;
scene.add(key);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new OutputPass());

function resize(): void {
  if (!canvas) return;
  const { clientWidth: width, clientHeight: height } = canvas;
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

/** Scroll progress through the page, 0 at the top and 1 at the bottom. */
function scrollProgress(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const elapsed = clock.getElapsedTime();
  hero.rotation.y = elapsed * 0.8; // One turn every 2π / 0.8 ≈ 7.85 s.
  (hero.material.uniforms.uTime as { value: number }).value = elapsed;
  const progress = scrollProgress();
  camera.position.set(0, 1 + progress * 1.5, 6 - progress * 3);
  camera.lookAt(0, 0, 0);
  composer.render();
});
