import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "../../context/PlayerContext";
import { useUserState } from "../../context/UserStateContext";
import { resolveTrackFromLibrary } from "../../lib/libraryNav";
import {
  buildNebulaModel,
  buildNebulaSpatialGrid,
  defaultNebulaCamera,
  filterNebulaStars,
  pickNebulaStarAt,
  sampleNebulaStarsForPreview,
  type NebulaCamera,
  type NebulaStar,
} from "../../lib/sonicNebula";
import { useI18n } from "../../i18n/useI18n";
import type { LibraryIndex } from "../../types";
import {
  UiAutoAwesome,
  UiCloseFullscreen,
  UiOpenInFull,
  UiPlayArrow,
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
  const user = useUserState();
  const player = usePlayer();

  const favorites = useMemo(
    () => new Set(user.state.favorites),
    [user.state.favorites]
  );

  const model = useMemo(
    () =>
      buildNebulaModel(index.tracks, {
        playCounts: user.state.trackPlayCounts ?? {},
        favorites,
      }),
    [index.tracks, user.state.trackPlayCounts, favorites]
  );

  const [query, setQuery] = useState("");
  const visibleStars = useMemo(
    () => filterNebulaStars(model.stars, query),
    [model.stars, query]
  );

  const spatial = useMemo(
    () => buildNebulaSpatialGrid(visibleStars),
    [visibleStars]
  );

  const [camera, setCamera] = useState<NebulaCamera>(() => defaultNebulaCamera());
  const [hovered, setHovered] = useState<NebulaStar | null>(null);
  const [selected, setSelected] = useState<NebulaStar | null>(null);
  const [beatPhase, setBeatPhase] = useState(0);
  const [expanded, setExpanded] = useState(false);

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
  cameraRef.current = camera;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

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

  useEffect(() => {
    if (!player.isPlaying || !currentStar) return;
    const hz = currentStar.bpm / 60;
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const elapsed = (performance.now() - start) / 1000;
      setBeatPhase((elapsed * hz) % 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player.isPlaying, currentStar]);

  const playStar = useCallback(
    (star: NebulaStar) => {
      const track = resolveTrackFromLibrary(star.track, index.tracks);
      player.playTrack(track, [track], 0);
      setSelected({ ...star, track });
    },
    [player, index.tracks]
  );

  const stopChromePointer = useCallback((event: ReactPointerEvent) => {
    event.stopPropagation();
  }, []);

  const onWheel = useCallback((event: ReactWheelEvent) => {
    if (isNebulaChrome(event.target)) return;
    event.preventDefault();
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
    setExpanded((value) => !value);
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

  const calloutLayout = useStarCalloutLayout(selected, camera, wrapRef);
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
      className={`${styles.stage}${expanded ? ` ${styles.stageExpanded}` : ""}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerCancel}
    >
      <NebulaCanvas
        className={styles.canvas}
        frameClassName={styles.canvasFrame}
        model={model}
        visibleStars={visibleStars}
        camera={camera}
        hoveredId={hovered?.id ?? null}
        selectedId={selected?.id ?? null}
        currentId={currentId}
        playing={player.isPlaying}
        beatPhase={beatPhase}
      />

      <header
        className={`${styles.topBar}${
          embedded ? ` ${styles.topBarEmbedded}` : ""
        }${expanded ? ` ${styles.topBarExpanded}` : ""}`}
        data-nebula-chrome
        onPointerDown={stopChromePointer}
      >
        {!embedded || expanded ? (
          <div className={styles.brand}>
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
            onClick={resetView}
            title={t("nebula.resetView")}
            aria-label={t("nebula.resetView")}
          >
            ↺
          </button>
          {expandBtn}
        </div>
      </header>

      {selected && calloutLayout ? (
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
              className={`player-bar2__ic player-bar2__ic--play ${styles.starCalloutPlay}`}
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
  const user = useUserState();
  const favorites = useMemo(
    () => new Set(user.state.favorites),
    [user.state.favorites]
  );
  const model = useMemo(
    () =>
      buildNebulaModel(index.tracks, {
        playCounts: user.state.trackPlayCounts ?? {},
        favorites,
      }),
    [index.tracks, user.state.trackPlayCounts, favorites]
  );
  const sample = useMemo(
    () => sampleNebulaStarsForPreview(model.stars, 300),
    [model.stars]
  );

  return (
    <button
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
        animated
      />
    </button>
  );
}
