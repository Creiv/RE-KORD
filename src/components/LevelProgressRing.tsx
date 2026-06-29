import type { CSSProperties } from "react";
import { levelRingTierIndex } from "../lib/achievements";
import styles from "./LevelProgressRing.module.css";

type Props = {
  level: number;
  pct: number;
  loading?: boolean;
  active?: boolean;
  title?: string;
  ariaLabel: string;
  onClick?: () => void;
};

export function LevelProgressRing({
  level,
  pct,
  loading = false,
  active = false,
  title,
  ariaLabel,
  onClick,
}: Props) {
  const clamped = Math.min(100, Math.max(0, pct));
  const style = {
    "--level-ring-pct": String(loading ? 0 : clamped),
    "--level-ring-tier": String(levelRingTierIndex(level)),
  } as CSSProperties;

  const inner = (
    <>
      <span
        className={`${styles.ring}${loading ? ` ${styles.ringLoading}` : ""}`}
        aria-hidden
      />
      <span className={styles.hole} aria-hidden />
      <span className={styles.level}>{loading ? "·" : level}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={styles.btn}
        style={style}
        onClick={onClick}
        title={title}
        aria-label={ariaLabel}
        aria-current={active ? "page" : undefined}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      className={styles.root}
      style={style}
      title={title}
      aria-label={ariaLabel}
      role="img"
    >
      {inner}
    </div>
  );
}
