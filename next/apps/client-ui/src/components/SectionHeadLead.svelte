<script lang="ts">
  let {
    eyebrow = "",
    title = "",
    flatIcon = true,
    children,
  }: {
    eyebrow?: string;
    title?: string;
    /** Icona flat come old (default). false = soft badge. */
    flatIcon?: boolean;
    children?: import("svelte").Snippet;
  } = $props();
</script>

<div class="section-head__lead section-head-lead">
  {#if children}
    <span
      class="section-head__icon-wrap"
      class:section-head__icon-wrap--soft={!flatIcon}
      aria-hidden="true"
    >
      {@render children()}
    </span>
  {/if}
  <div class="section-head__text section-head-lead__text">
    {#if eyebrow}
      <p class="rk-eyebrow">{eyebrow}</p>
    {/if}
    {#if title}
      <h2>{title}</h2>
    {/if}
  </div>
</div>

<style>
  .section-head__icon-wrap--soft {
    width: 2.4rem;
    height: 2.4rem;
    border-radius: var(--rk-radius);
    background: var(--rk-accent2-soft);
  }

  .section-head__icon-wrap--soft :global(svg) {
    width: 1.25rem;
    height: 1.25rem;
  }
</style>
