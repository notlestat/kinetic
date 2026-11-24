// A React Three Fiber scene: a box that spins at a steady rate under two lights.

import { Canvas, useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Mesh } from "three";

function SpinningBox() {
  const ref = useRef<Mesh>(null);
  useFrame((state) => {
    if (ref.current) ref.current.rotation.y = state.clock.elapsedTime * 1.2; // One turn every ≈ 5.24 s.
  });
  return (
    <mesh ref={ref} name="Box">
      <boxGeometry args={[1.2, 1.2, 1.2]} />
      <meshStandardMaterial color="#635bff" />
    </mesh>
  );
}

function Stage() {
  return (
    <section className="stage">
      <Canvas camera={{ position: [0, 1.5, 4], fov: 45 }}>
        <ambientLight name="Fill" intensity={0.5} />
        <directionalLight name="Key" position={[2, 4, 3]} intensity={1.5} />
        <SpinningBox />
      </Canvas>
    </section>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<Stage />);
