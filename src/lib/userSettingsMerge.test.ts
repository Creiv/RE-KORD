import { describe, expect, it } from "vitest";
import { mergePartialUserSettings } from "./userSettingsMerge";

describe("mergePartialUserSettings", () => {
  it("deep-merges customTheme so bgImage survives bgMode-only patches", () => {
    const merged = mergePartialUserSettings(
      {
        theme: "custom",
        customTheme: {
          bg: "#08111d",
          section: "#121f31",
          accent: "#ff8f5c",
          accent2: "#64d4ff",
          bgMode: "image",
          bgImage: "webp",
          bgImageRev: 123,
        },
      },
      {
        customTheme: {
          bgMode: "color",
        },
      },
    );

    expect(merged.customTheme?.bgMode).toBe("color");
    expect(merged.customTheme?.bgImage).toBe("webp");
    expect(merged.customTheme?.bgImageRev).toBe(123);
    expect(merged.customTheme?.bg).toBe("#08111d");
  });
});
