/**
 * Aggancio di risoluzione per i test, caricato con `--import`.
 *
 * Nel codice dell'app i moduli si citano come li cita Vite, `./trackMoods` senza
 * estensione; node invece pretende il nome completo e si fermerebbe al primo
 * import interno. Qui si prova ad aggiungere `.ts` ai percorsi relativi che non
 * hanno estensione: i test possono cosi' importare i moduli veri, invece di
 * copiarne dentro una versione che poi resta indietro.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const HAS_EXTENSION = /\.([cm]?[jt]s|json|svelte)$/;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !HAS_EXTENSION.test(specifier)) {
      try {
        const guess = `${specifier}.ts`;
        if (existsSync(fileURLToPath(new URL(guess, context.parentURL)))) {
          return next(guess, context);
        }
      } catch {
        /* Percorso non traducibile in file: se ne occupa node come sempre. */
      }
    }
    return next(specifier, context);
  },
});
