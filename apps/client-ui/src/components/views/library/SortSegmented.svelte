<script lang="ts">
  /** Sort toggle for library grids (Data / Aggiunti / Nome / Ascolti), one size everywhere. */
  import { Segmented } from "@rekord/ui";
  import UiIcon from "../../icons/UiIcon.svelte";
  import { t } from "../../../lib/i18n.svelte";

  type SortKey = "date" | "added" | "name" | "plays";

  let {
    value,
    keys = ["name", "plays"],
    ariaLabel,
    onchange,
  }: {
    value: SortKey;
    keys?: SortKey[];
    ariaLabel: string;
    onchange: (value: SortKey) => void;
  } = $props();

  const LABEL: Record<SortKey, string> = {
    date: "library.sortDate",
    added: "library.sortAdded",
    name: "library.sortName",
    plays: "library.sortPlays",
  };
  const ICON = { date: "date", added: "history", name: "sortByAlpha", plays: "chart" } as const;
</script>

<Segmented
  {ariaLabel}
  {value}
  onchange={(v) => onchange(v as SortKey)}
  options={keys.map((k) => ({ value: k, label: t(LABEL[k]) }))}
>
  {#snippet icon(opt)}<UiIcon name={ICON[opt.value as SortKey]} />{/snippet}
</Segmented>
