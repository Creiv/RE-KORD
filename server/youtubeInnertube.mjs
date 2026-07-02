/**
 * Costanti Innertube (YouTube Music) condivise: chiave API pubblica web,
 * endpoint browse/search e versione client (override via env).
 */
export const YTM_INNERTUBE_KEY = "AIzaSyC9XL3QWnjsQplBUbSJY1cffBoVwD0aN1U"
export const YTM_BROWSE_URL = `https://music.youtube.com/youtubei/v1/browse?key=${YTM_INNERTUBE_KEY}`
export const YTM_SEARCH_URL = `https://music.youtube.com/youtubei/v1/search?key=${YTM_INNERTUBE_KEY}`

export function innertubeClientVersion() {
  return String(
    process.env.REKORD_YTM_INNERTUBE_CLIENT_VERSION || "1.20241127.01.00",
  ).trim()
}
