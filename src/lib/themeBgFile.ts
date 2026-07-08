const THEME_BG_MIME = /^image\/(jpeg|png|webp|gif)$/i;
const THEME_BG_EXT = /\.(jpe?g|png|webp|gif)$/i;

/** Allineato a server/customThemeBg.mjs THEME_BG_MAX_BYTES */
export const THEME_BG_MAX_BYTES = 32 * 1024 * 1024;
export const THEME_BG_MAX_MB = THEME_BG_MAX_BYTES / (1024 * 1024);

/** Accetta MIME o estensione (alcuni browser lasciano type vuoto sulle GIF). */
export function isAllowedThemeBgFile(file: File): boolean {
  if (THEME_BG_MIME.test(file.type)) return true;
  return THEME_BG_EXT.test(file.name);
}

export type ThemeBgFileValidation = "ok" | "type" | "size";

export function validateThemeBgFile(file: File): ThemeBgFileValidation {
  if (!isAllowedThemeBgFile(file)) return "type";
  if (file.size > THEME_BG_MAX_BYTES) return "size";
  return "ok";
}

export function themeBgAcceptAttribute(): string {
  return "image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif";
}
