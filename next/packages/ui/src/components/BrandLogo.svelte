<script lang="ts">
  let {
    size = "md",
    decorative = true,
  }: {
    size?: "sm" | "md" | "lg";
    decorative?: boolean;
  } = $props();
</script>

<img
  class="rk-logo {size}"
  src="/REKORDlogo.png"
  alt={decorative ? "" : "RE-KORD"}
  decoding="async"
  draggable="false"
/>

<style>
  .rk-logo {
    display: block;
    object-fit: contain;
    user-select: none;
  }

  .sm {
    width: 28px;
    height: 28px;
  }

  .md {
    width: 32px;
    height: 32px;
  }

  .lg {
    width: 48px;
    height: 48px;
  }
</style>
