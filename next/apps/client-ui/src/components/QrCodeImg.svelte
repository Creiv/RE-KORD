<script lang="ts">
  import { onDestroy } from "svelte";

  let {
    value,
    size = 220,
    alt = "",
    class: className = "",
  }: {
    value: string;
    size?: number;
    alt?: string;
    class?: string;
  } = $props();

  let dataUrl = $state<string | null>(null);
  let gen = 0;

  $effect(() => {
    const v = value;
    const s = size;
    const id = ++gen;
    dataUrl = null;
    if (!v) return;

    let cancelled = false;
    void (async () => {
      try {
        const QRCode = (await import("qrcode")).default;
        const url = await QRCode.toDataURL(v, {
          width: s,
          margin: 2,
          errorCorrectionLevel: "M",
          color: { dark: "#000000", light: "#ffffff" },
        });
        if (!cancelled && id === gen) dataUrl = url;
      } catch {
        if (!cancelled && id === gen) dataUrl = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
    gen += 1;
  });
</script>

{#if dataUrl}
  <img src={dataUrl} width={size} height={size} class={className} {alt} />
{/if}
