import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewsPath = path.join(root, "src/styles/views.css");
const shellPath = path.join(root, "src/styles/shell.css");
const buttonsPath = path.join(root, "src/styles/buttons.css");

const lines = fs.readFileSync(viewsPath, "utf8").split("\n");

function take(start, end) {
  return lines.slice(start - 1, end).join("\n");
}

const shell =
  "/* Shell: shortcut, topbar utilities, input, layout contenuto */\n" +
  take(18, 67) +
  "\n\n" +
  take(119, 469) +
  "\n\n" +
  take(629, 714);

const buttons =
  "/* Pulsanti azione unificati */\n" + take(1671, 1787);

/** Rimuovi intervalli dal fondo per non alterare gli indici */
const remove = [
  [1671, 1787],
  [629, 714],
  [470, 627],
  [119, 469],
  [88, 117],
  [68, 74],
  [3, 16],
].sort((a, b) => b[0] - a[0]);

let out = [...lines];
for (const [start, end] of remove) {
  out.splice(start - 1, end - start + 1);
}

const header =
  "/* Viste: libreria, dashboard, ascolta, impostazioni, dialoghi */\n";
fs.writeFileSync(viewsPath, header + out.join("\n").replace(/^\n+/, ""));
fs.writeFileSync(shellPath, shell + "\n");
fs.writeFileSync(buttonsPath, buttons + "\n");
console.log("shell:", shell.split("\n").length, "buttons:", buttons.split("\n").length, "views:", out.length);
