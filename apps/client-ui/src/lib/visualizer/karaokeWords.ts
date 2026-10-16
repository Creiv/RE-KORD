/**
 * Karaoke backdrop: the lyrics themselves, lyric-video style.
 * For each line it picks the one or two "strong" words (long, not filler)
 * and a composition to show them huge behind the karaoke column. The
 * composition is seeded by the line's text, so a repeated chorus line always
 * comes back the same way.
 */

export type WordsLayout = "giant" | "stack" | "tilt" | "edge" | "echo";

export type WordsPlan = {
  /** Words to show, as sung (accents kept), upper case. Empty: nothing. */
  words: string[];
  layout: WordsLayout;
  /** Variation knobs, 0..1, fixed per line text. */
  a: number;
  b: number;
};

/** Filler words in IT / EN / ES / FR that never carry a line. */
const STOP = new Set(
  `
  il lo la i gli le un uno una di da in con su per tra fra e ed o ma se che chi cui non piu come anche ancora gia poi qui qua li la
  io tu lui lei noi voi loro me te ci vi ne mi ti si mio mia miei mie tuo tua tuoi tue suo sua suoi sue nostro nostra vostro vostra
  del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle col coi
  e sono sei siamo siete era erano ero eri fa fai fanno ho hai ha abbiamo avete hanno sto stai sta stanno stato stata essere avere fare
  questo questa questi queste quello quella quelli quelle cosa cose cosi quando dove perche tutto tutta tutti tutte niente nulla
  molto poco tanto tanta troppo sempre mai solo sola proprio ogni qualcosa qualcuno nessuno senza dentro fuori sopra sotto dopo prima
  adesso allora quindi pero oppure invece mentre ecco vero bene male via glie gliel tipo pare sia siano fosse
  voglio vuoi vuole vogliamo volete vogliono posso puoi puo possiamo potete possono potrei potresti potrebbe
  devo devi deve dobbiamo dovete devono dovrei faccio fanno facciamo dico dici dice dire detto vado vai andare
  resta restano resto rimane parte volta volte altro altra altri altre farne
  the a an and or but if of to in on at for with from by as into than then there here
  is are was were be been being am do does did done have has had having will would shall should can could may might must
  i you he she it we they me him her us them my your his its our their mine yours this that these those
  what when where why how who whom which all any some no not dont im ive youre its thats theres cant wont aint
  just so up down out off over again like get got gonna wanna gotta let lets know yeah yea yeh oh ooh oooh uh ah eh hey whoa
  el la los las un una unos unas y o pero que de del en con por para es soy eres somos son era fue mi mis tu tus su sus yo me te se lo le les nos
  muy mas pero porque cuando donde como todo todos nada siempre nunca
  le la les un une des et ou mais que qui de du en dans pour avec est suis es sommes sont etait je tu il elle on nous vous ils elles
  me te se ce ca cet cette ces mon ma mes ton ta tes son sa ses pas ne plus tout tous rien toujours jamais
  na nana lala yo uoh oh-oh
`
    .split(/\s+/)
    .filter(Boolean),
);

/** Lower case, no accents: the matching form of a word. */
function fold(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Words of a line as sung (punctuation and brackets dropped, accents kept). */
export function lineWords(text: string): string[] {
  return text
    .replace(/\([^)]*\)/g, " ") // backing vocals "(sì)", "(oooh)"
    .split(/[\s"“”«»,.;:!?¿¡…\-–—/]+/)
    .map((w) => w.replace(/^['’]+|['’]+$/g, ""))
    // "dall'altra" → "altra": the part after an elision carries the meaning.
    .map((w) => w.split(/['’]/).pop() ?? w)
    .filter(Boolean);
}

/** The one or two strongest words of a line, strongest first. */
export function strongWords(text: string, max = 2): string[] {
  const words = lineWords(text);
  const scored = words
    .map((w, i) => ({ w, i, f: fold(w) }))
    .filter((x) => x.f.length >= 4 && !STOP.has(x.f) && !/^\d+$/.test(x.f))
    .map((x) => ({ ...x, score: x.f.length + (x.i === words.length - 1 ? 1.5 : 0) }))
    .sort((p, q) => q.score - p.score);
  const picked: typeof scored = [];
  for (const x of scored) {
    if (picked.length >= max) break;
    if (picked.some((p) => p.f === x.f)) continue;
    picked.push(x);
  }
  return picked.map((x) => x.w.toLocaleUpperCase());
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const SINGLE: WordsLayout[] = ["giant", "tilt", "edge", "echo", "giant"];

/** Composition for one line; the same text always gets the same one. */
export function planLine(text: string): WordsPlan {
  const h = hash(fold(text) || text);
  const a = ((h >>> 8) & 0xff) / 255;
  const b = ((h >>> 16) & 0xff) / 255;
  const words = strongWords(text);
  if (!words.length) return { words, layout: "giant", a, b };
  if (words.length > 1 && h % 3 === 0) {
    // Stacked pair reads in sung order.
    const sung = lineWords(text).map((w) => w.toLocaleUpperCase());
    words.sort((p, q) => sung.indexOf(p) - sung.indexOf(q));
    return { words, layout: "stack", a, b };
  }
  return { words: [words[0]!], layout: SINGLE[h % SINGLE.length]!, a, b };
}

/**
 * Font size (CSS) that makes `word` span about `widthShare` of the stage at
 * the heavy upper-case weight, capped by the height.
 */
export function fitSize(word: string, widthShare: number, maxVh: number): string {
  // Heavy upper case runs about 0.7em per letter.
  const vw = (widthShare * 100) / (0.7 * Math.max(3, word.length));
  return `min(${vw.toFixed(2)}vw, ${maxVh}vh)`;
}
