<script lang="ts">
  import { Button, EmptyState, Field, Panel, Select, TextInput } from "@rekord/ui";
  import { admin, humanTime } from "../lib/admin.svelte";

  const scopeOptions = [
    { value: "all", label: "Tutto" },
    { value: "system", label: "Solo hub" },
    { value: "user", label: "Solo account" },
  ];

  const entries = $derived(admin.activity);
</script>

<Panel title="Registro attività">
  {#snippet actions()}
    <Button variant="secondary" disabled={admin.busy} onclick={() => void admin.loadActivity()}>
      Aggiorna
    </Button>
  {/snippet}

  <div class="filters">
    <Field label="Giorno">
      <TextInput
        type="date"
        value={admin.activityDay}
        oninput={(e) => {
          admin.activityDay = (e.currentTarget as HTMLInputElement).value;
          void admin.loadActivity();
        }}
      />
    </Field>
    <Field label="Origine">
      <Select
        options={scopeOptions}
        value={admin.activityScope}
        onchange={(e) => {
          admin.activityScope = (e.currentTarget as HTMLSelectElement).value;
          void admin.loadActivity();
        }}
      />
    </Field>
  </div>

  {#if entries.length === 0}
    <EmptyState message="Nessuna attività in questo giorno" />
  {:else}
    <ul class="log">
      {#each entries as e}
        <li>
          <span class="ts">{humanTime(e.ts)}</span>
          <span class="kind">{e.kind}</span>
          <span class="msg">{e.message}</span>
          {#if e.accountName || e.accountId}
            <span class="who">{e.accountName ?? e.accountId}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Panel>

<style>
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: 0.6rem 1rem;
    margin-bottom: 0.9rem;
  }

  .log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    max-height: 26rem;
    overflow-y: auto;
  }

  .log li {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    gap: 0.55rem;
    align-items: baseline;
    font-size: var(--rk-fs-sm);
    padding-bottom: 0.35rem;
    border-bottom: 1px solid color-mix(in srgb, var(--rk-line) 60%, transparent);
    min-width: 0;
  }

  .ts {
    color: var(--rk-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .kind {
    font-size: var(--rk-fs-2xs);
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--rk-accent);
  }

  .msg {
    overflow-wrap: anywhere;
  }

  .who {
    color: var(--rk-muted);
    white-space: nowrap;
  }

  @media (max-width: 639.98px) {
    .log li {
      grid-template-columns: 1fr;
      gap: 0.15rem;
    }
  }
</style>
