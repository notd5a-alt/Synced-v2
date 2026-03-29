import { useRef, useEffect } from "react";
import * as THREE from "three";

// ---------------------------------------------------------------------------
// GLSL Shaders (adapted from tgcnzn/Interactive-Particles-Music-Visualizer)
// ---------------------------------------------------------------------------
const vertexShader = /* glsl */ `
varying float vDistance;

uniform float time;
uniform float offsetSize;
uniform float size;
uniform float offsetGain;
uniform float amplitude;
uniform float frequency;
uniform float maxDistance;

vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x){ return mod289(((x * 34.0) + 1.0) * x); }

float noise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

vec3 curl(float x, float y, float z) {
  float eps = 1.0, eps2 = 2.0 * eps;
  float n1, n2, a, b;
  x += time * 0.05;
  y += time * 0.05;
  z += time * 0.05;
  vec3 c = vec3(0.0);
  n1 = noise(vec2(x, y + eps)); n2 = noise(vec2(x, y - eps)); a = (n1 - n2) / eps2;
  n1 = noise(vec2(x, z + eps)); n2 = noise(vec2(x, z - eps)); b = (n1 - n2) / eps2;
  c.x = a - b;
  n1 = noise(vec2(y, z + eps)); n2 = noise(vec2(y, z - eps)); a = (n1 - n2) / eps2;
  n1 = noise(vec2(x + eps, z)); n2 = noise(vec2(x + eps, z)); b = (n1 - n2) / eps2;
  c.y = a - b;
  n1 = noise(vec2(x + eps, y)); n2 = noise(vec2(x - eps, y)); a = (n1 - n2) / eps2;
  n1 = noise(vec2(y + eps, z)); n2 = noise(vec2(y - eps, z)); b = (n1 - n2) / eps2;
  c.z = a - b;
  return c;
}

void main() {
  vec3 newpos = position;
  vec3 target = position + (normal * 0.1) + curl(newpos.x * frequency, newpos.y * frequency, newpos.z * frequency) * amplitude;
  float d = length(newpos - target) / maxDistance;
  newpos = mix(position, target, pow(d, 4.0));
  newpos.z += sin(time) * (0.1 * offsetGain);
  vec4 mvPosition = modelViewMatrix * vec4(newpos, 1.0);
  gl_PointSize = size + (pow(d, 3.0) * offsetSize) * (1.0 / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  vDistance = d;
}
`;

const fragmentShader = /* glsl */ `
varying float vDistance;

uniform vec3 startColor;
uniform vec3 endColor;

float circle(in vec2 _st, in float _radius) {
  vec2 dist = _st - vec2(0.5);
  return 1.0 - smoothstep(_radius - (_radius * 0.01), _radius + (_radius * 0.01), dot(dist, dist) * 4.0);
}

void main() {
  vec2 uv = vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y);
  vec3 circ = vec3(circle(uv, 1.0));
  vec3 color = mix(startColor, endColor, vDistance);
  gl_FragColor = vec4(color, circ.r * vDistance);
}
`;

// ---------------------------------------------------------------------------
// Audio frequency analyzer for live MediaStream
// ---------------------------------------------------------------------------
class StreamAudioAnalyzer {
  analyser: AnalyserNode;
  dataArray: Uint8Array<ArrayBuffer>;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  bufferLength: number;
  frequencyData = { low: 0, mid: 0, high: 0 };

  constructor(stream: MediaStream) {
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.8;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
    this.bufferLength = this.analyser.frequencyBinCount;
    this.dataArray = new Uint8Array(this.bufferLength);
  }

  update() {
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.analyser.getByteFrequencyData(this.dataArray);

    const sampleRate = this.ctx.sampleRate;
    const lowEnd = Math.floor((250 * this.bufferLength) / sampleRate);
    const midEnd = Math.floor((2000 * this.bufferLength) / sampleRate);
    const highEnd = Math.floor((9000 * this.bufferLength) / sampleRate);

    this.frequencyData.low = this.avg(0, lowEnd) / 256;
    this.frequencyData.mid = this.avg(lowEnd, midEnd) / 256;
    this.frequencyData.high = this.avg(midEnd, highEnd) / 256;
  }

  private avg(start: number, end: number): number {
    let sum = 0;
    const e = Math.min(end, this.bufferLength - 1);
    for (let i = start; i <= e; i++) sum += this.dataArray[i];
    return sum / (e - start + 1 || 1);
  }

  dispose() {
    this.source.disconnect();
    this.ctx.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------
interface AudioVisualizerProps {
  stream: MediaStream | null;
}

export default function AudioVisualizer({ stream }: AudioVisualizerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    material: THREE.ShaderMaterial;
    holder: THREE.Object3D;
    pointsMesh: THREE.Object3D | null;
    analyzer: StreamAudioAnalyzer;
    animId: number;
    time: number;
    disposed: boolean;
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !stream || stream.getAudioTracks().length === 0) return;

    // --- Renderer ---
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const rect = el.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height);
    el.appendChild(renderer.domElement);

    // --- Scene & Camera ---
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 10000);
    camera.position.z = 4.5;
    scene.add(camera);

    const holder = new THREE.Object3D();
    scene.add(holder);

    // --- Read theme colors from CSS vars ---
    const style = getComputedStyle(document.documentElement);
    const accentHex = style.getPropertyValue("--accent").trim() || "#b400ff";
    const textHex = style.getPropertyValue("--text").trim() || "#00ffff";

    // --- Shader Material ---
    const material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      uniforms: {
        time: { value: 0 },
        offsetSize: { value: 40 },
        size: { value: 1.5 },
        frequency: { value: 2 },
        amplitude: { value: 1 },
        offsetGain: { value: 0 },
        maxDistance: { value: 1.8 },
        startColor: { value: new THREE.Color(accentHex) },
        endColor: { value: new THREE.Color(textHex) },
      },
    });

    // --- Audio ---
    const analyzer = new StreamAudioAnalyzer(stream);

    const state = {
      renderer,
      scene,
      camera,
      material,
      holder,
      pointsMesh: null as THREE.Object3D | null,
      analyzer,
      animId: 0,
      time: 0,
      disposed: false,
    };
    stateRef.current = state;

    // --- Geometry creation helpers ---
    function createMesh() {
      destroyMesh();
      // Dense cube — high segment counts for lots of particles
      const wSeg = THREE.MathUtils.randInt(15, 30);
      const hSeg = THREE.MathUtils.randInt(15, 30);
      const dSeg = THREE.MathUtils.randInt(15, 30);
      const size = 2;
      const geo = new THREE.BoxGeometry(size, size, size, wSeg, hSeg, dSeg);
      material.uniforms.offsetSize.value = THREE.MathUtils.randInt(20, 40);
      material.uniforms.size.value = 1.5;
      const pts = new THREE.Points(geo, material);
      const wrap = new THREE.Object3D();
      // Tilt for a 3D perspective like the reference
      wrap.rotation.x = Math.PI * 0.15;
      wrap.rotation.y = Math.PI * 0.25;
      wrap.add(pts);
      state.pointsMesh = wrap;
      holder.add(wrap);
      material.uniforms.frequency.value = THREE.MathUtils.randFloat(1, 2.5);
    }

    function destroyMesh() {
      if (state.pointsMesh) {
        holder.remove(state.pointsMesh);
        state.pointsMesh.traverse((child) => {
          if ((child as any).geometry) (child as any).geometry.dispose();
        });
        state.pointsMesh = null;
      }
    }

    createMesh();

    // --- Beat detection (simple energy-threshold approach) ---
    let prevLow = 0;
    let beatCooldown = 0;
    const BEAT_THRESHOLD = 0.15;
    const BEAT_COOLDOWN = 30; // frames

    // --- Slow auto-rotation ---
    let rotY = 0;

    // --- Resize observer ---
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    });
    ro.observe(el);

    // --- Render loop ---
    function animate() {
      if (state.disposed) return;
      state.animId = requestAnimationFrame(animate);

      analyzer.update();
      const { low, mid, high } = analyzer.frequencyData;

      // Drive uniforms from audio
      material.uniforms.amplitude.value =
        0.8 + THREE.MathUtils.mapLinear(high, 0, 0.6, -0.1, 0.2);
      material.uniforms.offsetGain.value = mid * 0.6;
      const t = THREE.MathUtils.mapLinear(low, 0.6, 1, 0.2, 0.5);
      state.time += THREE.MathUtils.clamp(t, 0.15, 0.5);
      material.uniforms.time.value = state.time;

      // Simple beat detection — spike in low frequency
      if (beatCooldown > 0) beatCooldown--;
      if (low - prevLow > BEAT_THRESHOLD && beatCooldown === 0) {
        beatCooldown = BEAT_COOLDOWN;
        // Occasionally regenerate the cube with new segment counts
        if (Math.random() < 0.2) createMesh();
        // Kick the rotation on beat
        if (state.pointsMesh) {
          state.pointsMesh.rotation.z += (Math.random() - 0.5) * 0.3;
          state.pointsMesh.rotation.x += (Math.random() - 0.5) * 0.15;
        }
      }
      prevLow = low;

      // Slow auto-rotation
      rotY += 0.003 + low * 0.005;
      holder.rotation.y = rotY;
      holder.rotation.x = Math.sin(state.time * 0.01) * 0.3;

      renderer.render(scene, camera);
    }
    animate();

    return () => {
      state.disposed = true;
      cancelAnimationFrame(state.animId);
      ro.disconnect();
      destroyMesh();
      material.dispose();
      renderer.dispose();
      analyzer.dispose();
      if (el.contains(renderer.domElement)) {
        el.removeChild(renderer.domElement);
      }
      stateRef.current = null;
    };
  }, [stream]);

  // Update theme colors reactively
  useEffect(() => {
    const s = stateRef.current;
    if (!s) return;
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue("--accent").trim() || "#b400ff";
    const text = style.getPropertyValue("--text").trim() || "#00ffff";
    s.material.uniforms.startColor.value.set(accent);
    s.material.uniforms.endColor.value.set(text);
  });

  return <div ref={containerRef} className="particle-visualizer" />;
}
