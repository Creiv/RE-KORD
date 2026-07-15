import { existsSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isExecutableFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Candidati dal binario impacchettato al percorso di sviluppo. */
export function bundledBinCandidates(fileName) {
  const candidates = [];
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    candidates.push(
      path.join(resourcesPath, "app.asar.unpacked", "server", "bin", fileName),
    );
  }
  const asarMarker = `${path.sep}app.asar${path.sep}`;
  const unpackedMarker = `${path.sep}app.asar.unpacked${path.sep}`;
  if (__dirname.includes(asarMarker)) {
    candidates.push(
      path.join(
        __dirname.replace(asarMarker, unpackedMarker),
        "bin",
        fileName,
      ),
    );
  }
  candidates.push(path.join(__dirname, "bin", fileName));
  return candidates;
}

/** Risolve un binario bundled eseguibile (mai da dentro app.asar). */
export function resolveBundledBinPath(fileName) {
  for (const candidate of bundledBinCandidates(fileName)) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function bundledBinAvailable(fileName) {
  return resolveBundledBinPath(fileName) != null;
}

/** Per messaggi d'errore: primo candidato atteso in build impacchettata. */
export function expectedBundledBinPath(fileName) {
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    return path.join(resourcesPath, "app.asar.unpacked", "server", "bin", fileName);
  }
  return path.join(__dirname, "bin", fileName);
}

/** existsSync su app.asar può essere true anche se il file non è eseguibile. */
export function pathLooksLikeAsarArchive(filePath) {
  return String(filePath || "").includes(`${path.sep}app.asar${path.sep}`);
}
