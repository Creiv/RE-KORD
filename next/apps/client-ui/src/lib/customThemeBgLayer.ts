import {
  applyCustomThemeBgObjectFitCssVars,
  clearCustomThemeBgObjectFitCssVars,
  objectFitForBgImageFit,
  type CustomThemeBgImageFit,
} from "./customThemeBgFit";

const BG_IMG_ID = "rekord-custom-theme-bg-img";

export function applyAnimatedCustomThemeBg(
  root: HTMLElement,
  url: string,
  fit: CustomThemeBgImageFit | undefined,
) {
  const { useCssBackground } = objectFitForBgImageFit(fit);
  if (useCssBackground) {
    clearAnimatedCustomThemeBg(root);
    root.dataset.customBgGifRepeat = "1";
    return;
  }
  delete root.dataset.customBgGifRepeat;

  let img = document.getElementById(BG_IMG_ID) as HTMLImageElement | null;
  if (!img) {
    img = document.createElement("img");
    img.id = BG_IMG_ID;
    img.className = "rekord-custom-theme-bg-img";
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    img.decoding = "async";
    document.documentElement.insertBefore(img, document.body);
  }
  if (img.src !== url) img.src = url;
  applyCustomThemeBgObjectFitCssVars(root, fit);
  root.dataset.customBgGif = "1";
}

export function clearAnimatedCustomThemeBg(root: HTMLElement) {
  document.getElementById(BG_IMG_ID)?.remove();
  delete root.dataset.customBgGif;
  delete root.dataset.customBgGifRepeat;
  clearCustomThemeBgObjectFitCssVars(root);
}
