<script lang="ts">
  import { ActionRow, Button, Field, Panel, TextInput } from "@rekord/ui";

  let {
    musicRoot = $bindable(""),
    busy = false,
    onsave,
    onscan,
  }: {
    musicRoot?: string;
    busy?: boolean;
    onsave: () => void;
    onscan: () => void;
  } = $props();
</script>

<Panel title="Libreria">
  <Field label="Percorso cartella musica">
    <TextInput bind:value={musicRoot} placeholder="/path/to/Music" />
  </Field>
  <ActionRow>
    <Button disabled={busy || !musicRoot.trim()} onclick={onsave}>Salva percorso</Button>
    <Button variant="secondary" disabled={busy} onclick={onscan}>Avvia scan</Button>
  </ActionRow>
</Panel>
