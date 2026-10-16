<script lang="ts">
  /**
   * Two-mode switch with a label on each side (Classico / Esplora, Locale / Web).
   * Each label is a toggle button (`aria-pressed`) that selects its own mode,
   * so clicking a word never flips to the other one; the track in the middle
   * is the same control for the pointer and flips the mode. Keyboard: Tab to a
   * label, Enter / Space to pick it, ←/→ to move between the two.
   */
  type Props = {
    /** Group label for assistive tech ("Modalità di download"). */
    label: string;
    left: string;
    right: string;
    /** The right-hand mode is active. */
    rightActive: boolean;
    onchange: (rightActive: boolean) => void;
    class?: string;
  };

  let { label, left, right, rightActive, onchange, class: cls = "" }: Props = $props();

  let leftBtn = $state<HTMLButtonElement | null>(null);
  let rightBtn = $state<HTMLButtonElement | null>(null);

  function pick(toRight: boolean) {
    if (toRight !== rightActive) onchange(toRight);
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const toRight = e.key === "ArrowRight";
    pick(toRight);
    (toRight ? rightBtn : leftBtn)?.focus();
  }
</script>

<div class="tools-dl-studio-switch {cls}" role="group" aria-label={label}>
  <button
    type="button"
    class="tools-dl-studio-switch__label"
    class:is-active={!rightActive}
    aria-pressed={!rightActive}
    bind:this={leftBtn}
    onclick={() => pick(false)}
    {onkeydown}
  >
    {left}
  </button>
  <button
    type="button"
    class="tools-dl-studio-switch__track"
    data-on={rightActive}
    aria-hidden="true"
    tabindex="-1"
    onclick={() => onchange(!rightActive)}
  >
    <span class="tools-dl-studio-switch__thumb"></span>
  </button>
  <button
    type="button"
    class="tools-dl-studio-switch__label"
    class:is-active={rightActive}
    aria-pressed={rightActive}
    bind:this={rightBtn}
    onclick={() => pick(true)}
    {onkeydown}
  >
    {right}
  </button>
</div>
