/** Achievement / XP — port leggero da src/lib/achievements.ts per next client-ui. */

export type AchievementIconKind =
  | "play"
  | "heart"
  | "list"
  | "artist"
  | "genre"
  | "shuffle"
  | "library"
  | "flame"
  | "streak"
  | "plectr";

export type AchievementSignals = {
  totalPlays: number;
  favoritesCount: number;
  playlistsCount: number;
  artistsWithPlays: number;
  genresWithPlays: number;
  tracksWithPlays: number;
  shuffleBlocks: number;
  libraryTrackCount: number;
  topArtistPlays: number;
  topTrackPlays: number;
  albumsWithPlays: number;
  playlistTrackCount: number;
  streak: number;
  plectrTracksPlayed: number;
};

type AchievementDefinition = {
  id: string;
  title: string;
  desc: string;
  xpBonus: number;
  icon: AchievementIconKind;
  check: (s: AchievementSignals) => boolean;
};

type XpTier = { xpMin: number; xpMax: number | null; title: string };

const XP_TIERS: XpTier[] = [
  { title: "KICKER", xpMin: 0, xpMax: 99 },
  { title: "KRAFTER", xpMin: 100, xpMax: 299 },
  { title: "KURATORE", xpMin: 300, xpMax: 599 },
  { title: "KEEPER OF RE-KORD", xpMin: 600, xpMax: 999 },
  { title: "KONDUCTOR", xpMin: 1000, xpMax: 1499 },
  { title: "KOMPONER", xpMin: 1500, xpMax: 2199 },
  { title: "KREATOR", xpMin: 2200, xpMax: 2999 },
  { title: "KONTROLLER", xpMin: 3000, xpMax: 3999 },
  { title: "RE-KORDMASTER", xpMin: 4000, xpMax: 5499 },
  { title: "KING OF RE-KORD", xpMin: 5500, xpMax: null },
];

const TITLES = XP_TIERS.map((t) => t.title);
const LEVEL_XP_SCALE = 1.25;

function tierSpan(tier: XpTier, prevSpan: number): number {
  if (tier.xpMax != null) return tier.xpMax - tier.xpMin + 1;
  return prevSpan;
}

function buildNumericLevelXpMins(): number[] {
  const mins: number[] = [];
  let prevSpan = 100;
  for (const tier of XP_TIERS) {
    const span = tierSpan(tier, prevSpan);
    prevSpan = span;
    const half = Math.floor(span / 2);
    mins.push(tier.xpMin, tier.xpMin + half);
  }
  return mins;
}

const NUMERIC_LEVEL_XP_MINS = buildNumericLevelXpMins();
const POST_TITLE_LEVEL_SPAN = Math.floor(
  (XP_TIERS[8]!.xpMax! - XP_TIERS[8]!.xpMin + 1) / 2,
);

function scaledLevelXp(xp: number): number {
  return Math.ceil(xp * LEVEL_XP_SCALE);
}

function scaledPostTitleLevelSpan(): number {
  return Math.ceil(POST_TITLE_LEVEL_SPAN * LEVEL_XP_SCALE);
}

export function titleForNumericLevel(level: number): string {
  const idx = Math.min(TITLES.length - 1, Math.floor((level - 1) / 3));
  return TITLES[idx]!;
}

function numericLevelForXp(xp: number): number {
  const kingMin = scaledLevelXp(NUMERIC_LEVEL_XP_MINS[18]!);
  const postKingMin = scaledLevelXp(NUMERIC_LEVEL_XP_MINS[19]!);
  const postSpan = scaledPostTitleLevelSpan();
  if (xp >= postKingMin) {
    return 20 + Math.floor((xp - postKingMin) / postSpan);
  }
  if (xp >= kingMin) return 19;
  for (let i = NUMERIC_LEVEL_XP_MINS.length - 2; i >= 0; i--) {
    if (xp >= scaledLevelXp(NUMERIC_LEVEL_XP_MINS[i]!)) return i + 1;
  }
  return 1;
}

function xpMinForNumericLevel(level: number): number {
  if (level <= 20) return scaledLevelXp(NUMERIC_LEVEL_XP_MINS[level - 1]!);
  const postKingMin = scaledLevelXp(NUMERIC_LEVEL_XP_MINS[19]!);
  return postKingMin + (level - 20) * scaledPostTitleLevelSpan();
}

function xpMaxForNumericLevel(level: number): number {
  return xpMinForNumericLevel(level + 1) - 1;
}

function libraryPctPlayed(signals: AchievementSignals, pct: number): boolean {
  if (signals.libraryTrackCount <= 0) return false;
  const need = Math.max(1, Math.ceil(signals.libraryTrackCount * pct));
  return signals.tracksWithPlays >= need;
}

const DEFINITIONS: AchievementDefinition[] = [
  { id: "first_play", title: "Prima nota", desc: "Riproduci un brano almeno una volta.", xpBonus: 10, icon: "play", check: (s) => s.totalPlays >= 1 },
  { id: "plays_10", title: "Riscaldamento", desc: "10 riproduzioni totali.", xpBonus: 15, icon: "play", check: (s) => s.totalPlays >= 10 },
  { id: "plays_25", title: "Flusso costante", desc: "25 riproduzioni totali.", xpBonus: 20, icon: "play", check: (s) => s.totalPlays >= 25 },
  { id: "plays_50", title: "Mezzo secolo", desc: "50 riproduzioni totali.", xpBonus: 30, icon: "play", check: (s) => s.totalPlays >= 50 },
  { id: "plays_100", title: "In loop", desc: "100 riproduzioni totali.", xpBonus: 50, icon: "play", check: (s) => s.totalPlays >= 100 },
  { id: "plays_250", title: "Sessione lunga", desc: "250 riproduzioni totali.", xpBonus: 75, icon: "play", check: (s) => s.totalPlays >= 250 },
  { id: "plays_500", title: "Maratona", desc: "500 riproduzioni totali.", xpBonus: 100, icon: "flame", check: (s) => s.totalPlays >= 500 },
  { id: "plays_1000", title: "Coda infinita", desc: "1.000 riproduzioni totali.", xpBonus: 150, icon: "flame", check: (s) => s.totalPlays >= 1000 },
  { id: "plays_2500", title: "Libreria in loop", desc: "2.500 riproduzioni totali.", xpBonus: 200, icon: "flame", check: (s) => s.totalPlays >= 2500 },
  { id: "plays_5000", title: "Giri di una vita", desc: "5.000 riproduzioni totali.", xpBonus: 300, icon: "flame", check: (s) => s.totalPlays >= 5000 },
  { id: "first_favorite", title: "Salvato per sempre", desc: "Aggiungi il primo preferito.", xpBonus: 15, icon: "heart", check: (s) => s.favoritesCount >= 1 },
  { id: "favorites_5", title: "Lista corta", desc: "5 preferiti.", xpBonus: 25, icon: "heart", check: (s) => s.favoritesCount >= 5 },
  { id: "favorites_10", title: "Lista d'oro", desc: "10 preferiti.", xpBonus: 40, icon: "heart", check: (s) => s.favoritesCount >= 10 },
  { id: "favorites_25", title: "Catalogo del cuore", desc: "25 preferiti.", xpBonus: 60, icon: "heart", check: (s) => s.favoritesCount >= 25 },
  { id: "favorites_50", title: "Cassa del tesoro", desc: "50 preferiti.", xpBonus: 90, icon: "heart", check: (s) => s.favoritesCount >= 50 },
  { id: "favorites_100", title: "Centinaia di gemme", desc: "100 preferiti.", xpBonus: 120, icon: "heart", check: (s) => s.favoritesCount >= 100 },
  { id: "playlist_1", title: "Mix maker", desc: "Crea la prima playlist.", xpBonus: 30, icon: "list", check: (s) => s.playlistsCount >= 1 },
  { id: "playlists_3", title: "Curatore di set", desc: "Possiedi 3 playlist.", xpBonus: 50, icon: "list", check: (s) => s.playlistsCount >= 3 },
  { id: "playlists_5", title: "Direttore di palinsesto", desc: "Possiedi 5 playlist.", xpBonus: 70, icon: "list", check: (s) => s.playlistsCount >= 5 },
  { id: "playlists_10", title: "Radio d'archivio", desc: "Possiedi 10 playlist.", xpBonus: 100, icon: "list", check: (s) => s.playlistsCount >= 10 },
  { id: "playlists_20", title: "Volta di set", desc: "Possiedi 20 playlist.", xpBonus: 140, icon: "list", check: (s) => s.playlistsCount >= 20 },
  { id: "artists_3", title: "Primo roster", desc: "Ascolta musica di 3 artisti.", xpBonus: 20, icon: "artist", check: (s) => s.artistsWithPlays >= 3 },
  { id: "artists_5", title: "Scout della scena", desc: "Ascolta musica di 5 artisti.", xpBonus: 30, icon: "artist", check: (s) => s.artistsWithPlays >= 5 },
  { id: "artists_10", title: "Orecchie larghe", desc: "Ascolta musica di 10 artisti.", xpBonus: 45, icon: "artist", check: (s) => s.artistsWithPlays >= 10 },
  { id: "artists_20", title: "Roster profondo", desc: "Ascolta musica di 20 artisti.", xpBonus: 70, icon: "artist", check: (s) => s.artistsWithPlays >= 20 },
  { id: "artists_50", title: "Salto tra etichette", desc: "Ascolta musica di 50 artisti.", xpBonus: 110, icon: "artist", check: (s) => s.artistsWithPlays >= 50 },
  { id: "artists_100", title: "Sala dei nomi", desc: "Ascolta musica di 100 artisti.", xpBonus: 160, icon: "artist", check: (s) => s.artistsWithPlays >= 100 },
  { id: "genres_3", title: "Salto di genere", desc: "Ascolta in 3 generi.", xpBonus: 25, icon: "genre", check: (s) => s.genresWithPlays >= 3 },
  { id: "genres_5", title: "Spettro", desc: "Tocca 5 generi dai metadati.", xpBonus: 40, icon: "genre", check: (s) => s.genresWithPlays >= 5 },
  { id: "genres_10", title: "Sezione trasversale", desc: "Tocca 10 generi.", xpBonus: 60, icon: "genre", check: (s) => s.genresWithPlays >= 10 },
  { id: "genres_15", title: "Orecchie aperte", desc: "Tocca 15 generi.", xpBonus: 80, icon: "genre", check: (s) => s.genresWithPlays >= 15 },
  { id: "genres_20", title: "Onnivoro", desc: "Tocca 20 generi.", xpBonus: 100, icon: "genre", check: (s) => s.genresWithPlays >= 20 },
  { id: "tracks_10", title: "Assaggiatore", desc: "Riproduci 10 brani diversi.", xpBonus: 20, icon: "library", check: (s) => s.tracksWithPlays >= 10 },
  { id: "tracks_50", title: "Tagli profondi", desc: "Riproduci 50 brani diversi.", xpBonus: 50, icon: "library", check: (s) => s.tracksWithPlays >= 50 },
  { id: "tracks_100", title: "Rassegna catalogo", desc: "Riproduci 100 brani diversi.", xpBonus: 80, icon: "library", check: (s) => s.tracksWithPlays >= 100 },
  { id: "tracks_500", title: "Maratona scaffale", desc: "Riproduci 500 brani diversi.", xpBonus: 150, icon: "library", check: (s) => s.tracksWithPlays >= 500 },
  { id: "shuffle_1", title: "Prima esclusione", desc: "Escludi 1 elemento dallo shuffle intelligente.", xpBonus: 15, icon: "shuffle", check: (s) => s.shuffleBlocks >= 1 },
  { id: "shuffle_3", title: "DJ shuffle intelligente", desc: "Escludi 3 elementi dallo shuffle intelligente.", xpBonus: 25, icon: "shuffle", check: (s) => s.shuffleBlocks >= 3 },
  { id: "shuffle_5", title: "Rotazione stretta", desc: "Escludi 5 elementi dallo shuffle intelligente.", xpBonus: 40, icon: "shuffle", check: (s) => s.shuffleBlocks >= 5 },
  { id: "shuffle_10", title: "Random curato", desc: "Escludi 10 elementi dallo shuffle intelligente.", xpBonus: 60, icon: "shuffle", check: (s) => s.shuffleBlocks >= 10 },
  { id: "shuffle_25", title: "Maestro blacklist", desc: "Escludi 25 elementi dallo shuffle intelligente.", xpBonus: 90, icon: "shuffle", check: (s) => s.shuffleBlocks >= 25 },
  { id: "artist_plays_10", title: "Artista in ripetizione", desc: "10+ ascolti per un artista.", xpBonus: 35, icon: "artist", check: (s) => s.topArtistPlays >= 10 },
  { id: "artist_plays_25", title: "Superfan", desc: "25+ ascolti per un singolo artista.", xpBonus: 80, icon: "flame", check: (s) => s.topArtistPlays >= 25 },
  { id: "artist_plays_50", title: "Devoto", desc: "50+ ascolti per un artista.", xpBonus: 120, icon: "flame", check: (s) => s.topArtistPlays >= 50 },
  { id: "artist_plays_100", title: "Orecchie monogame", desc: "100+ ascolti per un artista.", xpBonus: 180, icon: "flame", check: (s) => s.topArtistPlays >= 100 },
  { id: "library_5pct", title: "Tuffo leggero", desc: "Riproduci almeno il 5% della libreria.", xpBonus: 40, icon: "library", check: (s) => libraryPctPlayed(s, 0.05) },
  { id: "library_10pct", title: "Sommergibile", desc: "Riproduci almeno il 10% della libreria.", xpBonus: 100, icon: "library", check: (s) => libraryPctPlayed(s, 0.1) },
  { id: "library_25pct", title: "Scaffale profondo", desc: "Riproduci almeno il 25% della libreria.", xpBonus: 160, icon: "library", check: (s) => libraryPctPlayed(s, 0.25) },
  { id: "library_50pct", title: "Metà caveau", desc: "Riproduci almeno il 50% della libreria.", xpBonus: 250, icon: "library", check: (s) => libraryPctPlayed(s, 0.5) },
  { id: "streak_3", title: "Impulso di tre giorni", desc: "Ascolta 3 giorni di fila.", xpBonus: 25, icon: "streak", check: (s) => s.streak >= 3 },
  { id: "streak_7", title: "Rituale settimanale", desc: "Ascolta 7 giorni di fila.", xpBonus: 50, icon: "streak", check: (s) => s.streak >= 7 },
  { id: "streak_14", title: "Fiamma quindicina", desc: "Ascolta 14 giorni di fila.", xpBonus: 90, icon: "streak", check: (s) => s.streak >= 14 },
  { id: "streak_30", title: "Serie mensile", desc: "Ascolta 30 giorni di fila.", xpBonus: 150, icon: "streak", check: (s) => s.streak >= 30 },
  { id: "plays_7500", title: "Rotazione infinita", desc: "7.500 riproduzioni totali.", xpBonus: 400, icon: "flame", check: (s) => s.totalPlays >= 7500 },
  { id: "favorites_200", title: "Costellazione", desc: "200 preferiti.", xpBonus: 200, icon: "heart", check: (s) => s.favoritesCount >= 200 },
  { id: "albums_10", title: "Salto tra album", desc: "Ascolta brani da 10 album diversi.", xpBonus: 55, icon: "library", check: (s) => s.albumsWithPlays >= 10 },
  { id: "albums_50", title: "Giro degli scaffali", desc: "Ascolta brani da 50 album diversi.", xpBonus: 110, icon: "library", check: (s) => s.albumsWithPlays >= 50 },
  { id: "playlist_tracks_30", title: "Mix lungo", desc: "30+ brani nelle tue playlist.", xpBonus: 85, icon: "list", check: (s) => s.playlistTrackCount >= 30 },
  { id: "track_plays_20", title: "Singolo in loop", desc: "20+ ascolti per un brano.", xpBonus: 70, icon: "play", check: (s) => s.topTrackPlays >= 20 },
  { id: "library_75pct", title: "Maestro del caveau", desc: "Riproduci almeno il 75% della libreria.", xpBonus: 320, icon: "library", check: (s) => libraryPctPlayed(s, 0.75) },
  { id: "plectr_tracks_10", title: "Novizio ai pad", desc: "Gioca a Plectr su 10 brani diversi.", xpBonus: 30, icon: "plectr", check: (s) => s.plectrTracksPlayed >= 10 },
  { id: "plectr_tracks_50", title: "Veterano della corsia", desc: "Gioca a Plectr su 50 brani diversi.", xpBonus: 55, icon: "plectr", check: (s) => s.plectrTracksPlayed >= 50 },
  { id: "plectr_tracks_100", title: "Crociere sulle chart", desc: "Gioca a Plectr su 100 brani diversi.", xpBonus: 85, icon: "plectr", check: (s) => s.plectrTracksPlayed >= 100 },
  { id: "plectr_tracks_250", title: "Maestro delle lane", desc: "Gioca a Plectr su 250 brani diversi.", xpBonus: 130, icon: "plectr", check: (s) => s.plectrTracksPlayed >= 250 },
  { id: "plectr_tracks_500", title: "Leggenda Plectr", desc: "Gioca a Plectr su 500 brani diversi.", xpBonus: 200, icon: "plectr", check: (s) => s.plectrTracksPlayed >= 500 },
];

const STREAK_KEY = "rekord-achievements-streak";

type StreakState = { count: number; lastDate: string };

function localDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function yesterdayKey(d = new Date()): string {
  const prev = new Date(d);
  prev.setDate(prev.getDate() - 1);
  return localDateKey(prev);
}

function readStreakState(): StreakState {
  try {
    const raw =
      localStorage.getItem(STREAK_KEY) ??
      localStorage.getItem("rekord-resonance-streak") ??
      localStorage.getItem("kord-achievements-streak");
    if (!raw) return { count: 0, lastDate: "" };
    const parsed = JSON.parse(raw) as Partial<StreakState>;
    return {
      count:
        typeof parsed.count === "number" && parsed.count >= 0
          ? Math.floor(parsed.count)
          : 0,
      lastDate: typeof parsed.lastDate === "string" ? parsed.lastDate : "",
    };
  } catch {
    return { count: 0, lastDate: "" };
  }
}

export function writeStreakState(state: { count: number; lastDate: string }) {
  const next: StreakState = {
    count:
      typeof state.count === "number" && state.count >= 0
        ? Math.floor(state.count)
        : 0,
    lastDate: typeof state.lastDate === "string" ? state.lastDate : "",
  };
  try {
    localStorage.setItem(STREAK_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  return next;
}

export function touchListeningActivity(at = new Date()): StreakState {
  const today = localDateKey(at);
  const prev = readStreakState();
  if (prev.lastDate === today) return prev;
  const next: StreakState = {
    lastDate: today,
    count: prev.lastDate === yesterdayKey(at) ? prev.count + 1 : 1,
  };
  return writeStreakState(next);
}

function effectiveStreakCount(stored: StreakState, at = new Date()): number {
  const today = localDateKey(at);
  if (stored.lastDate === today) return stored.count;
  if (stored.lastDate === yesterdayKey(at)) return stored.count;
  return 0;
}

export type TrackLike = {
  id: number;
  artist_name: string;
  album_id: number | null;
  album_name: string;
  rel_path: string;
  /** Serve a chi passa `genreForTrack`: il genere arriva dal brano, non dai segnali. */
  genre?: string | null;
};

export type AchievementsSnapshot = {
  signals: AchievementSignals;
  totalXp: number;
  level: { level: number; title: string; xpMin: number; xpMax: number };
  progress: { pct: number };
  achievements: {
    id: string;
    title: string;
    desc: string;
    xpBonus: number;
    icon: AchievementIconKind;
    unlocked: boolean;
  }[];
  streak: number;
};

export function buildAchievementsSnapshot(input: {
  playCounts: Record<string, number>;
  tracks: TrackLike[];
  favoritesCount: number;
  playlistsCount: number;
  playlistTrackCount: number;
  libraryTrackCount: number;
  shuffleBlocks: number;
  genreForTrack: (t: TrackLike) => string | null;
  plectrTracksPlayed?: number;
}): AchievementsSnapshot {
  const streak = effectiveStreakCount(readStreakState());
  const counts = input.playCounts;
  let totalPlays = 0;
  for (const n of Object.values(counts)) totalPlays += n;

  const artistPlayMap = new Map<string, number>();
  const genrePlayMap = new Map<string, number>();
  const albumsWithPlays = new Set<number | string>();
  let tracksWithPlays = 0;
  let topTrackPlays = 0;

  for (const tr of input.tracks) {
    const n = counts[tr.rel_path] ?? counts[String(tr.id)] ?? 0;
    if (n <= 0) continue;
    tracksWithPlays += 1;
    if (n > topTrackPlays) topTrackPlays = n;
    if (tr.album_id != null) albumsWithPlays.add(tr.album_id);
    else albumsWithPlays.add(`${tr.artist_name}/${tr.album_name}`);
    artistPlayMap.set(tr.artist_name, (artistPlayMap.get(tr.artist_name) ?? 0) + n);
    const g = input.genreForTrack(tr);
    if (g && g !== "Senza genere") {
      const key = g.toLowerCase();
      genrePlayMap.set(key, (genrePlayMap.get(key) ?? 0) + n);
    }
  }

  let topArtistPlays = 0;
  for (const n of artistPlayMap.values()) {
    if (n > topArtistPlays) topArtistPlays = n;
  }

  const signals: AchievementSignals = {
    totalPlays,
    favoritesCount: input.favoritesCount,
    playlistsCount: input.playlistsCount,
    artistsWithPlays: artistPlayMap.size,
    genresWithPlays: genrePlayMap.size,
    tracksWithPlays,
    shuffleBlocks: input.shuffleBlocks,
    libraryTrackCount: input.libraryTrackCount,
    topArtistPlays,
    topTrackPlays,
    albumsWithPlays: albumsWithPlays.size,
    playlistTrackCount: input.playlistTrackCount,
    streak,
    plectrTracksPlayed: input.plectrTracksPlayed ?? 0,
  };

  const baseXp =
    signals.totalPlays +
    signals.favoritesCount * 5 +
    signals.playlistsCount * 10 +
    signals.artistsWithPlays * 3 +
    signals.shuffleBlocks * 2;

  let achievementXp = 0;
  const achievements = DEFINITIONS.map((def) => {
    const unlocked = def.check(signals);
    if (unlocked) achievementXp += def.xpBonus;
    return {
      id: def.id,
      title: def.title,
      desc: def.desc,
      xpBonus: def.xpBonus,
      icon: def.icon,
      unlocked,
    };
  });

  const totalXp = baseXp + achievementXp;
  const levelNum = numericLevelForXp(totalXp);
  const xpMin = xpMinForNumericLevel(levelNum);
  const xpMax = xpMaxForNumericLevel(levelNum);
  const span = Math.max(1, xpMax - xpMin + 1);
  const current = Math.min(span, Math.max(0, totalXp - xpMin));
  const pct = Math.min(100, Math.max(0, Math.round((current / span) * 100)));

  return {
    signals,
    totalXp,
    level: {
      level: levelNum,
      title: titleForNumericLevel(levelNum),
      xpMin,
      xpMax,
    },
    progress: { pct },
    achievements,
    streak,
  };
}
