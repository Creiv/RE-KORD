<script lang="ts">
  import { Button, Panel, StatList, type StatItem } from "@rekord/ui";

  let {
    items = [],
    busy = false,
    onrefresh,
  }: {
    items?: StatItem[];
    busy?: boolean;
    onrefresh: () => void;
  } = $props();
</script>

<Panel title="Stato">
  <StatList {items} />
  <Button variant="secondary" disabled={busy} onclick={onrefresh}>Aggiorna</Button>
</Panel>
