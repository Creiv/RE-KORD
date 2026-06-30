import { useEffect, useRef } from "react";
import type { NebulaFog, NebulaModel, NebulaStar, NebulaCamera } from "../../lib/sonicNebula";
import { NEBULA_CENTER, NEBULA_GALAXY_RADIUS } from "../../lib/sonicNebula";

export type { NebulaCamera };

export type NebulaCanvasProps = {
  model: NebulaModel;
  visibleStars: readonly NebulaStar[];
  camera: NebulaCamera;
  hoveredId: string | null;
  selectedId?: string | null;
  currentId: string | null;
  playing: boolean;
  beatPhase?: number;
  interactive?: boolean;
  /** Preview statica (dashboard): un solo frame, niente rAF continuo. */
  animated?: boolean;
  className?: string;
  frameClassName?: string;
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function parseHex(hex: string): [number, number, number] {
  const raw = hex.replace("#", "");
  const n = parseInt(raw.length === 3 ? raw.replace(/./g, "$&$&") : raw, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawNebulaFog(
  ctx: CanvasRenderingContext2D,
  fog: NebulaFog,
  t: number,
  alpha: number
) {
  const [r, g, b] = parseHex(fog.color);
  const pulse = 1 + Math.sin(t * 0.00045 + fog.x * 0.01) * 0.08;
  const rad = fog.radius * pulse;
  const g1 = ctx.createRadialGradient(fog.x, fog.y, 0, fog.x, fog.y, rad);
  g1.addColorStop(0, `rgba(${r},${g},${b},${0.22 * alpha})`);
  g1.addColorStop(0.45, `rgba(${r},${g},${b},${0.08 * alpha})`);
  g1.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = g1;
  ctx.beginPath();
  ctx.arc(fog.x, fog.y, rad, 0, Math.PI * 2);
  ctx.fill();
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  star: NebulaStar,
  t: number,
  opts: {
    hovered: boolean;
    current: boolean;
    playing: boolean;
    beatPhase: number;
    dimmed: boolean;
  }
) {
  const [r, g, b] = parseHex(star.color);
  const twinkle = 0.84 + Math.sin(t * 0.0028 + star.x * 0.04 + star.y * 0.03) * 0.16;
  let radius = star.radius * twinkle;
  let alpha = opts.dimmed ? 0.22 : 0.9;

  if (opts.current && opts.playing) {
    const beat = 0.5 + 0.5 * Math.sin(opts.beatPhase * Math.PI * 2);
    radius *= 1 + beat * 0.4;
    alpha = 1;
  }
  if (opts.hovered) {
    radius *= 1.5;
    alpha = 1;
  }
  if (star.favorite && !opts.dimmed) alpha = Math.min(1, alpha + 0.1);

  const glowR = radius * (opts.current ? 4.2 : 3.4);
  const glow = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, glowR);
  glow.addColorStop(0, `rgba(${r},${g},${b},${alpha * 0.95})`);
  glow.addColorStop(0.4, `rgba(${r},${g},${b},${alpha * 0.35})`);
  glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(star.x, star.y, glowR, 0, Math.PI * 2);
  ctx.fill();

  if (star.favorite || opts.current) {
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha * 0.75})`;
    ctx.lineWidth = opts.current ? 1.6 : 1.1;
    const spike = radius * 1.65;
    ctx.beginPath();
    ctx.moveTo(star.x - spike, star.y);
    ctx.lineTo(star.x + spike, star.y);
    ctx.moveTo(star.x, star.y - spike);
    ctx.lineTo(star.x, star.y + spike);
    ctx.stroke();
  }

  ctx.fillStyle = `rgba(255,255,255,${clamp(alpha, 0.25, 1)})`;
  ctx.beginPath();
  ctx.arc(star.x, star.y, radius * 0.5, 0, Math.PI * 2);
  ctx.fill();

  if (opts.hovered || opts.current) {
    ctx.strokeStyle = `rgba(255,255,255,${opts.current ? 0.9 : 0.5})`;
    ctx.lineWidth = opts.current ? 2 : 1.2;
    ctx.beginPath();
    ctx.arc(star.x, star.y, radius * 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawGalaxyGuides(
  ctx: CanvasRenderingContext2D,
  zoom: number
) {
  const cx = NEBULA_CENTER;
  const cy = NEBULA_CENTER;
  for (let ring = 1; ring <= 4; ring += 1) {
    const r = (NEBULA_GALAXY_RADIUS * ring) / 4;
    ctx.strokeStyle = `rgba(148,163,184,${0.05 + ring * 0.012})`;
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = "rgba(99,102,241,0.07)";
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + Math.cos(a) * NEBULA_GALAXY_RADIUS,
      cy + Math.sin(a) * NEBULA_GALAXY_RADIUS
    );
    ctx.stroke();
  }
  const halo = ctx.createRadialGradient(cx, cy, NEBULA_GALAXY_RADIUS * 0.2, cx, cy, NEBULA_GALAXY_RADIUS * 1.08);
  halo.addColorStop(0, "rgba(99,102,241,0)");
  halo.addColorStop(0.85, "rgba(99,102,241,0)");
  halo.addColorStop(1, "rgba(129,140,248,0.14)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, NEBULA_GALAXY_RADIUS * 1.08, 0, Math.PI * 2);
  ctx.fill();
}

function drawAlbumThreads(
  ctx: CanvasRenderingContext2D,
  stars: readonly NebulaStar[],
  zoom: number
) {
  if (zoom < 1.05 || stars.length > 600) return;
  const byAlbum = new Map<string, NebulaStar[]>();
  for (const star of stars) {
    const key = `${star.track.artist}::${star.track.album}`;
    const list = byAlbum.get(key);
    if (list) list.push(star);
    else byAlbum.set(key, [star]);
  }
  ctx.lineWidth = 0.9 / zoom;
  for (const group of byAlbum.values()) {
    if (group.length < 2 || group.length > 5) continue;
    const [r, g, b] = parseHex(group[0]!.color);
    ctx.strokeStyle = `rgba(${r},${g},${b},0.14)`;
    const sorted = [...group].sort((a, b) => a.bpm - b.bpm);
    ctx.beginPath();
    ctx.moveTo(sorted[0]!.x, sorted[0]!.y);
    for (let i = 1; i < sorted.length; i += 1) {
      ctx.lineTo(sorted[i]!.x, sorted[i]!.y);
    }
    ctx.stroke();
  }
}

type DrawProps = {
  model: NebulaModel;
  visibleStars: readonly NebulaStar[];
  camera: NebulaCamera;
  hoveredId: string | null;
  selectedId?: string | null;
  currentId: string | null;
  playing: boolean;
  beatPhase: number;
  interactive: boolean;
};

function paintNebulaFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  p: DrawProps
) {
  const zoom = p.camera.zoom;

  const bg = ctx.createRadialGradient(
    w / 2,
    h / 2,
    0,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.72
  );
  bg.addColorStop(0, "#0c1024");
  bg.addColorStop(0.45, "#070a16");
  bg.addColorStop(1, "#03040a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-p.camera.x, -p.camera.y);

  const parallax = (t * 0.00002) % 1;
  for (let i = 0; i < 4; i += 1) {
    const gx = NEBULA_CENTER + Math.cos(parallax * Math.PI * 2 + i) * 180;
    const gy = NEBULA_CENTER + Math.sin(parallax * Math.PI * 2 + i * 1.4) * 140;
    const rad = 240 + i * 90;
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, rad);
    g.addColorStop(0, `rgba(99,102,241,${0.055 - i * 0.01})`);
    g.addColorStop(1, "rgba(99,102,241,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(gx, gy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  drawGalaxyGuides(ctx, zoom);

  for (const fog of p.model.fogs) {
    drawNebulaFog(ctx, fog, t, clamp(zoom, 0.35, 1.5));
  }

  drawAlbumThreads(ctx, p.visibleStars, zoom);

  const isFocused = (id: string) =>
    id === p.hoveredId || id === p.selectedId;
  const hasFocus = Boolean(p.hoveredId || p.selectedId);
  const sorted = [...p.visibleStars].sort((a, b) => a.radius - b.radius);
  for (const star of sorted) {
    const dimmed = hasFocus && !isFocused(star.id) && star.id !== p.currentId;
    drawStar(ctx, star, t, {
      hovered: isFocused(star.id),
      current: star.id === p.currentId,
      playing: p.playing,
      beatPhase: p.beatPhase,
      dimmed,
    });
  }

  ctx.restore();
}

export function NebulaCanvas({
  model,
  visibleStars,
  camera,
  hoveredId,
  selectedId = null,
  currentId,
  playing,
  beatPhase = 0,
  interactive = true,
  animated = true,
  className,
  frameClassName,
  onCanvasReady,
}: NebulaCanvasProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const redrawRef = useRef<((t: number) => void) | null>(null);
  const propsRef = useRef<DrawProps>({
    model,
    visibleStars,
    camera,
    hoveredId,
    selectedId,
    currentId,
    playing,
    beatPhase,
    interactive,
  });

  useEffect(() => {
    propsRef.current = {
      model,
      visibleStars,
      camera,
      hoveredId,
      selectedId,
      currentId,
      playing,
      beatPhase,
      interactive,
    };
    redrawRef.current?.(performance.now());
  }, [
    model,
    visibleStars,
    camera,
    hoveredId,
    selectedId,
    currentId,
    playing,
    beatPhase,
    interactive,
  ]);

  useEffect(() => {
    onCanvasReady?.(canvasRef.current);
    return () => onCanvasReady?.(null);
  }, [onCanvasReady]);

  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const syncBuffer = () => {
      const rect = frame.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const prev = sizeRef.current;
      if (prev.w === w && prev.h === h && prev.dpr === dpr) return;
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const drawFrame = (t: number) => {
      syncBuffer();
      const { w, h } = sizeRef.current;
      if (w <= 0 || h <= 0) return;
      paintNebulaFrame(ctx, w, h, t, propsRef.current);
    };

    redrawRef.current = drawFrame;
    drawFrame(performance.now());

    const ro = new ResizeObserver(() => {
      drawFrame(performance.now());
    });
    ro.observe(frame);

    if (!animated) {
      return () => {
        redrawRef.current = null;
        ro.disconnect();
      };
    }

    const loop = (t: number) => {
      drawFrame(t);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      redrawRef.current = null;
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [animated]);

  return (
    <div ref={frameRef} className={frameClassName ?? "nebula-canvas-frame"}>
      <canvas
        ref={canvasRef}
        className={className ?? "nebula-canvas-surface"}
        aria-hidden={!interactive}
      />
    </div>
  );
}
