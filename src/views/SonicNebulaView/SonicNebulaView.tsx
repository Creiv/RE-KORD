import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "../../context/PlayerContext";
import { useUserStateSelector } from "../../context/UserStateContext";
import { resolveTrackFromLibrary } from "../../lib/libraryNav";
import {
  buildNebulaModel,
  buildNebulaSpatialGrid,
  defaultNebulaCamera,
  filterNebulaStars,
  NEBULA_MIN_ZOOM,
  nebulaStarsNear,
  pickNebulaStarAt,
  sampleNebulaStarsForPreview,
  sampleTracksForNebulaBuild,
  type NebulaCamera,
  type NebulaStar,
} from "../../lib/sonicNebula";
import {
  consumeNebulaFullscreenRequest,
  onNebulaFullscreenRequest,
} from "../../lib/nebulaFullscreen";
import { useI18n } from "../../i18n/useI18n";
import type { LibraryIndex } from "../../types";
import {
  UiAutoAwesome,
  UiCloseFullscreen,
  UiOpenInFull,
  UiPlayArrow,
  UiRadioOutlined,
  UiShuffle,
} from "../../components/RekordUiIcons";
import { NebulaCanvas } from "./NebulaCanvas";
import styles from "./SonicNebulaView.module.css";

type SonicNebulaViewProps = {
  index: LibraryIndex;
  embedded?: boolean;
};

function pinchMetrics(pointers: Map<number, { x: number; y: number }>) {
  const pts = [...pointers.values()];
  if (pts.length < 2) return null;
  const [a, b] = pts;
  const dx = b!.x - a!.x;
  const dy = b!.y - a!.y;
  return {
    dist: Math.hypot(dx, dy),
    cx: (a!.x + b!.x) / 2,
    cy: (a!.y + b!.y) / 2,
  };
}

function zoomCameraAt(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  prev: NebulaCamera,
  nextZoom: number
): NebulaCamera {
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  const wx = (sx - rect.width / 2) / prev.zoom + prev.x;
  const wy = (sy - rect.height / 2) / prev.zoom + prev.y;
  return {
    x: wx - (sx - rect.width / 2) / nextZoom,
    y: wy - (sy - rect.height / 2) / nextZoom,
    zoom: nextZoom,
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function screenToWorld(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  camera: NebulaCamera
) {
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  const wx = (sx - rect.width / 2) / camera.zoom + camera.x;
  const wy = (sy - rect.height / 2) / camera.zoom + camera.y;
  return { wx, wy };
}

function isNebulaChrome(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("[data-nebula-chrome]"));
}

type StarCalloutLayout = {
  anchorX: number;
  anchorY: number;
  left: number;
  top: number;
};

function useStarCalloutLayout(
  star: NebulaStar | null,
  camera: NebulaCamera,
  stageRef: RefObject<HTMLDivElement | null>
): StarCalloutLayout | null {
  const [layout, setLayout] = useState<StarCalloutLayout | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!star || !stage) {
      setLayout(null);
      return;
    }

    const update = () => {
      const rect = stage.getBoundingClientRect();
      const anchorX = (star.x - camera.x) * camera.zoom + rect.width / 2;
      const anchorY = (star.y - camera.y) * camera.zoom + rect.height / 2;
      const cardW = 252;
      const cardH = 74;
      let left = anchorX + 24;
      let top = anchorY - cardH / 2;
      if (left + cardW > rect.width - 10) left = anchorX - cardW - 24;
      if (top < 10) top = 10;
      if (top + cardH > rect.height - 10) top = rect.height - cardH - 10;
      left = clamp(left, 10, Math.max(10, rect.width - cardW - 10));
      setLayout({ anchorX, anchorY, left, top });
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [star, camera, stageRef]);

  return layout;
}

export default function SonicNebulaView({
  index,
  embedded = false,
}: SonicNebulaViewProps) {
  const { t } = useI18n();
  const favoritesList = useUserStateSelector((s) => s.state.favorites);
  const trackPlayCounts = useUserStateSelector((s) => s.state.trackPlayCounts ?? {});
  const player = usePlayer();

  const favorites = useMemo(
    () => new Set(favoritesList),
    [favoritesList]
  );

  const [query, setQuery] = useState("");
  const [camera, setCamera] = useState<NebulaCamera>(() =>
    embedded
      ? defaultNebulaCamera(NEBULA_MIN_ZOOM)
      : defaultNebulaCamera(),
  );
  const [hovered, setHovered] = useState<NebulaStar | null>(null);
  const [selected, setSelected] = useState<NebulaStar | null>(null);
  const [expanded, setExpanded] = useState(() =>
    consumeNebulaFullscreenRequest()
  );
  const [hintDismissed, setHintDismissed] = useState(false);
  const isStaticPreview = embedded && !expanded;

  const model = useMemo(
    () => {
      const tracks = isStaticPreview
        ? sampleTracksForNebulaBuild(index.tracks, 400)
        : index.tracks;
      return buildNebulaModel(tracks, {
        playCounts: trackPlayCounts,
        favorites,
      });
    },
    [
      index.tracks,
      trackPlayCounts,
      favorites,
      isStaticPreview,
    ]
  );

  const visibleStars = useMemo(
    () => filterNebulaStars(model.stars, query),
    [model.stars, query]
  );

  const spatial = useMemo(
    () => buildNebulaSpatialGrid(visibleStars),
    [visibleStars]
  );

  const coarsePointer = useMemo(
    () =>
      typeof matchMedia !== "undefined" &&
      matchMedia("(pointer: coarse)").matches,
    []
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef({
    active: false,
    pointerId: -1,
    lastX: 0,
    lastY: 0,
    moved: false,
  });
  const pinchRef = useRef({
    active: false,
    startDist: 0,
    startZoom: 1,
    anchorX: 0,
    anchorY: 0,
    camera: defaultNebulaCamera(),
  });
  const cameraRef = useRef(camera);
  const selectedRef = useRef(selected);
  useEffect(() => {
    cameraRef.current = camera;
    selectedRef.current = selected;
  }, [camera, selected]);

  const currentId = player.current?.relPath ?? null;
  const currentStar = useMemo(
    () => model.stars.find((s) => s.id === currentId) ?? null,
    [model.stars, currentId]
  );

  const selectStar = useCallback((star: NebulaStar) => {
    setSelected(star);
    setHovered(star);
    setCamera((prev) => ({
      x: star.x,
      y: star.y,
      zoom: clamp(Math.max(prev.zoom, 0.95), 0.35, 2.6),
    }));
  }, []);

  const playStar = useCallback(
    (star: NebulaStar) => {
      const track = resolveTrackFromLibrary(star.track, index.tracks);
      player.playTrack(track, [track], 0);
      setSelected({ ...star, track });
    },
    [player, index.tracks]
  );

  // "Radio da qui": coda con la stella scelta più le vicine (stesso
  // quartiere sonoro: tempo/energia simili per costruzione della mappa).
  const playStarRadio = useCallback(
    (star: NebulaStar) => {
      const neighbors = nebulaStarsNear(visibleStars, star, 320, 24);
      const tracks = [star, ...neighbors].map((s) =>
        resolveTrackFromLibrary(s.track, index.tracks)
      );
      player.playTrack(tracks[0]!, tracks, 0);
      setSelected({ ...star, track: tracks[0]! });
    },
    [player, index.tracks, visibleStars]
  );

  const surpriseMe = useCallback(() => {
    const pool = visibleStars.length ? visibleStars : model.stars;
    if (!pool.length) return;
    const star = pool[Math.floor(Math.random() * pool.length)]!;
    selectStar(star);
  }, [visibleStars, model.stars, selectStar]);

  const stopChromePointer = useCallback((event: ReactPointerEvent) => {
    event.stopPropagation();
  }, []);

  const onWheel = useCallback((event: ReactWheelEvent) => {
    if (isNebulaChrome(event.target)) return;
    event.preventDefault();
    setHintDismissed(true);
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = event.deltaY < 0 ? 1.07 : 0.93;
    setCamera((prev) => {
      const nextZoom = clamp(prev.zoom * factor, 0.32, 2.8);
      const { wx, wy } = screenToWorld(event.clientX, event.clientY, rect, prev);
      const sx = event.clientX - rect.left;
      const sy = event.clientY - rect.top;
      return {
        x: wx - (sx - rect.width / 2) / nextZoom,
        y: wy - (sy - rect.height / 2) / nextZoom,
        zoom: nextZoom,
      };
    });
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    if (isNebulaChrome(event.target)) return;
    setHintDismissed(true);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    const pinch = pinchMetrics(pointersRef.current);
    if (pinch && pinch.dist > 0) {
      pinchRef.current = {
        active: true,
        startDist: pinch.dist,
        startZoom: cameraRef.current.zoom,
        anchorX: pinch.cx,
        anchorY: pinch.cy,
        camera: cameraRef.current,
      };
      dragRef.current.active = false;
      return;
    }

    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      if (isNebulaChrome(event.target)) return;
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;

      if (pointersRef.current.has(event.pointerId)) {
        pointersRef.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
      }

      const pinch = pinchMetrics(pointersRef.current);
      if (pinchRef.current.active && pinch && pinch.dist > 0) {
        const nextZoom = clamp(
          pinchRef.current.startZoom * (pinch.dist / pinchRef.current.startDist),
          0.32,
          2.8
        );
        setCamera(
          zoomCameraAt(
            rect,
            pinchRef.current.anchorX,
            pinchRef.current.anchorY,
            pinchRef.current.camera,
            nextZoom
          )
        );
        return;
      }

      if (
        dragRef.current.active &&
        event.pointerId === dragRef.current.pointerId &&
        pointersRef.current.size === 1
      ) {
        const dx = event.clientX - dragRef.current.lastX;
        const dy = event.clientY - dragRef.current.lastY;
        const slop = event.pointerType === "touch" ? 12 : 3;
        if (Math.abs(dx) + Math.abs(dy) > slop) dragRef.current.moved = true;
        dragRef.current.lastX = event.clientX;
        dragRef.current.lastY = event.clientY;
        setCamera((prev) => ({
          ...prev,
          x: prev.x - dx / prev.zoom,
          y: prev.y - dy / prev.zoom,
        }));
        return;
      }

      if (pointersRef.current.size === 1) {
        const { wx, wy } = screenToWorld(
          event.clientX,
          event.clientY,
          rect,
          cameraRef.current
        );
        setHovered(pickNebulaStarAt(spatial, wx, wy, cameraRef.current.zoom));
      }
    },
    [spatial]
  );

  const clearTransientHover = useCallback(() => {
    setHovered((current) => {
      if (!current) return null;
      if (selectedRef.current?.id === current.id) return current;
      return null;
    });
  }, []);

  const releasePointer = useCallback(
    (event: ReactPointerEvent) => {
      if (isNebulaChrome(event.target)) return;
      const rect = wrapRef.current?.getBoundingClientRect();
      const wasPinch = pinchRef.current.active;
      const tapPointerId = dragRef.current.pointerId;
      const tapMoved = dragRef.current.moved;

      pointersRef.current.delete(event.pointerId);
      if (pointersRef.current.size < 2) {
        pinchRef.current.active = false;
      }
      if (pointersRef.current.size === 0) {
        dragRef.current.active = false;
        dragRef.current.pointerId = -1;
      }

      if (
        !rect ||
        wasPinch ||
        pointersRef.current.size > 0 ||
        tapMoved ||
        event.pointerId !== tapPointerId
      ) {
        if (pointersRef.current.size === 0) clearTransientHover();
        return;
      }

      const { wx, wy } = screenToWorld(
        event.clientX,
        event.clientY,
        rect,
        cameraRef.current
      );
      const hit = pickNebulaStarAt(spatial, wx, wy, cameraRef.current.zoom);
      if (hit) selectStar(hit);
      else {
        setSelected(null);
        clearTransientHover();
      }
    },
    [spatial, selectStar, clearTransientHover]
  );

  const cleanupPointer = useCallback((event: ReactPointerEvent) => {
    if (isNebulaChrome(event.target)) return;
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) {
      pinchRef.current.active = false;
    }
    if (pointersRef.current.size === 0) {
      dragRef.current.active = false;
      dragRef.current.pointerId = -1;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* già rilasciato */
    }
  }, []);

  const onPointerUp = useCallback(
    (event: ReactPointerEvent) => {
      releasePointer(event);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* già rilasciato */
      }
    },
    [releasePointer]
  );

  const onPointerLeave = useCallback(
    (event: ReactPointerEvent) => {
      // Su touch, pointerleave al rilascio del dito azzera hover/selezione.
      if (event.pointerType === "touch") return;
      if (dragRef.current.active || pointersRef.current.size > 0) return;
      clearTransientHover();
    },
    [clearTransientHover]
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent) => {
      cleanupPointer(event);
      if (pointersRef.current.size === 0) clearTransientHover();
    },
    [cleanupPointer, clearTransientHover]
  );

  const resetView = useCallback(() => {
    setCamera(defaultNebulaCamera());
    setSelected(null);
    setHovered(null);
    setQuery("");
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded((value) => {
      const next = !value;
      if (value && embedded) {
        setCamera(defaultNebulaCamera(NEBULA_MIN_ZOOM));
        setSelected(null);
        setHovered(null);
        setQuery("");
      }
      return next;
    });
  }, [embedded]);

  const openFullscreen = useCallback(() => {
    setExpanded(true);
  }, []);

  const previewCamera = useMemo(
    () => defaultNebulaCamera(NEBULA_MIN_ZOOM),
    [],
  );
  const activeCamera = isStaticPreview ? previewCamera : camera;

  useEffect(() => {
    /* Tasto N (AppShell): se la vista è già montata passa al fullscreen. */
    return onNebulaFullscreenRequest(() => setExpanded(true));
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  useEffect(() => {
    if (!expanded || typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  const calloutLayout = useStarCalloutLayout(
    isStaticPreview ? null : selected,
    activeCamera,
    wrapRef,
  );
  const isSelectedPlaying = Boolean(
    selected &&
      player.isPlaying &&
      currentId &&
      selected.id === currentId
  );

  if (!model.stars.length) {
    return <div className={styles.empty}>{t("nebula.empty")}</div>;
  }

  const expandBtn = (
    <button
      type="button"
      className={styles.toolBtn}
      data-active={expanded}
      onClick={toggleExpanded}
      title={expanded ? t("nebula.collapse") : t("nebula.expand")}
      aria-label={expanded ? t("nebula.collapse") : t("nebula.expand")}
    >
      {expanded ? (
        <UiCloseFullscreen className={styles.toolBtnIc} aria-hidden />
      ) : (
        <UiOpenInFull className={styles.toolBtnIc} aria-hidden />
      )}
    </button>
  );

  const stage = (
    <div
      ref={wrapRef}
      className={`${styles.stage}${expanded ? ` ${styles.stageExpanded}` : ""}${
        isStaticPreview ? ` ${styles.stagePreviewOnly}` : ""
      }`}
      role={isStaticPreview ? "button" : undefined}
      tabIndex={isStaticPreview ? 0 : undefined}
      aria-label={isStaticPreview ? t("nebula.expand") : undefined}
      onClick={isStaticPreview ? openFullscreen : undefined}
      onKeyDown={
        isStaticPreview
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openFullscreen();
              }
            }
          : undefined
      }
      onWheel={isStaticPreview ? undefined : onWheel}
      onPointerDown={isStaticPreview ? undefined : onPointerDown}
      onPointerMove={isStaticPreview ? undefined : onPointerMove}
      onPointerUp={isStaticPreview ? undefined : onPointerUp}
      onPointerLeave={isStaticPreview ? undefined : onPointerLeave}
      onPointerCancel={isStaticPreview ? undefined : onPointerCancel}
    >
      <NebulaCanvas
        className={styles.canvas}
        frameClassName={styles.canvasFrame}
        model={model}
        visibleStars={visibleStars}
        camera={activeCamera}
        hoveredId={isStaticPreview ? null : hovered?.id ?? null}
        selectedId={isStaticPreview ? null : selected?.id ?? null}
        currentId={currentId}
        playing={player.isPlaying}
        currentBpm={currentStar?.bpm ?? 0}
        interactive={!isStaticPreview}
        preview={isStaticPreview}
        surface="library"
      />

      {!isStaticPreview ? (
        <header
          className={`${styles.topBar}${
            embedded ? ` ${styles.topBarEmbedded}` : ""
          }${expanded ? ` ${styles.topBarExpanded}` : ""}`}
          data-nebula-chrome
          onPointerDown={stopChromePointer}
        >
          {!embedded || expanded ? (
            <div
              className={styles.brand}
              title={`${t("nebula.legendCenter")}\n${t("nebula.legendEdge")}\n${t(
                "nebula.legendAngle"
              )}`}
            >
              <UiAutoAwesome className={styles.brandIc} />
              <span className={styles.brandText}>
                {t("nebula.title")}{" "}
                <span className={styles.brandCount}>· {model.stars.length}</span>
              </span>
            </div>
          ) : null}
          <div className={styles.topTools}>
            <input
              className={styles.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("nebula.searchPlaceholder")}
              aria-label={t("nebula.searchPlaceholder")}
            />
            <button
              type="button"
              className={styles.toolBtn}
              onClick={surpriseMe}
              title={t("nebula.surprise")}
              aria-label={t("nebula.surprise")}
            >
              <UiShuffle className={styles.toolBtnIc} aria-hidden />
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={resetView}
              title={t("nebula.resetView")}
              aria-label={t("nebula.resetView")}
            >
              ↺
            </button>
            {expandBtn}
          </div>
        </header>
      ) : null}

      {!isStaticPreview && !hintDismissed && !selected ? (
        <div className={styles.hint} aria-hidden>
          {coarsePointer ? t("nebula.hintShort") : t("nebula.hint")}
        </div>
      ) : null}

      {selected && calloutLayout && !isStaticPreview ? (
        <>
          <div
            className={styles.starVignette}
            style={{
              left: calloutLayout.anchorX,
              top: calloutLayout.anchorY,
              color: selected.color,
            }}
            aria-hidden
          />
          <div
            className={styles.starCallout}
            style={{
              left: calloutLayout.left,
              top: calloutLayout.top,
              borderColor: `color-mix(in srgb, ${selected.color} 55%, var(--border, #334155))`,
            }}
            data-nebula-chrome
            onPointerDown={stopChromePointer}
          >
            <div className={styles.starCalloutText}>
              <p className={styles.starCalloutTitle}>{selected.track.title}</p>
              <p className={styles.starCalloutMeta}>
                {selected.track.artist} · {selected.track.album}
              </p>
            </div>
            <button
              type="button"
              className={`player-bar2__ic ${styles.starCalloutRadio}`}
              onClick={() => playStarRadio(selected)}
              title={t("nebula.radioHere")}
              aria-label={t("nebula.radioHere")}
            >
              <span
                className="player-bar2__ic-glyph player-bar2__ic-glyph--svg"
                aria-hidden
              >
                <UiRadioOutlined />
              </span>
            </button>
            <button
              type="button"
              className={`player-bar2__ic player-bar2__ic--play ${styles.starCalloutPlay}`}
              style={
                {
                  ["--nebula-play-c" as string]: selected.color,
                } as CSSProperties
              }
              onClick={() => playStar(selected)}
              title={t("nebula.play")}
              aria-label={t("nebula.play")}
              data-playing={isSelectedPlaying}
            >
              <span
                className="player-bar2__ic-glyph player-bar2__ic-glyph--svg"
                aria-hidden
              >
                <UiPlayArrow />
              </span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  );

  return (
    <div
      className={`${styles.root}${embedded ? ` ${styles.rootEmbedded}` : ""}${
        expanded ? ` ${styles.rootExpanded}` : ""
      }`}
    >
      {expanded ? <div className={styles.stagePlaceholder} aria-hidden /> : null}
      {expanded && typeof document !== "undefined"
        ? createPortal(stage, document.body)
        : stage}
    </div>
  );
}

export function SonicNebulaMiniPreview({
  index,
  onOpen,
}: {
  index: LibraryIndex;
  onOpen: () => void;
}) {
  const favoritesList = useUserStateSelector((s) => s.state.favorites);
  const trackPlayCounts = useUserStateSelector((s) => s.state.trackPlayCounts ?? {});
  const favorites = useMemo(
    () => new Set(favoritesList),
    [favoritesList]
  );
  const model = useMemo(
    () =>
      buildNebulaModel(sampleTracksForNebulaBuild(index.tracks, 400), {
        playCounts: trackPlayCounts,
        favorites,
      }),
    [index.tracks, trackPlayCounts, favorites]
  );
  const sample = useMemo(
    () => sampleNebulaStarsForPreview(model.stars, 300),
    [model.stars]
  );
  const rootRef = useRef<HTMLButtonElement>(null);
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting)),
      { rootMargin: "80px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <button
      ref={rootRef}
      type="button"
      className="dashboard-nebula-card"
      onClick={onOpen}
      aria-label={undefined}
    >
      <NebulaCanvas
        className="dashboard-nebula-card__canvas"
        frameClassName="dashboard-nebula-card__frame"
        model={model}
        visibleStars={sample}
        camera={defaultNebulaCamera(0.36)}
        hoveredId={null}
        currentId={null}
        playing={false}
        interactive={false}
        preview
        animated={inView}
        surface="dashboard"
      />
    </button>
  );
}
