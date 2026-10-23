/**
 * Share card: a 1080×1350 PNG of a run laid out like the results screen
 * (GitHub issue #100: the picture used to be its own design), saved through
 * a download link.
 */
import { fmtNumber, i18n, t } from "../i18n.svelte";
import { JUDGE_COLORS, STAGE_BG } from "./config";
import type { DifficultyId, GameResult } from "./types";

export type ShareCardData = {
  title: string;
  artist: string;
  difficulty: DifficultyId;
  result: GameResult;
  fc: boolean;
  ap: boolean;
  newRecord: boolean;
  /** The results screen's breakdown; when present the card shows the same rows. */
  perfects?: number;
  goods?: number;
  earlies?: number;
  lates?: number;
  judged?: number;
  notesHit?: number;
  previous?: GameResult | null;
};

const W = 1080;
const H = 1350;

/** Same values as `--plectr-grade-*` in plectr.css. */
const GRADE_COLORS: Record<string, string> = {
  S: "#fde047",
  A: "#46e7ff",
  B: "#4ade80",
  C: "#fbbf24",
  D: "#f87171",
  F: "#f87171",
};

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * The card laid out like the results screen (`RunResults.svelte`), without
 * its buttons: cover and eyebrow, title and artist, grade stamp next to the
 * score with the record ribbon (or the previous best) and the FC / AP badge,
 * the accuracy ring with max combo and notes hit, then the judgement bar and
 * its legend. 1080×1350, portrait, ready for a story.
 */
export function renderShareCard(data: ShareCardData, art: CanvasImageSource | null): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const r = data.result;
  const font = (weight: number, size: number, italic = false) =>
    `${italic ? "italic " : ""}${weight} ${size}px Inter, system-ui, sans-serif`;
  const muted = (a: number) => `rgba(255,255,255,${a})`;

  // Stage background with the cover washed behind, as on the results overlay.
  ctx.fillStyle = STAGE_BG;
  ctx.fillRect(0, 0, W, H);
  if (art) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.filter = "blur(40px)";
    ctx.drawImage(art, -H * 0.15, -H * 0.15, H * 1.3, H * 1.3);
    ctx.restore();
  }
  const veil = ctx.createLinearGradient(0, 0, 0, H);
  veil.addColorStop(0, "rgba(6,8,15,0.55)");
  veil.addColorStop(1, "rgba(6,8,15,0.92)");
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, W, H);

  // Card.
  const PAD = 72;
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  roundRect(ctx, PAD - 24, 96, W - (PAD - 24) * 2, H - 192, 36);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Header: cover, eyebrow, title, artist.
  const ART = 168;
  let y = 150;
  if (art) {
    ctx.save();
    roundRect(ctx, PAD, y, ART, ART, 20);
    ctx.clip();
    ctx.drawImage(art, PAD, y, ART, ART);
    ctx.restore();
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    roundRect(ctx, PAD, y, ART, ART, 20);
    ctx.fill();
  }
  const tx = PAD + ART + 36;
  const tw = W - PAD - tx;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = muted(0.65);
  ctx.font = font(700, 30);
  const eyebrow = `${r.failed ? t("plectr.results.failed") : t("plectr.results.complete")} · ${t(`plectr.diff.${data.difficulty}`)}`;
  ctx.fillText(fitText(ctx, eyebrow.toUpperCase(), tw), tx, y + 44);
  ctx.fillStyle = "#ffffff";
  ctx.font = font(800, 56);
  ctx.fillText(fitText(ctx, data.title, tw), tx, y + 112);
  ctx.fillStyle = muted(0.7);
  ctx.font = font(600, 36);
  ctx.fillText(fitText(ctx, data.artist, tw), tx, y + 160);

  // Hero: grade stamp, score, ribbon or previous best, badge.
  y = 420;
  ctx.fillStyle = GRADE_COLORS[r.grade] ?? "#ffffff";
  ctx.font = font(900, 300, true);
  ctx.fillText(r.grade, PAD - 6, y + 250);
  const sx = PAD + 300;
  ctx.fillStyle = "#ffffff";
  ctx.font = font(800, 104);
  ctx.fillText(fitText(ctx, fmtNumber(r.score), W - PAD - sx), sx, y + 150);
  ctx.font = font(600, 34);
  if (data.newRecord) {
    ctx.fillStyle = GRADE_COLORS.S;
    ctx.fillText(`★ ${t("plectr.results.newRecord")}`, sx, y + 205);
  } else if (data.previous) {
    ctx.fillStyle = muted(0.6);
    ctx.fillText(
      fitText(
        ctx,
        t("plectr.results.previousBest", { score: fmtNumber(data.previous.score), grade: data.previous.grade }),
        W - PAD - sx,
      ),
      sx,
      y + 205,
    );
  }
  if (data.ap || data.fc) {
    const label = data.ap ? t("plectr.results.allPerfect") : t("plectr.results.fullCombo");
    ctx.font = font(800, 30);
    const bw = ctx.measureText(label).width + 48;
    ctx.fillStyle = data.ap ? JUDGE_COLORS.perfect : JUDGE_COLORS.good;
    roundRect(ctx, sx, y + 232, bw, 54, 27);
    ctx.fill();
    ctx.fillStyle = STAGE_BG;
    ctx.fillText(label, sx + 24, y + 269);
  }

  // Metrics: accuracy ring, max combo, notes hit.
  y = 790;
  const RX = PAD + 100;
  const RY = y + 100;
  const RR = 88;
  ctx.lineWidth = 14;
  ctx.lineCap = "round";
  ctx.strokeStyle = muted(0.1);
  ctx.beginPath();
  ctx.arc(RX, RY, RR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = JUDGE_COLORS.perfect;
  ctx.beginPath();
  ctx.arc(RX, RY, RR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, r.accuracy)));
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = font(800, 44);
  const acc = `${Math.round(r.accuracy * 1000) / 10}%`;
  ctx.fillText(acc, RX, RY + 8);
  ctx.fillStyle = muted(0.6);
  ctx.font = font(600, 24);
  ctx.fillText(t("plectr.results.accuracy"), RX, RY + 42);
  ctx.textAlign = "left";
  const facts: [string, string][] = [[t("plectr.results.maxCombo"), `×${r.maxCombo}`]];
  if (data.judged != null && data.notesHit != null) {
    facts.push([
      t("plectr.results.notesJudged"),
      t("plectr.results.notesValue", { hit: data.notesHit, total: data.judged }),
    ]);
  } else {
    facts.push([t("plectr.results.miss"), String(r.misses)]);
  }
  facts.forEach(([label, value], i) => {
    const fx = RX + RR + 70 + i * 330;
    ctx.fillStyle = muted(0.6);
    ctx.font = font(600, 30);
    ctx.fillText(label, fx, RY - 20);
    ctx.fillStyle = "#ffffff";
    ctx.font = font(800, 64);
    ctx.fillText(value, fx, RY + 50);
  });

  // Judgement bar and legend, when the breakdown is known.
  y = 1030;
  const timing = (data.earlies ?? 0) + (data.lates ?? 0);
  const parts: [string, number][] = [
    [JUDGE_COLORS.perfect, data.perfects ?? 0],
    [JUDGE_COLORS.good, data.goods ?? 0],
    [JUDGE_COLORS.timing, timing],
    [JUDGE_COLORS.miss, r.misses],
  ];
  const total = parts.reduce((n, [, k]) => n + k, 0);
  if ((data.judged ?? 0) > 0 && total > 0) {
    let x = PAD;
    const bw = W - PAD * 2;
    for (const [color, n] of parts) {
      if (n <= 0) continue;
      const w = (bw * n) / total;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, Math.max(w - 3, 2), 22);
      x += w;
    }
    const legend: [string, string, string][] = [
      [JUDGE_COLORS.perfect, t("plectr.results.perfect"), String(data.perfects ?? 0)],
      [JUDGE_COLORS.good, t("plectr.results.good"), String(data.goods ?? 0)],
      [JUDGE_COLORS.timing, t("plectr.results.earlyLate"), `${data.earlies ?? 0}/${data.lates ?? 0}`],
      [JUDGE_COLORS.miss, t("plectr.results.miss"), String(r.misses)],
    ];
    legend.forEach(([color, label, value], i) => {
      const lx = PAD + i * ((W - PAD * 2) / 4);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(lx + 10, y + 70, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = muted(0.65);
      ctx.font = font(600, 26);
      ctx.fillText(label, lx + 32, y + 79);
      ctx.fillStyle = "#ffffff";
      ctx.font = font(800, 30);
      ctx.fillText(value, lx + 32, y + 118);
    });
  }

  // Footer.
  ctx.fillStyle = muted(0.45);
  ctx.font = font(700, 28);
  ctx.fillText("PLECTR · RE-KORD", PAD, H - 120);
  ctx.textAlign = "right";
  ctx.font = font(600, 26);
  ctx.fillText(new Date().toLocaleDateString(i18n.formatLocale), W - PAD, H - 120);
  ctx.textAlign = "left";
  return c;
}

export async function downloadShareCard(data: ShareCardData, art: CanvasImageSource | null): Promise<void> {
  const canvas = renderShareCard(data, art);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `plectr-${data.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60) || "run"}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
