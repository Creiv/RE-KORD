/** Verifica runtime se backdrop-filter: blur() produce un effetto visibile. */
export async function probeGlassBackdrop(): Promise<boolean> {
  if (typeof document === "undefined") return true;
  if (!CSS.supports("backdrop-filter", "blur(2px)")) return false;
  if (window.matchMedia("(prefers-reduced-transparency: reduce)").matches) {
    return false;
  }

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-9999px;top:0;width:80px;height:80px;pointer-events:none;opacity:1;z-index:-1;";

  const bg = document.createElement("div");
  bg.style.cssText =
    "position:absolute;inset:0;background:linear-gradient(90deg,#000 0 50%,#fff 50% 100%);";

  const glass = document.createElement("div");
  glass.style.cssText =
    "position:absolute;inset:12px;background:rgba(127,127,127,0.02);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);";

  host.appendChild(bg);
  host.appendChild(glass);
  document.body.appendChild(host);

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  try {
    const bitmap = await createImageBitmap(glass as unknown as ImageBitmapSource);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(
      Math.floor(bitmap.width / 2),
      Math.floor(bitmap.height / 2),
      1,
      1,
    );
    const [r, g, b] = data;
    return (
      r > 35 &&
      r < 220 &&
      g > 35 &&
      g < 220 &&
      b > 35 &&
      b < 220 &&
      Math.abs(r - g) < 30 &&
      Math.abs(g - b) < 30
    );
  } catch {
    return false;
  } finally {
    host.remove();
  }
}
