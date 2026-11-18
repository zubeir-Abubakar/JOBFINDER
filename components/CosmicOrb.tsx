"use client";

import React, { useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";

export type OrbState =
  | "IDLE"
  | "CONNECTING"
  | "LISTENING"
  | "THINKING"
  | "SPEAKING"
  | "INTERRUPTED"
  | "DISCONNECTED"
  | "ERROR";

export type OrbLevels = { input: number; output: number };

type CosmicOrbProps = {
  state: OrbState;
  levelsRef: { current: OrbLevels };
  compact?: boolean;
};

const TAU = Math.PI * 2;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function makeParticles(count: number) {
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    const radius = 0.78 + Math.random() * 2.18;
    const theta = Math.random() * TAU;
    const phi = Math.acos(2 * Math.random() - 1);
    const flatten = 0.7 + Math.random() * 0.3;
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta) * flatten;
    positions[index * 3 + 2] = radius * Math.cos(phi);
    phases[index] = Math.random();
    sizes[index] = 0.55 + Math.random() * 1.15;
  }

  return { positions, phases, sizes };
}

function makeRibbonCurve(index: number): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  const steps = 34;
  const turns = 1.18 + index * 0.13;
  const radius = 1.22 + index * 0.1;

  for (let step = 0; step < steps; step += 1) {
    const progress = step / (steps - 1);
    const angle = progress * TAU * turns + index * 1.13;
    const wobble = Math.sin(angle * 2.4 + index * 1.7) * 0.15;
    points.push(
      new THREE.Vector3(
        Math.cos(angle) * (radius + wobble),
        Math.sin(angle * 1.55 + index * 0.8) * 0.43 + Math.sin(angle * 3.2) * 0.05,
        Math.sin(angle) * (radius + wobble),
      ),
    );
  }

  return new THREE.CatmullRomCurve3(points, true, "catmullrom", 0.5);
}

const particleVertex = `
  attribute float aPhase;
  attribute float aScale;
  uniform float uTime;
  uniform float uActivity;
  varying float vTwinkle;

  void main() {
    vec3 transformed = position;
    transformed.y += sin(uTime * 0.32 + aPhase * 6.28318) * 0.055;
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float twinkle = 0.55 + 0.45 * sin(uTime * 1.55 + aPhase * 12.56636);
    vTwinkle = twinkle;
    gl_PointSize = (0.8 + uActivity * 1.3) * aScale * (0.8 + twinkle * 0.7) * (16.0 / max(1.4, -mvPosition.z));
  }
`;

const particleFragment = `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying float vTwinkle;

  void main() {
    vec2 centered = gl_PointCoord - 0.5;
    float distanceToCenter = length(centered);
    if (distanceToCenter > 0.5) discard;
    float alpha = smoothstep(0.5, 0.04, distanceToCenter) * (0.35 + vTwinkle * 0.65);
    vec3 color = mix(uColorA, uColorB, vTwinkle);
    gl_FragColor = vec4(color, alpha);
  }
`;

function OrbScene({ state, levelsRef, compact }: CosmicOrbProps) {
  const root = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const coreMaterial = useRef<THREE.MeshPhysicalMaterial>(null);
  const hotCore = useRef<THREE.Mesh>(null);
  const hotMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const vein = useRef<THREE.Mesh>(null);
  const veinMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const innerGlow = useRef<THREE.Mesh>(null);
  const innerMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const lattice = useRef<THREE.Mesh>(null);
  const latticeMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const atmosphere = useRef<THREE.Mesh>(null);
  const atmosphereMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const rings = useRef<Array<THREE.Group | null>>([]);
  const ringMaterials = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const ringHaloMaterials = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const ribbons = useRef<Array<THREE.Group | null>>([]);
  const ribbonMaterials = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const ribbonHaloMaterials = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const waves = useRef<Array<THREE.Group | null>>([]);
  const waveMaterials = useRef<Array<THREE.MeshBasicMaterial | null>>([]);
  const particles = useRef<THREE.Points>(null);
  const smooth = useRef({ input: 0, output: 0, thinking: 0, connecting: 0 });

  const particleField = useMemo(() => makeParticles(compact ? 420 : 1100), [compact]);

  const ringData = useMemo(
    () => [
      { radius: 1.18, tube: 0.012, tilt: [1.1, 0.12, 0.22] as const, speed: 0.17, drift: 0.035, opacity: 0.62, color: "#49e2ff" },
      { radius: 1.3, tube: 0.01, tilt: [0.2, 1.18, -0.38] as const, speed: -0.23, drift: 0.05, opacity: 0.54, color: "#aa7cff" },
      { radius: 1.43, tube: 0.016, tilt: [0.72, 0.52, 0.8] as const, speed: 0.13, drift: 0.06, opacity: 0.46, color: "#6eb7ff" },
      { radius: 1.56, tube: 0.009, tilt: [-0.42, 0.65, 1.22] as const, speed: -0.09, drift: 0.08, opacity: 0.4, color: "#d38dff" },
      { radius: 1.7, tube: 0.013, tilt: [1.34, -0.32, -0.62] as const, speed: 0.07, drift: 0.045, opacity: 0.32, color: "#81f0ff" },
    ],
    [],
  );

  const ribbonData = useMemo(
    () =>
      Array.from({ length: 4 }, (_, index) => ({
        curve: makeRibbonCurve(index),
        tilt: [index * 0.48 + 0.2, index * 0.72, index * 0.3] as const,
        speed: index % 2 === 0 ? 0.15 + index * 0.025 : -0.13 - index * 0.02,
        drift: 0.025 + index * 0.005,
        color: index % 2 === 0 ? "#50e6ff" : "#a874ff",
        opacity: 0.5 - index * 0.045,
      })),
    [],
  );

  const particleUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uActivity: { value: 0 },
      uColorA: { value: new THREE.Color("#8ce7ff") },
      uColorB: { value: new THREE.Color("#ad8cff") },
    }),
    [],
  );

  useFrame((frame, delta) => {
    const t = frame.clock.elapsedTime;
    const dt = Math.min(delta, 0.05);
    const levels = levelsRef.current;
    const incoming = state === "LISTENING" ? clamp01(levels.input) : 0;
    const outgoing = state === "SPEAKING" ? clamp01(levels.output) : 0;
    const thinkingTarget = state === "THINKING" ? 1 : 0;
    const connectingTarget = state === "CONNECTING" ? 1 : 0;
    const dim = state === "DISCONNECTED" || state === "ERROR" ? 0.56 : state === "INTERRUPTED" ? 0.74 : 1;
    const response = 1 - Math.exp(-8.5 * dt);

    smooth.current.input += (incoming - smooth.current.input) * response;
    smooth.current.output += (outgoing - smooth.current.output) * response;
    smooth.current.thinking += (thinkingTarget - smooth.current.thinking) * response;
    smooth.current.connecting += (connectingTarget - smooth.current.connecting) * response;

    const smoothed = smooth.current;
    const activity = Math.max(smoothed.input, smoothed.output) + smoothed.thinking * 0.18 + smoothed.connecting * 0.08;
    const pulse = Math.sin(t * 1.7) * 0.023;

    if (root.current) {
      root.current.position.y = Math.sin(t * 0.46) * 0.028;
      root.current.rotation.x = Math.sin(t * 0.21) * 0.032;
      root.current.rotation.z = Math.sin(t * 0.16) * 0.016;
    }

    if (core.current && coreMaterial.current) {
      const targetScale = 1 + pulse + smoothed.output * 0.22 + smoothed.input * 0.07 + smoothed.thinking * 0.055 + smoothed.connecting * 0.025;
      core.current.scale.setScalar(targetScale);
      core.current.rotation.y += dt * (0.11 + smoothed.output * 0.32 + smoothed.thinking * 0.18);
      core.current.rotation.x += dt * 0.045;
      coreMaterial.current.emissiveIntensity = (2.1 + smoothed.output * 3.4 + smoothed.input * 0.45 + smoothed.thinking * 0.7 + smoothed.connecting * 0.25) * dim;
    }

    if (hotCore.current && hotMaterial.current) {
      hotCore.current.scale.setScalar(0.82 + Math.sin(t * 2.2) * 0.08 + smoothed.output * 0.36 + smoothed.input * 0.1);
      hotMaterial.current.opacity = (0.62 + smoothed.output * 0.35 + smoothed.input * 0.12) * dim;
    }

    if (vein.current && veinMaterial.current) {
      vein.current.rotation.y -= dt * (0.16 + activity * 0.22);
      vein.current.rotation.z += dt * 0.06;
      veinMaterial.current.opacity = (0.15 + activity * 0.17) * dim;
    }

    if (innerGlow.current && innerMaterial.current) {
      innerGlow.current.rotation.y -= dt * (0.14 + activity * 0.25);
      innerGlow.current.scale.setScalar(1.09 + Math.sin(t * 0.82) * 0.018 + smoothed.output * 0.11 + smoothed.input * 0.04);
      innerMaterial.current.opacity = (0.1 + activity * 0.14) * dim;
    }

    if (lattice.current && latticeMaterial.current) {
      lattice.current.rotation.y += dt * (0.08 + activity * 0.2);
      lattice.current.rotation.z -= dt * 0.04;
      lattice.current.scale.setScalar(1 + activity * 0.05);
      latticeMaterial.current.opacity = (0.13 + activity * 0.15) * dim;
    }

    if (atmosphere.current && atmosphereMaterial.current) {
      atmosphere.current.scale.setScalar(1.38 + smoothed.output * 0.08 + smoothed.input * 0.03);
      atmosphereMaterial.current.opacity = (0.035 + activity * 0.08) * dim;
    }

    for (let index = 0; index < ringData.length; index += 1) {
      const ring = ringData[index];
      const group = rings.current[index];
      const material = ringMaterials.current[index];
      const halo = ringHaloMaterials.current[index];
      if (group) {
        const speed = ring.speed * (1 + activity * 2.1 + smoothed.thinking * 0.7);
        group.rotation.z += dt * speed;
        group.rotation.x += dt * ring.drift * (1 + activity * 0.9);
        group.rotation.y += dt * ring.drift * 0.6;
        group.scale.setScalar(1 + activity * 0.05 + Math.sin(t * 0.7 + index * 1.2) * 0.007);
      }
      if (material) material.opacity = Math.min(0.94, (ring.opacity + activity * 0.24) * dim);
      if (halo) halo.opacity = (ring.opacity * 0.2 + activity * 0.09) * dim;
    }

    for (let index = 0; index < ribbonData.length; index += 1) {
      const ribbon = ribbonData[index];
      const group = ribbons.current[index];
      const material = ribbonMaterials.current[index];
      const halo = ribbonHaloMaterials.current[index];
      if (group) {
        group.rotation.y += dt * ribbon.speed * (1 + activity * 1.9 + smoothed.thinking * 0.55);
        group.rotation.z += dt * ribbon.drift * (1 + activity);
        group.scale.setScalar(1 + activity * 0.035 + Math.sin(t * 0.8 + index) * 0.006);
      }
      if (material) material.opacity = (ribbon.opacity + activity * 0.2) * dim;
      if (halo) halo.opacity = (ribbon.opacity * 0.2 + activity * 0.08) * dim;
    }

    for (let index = 0; index < waves.current.length; index += 1) {
      const wave = waves.current[index];
      const material = waveMaterials.current[index];
      if (!wave) continue;
      const phase = (t * 0.1 + index / 3) % 1;
      wave.scale.setScalar(1 + phase * 0.72);
      wave.rotation.z += dt * 0.06;
      if (material) material.opacity = (1 - phase) * (0.055 + activity * 0.08) * dim;
    }

    if (particles.current) {
      particles.current.rotation.y += dt * (0.032 + activity * 0.12);
      particles.current.rotation.z += dt * (0.01 + activity * 0.035);
    }
    particleUniforms.uTime.value = t;
    particleUniforms.uActivity.value = activity;
  });

  return (
    <>
      <ambientLight intensity={0.24} />
      <pointLight position={[0, 0, 0]} intensity={2.8} color="#57b8ff" distance={6} />
      <pointLight position={[2.2, 1.2, -2.4]} intensity={1.65} color="#8b5cf6" distance={5.5} />
      <pointLight position={[-2.1, -1.4, 1.8]} intensity={0.9} color="#53e8ff" distance={4.5} />

      <group ref={root}>
        <mesh ref={core}>
          <icosahedronGeometry args={[0.83, 5]} />
          <meshPhysicalMaterial
            ref={coreMaterial}
            color="#4f9cff"
            emissive="#1d5eff"
            emissiveIntensity={2.1}
            roughness={0.12}
            metalness={0.55}
            clearcoat={1}
            clearcoatRoughness={0.08}
            toneMapped={false}
          />
        </mesh>

        <mesh ref={hotCore} renderOrder={2}>
          <sphereGeometry args={[0.16, 24, 24]} />
          <meshBasicMaterial
            ref={hotMaterial}
            color="#edffff"
            transparent
            opacity={0.62}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            depthTest={false}
            toneMapped={false}
          />
        </mesh>

        <mesh ref={vein} renderOrder={1}>
          <icosahedronGeometry args={[0.84, 1]} />
          <meshBasicMaterial
            ref={veinMaterial}
            color="#b8f7ff"
            wireframe
            transparent
            opacity={0.15}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>

        <mesh ref={innerGlow}>
          <sphereGeometry args={[1.55, 40, 40]} />
          <meshBasicMaterial
            ref={innerMaterial}
            color="#496dff"
            transparent
            opacity={0.12}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.BackSide}
            toneMapped={false}
          />
        </mesh>

        <mesh ref={lattice}>
          <icosahedronGeometry args={[1.03, 2]} />
          <meshBasicMaterial
            ref={latticeMaterial}
            color="#75ddff"
            wireframe
            transparent
            opacity={0.16}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>

        <mesh ref={atmosphere}>
          <sphereGeometry args={[1.05, 32, 32]} />
          <meshBasicMaterial
            ref={atmosphereMaterial}
            color="#5875ff"
            transparent
            opacity={0.055}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.BackSide}
            toneMapped={false}
          />
        </mesh>

        {ringData.map((ring, index) => (
          <group
            key={`ring-${index}`}
            ref={(node) => {
              rings.current[index] = node;
            }}
            rotation={ring.tilt}
          >
            <mesh>
              <torusGeometry args={[ring.radius, ring.tube * 2.8, 6, 180]} />
              <meshBasicMaterial
                ref={(node) => {
                  ringHaloMaterials.current[index] = node;
                }}
                color={ring.color}
                transparent
                opacity={ring.opacity * 0.2}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
            <mesh>
              <torusGeometry args={[ring.radius, ring.tube, 6, 180]} />
              <meshBasicMaterial
                ref={(node) => {
                  ringMaterials.current[index] = node;
                }}
                color={ring.color}
                transparent
                opacity={ring.opacity}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          </group>
        ))}

        {ribbonData.map((ribbon, index) => (
          <group
            key={`ribbon-${index}`}
            ref={(node) => {
              ribbons.current[index] = node;
            }}
            rotation={ribbon.tilt}
          >
            <mesh>
              <tubeGeometry args={[ribbon.curve, 128, 0.035, 6, false]} />
              <meshBasicMaterial
                ref={(node) => {
                  ribbonHaloMaterials.current[index] = node;
                }}
                color={ribbon.color}
                transparent
                opacity={ribbon.opacity * 0.16}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
            <mesh>
              <tubeGeometry args={[ribbon.curve, 128, 0.016 + index * 0.0015, 6, false]} />
              <meshBasicMaterial
                ref={(node) => {
                  ribbonMaterials.current[index] = node;
                }}
                color={ribbon.color}
                transparent
                opacity={ribbon.opacity}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>
          </group>
        ))}

        {[0, 1, 2].map((index) => (
          <group
            key={`wave-${index}`}
            ref={(node) => {
              waves.current[index] = node;
            }}
            rotation={[Math.PI / 2 + index * 0.34, index * 0.5, index * 0.2]}
          >
            <mesh>
              <ringGeometry args={[1.32, 1.335, 96]} />
              <meshBasicMaterial
                ref={(node) => {
                  waveMaterials.current[index] = node;
                }}
                color={index === 1 ? "#aa8cff" : "#72ddff"}
                transparent
                opacity={0.08}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
                side={THREE.DoubleSide}
                toneMapped={false}
              />
            </mesh>
          </group>
        ))}

        <points ref={particles} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[particleField.positions, 3]} />
            <bufferAttribute attach="attributes-aPhase" args={[particleField.phases, 1]} />
            <bufferAttribute attach="attributes-aScale" args={[particleField.sizes, 1]} />
          </bufferGeometry>
          <shaderMaterial
            uniforms={particleUniforms}
            vertexShader={particleVertex}
            fragmentShader={particleFragment}
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </points>
      </group>
    </>
  );
}

export default function CosmicOrb({ state, levelsRef, compact = false }: CosmicOrbProps) {
  return (
    <div className="cosmic-orb" data-orb-state={state} data-orb-compact={compact ? "true" : "false"} aria-hidden="true">
      <Canvas
        camera={{ position: [0, 0, 5.2], fov: 42 }}
        dpr={compact ? [1, 1.15] : [1, 1.55]}
        gl={{ alpha: true, antialias: !compact, powerPreference: "high-performance", premultipliedAlpha: false }}
        style={{ background: "transparent" }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
          gl.setClearAlpha(0);
        }}
      >
        <OrbScene state={state} levelsRef={levelsRef} compact={compact} />
      </Canvas>
    </div>
  );
}
