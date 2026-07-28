<script lang="ts">
  /** Stub grafico lyrics: off / plain / lrc (nessun LRC wired). */
  let {
    kind = "off" as "off" | "plain" | "lrc",
    class: className = "",
  }: {
    kind?: "off" | "plain" | "lrc";
    class?: string;
  } = $props();
</script>

<span
  class="track-row__lyrics-inline {className}"
  class:is-off={kind === "off"}
  class:is-plain={kind === "plain"}
  class:is-lrc={kind === "lrc"}
  title={kind === "lrc"
    ? "Lyrics sincronizzate (LRC) presenti"
    : kind === "plain"
      ? "Lyrics presenti (non LRC)"
      : "Lyrics non presenti"}
  aria-hidden="true"
>
  <svg viewBox="0 0 24 24" fill="currentColor">
    {#if kind === "lrc"}
      <path
        d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6zM4 19h10v2H4v-2zm0-4h7v2H4v-2z"
      />
    {:else}
      <path
        d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm-1 13H9v-2h4v2zm0-4H9V9h4v2zm-1-5V3.5L18.5 9H12z"
      />
    {/if}
  </svg>
</span>
