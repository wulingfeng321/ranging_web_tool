import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { archivePosition, type ArchiveGroup } from "./archiveNavigation";

type Props = {
  groups: ArchiveGroup[];
  selectedId: string;
  onSelect: (id: string) => void;
  onStep: (axis: "row" | "column", delta: number) => void;
};

/** Instanced, on-demand rendered archive carriers. Blank carriers are scenery,
 * only positions backed by an actual experiment are selectable. */
export default function ArchiveScene({
  groups,
  selectedId,
  onSelect,
  onStep,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef({ groups, selectedId, onSelect, onStep });
  state.current = { groups, selectedId, onSelect, onStep };
  const invalidate = useRef<(() => void) | null>(null);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    invalidate.current?.();
  }, [groups, selectedId]);
  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "low-power",
      });
    } catch {
      setFallback(true);
      return;
    }
    renderer.setClearColor("#e8e5e0");
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.domElement.setAttribute("aria-hidden", "true");
    el.append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog("#e8e5e0", 62, 115);
    const camera = new THREE.OrthographicCamera(-15, 15, 9, -9, 0.1, 180);
    const aim = new THREE.Vector3(3, 1, 0);
    camera.position.set(-36, 20, 32);
    camera.lookAt(aim);
    scene.add(new THREE.HemisphereLight("#fffdf6", "#8c8475", 1.05));
    const sun = new THREE.DirectionalLight("#fff6e9", 3.6);
    sun.position.set(-12, 21, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, {
      left: -20,
      right: 20,
      top: 20,
      bottom: -20,
      near: 0.1,
      far: 80,
    });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);
    const fill = new THREE.DirectionalLight("#ffffff", 0.35);
    fill.position.set(10, 8, -10);
    scene.add(fill);
    const floorGeometry = new THREE.PlaneGeometry(150, 150);
    const floorMaterial = new THREE.MeshStandardMaterial({
      color: "#ddd9ce",
      roughness: 0.95,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    scene.add(floor);

    const columns = 9,
      rows = 59,
      count = columns * rows;
    const bodyGeometry = new THREE.BoxGeometry(4.9, 3.6, 0.38);
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: "#a6a18f",
      roughness: 0.54,
      metalness: 0.08,
    });
    const bodies = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, count);
    bodies.castShadow = true;
    bodies.receiveShadow = true;
    bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bodies.frustumCulled = false;
    scene.add(bodies);
    const faceGeometry = new THREE.PlaneGeometry(4.66, 3.36);
    const faceMaterial = new THREE.MeshStandardMaterial({
      color: "#eee9dc",
      roughness: 0.38,
      metalness: 0.05,
    });
    const faces = new THREE.InstancedMesh(faceGeometry, faceMaterial, count);
    faces.receiveShadow = true;
    faces.frustumCulled = false;
    scene.add(faces);
    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = 512;
    labelCanvas.height = 128;
    const context = labelCanvas.getContext("2d")!;
    context.fillStyle = "#f1efe7";
    context.fillRect(0, 0, 512, 128);
    context.fillStyle = "#6c6d63";
    context.font = "28px sans-serif";
    context.fillText("RANGING LAB.", 18, 44);
    context.font = "13px monospace";
    context.fillText("ACOUSTIC RESEARCH / DATA CARRIER", 18, 73);
    context.fillStyle = "#888779";
    context.fillRect(18, 98, 475, 1);
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    labelTexture.colorSpace = THREE.SRGBColorSpace;
    const labelGeometry = new THREE.PlaneGeometry(1.75, 0.44);
    const labelMaterial = new THREE.MeshStandardMaterial({
      map: labelTexture,
      roughness: 0.9,
    });
    const labels = new THREE.InstancedMesh(labelGeometry, labelMaterial, count);
    labels.frustumCulled = false;
    scene.add(labels);
    const screwGeometry = new THREE.CylinderGeometry(0.047, 0.047, 0.012, 8);
    const screwMaterial = new THREE.MeshStandardMaterial({
      color: "#aaa99f",
      metalness: 0.65,
      roughness: 0.5,
    });
    const screws = new THREE.InstancedMesh(screwGeometry, screwMaterial, count);
    screws.frustumCulled = false;
    scene.add(screws);

    const dummy = new THREE.Object3D();
    const colors = ["#fffbef", "#f4f0e5", "#edeae1"].map(
      (c) => new THREE.Color(c),
    );
    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const ids: (string | null)[] = [];
    const lifts = new Map<string, number>();
    const initial = archivePosition(
      state.current.groups,
      state.current.selectedId,
    );
    let x = initial.column * 5.3,
      z = initial.row * 0.88;
    let frame = 0,
      previousTime = 0,
      disposed = false,
      contextLost = false;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    function render(now: number) {
      frame = 0;
      if (disposed || contextLost || document.hidden) return;
      const target = archivePosition(
        state.current.groups,
        state.current.selectedId,
      );
      const dt = Math.min((now - previousTime) / 1000 || 0.016, 0.05);
      previousTime = now;
      const alpha = reduced.matches ? 1 : 1 - Math.exp(-dt * 8);
      const targetX = target.column * 5.3,
        targetZ = target.row * 0.88;
      x += (targetX - x) * alpha;
      z += (targetZ - z) * alpha;
      let moving = Math.abs(targetX - x) + Math.abs(targetZ - z) > 0.001;
      const baseColumn = Math.round(x / 5.3),
        baseRow = Math.round(z / 0.88);
      let i = 0;
      const visible = new Set<string>();
      for (let c = baseColumn - 4; c <= baseColumn + 4; c++) {
        for (let r = baseRow - 29; r <= baseRow + 29; r++, i++) {
          const id = state.current.groups[c]?.records[r]?.id ?? null;
          ids[i] = id;
          const key = `${c}:${r}`;
          visible.add(key);
          const active = id !== null && id === state.current.selectedId;
          const shoulder =
            c === target.column
              ? Math.max(0, 1 - Math.abs(r - target.row) / 4) * 0.35
              : 0;
          const targetLift = active ? 1.6 : shoulder;
          let lift = lifts.get(key) ?? 0;
          lift += (targetLift - lift) * alpha;
          if (Math.abs(targetLift - lift) > 0.001) moving = true;
          lifts.set(key, lift);
          dummy.rotation.set(0, 0, 0);
          dummy.position.set(c * 5.3 - x, 1.8 + lift, r * 0.88 - z);
          dummy.updateMatrix();
          bodies.setMatrixAt(i, dummy.matrix);
          bodies.setColorAt(i, colors[active ? 0 : id ? 1 : 2]);
          dummy.position.z += 0.196;
          dummy.updateMatrix();
          faces.setMatrixAt(i, dummy.matrix);
          dummy.position.x -= 1.25;
          dummy.position.y += 1.31;
          dummy.position.z += 0.007;
          dummy.updateMatrix();
          labels.setMatrixAt(i, dummy.matrix);
          dummy.position.x += 3.42;
          dummy.position.y -= 2.8;
          dummy.rotation.x = Math.PI / 2;
          dummy.updateMatrix();
          screws.setMatrixAt(i, dummy.matrix);
        }
      }
      for (const key of lifts.keys()) if (!visible.has(key)) lifts.delete(key);
      for (const mesh of [bodies, faces, labels, screws])
        mesh.instanceMatrix.needsUpdate = true;
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
      renderer.render(scene, camera);
      if (moving) frame = requestAnimationFrame(render);
    }
    function schedule() {
      if (!disposed && !contextLost && !frame && !document.hidden)
        frame = requestAnimationFrame(render);
    }
    invalidate.current = schedule;
    function resize() {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      const aspect = width / height;
      const halfHeight = aspect < 0.9 ? 8 : 5.2;
      camera.left = -halfHeight * aspect;
      camera.right = halfHeight * aspect;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      schedule();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    let down: { x: number; y: number } | null = null;
    function pointerDown(e: PointerEvent) {
      renderer.domElement.setPointerCapture(e.pointerId);
      down = { x: e.clientX, y: e.clientY };
    }
    function pointerUp(e: PointerEvent) {
      if (!down) return;
      const dx = e.clientX - down.x,
        dy = e.clientY - down.y;
      down = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 40) {
        state.current.onStep(
          Math.abs(dx) > Math.abs(dy) ? "column" : "row",
          (Math.abs(dx) > Math.abs(dy) ? dx : dy) < 0 ? 1 : -1,
        );
        return;
      }
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(bodies)[0];
      const id = hit?.instanceId == null ? null : ids[hit.instanceId];
      if (id) state.current.onSelect(id);
    }
    function cancelPointer() {
      down = null;
    }
    function visibility() {
      if (document.hidden && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else schedule();
    }
    function lost(e: Event) {
      e.preventDefault();
      contextLost = true;
      setFallback(true);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("pointercancel", cancelPointer);
    renderer.domElement.addEventListener("webglcontextlost", lost);
    document.addEventListener("visibilitychange", visibility);
    reduced.addEventListener("change", schedule);
    resize();
    return () => {
      disposed = true;
      invalidate.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      reduced.removeEventListener("change", schedule);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("pointercancel", cancelPointer);
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      for (const geometry of [
        bodyGeometry,
        faceGeometry,
        labelGeometry,
        screwGeometry,
        floorGeometry,
      ])
        geometry.dispose();
      for (const material of [
        bodyMaterial,
        faceMaterial,
        labelMaterial,
        screwMaterial,
        floorMaterial,
      ])
        material.dispose();
      labelTexture.dispose();
      sun.shadow.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div
      className={`archive-scene ${fallback ? "scene-fallback" : ""}`}
      ref={host}
    >
      {fallback && (
        <>
          <div className="fallback-carriers" aria-hidden="true">
            {Array.from({ length: 24 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
          <span className="scene-fallback-note">
            简化场景 · 使用下方按钮或检索选择记录
          </span>
        </>
      )}
    </div>
  );
}
