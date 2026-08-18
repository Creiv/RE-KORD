<script lang="ts">
  import type { HTMLButtonAttributes } from "svelte/elements";

  type Variant = "primary" | "secondary" | "ghost" | "chip" | "link";

  let {
    variant = "primary",
    size = "md",
    tone = "default",
    type = "button",
    disabled = false,
    class: className = "",
    children,
    ...rest
  }: HTMLButtonAttributes & {
    variant?: Variant;
    size?: "md" | "sm";
    tone?: "default" | "danger";
    children: import("svelte").Snippet;
  } = $props();

  // Styles live in `@rekord/ui/styles/controls.css`, shared with plain markup.
  const classes = $derived(
    [
      "rk-btn",
      `rk-btn--${variant}`,
      size === "sm" ? "rk-btn--sm" : "",
      tone === "danger" ? "rk-btn--danger" : "",
      className,
    ]
      .filter(Boolean)
      .join(" "),
  );
</script>

<button class={classes} {type} {disabled} {...rest}>
  {@render children()}
</button>
