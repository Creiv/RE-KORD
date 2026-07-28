<script lang="ts">
  import { Button, EmptyState, Panel } from "@rekord/ui";
  import UiIcon from "../components/icons/UiIcon.svelte";
  import { session } from "../lib/session.svelte";
</script>

<section class="hero rk-surface-card">
  <div class="lead">
    <span class="badge" aria-hidden="true"><UiIcon name="plectrum" /></span>
    <div>
      <p class="rk-eyebrow">Plectr</p>
      <h2>Ritmo e gioco</h2>
      <p class="sub">
        Modalità rhythm / disco-wall — stub grafico. Si attiva con una coda in riproduzione.
      </p>
    </div>
  </div>
  <Button disabled={!session.hasQueue} title={session.hasQueue ? "In arrivo" : "Avvia prima una coda"}>
    Avvia Plectr
  </Button>
</section>

<div class="grid">
  <Panel>
    <header class="h">
      <UiIcon name="sparkle" />
      <div>
        <h3>Disco Wall</h3>
        <p>Visualizer a mosaico cover</p>
      </div>
    </header>
    <div class="mosaic" aria-hidden="true">
      {#each Array(12) as _, i}
        <span style="--i:{i}"></span>
      {/each}
    </div>
  </Panel>
  <Panel>
    <header class="h">
      <UiIcon name="music" />
      <div>
        <h3>Rhythm Mode</h3>
        <p>Input ritmico sul brano corrente</p>
      </div>
    </header>
    <EmptyState message="Gameplay in arrivo — UI pronta" />
  </Panel>
</div>

<style>
  .hero {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 0;
    padding: 1rem 1.15rem;
  }

  .lead {
    display: flex;
    gap: 0.85rem;
    align-items: flex-start;
    min-width: 0;
  }

  .badge {
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--rk-radius);
    display: grid;
    place-items: center;
    background: var(--rk-accent-soft);
    color: var(--rk-accent);
  }

  h2 {
    margin: 0;
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: -0.03em;
  }

  .sub {
    margin: 0.25rem 0 0;
    color: var(--rk-muted);
    font-size: 0.88rem;
    max-width: 36rem;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--rk-section-gap);
  }

  .h {
    display: flex;
    gap: 0.65rem;
    margin-bottom: 0.85rem;
  }

  .h :global(svg) {
    color: var(--rk-accent-2);
    margin-top: 0.1rem;
  }

  .h h3 {
    margin: 0;
    font-size: 1rem;
  }

  .h p {
    margin: 0.15rem 0 0;
    color: var(--rk-muted);
    font-size: 0.8rem;
  }

  .mosaic {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.35rem;
  }

  .mosaic span {
    aspect-ratio: 1;
    border-radius: 6px;
    background: linear-gradient(
      135deg,
      color-mix(in srgb, var(--rk-accent) calc(20% + var(--i) * 4%), var(--rk-surface-3)),
      color-mix(in srgb, var(--rk-accent-2) calc(15% + var(--i) * 3%), var(--rk-surface))
    );
    animation: pulse 2.4s ease-in-out infinite;
    animation-delay: calc(var(--i) * 0.08s);
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }

  @media (max-width: 800px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
