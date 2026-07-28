<script lang="ts">
  import UiIcon from "./icons/UiIcon.svelte";
  import { player } from "../lib/player";
  import { session } from "../lib/session.svelte";

  const PRESETS = [15, 30, 60] as const;

  let open = $state(false);
  let now = $state(Date.now());
  let customHours = $state("0");
  let customMinutes = $state("45");
  let customError = $state(false);

  $effect(() => {
    if (!session.sleepTimerEndsAt) return;
    now = Date.now();
    const id = window.setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => window.clearInterval(id);
  });

  const remainingMs = $derived(
    session.sleepTimerEndsAt ? Math.max(0, session.sleepTimerEndsAt - now) : 0,
  );
  const active = $derived(Boolean(session.sleepTimerEndsAt && remainingMs > 0));
  const remainingLabel = $derived.by(() => {
    const totalSec = Math.floor(remainingMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }
    return `${m}:${s.toString().padStart(2, "0")}`;
  });

  function digitsOnly(value: string): string {
    return value.replace(/\D/g, "");
  }

  function startTimer(minutes: number) {
    player.setSleepTimer(minutes);
    now = Date.now();
    customError = false;
    open = false;
  }

  function startCustom() {
    const h = Number(customHours) || 0;
    const m = Number(customMinutes) || 0;
    const total = h * 60 + m;
    if (total <= 0 || h > 12) {
      customError = true;
      return;
    }
    startTimer(total);
  }
</script>

<section
  class="listen-sleep-timer"
  class:is-open={open}
  class:is-active={active}
  aria-label="Timer spegnimento"
>
  <button
    type="button"
    class="listen-sleep-timer__toggle"
    onclick={() => (open = !open)}
    aria-expanded={open}
  >
    <span class="listen-sleep-timer__toggle-main">
      <UiIcon name="history" class="listen-sleep-timer__ic" />
      <span class="listen-sleep-timer__toggle-title">Timer spegnimento</span>
      {#if active}
        <span class="listen-sleep-timer__badge" aria-live="polite">{remainingLabel}</span>
      {/if}
    </span>
    <UiIcon
      name="chevronRight"
      class="listen-sleep-timer__chev{open ? ' is-open' : ''}"
    />
  </button>

  {#if open}
    <div class="listen-sleep-timer__panel">
      <div class="listen-sleep-timer__row">
        {#each PRESETS as min}
          <button
            type="button"
            class="ghost-btn ghost-btn--sm"
            onclick={() => startTimer(min)}
          >
            {min} min
          </button>
        {/each}

        <label class="listen-sleep-timer__field">
          <span class="listen-sleep-timer__field-label">Ore</span>
          <input
            type="text"
            class="ghost-input listen-sleep-timer__input"
            inputmode="numeric"
            autocomplete="off"
            aria-label="Ore"
            value={customHours}
            oninput={(e) => {
              customError = false;
              customHours = digitsOnly(e.currentTarget.value);
            }}
          />
        </label>

        <label class="listen-sleep-timer__field">
          <span class="listen-sleep-timer__field-label">Minuti</span>
          <input
            type="text"
            class="ghost-input listen-sleep-timer__input"
            inputmode="numeric"
            autocomplete="off"
            aria-label="Minuti"
            value={customMinutes}
            oninput={(e) => {
              customError = false;
              customMinutes = digitsOnly(e.currentTarget.value);
            }}
            onkeydown={(e) => {
              if (e.key === "Enter") startCustom();
            }}
          />
        </label>

        <button type="button" class="ghost-btn ghost-btn--sm" onclick={startCustom}>
          Avvia
        </button>

        {#if active}
          <button
            type="button"
            class="text-btn listen-sleep-timer__cancel"
            onclick={() => player.setSleepTimer(null)}
          >
            Annulla
          </button>
        {/if}
      </div>
      {#if customError}
        <p class="listen-sleep-timer__error warnline" role="alert">
          Imposta un tempo valido.
        </p>
      {/if}
    </div>
  {/if}
</section>
