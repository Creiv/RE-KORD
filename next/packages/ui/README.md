# `@rekord/ui`

Componenti grafici condivisi RE-KORD. Usarli per ogni controllo UI (niente markup grezzo ripetuto nelle view).

## Primitives

- `Button`, `TextInput`, `Select`, `IconButton`, `NavButton`
- `Banner`, `Panel`, `Field`, `ActionRow`, `SearchBar`
- `BrandMark`, `PageHeader`, `StatList`, `EmptyState`

## Uso

```svelte
<script>
  import { Button, Panel, TextInput } from "@rekord/ui";
</script>

<Panel title="Esempio">
  <TextInput bind:value={name} />
  <Button onclick={save}>Salva</Button>
</Panel>
```

Token CSS: `@import "@rekord/ui/styles/tokens.css"`.

Look base: **Midnight** (dark, coral `#ff8f5c` + cyan `#64d4ff`, Inter, radius 4–8px), ispirato a RE-KORD 5.0 ma senza glass multi-layer.

Tema admin server: attributo `data-theme="server"` sul root (stessa famiglia, accenti invertiti).
