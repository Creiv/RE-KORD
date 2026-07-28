<script lang="ts">
  import { onMount } from "svelte";
  import AppShell from "./components/AppShell.svelte";
  import { session } from "./lib/session.svelte";

  onMount(() => {
    const unsub = session.bindPlayer();
    void session.bootstrap();
    return unsub;
  });
</script>

<AppShell />
