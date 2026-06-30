import { getCachedChart } from "../game/lib/chartCache";
import { stableHash } from "../game/lib/math";
import { parseTrackGenres } from "./genres";
import {
  parseTrackMoods,
  TRACK_MOOD_COLORS,
  type TrackMoodId,
} from "./trackMoods";
import type { EnrichedTrack } from "../types";

export const NEBULA_WORLD = 2200;
export const NEBULA_CENTER = NEBULA_WORLD / 2;
export const NEBULA_GALAXY_RADIUS = NEBULA_WORLD * 0.44;

export type NebulaCamera = {
  x: number;
  y: number;
  zoom: number;
};

export function defaultNebulaCamera(zoom = 0.52): NebulaCamera {
  return { x: NEBULA_CENTER, y: NEBULA_CENTER, zoom };
}

/** Energia percettiva 0–1 per mood canonico. */
export const MOOD_ENERGY: Record<TrackMoodId, number> = {
  aggressive_heavy: 0.96,
  party_dance: 0.9,
  energy_boost: 0.86,
  motivational_drive: 0.82,
  epic_cinematic: 0.76,
  fun_quirky: 0.64,
  soulful_groovy: 0.58,
  nostalgia_retro: 0.5,
  romantic_intimacy: 0.44,
  dreamy_ethereal: 0.38,
  focus_study: 0.34,
  chill_relax: 0.26,
  sad_melancholy: 0.2,
  dark_tense: 0.14,
};

export type NebulaStar = {
  id: string;
  track: EnrichedTrack;
  x: number;
  y: number;
  radius: number;
  color: string;
  bpm: number;
  energy: number;
  moods: TrackMoodId[];
  favorite: boolean;
  playCount: number;
};

export type NebulaFog = {
  mood: TrackMoodId | null;
  labelKey: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  count: number;
};

export type NebulaModel = {
  stars: NebulaStar[];
  fogs: NebulaFog[];
  bpmMin: number;
  bpmMax: number;
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s / 100, 0, 1);
  const lit = clamp(l / 100, 0, 1);
  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lit - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hue < 60) {
    rp = c;
    gp = x;
  } else if (hue < 120) {
    rp = x;
    gp = c;
  } else if (hue < 180) {
    gp = c;
    bp = x;
  } else if (hue < 240) {
    gp = x;
    bp = c;
  } else if (hue < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }
  const toByte = (v: number) =>
    Math.round(clamp((v + m) * 255, 0, 255))
      .toString(16)
      .padStart(2, "0");
  return `#${toByte(rp)}${toByte(gp)}${toByte(bp)}`;
}

function estimateBpm(track: EnrichedTrack): number {
  const cached = getCachedChart(track.relPath);
  const fromChart =
    cached?.charts.normal?.stats.bpm ??
    cached?.charts.hard?.stats.bpm ??
    cached?.charts.easy?.stats.bpm;
  if (fromChart && fromChart > 40 && fromChart < 220) return fromChart;

  const h = stableHash(track.relPath);
  let bpm = 68 + (h % 104);
  const dur = track.meta?.durationMs;
  if (dur) {
    if (dur < 150_000) bpm += 18;
    else if (dur < 210_000) bpm += 8;
    else if (dur > 420_000) bpm -= 14;
    else if (dur > 300_000) bpm -= 6;
  }
  return clamp(bpm, 62, 178);
}

function estimateEnergy(track: EnrichedTrack): number {
  const moods = parseTrackMoods(track.meta ?? undefined);
  if (moods.length) {
    const sum = moods.reduce((acc, m) => acc + MOOD_ENERGY[m], 0);
    return sum / moods.length;
  }
  const genres = parseTrackGenres(track.meta?.genre ?? track.albumMeta?.genre);
  const g = genres.join(" ").toLowerCase();
  if (/metal|hardcore|punk|drum|techno|dnb|trap|grime/.test(g)) return 0.88;
  if (/dance|edm|house|disco|funk|hip.?hop|rap/.test(g)) return 0.78;
  if (/rock|pop|indie|electro/.test(g)) return 0.62;
  if (/jazz|soul|r&b|blues/.test(g)) return 0.52;
  if (/ambient|chill|lofi|classical|piano/.test(g)) return 0.28;
  if (/soundtrack|score|cinema/.test(g)) return 0.45;
  const h = stableHash(`${track.relPath}:energy`);
  return 0.22 + (h % 700) / 1000;
}

function starColor(track: EnrichedTrack, moods: TrackMoodId[]): string {
  if (moods[0]) return TRACK_MOOD_COLORS[moods[0]];
  const genres = parseTrackGenres(track.meta?.genre ?? track.albumMeta?.genre);
  if (genres[0]) {
    return hslToHex(stableHash(genres[0]) % 360, 58, 56);
  }
  const h = stableHash(track.artist) % 360;
  return hslToHex(h, 42, 62);
}

function starRadius(playCount: number, favorite: boolean): number {
  const base = favorite ? 5.2 : 3.4;
  if (playCount <= 0) return base;
  return clamp(base + Math.log2(playCount + 1) * 1.35, base, 11);
}

function jitter(relPath: string, spread: number): [number, number] {
  const h = stableHash(`${relPath}:pos`);
  const a = (h % 10_000) / 10_000;
  const b = ((h / 10_000) % 10_000) / 10_000;
  return [(a - 0.5) * spread, (b - 0.5) * spread];
}

function galaxyPosition(
  relPath: string,
  bpmNorm: number,
  energy: number
): [number, number] {
  const hash = stableHash(relPath);
  const cx = NEBULA_CENTER;
  const cy = NEBULA_CENTER;
  const theta = bpmNorm * Math.PI * 2 - Math.PI / 2;
  const arm = ((hash % 5) * Math.PI * 2) / 5;
  const angle = theta * 0.68 + arm * 0.32 + ((hash % 1000) / 1000) * 0.28;
  const ring = 0.1 + energy * 0.82;
  const ripple = Math.sin(theta * 4 + hash * 0.002) * 34;
  const r = ring * NEBULA_GALAXY_RADIUS + ripple;
  const [jx, jy] = jitter(relPath, 18);
  return [cx + Math.cos(angle) * r + jx, cy + Math.sin(angle) * r + jy];
}

function relaxGalaxyStars(stars: NebulaStar[]) {
  if (stars.length < 2 || stars.length > 2500) return;
  const cell = 52;
  const cx = NEBULA_CENTER;
  const cy = NEBULA_CENTER;
  const maxR = NEBULA_GALAXY_RADIUS + 24;

  for (let pass = 0; pass < 4; pass += 1) {
    const grid = buildNebulaSpatialGrid(stars, cell);
    for (const star of stars) {
      const gx = Math.floor(star.x / cell);
      const gy = Math.floor(star.y / cell);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const bucket = grid.buckets.get(`${gx + ox}:${gy + oy}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other.id === star.id) continue;
            const dx = other.x - star.x;
            const dy = other.y - star.y;
            const d2 = dx * dx + dy * dy;
            const min = star.radius + other.radius + 7;
            if (d2 >= min * min || d2 < 0.25) continue;
            const d = Math.sqrt(d2);
            const push = ((min - d) / d) * 0.42;
            star.x -= dx * push;
            star.y -= dy * push;
          }
        }
      }
      const rdx = star.x - cx;
      const rdy = star.y - cy;
      const rd = Math.hypot(rdx, rdy);
      if (rd > maxR) {
        star.x = cx + (rdx / rd) * maxR;
        star.y = cy + (rdy / rd) * maxR;
      }
    }
  }
}

export function buildNebulaModel(
  tracks: readonly EnrichedTrack[],
  opts: {
    playCounts: Record<string, number>;
    favorites: ReadonlySet<string>;
  }
): NebulaModel {
  if (!tracks.length) {
    return { stars: [], fogs: [], bpmMin: 60, bpmMax: 180 };
  }

  const bpms = tracks.map(estimateBpm);
  const bpmMin = Math.min(...bpms);
  const bpmMax = Math.max(...bpms);
  const bpmSpan = Math.max(12, bpmMax - bpmMin);

  const stars: NebulaStar[] = tracks.map((track, i) => {
    const moods = parseTrackMoods(track.meta ?? undefined);
    const bpm = bpms[i]!;
    const energy = estimateEnergy(track);
    const nx = (bpm - bpmMin) / bpmSpan;
    const [x, y] = galaxyPosition(track.relPath, nx, energy);
    const playCount = opts.playCounts[track.relPath] ?? 0;
    const favorite = opts.favorites.has(track.relPath);
    return {
      id: track.relPath,
      track,
      x,
      y,
      radius: starRadius(playCount, favorite),
      color: starColor(track, moods),
      bpm,
      energy,
      moods,
      favorite,
      playCount,
    };
  });

  relaxGalaxyStars(stars);

  const moodBuckets = new Map<
    TrackMoodId,
    { sx: number; sy: number; n: number }
  >();
  const unlabeled = { sx: 0, sy: 0, n: 0 };
  for (const star of stars) {
    const mood = star.moods[0];
    if (!mood) {
      unlabeled.sx += star.x;
      unlabeled.sy += star.y;
      unlabeled.n += 1;
      continue;
    }
    const bucket = moodBuckets.get(mood) ?? { sx: 0, sy: 0, n: 0 };
    bucket.sx += star.x;
    bucket.sy += star.y;
    bucket.n += 1;
    moodBuckets.set(mood, bucket);
  }

  const fogs: NebulaFog[] = [];
  for (const [mood, bucket] of moodBuckets) {
    if (bucket.n < 2) continue;
    fogs.push({
      mood,
      labelKey: `trackMeta.mood.${mood}`,
      x: bucket.sx / bucket.n,
      y: bucket.sy / bucket.n,
      radius: clamp(90 + Math.sqrt(bucket.n) * 34, 120, 420),
      color: TRACK_MOOD_COLORS[mood],
      count: bucket.n,
    });
  }
  if (unlabeled.n >= 4) {
    fogs.push({
      mood: null,
      labelKey: "nebula.fog.unlabeled",
      x: unlabeled.sx / unlabeled.n,
      y: unlabeled.sy / unlabeled.n,
      radius: clamp(80 + Math.sqrt(unlabeled.n) * 28, 100, 360),
      color: "#94a3b8",
      count: unlabeled.n,
    });
  }

  return { stars, fogs, bpmMin, bpmMax };
}

export function filterNebulaStars(
  stars: readonly NebulaStar[],
  moodFilter: TrackMoodId | null,
  query: string
): NebulaStar[] {
  const q = query.trim().toLowerCase();
  return stars.filter((star) => {
    if (moodFilter && !star.moods.includes(moodFilter)) return false;
    if (!q) return true;
    const hay = `${star.track.title} ${star.track.artist} ${star.track.album}`.toLowerCase();
    return hay.includes(q);
  });
}

export function nebulaStarsNear(
  stars: readonly NebulaStar[],
  center: NebulaStar,
  radius: number,
  limit = 48
): NebulaStar[] {
  const r2 = radius * radius;
  const hits: { star: NebulaStar; d2: number }[] = [];
  for (const star of stars) {
    if (star.id === center.id) continue;
    const dx = star.x - center.x;
    const dy = star.y - center.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2) hits.push({ star, d2 });
  }
  hits.sort((a, b) => a.d2 - b.d2);
  return hits.slice(0, limit).map((h) => h.star);
}

export type NebulaSpatialGrid = {
  cell: number;
  buckets: Map<string, NebulaStar[]>;
};

export function buildNebulaSpatialGrid(
  stars: readonly NebulaStar[],
  cell = 72
): NebulaSpatialGrid {
  const buckets = new Map<string, NebulaStar[]>();
  for (const star of stars) {
    const cx = Math.floor(star.x / cell);
    const cy = Math.floor(star.y / cell);
    const key = `${cx}:${cy}`;
    const list = buckets.get(key);
    if (list) list.push(star);
    else buckets.set(key, [star]);
  }
  return { cell, buckets };
}

export function pickNebulaStarAt(
  grid: NebulaSpatialGrid,
  wx: number,
  wy: number,
  zoom: number
): NebulaStar | null {
  const hitR = clamp(14 / Math.max(zoom, 0.35), 8, 28);
  const cell = grid.cell;
  const cx = Math.floor(wx / cell);
  const cy = Math.floor(wy / cell);
  let best: NebulaStar | null = null;
  let bestD2 = hitR * hitR;
  for (let ox = -1; ox <= 1; ox += 1) {
    for (let oy = -1; oy <= 1; oy += 1) {
      const list = grid.buckets.get(`${cx + ox}:${cy + oy}`);
      if (!list) continue;
      for (const star of list) {
        const dx = star.x - wx;
        const dy = star.y - wy;
        const d2 = dx * dx + dy * dy;
        const threshold = Math.max(star.radius + 4, hitR);
        if (d2 <= threshold * threshold && d2 < bestD2) {
          best = star;
          bestD2 = d2;
        }
      }
    }
  }
  return best;
}
