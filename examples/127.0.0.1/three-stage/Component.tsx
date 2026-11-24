import { type CSSProperties, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

const tokens = { "--radius-1": "16px", "--night": "#0a2540" } as CSSProperties;

// three/shaders/hero-glow-1.*.glsl: a rim light that pulses with time.
const vertexShader = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  varying vec3 vNormal;
  void main() {
    float rim = pow(1.0 - abs(vNormal.z), 2.0);
    float pulse = 0.5 + 0.5 * sin(uTime * 2.0);
    gl_FragColor = vec4(uColor * (0.6 + rim * pulse), 1.0);
    // Fix pass: the original ran an OutputPass (tone mapping + sRGB) over the frame.
    // Rendering directly, the shader applies both itself.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** three-1 (approximate): one turn every 7.85 s around y. */
function Hero({ still }: { still: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uColor: { value: new THREE.Color("#635bff") }, uResolution: { value: new THREE.Vector2(1, 1) } }), []);
  useFrame(({ clock }) => {
    const t = still ? 0 : clock.getElapsedTime();
    if (mesh.current) mesh.current.rotation.y = t * 0.8;
    uniforms.uTime.value = t;
  });
  return (
    <mesh ref={mesh} castShadow>
      <torusKnotGeometry args={[1, 0.32, 128, 16]} />
      <shaderMaterial uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader} />
    </mesh>
  );
}

function Stars() {
  const positions = useMemo(() => {
    const p = new Float32Array(5000 * 3);
    for (let i = 0; i < p.length; i++) p[i] = Math.sin(i * 12.9898) * 10;
    return p;
  }, []);
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#80e9ff" size={0.03} />
    </points>
  );
}

/** three-2 (near): the camera rises 1 → 2.5 and moves in 6 → 3 as the page scrolls, always looking at the origin. */
function ScrollCamera() {
  const camera = useThree((state) => state.camera);
  useFrame(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    camera.position.set(0, 1 + progress * 1.5, 6 - progress * 3);
    camera.lookAt(0, 0, 0);
  });
  return null;
}

function Scene({ still }: { still: boolean }) {
  return (
    <>
      <color attach="background" args={["#0a2540"]} />
      <fog attach="fog" args={["#0a2540", 8, 20]} />
      <ambientLight color="#ffffff" intensity={0.4} />
      <directionalLight color="#ffffff" intensity={2} position={[3, 5, 2]} castShadow />
      <Hero still={still} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.6, 0]} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#1c3d5a" />
      </mesh>
      <Stars />
      <ScrollCamera />
    </>
  );
}

export default function Stage() {
  const still = useRef(typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      still.current = media.matches;
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <section style={tokens} className="relative h-[200vh]">
      <div className="sticky top-0 h-screen w-full overflow-hidden rounded-[var(--radius-1)]">
        <Canvas
          aria-label="Spinning torus knot"
          shadows
          dpr={[1, 2]}
          camera={{ fov: 50, near: 0.1, far: 100, position: [0, 1, 6] }}
          gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.1, outputColorSpace: THREE.SRGBColorSpace }}
        >
          <Scene still={still.current} />
        </Canvas>
      </div>
    </section>
  );
}
