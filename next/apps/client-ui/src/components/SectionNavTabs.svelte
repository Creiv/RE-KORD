<script lang="ts">
  type Tab = { id: string; label: string };

  let {
    tabs,
    active,
    ariaLabel = "Sezioni",
    size = "md" as "md" | "sm",
    even = false,
    onselect,
  }: {
    tabs: Tab[];
    active: string;
    ariaLabel?: string;
    size?: "md" | "sm";
    /** Distribuisce i tab a tutta larghezza (es. Studio); Library resta flex-start */
    even?: boolean;
    onselect: (id: string) => void;
  } = $props();
</script>

<div
  class="section-nav-tabs"
  class:section-nav-tabs--sm={size === "sm"}
  class:section-nav-tabs--even={even}
  role="group"
  aria-label={ariaLabel}
>
  {#each tabs as tab}
    <button
      type="button"
      class="section-nav-tab"
      class:is-on={active === tab.id}
      onclick={() => onselect(tab.id)}
    >
      {tab.label}
    </button>
  {/each}
</div>

<style>
  .section-nav-tabs {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.25rem 1.15rem;
    justify-content: flex-start;
    min-width: 0;
  }

  .section-nav-tabs--even {
    justify-content: space-evenly;
    width: 100%;
  }

  .section-nav-tab {
    position: relative;
    margin: 0;
    padding: 0.12rem 0;
    border: none;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: 1.32rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.2;
    color: color-mix(in srgb, var(--rk-muted) 78%, var(--rk-ink) 22%);
    transition: color 0.16s ease;
  }

  .section-nav-tabs--sm {
    gap: 0.2rem 0.85rem;
  }

  .section-nav-tabs--sm .section-nav-tab {
    font-size: 0.86rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    padding: 0.1rem 0;
  }

  .section-nav-tab:hover:not(.is-on) {
    color: color-mix(in srgb, var(--rk-muted-strong) 85%, var(--rk-ink) 15%);
  }

  .section-nav-tab.is-on {
    color: var(--rk-ink);
  }

  .section-nav-tab.is-on::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: -0.06rem;
    height: 2px;
    border-radius: 99px;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--rk-accent) 85%, transparent),
      color-mix(in srgb, var(--rk-accent-2) 85%, transparent)
    );
  }

  .section-nav-tabs--sm .section-nav-tab.is-on::after {
    bottom: -0.08rem;
  }

  .section-nav-tab:focus-visible {
    outline: 2px solid var(--rk-focus);
    outline-offset: 4px;
    border-radius: 6px;
  }
</style>
