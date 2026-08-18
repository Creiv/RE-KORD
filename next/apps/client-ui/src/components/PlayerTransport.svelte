<script lang="ts">
  import { IconButton } from "@rekord/ui";
  import { t } from "../lib/i18n.svelte";
  import type { RepeatMode } from "../lib/player";
  import UiIcon from "./icons/UiIcon.svelte";

  let {
    playing = false,
    shuffle = false,
    repeat = "off" as RepeatMode,
    favorited = false,
    excluded = false,
    excludeLocked = false,
    ontoggle,
    onprev,
    onnext,
    ontoggleShuffle,
    oncycleRepeat,
    ontoggleFavorite,
    ontoggleExclude,
  }: {
    playing?: boolean;
    shuffle?: boolean;
    repeat?: RepeatMode;
    favorited?: boolean;
    excluded?: boolean;
    excludeLocked?: boolean;
    ontoggle: () => void;
    onprev: () => void;
    onnext: () => void;
    ontoggleShuffle: () => void;
    oncycleRepeat: () => void;
    ontoggleFavorite: () => void;
    ontoggleExclude?: () => void;
  } = $props();
</script>

<div class="transport">
  <IconButton
    bare
    tone="danger"
    label={t("player.favorite")}
    active={favorited}
    onclick={ontoggleFavorite}
  >
    <UiIcon name="favorite" />
  </IconButton>
  <IconButton
    bare
    label={t("player.repeat")}
    active={repeat !== "off"}
    onclick={oncycleRepeat}
  >
    <UiIcon name="repeat" />
    {#if repeat === "one"}<span class="one">1</span>{/if}
  </IconButton>
  <IconButton bare label={t("player.prev")} onclick={onprev}>
    <UiIcon name="prev" />
  </IconButton>
  <IconButton label={t("player.playPause")} emphasis onclick={ontoggle}>
    <UiIcon name={playing ? "pause" : "play"} />
  </IconButton>
  <IconButton bare label={t("player.next")} onclick={onnext}>
    <UiIcon name="next" />
  </IconButton>
  <IconButton bare label={t("player.shuffle")} active={shuffle} onclick={ontoggleShuffle}>
    <UiIcon name="shuffle" />
  </IconButton>
  {#if ontoggleExclude}
    <IconButton
      bare
      tone="danger"
      label={excludeLocked
        ? t("player.excludeLocked")
        : excluded
          ? t("player.excludeOn")
          : t("player.excludeOff")}
      active={excluded || excludeLocked}
      disabled={excludeLocked}
      onclick={ontoggleExclude}
    >
      <UiIcon name="exclude" />
    </IconButton>
  {/if}
</div>

<style>
  .transport {
    display: inline-flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: center;
    gap: 0.42rem;
    min-width: 0;
    position: relative;
  }

  .one {
    position: absolute;
    font-size: 0.52rem;
    font-weight: 800;
    margin-left: 0.85rem;
    margin-top: 0.55rem;
    pointer-events: none;
  }
</style>
