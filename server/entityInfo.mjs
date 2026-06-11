/**
 * Info e curiosità per artista e album — a voci multiple, per lingua.
 *
 * Storage locale nelle cartelle della libreria: per l'artista
 * kord-artistinfo.json ({ items, image }), per l'album la chiave `infoItems`
 * dentro kord-albuminfo.json. Ogni voce è { id, lang, title?, text, savedAt }
 * e il client mostra solo quelle nella lingua dell'interfaccia.
 *
 * La ricerca lavora in UNA lingua sola: trova la voce Wikipedia giusta
 * validandola col contesto musicale (niente "salmone atlantico" cercando
 * Salmo), poi estrae incipit + sezioni interessanti (vita privata, stile,
 * controversie, curiosità, produzione…) e aggiunge la biografia TheAudioDB
 * della stessa lingua. Foto artista scaricata in cartella (local-first).
 */
import fs from "fs/promises"
import path from "path"
import { existsSync } from "fs"
import { randomUUID } from "crypto"
import { withMetaMutation } from "./albumInfo.mjs"
import { hostnameBlockedForUpstreamImageFetch } from "./pathSafety.mjs"
import { atomicWriteFileUtf8 } from "./rekordDataStore.mjs"
import { rekordApiUserAgentWithUrl } from "./rekordVersion.mjs"

const FILE_ARTIST_INFO = "kord-artistinfo.json"
const FILE_ARTIST_IMAGE = "kord-artistinfo.jpg"
const FILE_ALBUM = "kord-albuminfo.json"
const FILE_ALBUM_WPP = "wpp-albuminfo.json"
const IMAGE_MAX_BYTES = 6 * 1024 * 1024

const ITEM_TEXT_MAX = 6000
const SECTION_TEXT_MAX = 1600
const MAX_ITEMS_PER_ENTITY = 40
const WEB_HEADERS = {
  "User-Agent": rekordApiUserAgentWithUrl(),
  Accept: "application/json",
}
const THEAUDIODB_KEY = () => process.env.THEAUDIODB_API_KEY || "2"

/* ------------------------------ storage ------------------------------ */

export function sanitizeEntityInfoItem(raw) {
  if (!raw || typeof raw !== "object") return null
  const text =
    typeof raw.text === "string" ? raw.text.trim().slice(0, ITEM_TEXT_MAX) : ""
  if (!text) return null
  const lang =
    typeof raw.lang === "string" && raw.lang.trim()
      ? raw.lang.trim().toLowerCase().slice(0, 8)
      : "it"
  const out = {
    id:
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim().slice(0, 64)
        : randomUUID(),
    lang,
    text,
  }
  const title =
    typeof raw.title === "string" ? raw.title.trim().slice(0, 200) : ""
  if (title) out.title = title
  out.savedAt =
    typeof raw.savedAt === "string" && raw.savedAt.trim()
      ? raw.savedAt
      : new Date().toISOString()
  return out
}

function sanitizeItemsList(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const row of raw) {
    const item = sanitizeEntityInfoItem(row)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
    if (out.length >= MAX_ITEMS_PER_ENTITY) break
  }
  return out
}

/** Chiave anti-doppione: lingua + testo normalizzato. */
function itemDedupeKey(item) {
  return `${item.lang}\0${normalizeName(item.text).slice(0, 140)}`
}

/** Tollera il formato iniziale a voce singola (`info: {...}`). */
function itemsFromLegacy(j) {
  const single = j?.info
  if (!single || typeof single !== "object") return []
  const item = sanitizeEntityInfoItem(single)
  return item ? [item] : []
}

async function readJsonFile(fp) {
  if (!existsSync(fp)) return null
  try {
    const raw = await fs.readFile(fp, "utf8")
    const j = JSON.parse(raw)
    return j && typeof j === "object" ? j : null
  } catch {
    return null
  }
}

export async function loadArtistInfoBundle(artistDir) {
  const j = await readJsonFile(path.join(artistDir, FILE_ARTIST_INFO))
  const items = j
    ? [...sanitizeItemsList(j.items), ...itemsFromLegacy(j)]
    : []
  const image =
    typeof j?.image === "string" &&
    j.image.trim() &&
    !j.image.includes("/") &&
    !j.image.includes("\\")
      ? j.image.trim()
      : null
  return { items: items.slice(0, MAX_ITEMS_PER_ENTITY), image }
}

/**
 * Aggiunge/rimuove voci artista; `imageFile` (se presente) viene registrata.
 * Con zero voci residue il file (e la foto) vengono eliminati.
 */
export async function mutateArtistInfo(artistDir, { add, removeIds, imageFile }) {
  const fp = path.join(artistDir, FILE_ARTIST_INFO)
  return withMetaMutation(fp, async () => {
    const prev = await loadArtistInfoBundle(artistDir)
    const removeSet = new Set(Array.isArray(removeIds) ? removeIds : [])
    const items = prev.items.filter((it) => !removeSet.has(it.id))
    const have = new Set(items.map(itemDedupeKey))
    for (const raw of Array.isArray(add) ? add : []) {
      const item = sanitizeEntityInfoItem({ ...raw, id: null })
      if (!item || items.length >= MAX_ITEMS_PER_ENTITY) continue
      const k = itemDedupeKey(item)
      if (have.has(k)) continue
      have.add(k)
      items.push(item)
    }
    const image = imageFile || prev.image || null
    if (!items.length) {
      if (existsSync(fp)) await fs.rm(fp, { force: true })
      const img = path.join(artistDir, FILE_ARTIST_IMAGE)
      if (existsSync(img)) await fs.rm(img, { force: true })
      return { items: [], image: null }
    }
    await atomicWriteFileUtf8(
      fp,
      JSON.stringify(
        { items, ...(image ? { image } : {}), editedAt: new Date().toISOString() },
        null,
        2
      )
    )
    return { items, image }
  })
}

function pickAlbumMetaReadPath(albumDir) {
  const k = path.join(albumDir, FILE_ALBUM)
  const w = path.join(albumDir, FILE_ALBUM_WPP)
  if (existsSync(k)) return k
  if (existsSync(w)) return w
  return k
}

export async function loadAlbumInfoItems(albumDir) {
  const j = await readJsonFile(pickAlbumMetaReadPath(albumDir))
  if (!j) return []
  return [...sanitizeItemsList(j.infoItems), ...itemsFromLegacy(j)].slice(
    0,
    MAX_ITEMS_PER_ENTITY
  )
}

export async function mutateAlbumInfo(albumDir, { add, removeIds }) {
  const writePath = path.join(albumDir, FILE_ALBUM)
  return withMetaMutation(writePath, async () => {
    const existing = (await readJsonFile(pickAlbumMetaReadPath(albumDir))) || {}
    const prevItems = [
      ...sanitizeItemsList(existing.infoItems),
      ...itemsFromLegacy(existing),
    ]
    delete existing.info
    const removeSet = new Set(Array.isArray(removeIds) ? removeIds : [])
    const items = prevItems.filter((it) => !removeSet.has(it.id))
    const have = new Set(items.map(itemDedupeKey))
    for (const raw of Array.isArray(add) ? add : []) {
      const item = sanitizeEntityInfoItem({ ...raw, id: null })
      if (!item || items.length >= MAX_ITEMS_PER_ENTITY) continue
      const k = itemDedupeKey(item)
      if (have.has(k)) continue
      have.add(k)
      items.push(item)
    }
    if (items.length) existing.infoItems = items
    else delete existing.infoItems
    existing.editedAt = new Date().toISOString()
    await atomicWriteFileUtf8(writePath, JSON.stringify(existing, null, 2))
    return items
  })
}

/**
 * Scarica la foto artista nella cartella (kord-artistinfo.jpg, local-first:
 * il dialog la legge da /media, funziona offline e finisce nel backup).
 */
export async function downloadArtistImage(artistDir, imageUrl) {
  const raw = String(imageUrl || "").trim()
  if (!/^https?:\/\//i.test(raw)) return null
  try {
    const u = new URL(raw)
    if (hostnameBlockedForUpstreamImageFetch(u.hostname)) return null
    const r = await fetch(u, {
      headers: { "User-Agent": WEB_HEADERS["User-Agent"] },
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) return null
    const ctype = String(r.headers.get("content-type") || "")
    if (!ctype.startsWith("image/")) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (!buf.length || buf.length > IMAGE_MAX_BYTES) return null
    await fs.writeFile(path.join(artistDir, FILE_ARTIST_IMAGE), buf)
    return FILE_ARTIST_IMAGE
  } catch {
    return null
  }
}

/* ------------------------------ ricerca ------------------------------ */

const MUSIC_RE = {
  it: /(musicist|rapper|cantant|cantautor|gruppo musical|band|discografi|album|singol|produttore discografic|\bdj\b|chitarrist|polistrumentist)/i,
  en: /(musician|rapper|singer|songwriter|band|discograph|album|single|record producer|\bdj\b|guitarist|hip.hop)/i,
}

const MUSIC_HINT = { it: "musica", en: "music" }

const SECTION_PRIORITY = {
  it: [
    /curiosit|aneddot/i,
    /vita privata/i,
    /controversi|polemich/i,
    /origine del nome|nome d'arte|pseudonimo/i,
    /stile|influenz/i,
    /produzione|registrazione/i,
    /accoglienza|critica/i,
    /tematich|concept/i,
    /riconoscim|premi/i,
    /eredità|impatto/i,
  ],
  en: [
    /trivia|did you know/i,
    /personal life/i,
    /controvers/i,
    /name|etymology/i,
    /style|influence/i,
    /production|recording/i,
    /reception|critical/i,
    /themes|composition|concept/i,
    /accolade|award/i,
    /legacy|impact/i,
  ],
}

async function webJson(url) {
  try {
    const r = await fetch(url, {
      headers: WEB_HEADERS,
      signal: AbortSignal.timeout(12000),
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

async function wikiSearchTitles(lang, query, limit) {
  const u =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&srprop=&format=json`
  const j = await webJson(u)
  const rows = j?.query?.search
  return Array.isArray(rows)
    ? rows.map((s) => String(s?.title || "").trim()).filter(Boolean)
    : []
}

/** Incipit completo in testo semplice + thumbnail della voce. */
async function wikiIntroExtract(lang, title) {
  const u =
    `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageimages` +
    `&exintro=1&explaintext=1&redirects=1&piprop=thumbnail&pithumbsize=600` +
    `&format=json&titles=${encodeURIComponent(title)}`
  const j = await webJson(u)
  const pages = j?.query?.pages
  if (!pages || typeof pages !== "object") return null
  const page = Object.values(pages)[0]
  const extract = typeof page?.extract === "string" ? page.extract.trim() : ""
  if (!extract) return null
  return {
    title: String(page.title || title),
    extract: extract.slice(0, ITEM_TEXT_MAX),
    thumbnail:
      typeof page?.thumbnail?.source === "string"
        ? page.thumbnail.source
        : null,
  }
}

/** Wikitext → testo leggibile (rimozione grezza di template, ref, link). */
function stripWikitext(raw) {
  let s = String(raw || "")
  s = s.replace(/<ref[^>]*\/>/gi, "")
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
  s = s.replace(/<!--[\s\S]*?-->/g, "")
  for (let i = 0; i < 6 && s.includes("{{"); i += 1) {
    s = s.replace(/\{\{[^{}]*\}\}/g, "")
  }
  s = s.replace(/\[\[(?:File|Image|Immagine):[^\]]*\]\]/gi, "")
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
  s = s.replace(/\[\[([^\]]*)\]\]/g, "$1")
  s = s.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1")
  s = s.replace(/'{2,}/g, "")
  s = s.replace(/^=+.*=+\s*$/gm, "")
  s = s.replace(/^\s*[*#:;]+\s*/gm, "• ")
  s = s.replace(/<[^>]+>/g, "")
  s = s.replace(/\n{3,}/g, "\n\n").trim()
  return s
}

/** Taglia a fine frase entro `max` caratteri. */
function capAtSentence(text, max) {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  const cut = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf(".\n"),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? ")
  )
  return cut > max * 0.4 ? slice.slice(0, cut + 1) : slice
}

async function wikiSectionsList(lang, title) {
  const u =
    `https://${lang}.wikipedia.org/w/api.php?action=parse&prop=sections` +
    `&redirects=1&format=json&page=${encodeURIComponent(title)}`
  const j = await webJson(u)
  const sections = j?.parse?.sections
  return Array.isArray(sections) ? sections : []
}

async function wikiSectionText(lang, title, index) {
  const u =
    `https://${lang}.wikipedia.org/w/api.php?action=parse&prop=wikitext` +
    `&redirects=1&format=json&page=${encodeURIComponent(title)}` +
    `&section=${encodeURIComponent(String(index))}`
  const j = await webJson(u)
  const text = stripWikitext(j?.parse?.wikitext?.["*"])
  if (!text || text.length < 60) return null
  return capAtSentence(text, SECTION_TEXT_MAX)
}

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Trova la voce Wikipedia giusta: tra i risultati di ricerca passa solo la
 * prima pagina il cui incipit ha contesto musicale (o cita l'artista).
 */
async function wikiFindMusicPage(lang, { artist, album }) {
  const queries = album
    ? [`${album} ${artist}`, `${album} album ${artist}`]
    : [`${artist} ${MUSIC_HINT[lang]}`, artist]
  const seen = new Set()
  const titles = []
  for (const q of queries) {
    for (const title of await wikiSearchTitles(lang, q, 4)) {
      const key = title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      titles.push(title)
    }
    if (titles.length >= 6) break
  }
  const artistNorm = normalizeName(artist)
  for (const title of titles.slice(0, 6)) {
    const intro = await wikiIntroExtract(lang, title)
    if (!intro) continue
    const extractNorm = normalizeName(intro.extract)
    const musical = MUSIC_RE[lang].test(intro.extract)
    const mentionsArtist = artistNorm && extractNorm.includes(artistNorm)
    if (musical || (album && mentionsArtist)) return { ...intro, pageTitle: title }
  }
  return null
}

/**
 * Voci candidate per artista o album, in UNA lingua: incipit + sezioni
 * interessanti della voce Wikipedia validata + biografia/descrizione
 * TheAudioDB della stessa lingua. Ogni candidato è selezionabile a parte.
 */
export async function searchEntityInfoSources({
  artist,
  album,
  lang: rawLang,
  maxCandidates = 7,
}) {
  const art = String(artist || "").trim()
  if (!art) return []
  const alb = String(album || "").trim()
  const lang = rawLang === "en" ? "en" : "it"

  const out = []
  const seen = new Set()
  const push = (cand) => {
    const key = normalizeName(cand.text).slice(0, 120)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(cand)
  }

  let pageThumb = null
  const page = await wikiFindMusicPage(lang, { artist: art, album: alb || null })
  if (page) {
    pageThumb = page.thumbnail
    push({
      kind: alb ? "desc" : "bio",
      lang,
      title: page.title,
      text: page.extract,
      thumbnail: page.thumbnail,
    })
    const sections = await wikiSectionsList(lang, page.pageTitle)
    const used = new Set()
    for (const re of SECTION_PRIORITY[lang]) {
      if (out.length >= maxCandidates) break
      const hit = sections.find(
        (s) => !used.has(s?.index) && re.test(String(s?.line || ""))
      )
      if (!hit?.index) continue
      used.add(hit.index)
      const text = await wikiSectionText(lang, page.pageTitle, hit.index)
      if (!text) continue
      push({
        kind: /curiosit|aneddot|trivia|did you know/i.test(String(hit.line))
          ? "trivia"
          : "section",
        lang,
        title: String(hit.line || "").trim(),
        text,
        thumbnail: pageThumb,
      })
    }
  }

  if (!alb) {
    const quotes = await wikiquoteArtistQuotes(lang, art)
    if (quotes) {
      push({
        kind: "trivia",
        lang,
        title: lang === "it" ? "Citazioni" : "Quotes",
        text: quotes,
        thumbnail: pageThumb,
      })
    }
  }

  const lfm = await lastfmInfo(lang, art, alb || null)
  if (lfm) {
    push({
      kind: alb ? "desc" : "bio",
      lang,
      title: null,
      text: lfm,
      thumbnail: pageThumb,
    })
  }

  const adb = alb
    ? await audiodbAlbumDesc(art, alb, lang)
    : await audiodbArtistBio(art, lang)
  if (adb?.text) {
    push({
      kind: alb ? "desc" : "bio",
      lang,
      title: null,
      text: capAtSentence(adb.text, ITEM_TEXT_MAX),
      thumbnail: adb.thumb ?? pageThumb,
    })
  }
  if (!alb) {
    const bestThumb = adb?.thumb || pageThumb || null
    if (bestThumb) {
      for (const c of out) if (!c.thumbnail) c.thumbnail = bestThumb
    }
  }
  return out.slice(0, maxCandidates)
}

/**
 * Citazioni dell'artista da Wikiquote (stessa lingua): un'unica voce
 * "Citazioni" con le frasi più riconoscibili — materiale da vera curiosità.
 */
async function wikiquoteArtistQuotes(lang, artist) {
  const base = `https://${lang}.wikiquote.org/w/api.php`
  const js = await webJson(
    `${base}?action=query&list=search&srsearch=${encodeURIComponent(artist)}` +
      `&srlimit=3&srprop=&format=json`
  )
  const rows = Array.isArray(js?.query?.search) ? js.query.search : []
  const artistNorm = normalizeName(artist)
  const hit = rows.find((s) => {
    const t = normalizeName(s?.title)
    return t === artistNorm || t.includes(artistNorm)
  })
  if (!hit?.title) return null
  const jx = await webJson(
    `${base}?action=query&prop=extracts&explaintext=1&redirects=1&format=json` +
      `&titles=${encodeURIComponent(hit.title)}`
  )
  const pages = jx?.query?.pages
  const extract =
    pages && typeof pages === "object"
      ? String(Object.values(pages)[0]?.extract || "")
      : ""
  if (!extract) return null
  // La testa della pagina descrive la persona: dev'essere un musicista
  // (evita omonimi, es. i salmi biblici cercando "Salmo").
  if (!MUSIC_RE[lang].test(extract.slice(0, 600))) return null
  const quotes = extract
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length >= 40 &&
        l.length <= 320 &&
        !/^==|^Altri progetti|^Note|^Bibliografia|^Voci correlate|^External|^See also|^References/i.test(
          l
        )
    )
    .slice(0, 8)
  if (quotes.length < 2) return null
  return quotes.map((q) => `• ${q}`).join("\n")
}

const LASTFM_KEY = () => process.env.LASTFM_API_KEY || ""

/** Bio/descrizione Last.fm nella lingua richiesta (richiede LASTFM_API_KEY). */
async function lastfmInfo(lang, artist, album) {
  const key = LASTFM_KEY()
  if (!key) return null
  const base = "https://ws.audioscrobbler.com/2.0/"
  const common = `&api_key=${encodeURIComponent(key)}&format=json&lang=${lang}`
  const u = album
    ? `${base}?method=album.getinfo&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}${common}`
    : `${base}?method=artist.getinfo&artist=${encodeURIComponent(artist)}${common}`
  const j = await webJson(u)
  const content = album
    ? j?.album?.wiki?.content
    : j?.artist?.bio?.content
  let text = typeof content === "string" ? content : ""
  text = text
    .replace(/<a href[^>]*>.*?<\/a>\.?/gis, "")
    .replace(/<[^>]+>/g, "")
    .replace(/Read more on Last\.fm.*$/is, "")
    .trim()
  return text.length >= 80 ? capAtSentence(text, ITEM_TEXT_MAX) : null
}

function audiodbField(row, base, lang) {
  const suffix = lang === "it" ? "IT" : "EN"
  const v = row?.[`${base}${suffix}`]
  const s = typeof v === "string" ? v.trim() : ""
  return s || null
}

async function audiodbArtistBio(artist, lang) {
  const u = `https://www.theaudiodb.com/api/v1/json/${THEAUDIODB_KEY()}/search.php?s=${encodeURIComponent(artist)}`
  const j = await webJson(u)
  const row = Array.isArray(j?.artists) ? j.artists[0] : null
  if (!row) return null
  const text = audiodbField(row, "strBiography", lang)
  const thumb =
    typeof row.strArtistThumb === "string" && row.strArtistThumb.trim()
      ? row.strArtistThumb.trim()
      : null
  if (!text && !thumb) return null
  return { text, thumb }
}

async function audiodbAlbumDesc(artist, album, lang) {
  const u =
    `https://www.theaudiodb.com/api/v1/json/${THEAUDIODB_KEY()}/searchalbum.php` +
    `?s=${encodeURIComponent(artist)}&a=${encodeURIComponent(album)}`
  const j = await webJson(u)
  const row = Array.isArray(j?.album) ? j.album[0] : null
  if (!row) return null
  const text = audiodbField(row, "strDescription", lang)
  return text ? { text, thumb: null } : null
}
