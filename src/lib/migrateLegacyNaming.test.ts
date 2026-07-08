import { describe, expect, it } from "vitest";
import { migrateLegacyStorageKeys, readSessionAccountId } from "./migrateLegacyNaming";

describe("migrateLegacyNaming", () => {
  it("migrates wpp and kord storage keys to rekord", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    } as Storage;
    storage.setItem("wpp-favorites", '["a.mp3"]');
    storage.setItem("kord-session-account-id", "acc1");
    const n = migrateLegacyStorageKeys(storage);
    expect(n).toBeGreaterThan(0);
    expect(storage.getItem("rekord-favorites")).toBe('["a.mp3"]');
    expect(storage.getItem("wpp-favorites")).toBeNull();
    expect(readSessionAccountId(storage)).toBe("acc1");
  });
});
