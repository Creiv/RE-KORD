<script lang="ts">
  import { Button, IconButton } from "@rekord/ui";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";

  let open = $state(false);
  let now = $state(Date.now());
  let custom = $state("45");

  $effect(() => {
    if (!session.sleepTimerEndsAt) return;
    now = Date.now();
    const id = window.setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => window.clearInterval(id);
  });

  const remaining = $derived(
    session.sleepTimerEndsAt
      ? Math.max(0, session.sleepTimerEndsAt - now)
      : 0,
  );
  const active = $derived(Boolean(session.sleepTimerEndsAt && remaining > 0));
  const label = $derived.by(() => {
    if (!active) return "Timer";
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    return `${m}:${s.toString().padStart(2, "0")}`;
  });
</script>

<div class="wrap">
  <IconButton
    label="Sleep timer"
    active={active}
    onclick={() => (open = !open)}
  >
    ⏱
  </IconButton>
  {#if open}
    <div class="pop">
      <strong>{active ? `Resta ${label}` : "Sleep timer"}</strong>
      <div class="row">
        {#each [15, 30, 60] as m}
          <Button variant="ghost" onclick={() => { player.setSleepTimer(m); open = false; }}>
            {m}m
          </Button>
        {/each}
      </div>
      <div class="row">
        <input
          type="number"
          min="1"
          max="600"
          bind:value={custom}
          aria-label="Minuti personalizzati"
        />
        <Button
          onclick={() => {
            const n = Number(custom);
            if (n > 0) {
              player.setSleepTimer(n);
              open = false;
            }
          }}
        >
          Avvia
        </Button>
      </div>
      {#if active}
        <Button variant="ghost" onclick={() => { player.setSleepTimer(null); open = false; }}>
          Annulla
        </Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
  }

  .pop {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    z-index: 10;
    width: 12rem;
    display: grid;
    gap: 0.45rem;
    padding: 0.65rem;
    background: var(--rk-surface);
    border: 1px solid var(--rk-line);
    border-radius: var(--rk-radius);
    box-shadow: var(--rk-shadow);
  }

  .row {
    display: flex;
    gap: 0.35rem;
    align-items: center;
  }

  input {
    width: 4rem;
    border: 1px solid var(--rk-line);
    background: var(--rk-surface-3);
    color: inherit;
    border-radius: var(--rk-radius-sm);
    padding: 0.3rem;
    font: inherit;
  }

  strong {
    font-size: 0.85rem;
  }
</style>
