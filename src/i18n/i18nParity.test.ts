import { describe, expect, it } from "vitest";
import { DE } from "./de";
import { EN } from "./en";
import { IT } from "./it";

const TABLES = { en: EN, it: IT, de: DE } as const;
const LOCALES = Object.keys(TABLES) as Array<keyof typeof TABLES>;

describe("i18n parity EN/IT/DE", () => {
  for (const from of LOCALES) {
    for (const to of LOCALES) {
      if (from === to) continue;
      it(`every ${from.toUpperCase()} key exists in ${to.toUpperCase()}`, () => {
        const missing = Object.keys(TABLES[from]).filter(
          (key) => !(key in TABLES[to])
        );
        expect(missing).toEqual([]);
      });
    }
  }
});
