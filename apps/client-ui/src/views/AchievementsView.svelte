<script lang="ts">
  import { onMount } from "svelte";
  import { Button, Panel } from "@rekord/ui";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { type AchievementIconKind } from "../lib/achievements";
  import { t } from "../lib/i18n.svelte";
  import { accountAchievements } from "../lib/accountLevel.svelte";
  import { plectrRecords } from "../lib/plectr/persist.svelte";
  import { session } from "../lib/session.svelte";

  let bootstrapped = $state(false);
  let loadError = $state(false);

  function iconName(
    kind: AchievementIconKind,
  ):
    | "play"
    | "favorite"
    | "queueMusic"
    | "disc"
    | "chart"
    | "shuffle"
    | "music"
    | "history"
    | "plectrum" {
    switch (kind) {
      case "heart":
        return "favorite";
      case "list":
        return "queueMusic";
      case "artist":
        return "disc";
      case "genre":
        return "chart";
      case "shuffle":
        return "shuffle";
      case "library":
        return "music";
      case "streak":
      case "flame":
        return "history";
      case "plectr":
        return "plectrum";
      default:
        return "play";
    }
  }

  /** Same snapshot as the rail ring and Settings › Account (one level everywhere). */
  const snapshot = $derived(bootstrapped ? accountAchievements.snapshot : null);

  const loading = $derived(!bootstrapped || snapshot == null);
  type Badge = NonNullable<typeof snapshot>["achievements"][number];
  /** Closest locked badges first (library requirements last). */
  const nextUp = $derived(
    (snapshot?.achievements ?? [])
      .filter((a) => !a.unlocked)
      .sort((a, b) => Number(!!a.requirement) - Number(!!b.requirement) || b.progress.pct - a.progress.pct)
      .slice(0, 6),
  );
  function requirementText(req: NonNullable<Badge["requirement"]>): string {
    return t(`achievements.requires.${req.kind}`, { need: req.need, have: req.have });
  }
  function badgeTooltip(ach: Badge): string {
    const desc = t(ach.descKey);
    if (ach.unlocked) return `${t("achievements.unlockedLabel")} · ${desc}`;
    const state = ach.requirement
      ? requirementText(ach.requirement)
      : t("achievements.progressOf", { value: ach.progress.value, target: ach.progress.target });
    return `${state} · ${desc}`;
  }
  const unlocked = $derived(
    snapshot?.achievements.filter((a) => a.unlocked).length ?? 0,
  );

  async function load() {
    loadError = false;
    try {
      await Promise.all([
        session.ensureCatalogTracks(),
        session.favorites.length ? Promise.resolve() : session.loadFavorites(),
        session.playlists.length ? Promise.resolve() : session.loadPlaylists(),
        session.stats ? Promise.resolve() : session.loadStats(),
      ]);
    } catch {
      // Badges still render from what is known; the banner says it may be partial.
      loadError = true;
    } finally {
      bootstrapped = true;
    }
  }

  onMount(() => {
    void load();
    void plectrRecords.ensureReady();
  });
</script>

<div class="view-page achievements-page">
  <header class="achievements-page__hero view-page__intro">
    <section class="achievements-hero rk-surface-card">
      <div class="achievements-hero__pills">
        <span class="achievements-hero__level-pill" aria-busy={loading || undefined}>
          {loading || !snapshot ? "·" : t("achievements.levelBadge", { n: snapshot.level.level })}
        </span>
      </div>
      <h1 class="achievements-hero__rank">
        {loading || !snapshot ? "…" : snapshot.level.title}
      </h1>

      <div
        class="achievements-hero__xp"
        aria-label={t("achievements.xpAria")}
        aria-busy={loading}
      >
        <div
          class="achievements-xp__track"
          role="progressbar"
          aria-valuenow={loading || !snapshot ? undefined : snapshot.progress.pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={loading || !snapshot
            ? t("achievements.xpLoadingAria")
            : t("achievements.xpProgressAria", { pct: snapshot.progress.pct })}
        >
          {#if loading || !snapshot}
            <div class="achievements-xp__fill achievements-xp__fill--shimmer"></div>
          {:else}
            <div
              class="achievements-xp__fill"
              style="width: {snapshot.progress.pct}%"
            ></div>
          {/if}
        </div>
        <p class="achievements-hero__xp-caption">
          {#if loading || !snapshot}
            {t("achievements.xpLoadingHint")}
          {:else}
            <strong>{snapshot.totalXp}</strong>
            {` ${t("achievements.xpLabel")} · `}
            {t("achievements.xpToNext", {
              n: Math.max(0, snapshot.level.xpMax + 1 - snapshot.totalXp),
            })}
          {/if}
        </p>
      </div>

      <ul class="achievements-hero__stats" aria-label={t("achievements.metricsAria")}>
        <li>
          <strong>{loading || !snapshot ? "—" : snapshot.signals.totalPlays}</strong>
          <span>{t("achievements.metricPlays")}</span>
        </li>
        <li>
          <strong>
            {loading || !snapshot ? "—" : snapshot.signals.artistsWithPlays}
          </strong>
          <span>{t("achievements.metricArtists")}</span>
        </li>
        <li>
          <strong>
            {loading || !snapshot ? "—" : snapshot.signals.favoritesCount}
          </strong>
          <span>{t("achievements.metricFavorites")}</span>
        </li>
        <li>
          <strong>
            {loading || !snapshot
              ? "—"
              : `${unlocked}/${snapshot.achievements.length}`}
          </strong>
          <span>{t("achievements.metricBadges")}</span>
        </li>
        <li
          class="achievements-hero__stat-streak"
          title={t("achievements.streakTitle")}
        >
          <strong>{loading || !snapshot ? "—" : snapshot.streak}</strong>
          <span>{t("achievements.streakDays")}</span>
        </li>
      </ul>

      <div class="achievements-hero__actions">
        <Button
          onclick={() => {
            session.studioPane = "listen";
            session.navigate("studio");
          }}
        >
          <UiIcon name="headphones" />
          {t("achievements.ctaListen")}
        </Button>
        <Button variant="ghost" onclick={() => session.navigate("statistics")}>
          <UiIcon name="chart" />
          {t("achievements.ctaStats")}
        </Button>
      </div>
    </section>
  </header>

  {#if loadError}
    <div class="achievements-page__error rk-surface-card" role="alert">
      <p>{t("achievements.loadError")}</p>
      <button type="button" class="rk-btn rk-btn--secondary rk-btn--sm" onclick={() => void load()}>
        <UiIcon name="sync" />
        {t("achievements.retry")}
      </button>
    </div>
  {/if}

  <div class="achievements-page__main view-page__main" aria-busy={loading}>
    {#if nextUp.length}
      <Panel title={t("achievements.nextTitle")} class="achievements-board">
        <ul class="achievements-next">
          {#each nextUp as ach (ach.id)}
            <li class="achievements-next__item" title={badgeTooltip(ach)}>
              <UiIcon name={iconName(ach.icon)} class="achievements-next__ic" />
              <span class="achievements-next__title">{t(ach.titleKey)}</span>
              <span class="achievements-next__meta">
                {ach.requirement
                  ? requirementText(ach.requirement)
                  : t("achievements.progressOf", { value: ach.progress.value, target: ach.progress.target })}
              </span>
              <span class="achievements-next__bar" aria-hidden="true"><span style="width: {ach.progress.pct}%"></span></span>
            </li>
          {/each}
        </ul>
      </Panel>
    {/if}
    <Panel title={t("achievements.boardTitle")} class="achievements-board">
      {#snippet actions()}
        <p class="achievements-board__lead">
          {#if loading || !snapshot}
            …
          {:else}
            {t("achievements.boardLead", { n: unlocked, total: snapshot.achievements.length })}
          {/if}
        </p>
      {/snippet}
      <ul class="achievements-badge-grid">
        {#each snapshot?.achievements ?? [] as ach (ach.id)}
          {@const title = t(ach.titleKey)}
          <li
            class="achievements-badge"
            class:achievements-badge--unlocked={ach.unlocked}
            class:achievements-badge--locked={!ach.unlocked}
            aria-label={ach.unlocked
              ? t("achievements.achUnlockedAria", { title })
              : t("achievements.achLockedAria", { title })}
            title={badgeTooltip(ach)}
          >
            <span class="achievements-badge__icon" aria-hidden="true">
              <UiIcon
                name={iconName(ach.icon)}
                class="achievements-badge__ic"
              />
            </span>
            <div class="achievements-badge__body">
              <h3>{title}</h3>
              <p>{t(ach.descKey)}</p>
              <span class="achievements-badge__xp">+{ach.xpBonus} XP</span>
              {#if !ach.unlocked}
                <span class="achievements-badge__progress" aria-hidden="true">
                  <span class="achievements-badge__progress-bar" style="width: {ach.progress.pct}%"></span>
                </span>
                <span class="achievements-badge__progress-text">
                  {ach.requirement
                    ? requirementText(ach.requirement)
                    : t("achievements.progressOf", { value: ach.progress.value, target: ach.progress.target })}
                </span>
              {/if}
            </div>
            <span
              class="achievements-badge__state"
              class:achievements-badge__state--unlocked={ach.unlocked}
              class:achievements-badge__state--locked={!ach.unlocked}
              aria-hidden="true"
            >
              {ach.unlocked ? "✓" : "○"}
            </span>
          </li>
        {/each}
      </ul>
    </Panel>
  </div>
</div>

<style>
  .achievements-page__error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--rk-space-lg);
    flex-wrap: wrap;
    padding: var(--rk-space-lg) var(--rk-space-xl);
    border-color: color-mix(in srgb, var(--rk-danger) 40%, var(--rk-line));
    background: color-mix(in srgb, var(--rk-danger-soft) 60%, var(--rk-surface));
  }

  .achievements-page__error p {
    margin: 0;
    font-size: var(--rk-fs-sm);
    color: var(--rk-ink);
  }
</style>
