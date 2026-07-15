import { useEffect, useMemo, useRef } from "react";
import { isAppInForeground } from "../../hooks/useAppForeground";
import {
  shouldPauseBackgroundVisualizersForPlectr,
  subscribeRhythmModeOpen,
} from "../../hooks/useRhythmModeOpen";
import {
  shouldPauseNebulaCanvas,
  subscribeVisualSurfaceActive,
  type NebulaSurface,
} from "../../hooks/useVisualSurfaceActive";
import {
  canvasDprCap,
  isDocumentHidden,
  nebulaLoopCadence,
} from "../../lib/renderQuality";
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
  /** BPM del brano in riproduzione (0 se nessuno). */
  currentBpm?: number;
  interactive?: boolean;
  /** Anteprima compatta (dashboard): stelle più visibili, glow leggero. */
  preview?: boolean;
  /** Preview statica (dashboard): un solo frame se false. */
  animated?: boolean;
  /** Tab che ospita il canvas: pausa il loop se non è quella attiva. */
  surface?: NebulaSurface;
  className?: string;
  frameClassName?: string;
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** MediaQueryList condivisa: `.matches` è live, evita matchMedia() per frame. */
const reducedMotionMq =
  typeof matchMedia !== "undefined"
    ? matchMedia("(prefers-reduced-motion: reduce)")
    : null;

function parseHex(hex: string): [number, number, number] {
  const raw = hex.replace("#", "");
  const n = parseInt(raw.length === 3 ? raw.replace(/./g, "$&$&") : raw, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Sprite di glow pre-renderizzati per colore: creare un radial gradient
 * per ogni stella a ogni frame è il collo di bottiglia principale del
 * canvas su librerie grandi. Uno sprite scalato con drawImage è ~10x
 * più economico e visivamente identico.
 */
const GLOW_SPRITE_SIZE = 64;
const glowSpriteCache = new Map<string, HTMLCanvasElement>();

function glowSpriteFor(color: string): HTMLCanvasElement | null {
  const cached = glowSpriteCache.get(color);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const sprite = document.createElement("canvas");
  sprite.width = GLOW_SPRITE_SIZE;
  sprite.height = GLOW_SPRITE_SIZE;
  const sctx = sprite.getContext("2d");
  if (!sctx) return null;
  const [r, g, b] = parseHex(color);
  const half = GLOW_SPRITE_SIZE / 2;
  const grad = sctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
  grad.addColorStop(0.4, `rgba(${r},${g},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE);
  // I colori derivano da mood (14), generi e artisti: cap difensivo.
  if (glowSpriteCache.size > 512) glowSpriteCache.clear();
  glowSpriteCache.set(color, sprite);
  return sprite;
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
    zoom: number;
    preview: boolean;
  }
) {
  const [r, g, b] = parseHex(star.color);
  const twinkle = 0.84 + Math.sin(t * 0.0028 + star.x * 0.04 + star.y * 0.03) * 0.16;
  let radius = star.radius * twinkle * (opts.preview ? 1.65 : 1);
  let alpha = opts.dimmed ? 0.52 : opts.preview ? 0.96 : 0.9;

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

  const screenR = radius * opts.zoom;
  const simple =
    !opts.preview &&
    !opts.hovered &&
    !opts.current &&
    !star.favorite &&
    screenR < 5.5;

  if (simple) {
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha * 0.88})`;
    ctx.beginPath();
    ctx.arc(star.x, star.y, radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const glowR = radius * (opts.current ? 4.2 : 3.4);
  const sprite = glowSpriteFor(star.color);
  if (sprite) {
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite, star.x - glowR, star.y - glowR, glowR * 2, glowR * 2);
    ctx.globalAlpha = prevAlpha;
  } else {
    const glow = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, glowR);
    glow.addColorStop(0, `rgba(${r},${g},${b},${alpha * 0.95})`);
    glow.addColorStop(0.4, `rgba(${r},${g},${b},${alpha * 0.35})`);
    glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(star.x, star.y, glowR, 0, Math.PI * 2);
    ctx.fill();
  }

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

function drawSelectionVignette(
  ctx: CanvasRenderingContext2D,
  star: NebulaStar,
  t: number
) {
  const [r, g, b] = parseHex(star.color);
  const pulse = 1 + Math.sin(t * 0.0022 + star.x * 0.03) * 0.07;
  const rad = (108 + star.radius * 10) * pulse;
  const glow = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, rad);
  glow.addColorStop(0, `rgba(${r},${g},${b},0.5)`);
  glow.addColorStop(0.38, `rgba(${r},${g},${b},0.16)`);
  glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(star.x, star.y, rad, 0, Math.PI * 2);
  ctx.fill();
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
  sortedStars: readonly NebulaStar[];
  camera: NebulaCamera;
  hoveredId: string | null;
  selectedId?: string | null;
  currentId: string | null;
  playing: boolean;
  currentBpm: number;
  beatEpoch: number;
  interactive: boolean;
  preview: boolean;
};

function nebulaWorldBounds(
  w: number,
  h: number,
  camera: NebulaCamera,
  pad = 48
) {
  const halfW = w / 2 / camera.zoom;
  const halfH = h / 2 / camera.zoom;
  return {
    minX: camera.x - halfW - pad,
    maxX: camera.x + halfW + pad,
    minY: camera.y - halfH - pad,
    maxY: camera.y + halfH + pad,
  };
}

function isStarInBounds(
  star: NebulaStar,
  bounds: ReturnType<typeof nebulaWorldBounds>
) {
  const hit = star.radius + 12;
  return (
    star.x + hit >= bounds.minX &&
    star.x - hit <= bounds.maxX &&
    star.y + hit >= bounds.minY &&
    star.y - hit <= bounds.maxY
  );
}

function paintNebulaFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  p: DrawProps
) {
  const zoom = p.camera.zoom;
  const animT = reducedMotionMq?.matches ? 0 : t;

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

  const parallax = (animT * 0.00002) % 1;
  const parallaxLayers =
    p.preview || w < 520 || p.visibleStars.length > 900 ? 3 : 4;
  for (let i = 0; i < parallaxLayers; i += 1) {
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
    const fogAlpha = clamp(zoom, 0.35, 1.5) * (p.preview ? 1.35 : 1);
    drawNebulaFog(ctx, fog, animT, fogAlpha);
  }

  if (!p.preview) {
    drawAlbumThreads(ctx, p.visibleStars, zoom);
  }

  const selectedStar = p.selectedId
    ? p.sortedStars.find((s) => s.id === p.selectedId) ??
      p.visibleStars.find((s) => s.id === p.selectedId) ??
      null
    : null;
  if (selectedStar) {
    drawSelectionVignette(ctx, selectedStar, animT);
  }

  const bounds = nebulaWorldBounds(w, h, p.camera);
  const isFocused = (id: string) =>
    id === p.hoveredId || id === p.selectedId;
  const hasFocus = Boolean(p.selectedId);
  const beatPhase =
    p.playing && p.currentId && p.currentBpm > 0
      ? (((animT - p.beatEpoch) / 1000) * (p.currentBpm / 60)) % 1
      : 0;
  for (const star of p.sortedStars) {
    if (!isStarInBounds(star, bounds) && star.id !== p.currentId) continue;
    const dimmed = hasFocus && !isFocused(star.id) && star.id !== p.currentId;
    const isCurrent = star.id === p.currentId;
    drawStar(ctx, star, animT, {
      hovered: isFocused(star.id),
      current: isCurrent,
      playing: p.playing,
      beatPhase: isCurrent ? beatPhase : 0,
      dimmed,
      zoom,
      preview: p.preview,
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
  currentBpm = 0,
  interactive = true,
  preview = false,
  animated = true,
  surface,
  className,
  frameClassName,
  onCanvasReady,
}: NebulaCanvasProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const lastDrawRef = useRef(0);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const redrawRef = useRef<((t: number) => void) | null>(null);
  const sortedStars = useMemo(
    () => [...visibleStars].sort((a, b) => a.radius - b.radius),
    [visibleStars]
  );

  const propsRef = useRef<DrawProps>({
    model,
    visibleStars,
    sortedStars,
    camera,
    hoveredId,
    selectedId,
    currentId,
    playing,
    currentBpm,
    beatEpoch: 0,
    interactive,
    preview,
  });

  // Fase del beat ancorata al brano: si resetta solo al cambio traccia/BPM,
  // non a ogni pan/zoom/hover (altrimenti la pulsazione "salta").
  const beatEpochRef = useRef(0);
  useEffect(() => {
    beatEpochRef.current = performance.now();
  }, [currentId, currentBpm]);

  useEffect(() => {
    propsRef.current = {
      model,
      visibleStars,
      sortedStars,
      camera,
      hoveredId,
      selectedId,
      currentId,
      playing,
      currentBpm,
      beatEpoch: beatEpochRef.current,
      interactive,
      preview,
    };
    redrawRef.current?.(performance.now());
  }, [
    model,
    visibleStars,
    sortedStars,
    camera,
    hoveredId,
    selectedId,
    currentId,
    playing,
    currentBpm,
    interactive,
    preview,
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

    /* La misura del frame vive SOLO nel ResizeObserver: chiamare
     * getBoundingClientRect a ogni frame forza un reflow sincrono
     * dell'intera pagina (misurato: la voce di script più costosa
     * dell'app durante il gameplay di Plectr). */
    const measuredRef = { w: 0, h: 0 };
    const readMeasure = () => {
      const rect = frame.getBoundingClientRect();
      measuredRef.w = rect.width;
      measuredRef.h = rect.height;
    };

    const syncBuffer = () => {
      const w = Math.max(1, Math.floor(measuredRef.w));
      const h = Math.max(1, Math.floor(measuredRef.h));
      const dpr = canvasDprCap({ lite: w < 520 });
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
    readMeasure();
    drawFrame(performance.now());

    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) {
        measuredRef.w = entry.contentRect.width;
        measuredRef.h = entry.contentRect.height;
      }
      drawFrame(performance.now());
    });
    ro.observe(frame);

    if (!animated) {
      return () => {
        redrawRef.current = null;
        ro.disconnect();
      };
    }

    let timerId = 0;

    const clearLoop = () => {
      cancelAnimationFrame(rafRef.current);
      window.clearTimeout(timerId);
      rafRef.current = 0;
      timerId = 0;
    };

    const scheduleNext = (delayMs: number) => {
      if (rafRef.current || timerId) return;
      if (delayMs <= 4) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      timerId = window.setTimeout(() => {
        timerId = 0;
        rafRef.current = requestAnimationFrame(loop);
      }, delayMs);
    };

    const restartLoop = () => {
      scheduleNext(0);
    };

    const stopLoop = () => {
      clearLoop();
    };

    const shouldPauseLoop = () =>
      shouldPauseBackgroundVisualizersForPlectr() ||
      !isAppInForeground() ||
      isDocumentHidden() ||
      (surface !== undefined && shouldPauseNebulaCanvas(surface));

    const syncRhythmPause = () => {
      if (shouldPauseLoop()) {
        stopLoop();
        return;
      }
      restartLoop();
    };

    const onVisibility = () => syncRhythmPause();
    document.addEventListener("visibilitychange", onVisibility);
    const unsubRhythm = subscribeRhythmModeOpen(syncRhythmPause);
    const unsubSurface = subscribeVisualSurfaceActive(syncRhythmPause);

    const loop = (t: number) => {
      rafRef.current = 0;
      if (shouldPauseLoop()) {
        stopLoop();
        return;
      }
      const p = propsRef.current;
      const active = p.playing || Boolean(p.hoveredId || p.selectedId);
      const cadence = nebulaLoopCadence({ active, preview: p.preview });
      if (t - lastDrawRef.current >= cadence.minFrameIntervalMs) {
        drawFrame(t);
        lastDrawRef.current = t;
      }
      const wait = Math.max(
        1,
        cadence.minFrameIntervalMs - (performance.now() - lastDrawRef.current),
      );
      scheduleNext(wait);
    };
    restartLoop();

    return () => {
      redrawRef.current = null;
      stopLoop();
      unsubRhythm();
      unsubSurface();
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
    };
  }, [animated, surface]);

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
