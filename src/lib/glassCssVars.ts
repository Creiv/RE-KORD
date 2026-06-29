import {
  mixSrgbColors,
  mixSrgbWithTransparent,
  parseCssColor,
  type Rgba,
} from "./cssColorMix";

const GLASS_VARS = [
  "--glass-panel",
  "--glass-panel-deep",
  "--glass-panel-muted",
  "--glass-shine",
  "--glass-shine-soft",
  "--glass-edge",
  "--glass-fill-main",
  "--glass-fill-muted",
  "--glass-fill-page",
  "--glass-fill-accent-band",
] as const;

export function clearGlassSurfaceCssVars(root: HTMLElement): void {
  for (const name of GLASS_VARS) root.style.removeProperty(name);
}

function isLightGlassTheme(root: HTMLElement): boolean {
  const theme = root.dataset.theme ?? "";
  if (theme.endsWith("-light")) return true;
  return getComputedStyle(root).colorScheme === "light";
}

export function applyGlassSurfaceCssVars(
  root: HTMLElement,
  glassOpacityPercent: number,
): void {
  const cs = getComputedStyle(root);
  const glass1 = parseCssColor(cs.getPropertyValue("--glass-1").trim());
  const glass2 = parseCssColor(cs.getPropertyValue("--glass-2").trim());
  const border = parseCssColor(cs.getPropertyValue("--border").trim());
  const accent = parseCssColor(cs.getPropertyValue("--accent").trim());
  const accent2 = parseCssColor(cs.getPropertyValue("--accent2").trim());
  if (!glass1 || !glass2 || !border) return;

  const userPct = Math.min(100, Math.max(0, glassOpacityPercent));
  const panel = mixSrgbWithTransparent(glass1, userPct);
  const panelDeep = mixSrgbWithTransparent(glass2, Math.max(0, userPct - 10));
  const panelMuted = mixSrgbWithTransparent(glass1, Math.max(0, userPct - 14));
  const panelRgb = parseCssColor(panel);
  const panelDeepRgb = parseCssColor(panelDeep);
  if (!panelRgb || !panelDeepRgb) return;

  const light = isLightGlassTheme(root);
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  const transparent: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  const shine = mixSrgbColors(white, light ? 48 : 22, transparent, light ? 52 : 78);
  const shineSoft = mixSrgbColors(
    white,
    light ? 22 : 9,
    transparent,
    light ? 78 : 91,
  );
  const edge = mixSrgbColors(border, 78, transparent, 22);
  const shineRgb = parseCssColor(shine);
  if (!shineRgb) return;

  const fillMain = `linear-gradient(145deg, ${mixSrgbColors(shineRgb, 55, panelRgb, 45)} 0%, ${panel} 38%, ${panelDeep} 100%)`;

  root.style.setProperty("--glass-panel", panel);
  root.style.setProperty("--glass-panel-deep", panelDeep);
  root.style.setProperty("--glass-panel-muted", panelMuted);
  root.style.setProperty("--glass-shine", shine);
  root.style.setProperty("--glass-shine-soft", shineSoft);
  root.style.setProperty("--glass-edge", edge);
  root.style.setProperty("--glass-fill-main", fillMain);
  root.style.setProperty("--glass-fill-muted", panelMuted);
  root.style.setProperty("--glass-fill-page", fillMain);

  if (accent && accent2) {
    const accentBand = [
      `radial-gradient(ellipse 85% 140% at 0% 50%, ${mixSrgbColors(accent, 14, panelRgb, 86)} 0%, transparent 52%)`,
      `radial-gradient(ellipse 75% 130% at 100% 50%, ${mixSrgbColors(accent2, 10, panelRgb, 90)} 0%, transparent 48%)`,
      `linear-gradient(145deg, ${mixSrgbColors(shineRgb, 45, panelRgb, 55)} 0%, ${panel} 42%, ${panelDeep} 100%)`,
    ].join(", ");
    root.style.setProperty("--glass-fill-accent-band", accentBand);
  } else {
    root.style.setProperty("--glass-fill-accent-band", fillMain);
  }
}
