// Model preview (?modelview=<hullId>[&variant=…][&preset=…][&models=0]): a content author's check of a
// ship model without starting a game — the hull turning slowly with its preset's turrets mounted,
// hardpoint data drawn as green markers with facing arrows (they should sit on the model's turret bases),
// the procedural fallback hull beside it for comparison, and the loader's report. Docs: CODEX guide §31.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CONTENT } from '../content/registry';
import { SHIP_CLASSES } from '../sim/data/ships';
import { shipLoadout } from '../world/fitting';
import { buildShip, type ShipModel } from './shipMesh';
import { modelStats } from './modelLoader';

export function startModelPreview(app: HTMLElement, canvas: HTMLCanvasElement, params: URLSearchParams) {
  const hullId = params.get('modelview') ?? '';
  const h = CONTENT.hulls[hullId];
  canvas.style.visibility = 'visible';
  const info = document.createElement('div');
  info.style.cssText = 'position:fixed;left:12px;top:12px;z-index:5;font:13px/1.5 monospace;color:#cfe;background:rgba(0,10,20,.75);padding:10px 12px;border:1px solid #2a4a5a;max-width:520px;white-space:pre-wrap';
  app.appendChild(info);
  if (!h) { info.textContent = `알 수 없는 선체 "${hullId}"\n선체 목록: ${Object.keys(CONTENT.hulls).filter(k => CONTENT.hulls[k].mesh.model).join(', ') || '(모델을 쓰는 선체 없음)'}`; return; }
  const variant = params.get('variant') ?? Object.values(CONTENT.variants).find(v => v.hull === h.id)?.id ?? '';
  const preset = CONTENT.presets[params.get('preset') ?? ''] ?? Object.values(CONTENT.presets).find(p => p.variant === variant);
  const cls = SHIP_CLASSES[h.classId];
  const ship = { classId: h.classId, loadoutId: '', variant, fitting: { hp: { ...(preset?.weapons ?? {}) }, bay: {} } };
  const lo = shipLoadout(ship);
  const team = params.get('team') === '1' ? 1 : 0;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080d);
  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x202430, 1.4));
  const sun = new THREE.DirectionalLight(0xfff2e0, 3.2); sun.position.set(40, 60, 30); scene.add(sun);
  const rim = new THREE.DirectionalLight(0x6fb0ff, 1.4); rim.position.set(-50, 10, -40); scene.add(rim);
  const L = cls.length * h.mesh.scale;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, L * 400);
  camera.position.set(L * 1.1, L * 0.6, L * 1.1);
  const ctl = new OrbitControls(camera, canvas); ctl.target.set(params.has('solo') ? 0 : -L * 0.45, 0, 0); ctl.update();

  const mk = (withModel: boolean, x: number): ShipModel => {
    const m = buildShip(cls, withModel ? lo : { ...lo, mesh: lo.mesh ? { base: lo.mesh.base, scale: lo.mesh.scale } : undefined }, team);
    m.root.position.x = x; scene.add(m.root); return m;
  };
  const main = mk(true, 0);
  const proc = params.has('solo') ? null : mk(false, -L * 0.9);
  // hardpoint data markers
  const hpGroup = new THREE.Group(); main.bank.add(hpGroup);
  const mGeo = new THREE.SphereGeometry(Math.max(0.25, L * 0.012), 10, 8);
  for (const p of h.hardpoints) {
    const s = new THREE.Mesh(mGeo, new THREE.MeshBasicMaterial({ color: 0x40ff80, depthTest: false, transparent: true, opacity: 0.85 }));
    s.position.set(p.pos[0], p.pos[1], p.pos[2]); s.renderOrder = 10; hpGroup.add(s);
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(Math.sin(p.facing * Math.PI / 180), 0, Math.cos(p.facing * Math.PI / 180)), s.position, L * 0.06, 0x40ff80);
    hpGroup.add(arrow);
  }
  hpGroup.visible = !params.has('nohp');
  const resize = () => { const w = innerWidth, hh = innerHeight; renderer.setSize(w, hh, false); canvas.style.width = w + 'px'; canvas.style.height = hh + 'px'; camera.aspect = w / hh; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize); resize();
  let spin = !params.has('still');
  addEventListener('keydown', e => { if (e.key === ' ') spin = !spin; if (e.key === 'h') hpGroup.visible = !hpGroup.visible; });
  let t = 0, last = performance.now();
  const frame = () => {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (spin) t += dt;
    for (const m of [main, proc]) if (m) { m.root.rotation.y = t * 0.4; for (const e of m.engines) { e.plume.scale.z = e.base * 6; e.glow.scale.setScalar(e.base); } }
    for (const tv of main.turrets) if (tv.rotates) tv.root.rotation.y = tv.mount.facing * Math.PI / 180 + Math.sin(t * 0.8) * 0.5;
    renderer.render(scene, camera);
    const st = main.model?.state ?? '모델 없음 (절차적 선체)';
    info.textContent = `${h.name} (${h.id}) · ${cls.type} · 길이 ${L.toFixed(1)}\n모델 ${h.mesh.model ?? '-'} · 상태 ${st}\n변형 ${variant} · 프리셋 ${preset?.id ?? '-'}\n하드포인트 ${h.hardpoints.length} · 장착 ${lo.mounts.length} · 엔진 ${main.engines.length} · 항법등 ${main.lights.length}\n로더: 요청 ${modelStats.requests} · 내려받기 ${modelStats.fetches} · 성공 ${modelStats.loaded} · 실패 ${modelStats.failed}\n${proc ? '왼쪽: 절차적 대체 외형 · 오른쪽: 모델\n' : ''}초록 점 = 하드포인트 데이터 위치 (h: 표시 전환, space: 회전 정지)`;
    info.dataset.state = main.model?.state ?? 'none';
    requestAnimationFrame(frame);
  };
  frame();
  (window as any).__preview = { main, proc, scene, camera, renderer };
}
