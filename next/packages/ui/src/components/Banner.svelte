<script lang="ts">
  type Tone = "ok" | "error" | "info";

  let {
    tone = "info",
    children,
  }: {
    tone?: Tone;
    children: import("svelte").Snippet;
  } = $props();
</script>

<p class="rk-banner {tone}" role="status">
  {@render children()}
</p>

<style>
  .rk-banner {
    margin: 0;
    padding: 0.65rem 0.85rem;
    border-radius: var(--rk-radius);
    border: 1px solid var(--rk-line);
    font-size: var(--rk-fs-md);
  }

  .ok {
    background: var(--rk-ok-soft);
    color: var(--rk-ok);
    border-color: color-mix(in srgb, var(--rk-ok) 30%, transparent);
  }

  .error {
    background: var(--rk-danger-soft);
    color: var(--rk-danger);
    border-color: color-mix(in srgb, var(--rk-danger) 30%, transparent);
  }

  .info {
    background: var(--rk-accent2-soft);
    color: var(--rk-muted-strong);
  }
</style>
