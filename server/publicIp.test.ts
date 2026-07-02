import { describe, expect, it } from "vitest";
import { parsePublicIp } from "./publicIp.mjs";

describe("parsePublicIp", () => {
  it("parsa JSON ipify", () => {
    expect(parsePublicIp('{"ip":"203.0.113.42"}')).toBe("203.0.113.42");
  });

  it("parsa testo plain", () => {
    expect(parsePublicIp("203.0.113.42\n")).toBe("203.0.113.42");
  });

  it("rifiuta garbage", () => {
    expect(parsePublicIp("not-an-ip")).toBeNull();
    expect(parsePublicIp("")).toBeNull();
  });
});
