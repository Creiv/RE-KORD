import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discowallLoopCadence,
  isCompactRenderTarget,
  libraryPollIntervalMs,
  mediaSessionSyncIntervalMs,
  nebulaLoopCadence,
  NEBULA_MOBILE_FRAME_MS,
  plectrBackdropCadence,
  resetRenderQualityMqCacheForTests,
  vizLoopCadence,
} from "./renderQuality";

describe("renderQuality", () => {
  beforeEach(() => {
    resetRenderQualityMqCacheForTests();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetRenderQualityMqCacheForTests();
  });
  it("libraryPollIntervalMs adatta foreground/background", () => {
    expect(libraryPollIntervalMs(true)).toBe(30_000);
  });

  it("libraryPollIntervalMs più lento su compact in foreground", () => {
    resetRenderQualityMqCacheForTests();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: coarse") || query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1080,
    });
    expect(libraryPollIntervalMs(false)).toBe(8000);
    expect(libraryPollIntervalMs(false, true)).toBe(15_000);
  });

  it("mediaSessionSyncIntervalMs adatta play/pause e hidden", () => {
    expect(mediaSessionSyncIntervalMs(true, false)).toBe(1000);
    expect(mediaSessionSyncIntervalMs(false, false)).toBe(2500);
    expect(mediaSessionSyncIntervalMs(true, true)).toBe(10_000);
    expect(mediaSessionSyncIntervalMs(false, true)).toBe(30_000);
  });

  it("mediaSessionSyncIntervalMs più lento su compact in play", () => {
    resetRenderQualityMqCacheForTests();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: coarse") || query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    expect(mediaSessionSyncIntervalMs(true, false)).toBe(2000);
  });

  it("discowallLoopCadence limita fps panel vs expanded", () => {
    resetRenderQualityMqCacheForTests();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    expect(
      discowallLoopCadence({ expanded: false, active: false }).minFrameIntervalMs,
    ).toBe(33);
    expect(
      discowallLoopCadence({ expanded: true, active: true }).minFrameIntervalMs,
    ).toBe(16);
  });

  it("vizLoopCadence limita fps in panel mode desktop", () => {
    resetRenderQualityMqCacheForTests();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    expect(vizLoopCadence({ expanded: false, isPlaying: true }).minFrameIntervalMs).toBe(
      33,
    );
    expect(vizLoopCadence({ expanded: false, isPlaying: false }).minFrameIntervalMs).toBe(
      66,
    );
  });

  it("vizLoopCadence più lento su compact in panel play", () => {
    resetRenderQualityMqCacheForTests();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: coarse") || query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    expect(vizLoopCadence({ expanded: false, isPlaying: true }).minFrameIntervalMs).toBe(
      48,
    );
  });

  it("nebulaLoopCadence più lento quando idle", () => {
    expect(nebulaLoopCadence({ active: true }).minFrameIntervalMs).toBeGreaterThanOrEqual(
      0,
    );
    expect(nebulaLoopCadence({ active: false }).minFrameIntervalMs).toBe(40);
  });

  it("nebulaLoopCadence preview idle rallenta su compact", () => {
    resetRenderQualityMqCacheForTests();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: coarse") || query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    expect(nebulaLoopCadence({ active: false, preview: true }).minFrameIntervalMs).toBe(
      250,
    );
  });

  it("nebulaLoopCadence cap ~30fps su compact attivo", () => {
    resetRenderQualityMqCacheForTests();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("pointer: coarse") || query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    expect(nebulaLoopCadence({ active: true }).minFrameIntervalMs).toBe(
      NEBULA_MOBILE_FRAME_MS,
    );
  });

  it("plectrBackdropCadence restituisce scale e interval", () => {
    const q = plectrBackdropCadence();
    expect(q.scale).toBeGreaterThan(0);
    expect(q.intervalMs).toBeGreaterThan(0);
  });

  it("isCompactRenderTarget con viewport stretto", () => {
    resetRenderQualityMqCacheForTests();
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 480,
    });
    expect(isCompactRenderTarget()).toBe(true);
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
  });
});
