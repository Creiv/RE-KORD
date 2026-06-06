import type { CustomThemeBgImageFit } from "../types";

export const CUSTOM_THEME_BG_IMAGE_FITS: readonly CustomThemeBgImageFit[] = [
  "cover",
  "contain",
  "fill",
  "repeat",
  "center",
];

const FIT_CSS: Record<
  CustomThemeBgImageFit,
  { size: string; repeat: string; position: string }
> = {
  cover: { size: "cover", repeat: "no-repeat", position: "center" },
  contain: { size: "contain", repeat: "no-repeat", position: "center" },
  fill: { size: "100% 100%", repeat: "no-repeat", position: "center" },
  repeat: { size: "auto", repeat: "repeat", position: "top left" },
  center: { size: "auto", repeat: "no-repeat", position: "center center" },
};

export function normalizeCustomThemeBgImageFit(
  raw: unknown,
): CustomThemeBgImageFit {
  if (
    typeof raw === "string" &&
    (CUSTOM_THEME_BG_IMAGE_FITS as readonly string[]).includes(raw)
  ) {
    return raw as CustomThemeBgImageFit;
  }
  return "cover";
}

export function customThemeBgImageCss(fit: CustomThemeBgImageFit | undefined) {
  return FIT_CSS[normalizeCustomThemeBgImageFit(fit)];
}

export function applyCustomThemeBgImageCssVars(
  root: HTMLElement,
  fit: CustomThemeBgImageFit | undefined,
) {
  const css = customThemeBgImageCss(fit);
  root.style.setProperty("--page-bg-size", css.size);
  root.style.setProperty("--page-bg-repeat", css.repeat);
  root.style.setProperty("--page-bg-position", css.position);
}

export function clearCustomThemeBgImageCssVars(root: HTMLElement) {
  root.style.removeProperty("--page-bg-size");
  root.style.removeProperty("--page-bg-repeat");
  root.style.removeProperty("--page-bg-position");
}
