<script lang="ts">
  import type { TrackMoodId } from "../lib/trackMoods";
  import { TRACK_MOOD_COLORS } from "../lib/trackMoods";

  let {
    mood = null as TrackMoodId | null,
    class: className = "",
    /** Usa currentColor del genitore (filtri: spento → acceso via CSS del bottone). */
    inheritColor = false,
  }: {
    mood?: TrackMoodId | null;
    class?: string;
    inheritColor?: boolean;
  } = $props();

  const color = $derived(
    inheritColor || !mood ? "currentColor" : TRACK_MOOD_COLORS[mood],
  );
</script>

<span class="mood-g {className}" aria-hidden="true" style="color:{color}">
  {#if mood === "energy_boost"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" />
    </svg>
  {:else if mood === "party_dance"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  {:else if mood === "chill_relax"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
      <path d="M2 21c0-4 4-8 9-8" />
    </svg>
  {:else if mood === "focus_study"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  {:else if mood === "romantic_intimacy"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" />
    </svg>
  {:else if mood === "sad_melancholy"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 14.899A7 7 0 0 1 9.2 4.2 7 7 0 0 1 15.71 8h1.79a4.5 4.5 0 0 1 3.5 7.33" />
      <path d="M8 19v2" />
      <path d="M12 19v2" />
      <path d="M16 19v2" />
    </svg>
  {:else if mood === "dark_tense"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  {:else if mood === "aggressive_heavy"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 1.98Q1.22 13.12 9.05 21.9Q12 22.82 14.95 21.9Q22.78 13.12 12 1.98z" />
      <path d="M12 10.2Q5.85 13.95 12 18.38Q18.15 13.95 12 10.2z" />
    </svg>
  {:else if mood === "dreamy_ethereal"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z" />
    </svg>
  {:else if mood === "epic_cinematic"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M7 3v18" />
      <path d="M17 3v18" />
      <path d="M3 9.5h4" />
      <path d="M3 14.5h4" />
      <path d="M17 9.5h4" />
      <path d="M17 14.5h4" />
    </svg>
  {:else if mood === "nostalgia_retro"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  {:else if mood === "fun_quirky"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <path d="M9 9h.01" />
      <path d="M15 9h.01" />
    </svg>
  {:else if mood === "soulful_groovy"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 10v4" />
      <path d="M6 6v12" />
      <path d="M10 3v18" />
      <path d="M14 8v8" />
      <path d="M18 5v14" />
      <path d="M22 10v4" />
    </svg>
  {:else if mood === "motivational_drive"}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 19h16" />
      <path d="m6 15 4-4 3 2 5-6" />
      <path d="m15 7h3v3" />
    </svg>
  {:else}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="5" y="5" width="14" height="14" rx="2" stroke-dasharray="3 2" />
    </svg>
  {/if}
</span>

<style>
  .mood-g {
    display: inline-flex;
    width: 0.95rem;
    height: 0.95rem;
    flex-shrink: 0;
  }

  .mood-g svg {
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
