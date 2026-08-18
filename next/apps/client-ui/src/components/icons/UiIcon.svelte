<script lang="ts">
  /** Icone Material-like allineate a RekordUiIcons del vecchio app. */
  let {
    name,
    class: className = "",
  }: {
    name:
      | "home"
      | "disc"
      | "list"
      | "queueMusic"
      | "favorite"
      | "settings"
      | "search"
      | "sync"
      | "play"
      | "pause"
      | "prev"
      | "next"
      | "chevronLeft"
      | "chevronRight"
      | "shuffle"
      | "repeat"
      | "radio"
      | "plectrum"
      | "person"
      | "album"
      | "music"
      | "more"
      | "close"
      | "note"
      | "edit"
      | "image"
      | "sparkle"
      | "exclude"
      | "add"
      | "history"
      | "date"
      | "sortByAlpha"
      | "chart"
      | "trophy"
      | "style"
      | "palette"
      | "download"
      | "build"
      | "dragHandle"
      | "headphones";
    class?: string;
  } = $props();
</script>

<svg class="ui-ic {className}" viewBox="0 0 24 24" aria-hidden="true">
  {#if name === "home"}
    <path
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linejoin="round"
      d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1h-5v-6H10v6H5a1 1 0 01-1-1v-9.5z"
    />
  {:else if name === "disc"}
    <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.75" />
    <circle cx="12" cy="12" r="2" fill="currentColor" />
  {:else if name === "list"}
    <path
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"
    />
  {:else if name === "queueMusic"}
    <path
      fill="currentColor"
      d="M15 6H3v2h12zm0 4H3v2h12zM3 16h8v-2H3zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6z"
    />
  {:else if name === "favorite"}
    <path
      fill="currentColor"
      d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
    />
  {:else if name === "settings"}
    <path
      fill="currentColor"
      d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96a7.03 7.03 0 00-1.69-.98l-.36-2.54A.5.5 0 0013.9 2h-3.8a.5.5 0 00-.49.42l-.36 2.54c-.61.25-1.17.57-1.69.98l-2.39-.96a.5.5 0 00-.6.22L2.65 8.84a.5.5 0 00.12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.14.24.42.33.66.22l2.39-.96c.52.4 1.08.73 1.69.98l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.61-.25 1.17-.57 1.69-.98l2.39.96c.24.1.52 0 .66-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"
    />
  {:else if name === "search"}
    <path
      fill="currentColor"
      d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5m-6 0C8.01 14 6 11.99 6 9.5S8.01 5 10.5 5 15 7.01 15 9.5 12.99 14 9.5 14"
    />
  {:else if name === "sync"}
    <path
      fill="currentColor"
      d="M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8A5.87 5.87 0 016 12c0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z"
    />
  {:else if name === "play"}
    <path fill="currentColor" d="M8 5v14l11-7L8 5z" />
  {:else if name === "pause"}
    <path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
  {:else if name === "prev"}
    <path fill="currentColor" d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z" />
  {:else if name === "next"}
    <path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
  {:else if name === "chevronLeft"}
    <path
      fill="currentColor"
      d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"
    />
  {:else if name === "chevronRight"}
    <path
      fill="currentColor"
      d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"
    />
  {:else if name === "shuffle"}
    <path
      fill="currentColor"
      d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 8.17l-1.41 1.41 3.13 3.13L15.5 20H20v-4.5l-2.04 2.04-3.13-3.12z"
    />
  {:else if name === "repeat"}
    <path
      fill="currentColor"
      d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"
    />
  {:else if name === "radio"}
    <path
      fill="currentColor"
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M20.432 4.103a.75.75 0 0 0-.364-1.456L4.128 6.632l-.2.033C2.498 6.904 1.5 8.158 1.5 9.574v9.176a3 3 0 0 0 3 3h15a3 3 0 0 0 3-3V9.574c0-1.416-.997-2.67-2.429-2.909a49.017 49.017 0 0 0-7.255-.658l7.616-1.904Zm-9.585 8.56a.75.75 0 0 1 0 1.06l-.005.006a.75.75 0 0 1-1.06 0l-.006-.006a.75.75 0 0 1 0-1.06l.005-.005a.75.75 0 0 1 1.06 0l.006.005ZM9.781 15.85a.75.75 0 0 0 1.061 0l.005-.005a.75.75 0 0 0 0-1.061l-.005-.005a.75.75 0 0 0-1.06 0l-.006.005a.75.75 0 0 0 0 1.06l.005.006Zm-1.055-1.066a.75.75 0 0 1 0 1.06l-.005.006a.75.75 0 0 1-1.061 0l-.005-.005a.75.75 0 0 1 0-1.06l.005-.006a.75.75 0 0 1 1.06 0l.006.005ZM7.66 13.73a.75.75 0 0 0 1.061 0l.005-.006a.75.75 0 0 0 0-1.06l-.005-.006a.75.75 0 0 0-1.06 0l-.006.006a.75.75 0 0 0 0 1.06l.005.006ZM9.255 9.75a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75h-.008a.75.75 0 0 1-.75-.75V10.5a.75.75 0 0 1 .75-.75h.008Zm3.624 3.28a.75.75 0 0 0 .275-1.025L13.15 12a.75.75 0 0 0-1.025-.275l-.006.004a.75.75 0 0 0-.275 1.024l.004.007a.75.75 0 0 0 1.025.274l.006-.003Zm-1.38 5.126a.75.75 0 0 1-1.024-.275l-.004-.006a.75.75 0 0 1 .275-1.025l.006-.004a.75.75 0 0 1 1.025.275l.004.007a.75.75 0 0 1-.275 1.024l-.006.004Zm.282-6.776a.75.75 0 0 0-.274-1.025l-.007-.003a.75.75 0 0 0-1.024.274l-.004.007a.75.75 0 0 0 .274 1.024l.007.004a.75.75 0 0 0 1.024-.275l.004-.006Zm1.369 5.129a.75.75 0 0 1-1.025.274l-.006-.004a.75.75 0 0 1-.275-1.024l.004-.007a.75.75 0 0 1 1.025-.274l.006.004a.75.75 0 0 1 .275 1.024l-.004.007Zm-.145-1.502a.75.75 0 0 0 .75-.75v-.007a.75.75 0 0 0-.75-.75h-.008a.75.75 0 0 0-.75.75v.007c0 .415.336.75.75.75h.008Zm-3.75 2.243a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75h-.008a.75.75 0 0 1-.75-.75V18a.75.75 0 0 1 .75-.75h.008Zm-2.871-.47a.75.75 0 0 0 .274-1.025l-.003-.006a.75.75 0 0 0-1.025-.275l-.006.004a.75.75 0 0 0-.275 1.024l.004.007a.75.75 0 0 0 1.024.274l.007-.003Zm1.366-5.12a.75.75 0 0 1-1.025-.274l-.004-.006a.75.75 0 0 1 .275-1.025l.006-.004a.75.75 0 0 1 1.025.275l.004.006a.75.75 0 0 1-.275 1.025l-.006.004Zm.281 6.215a.75.75 0 0 0-.275-1.024l-.006-.004a.75.75 0 0 0-1.025.274l-.003.007a.75.75 0 0 0 .274 1.024l.007.004a.75.75 0 0 0 1.024-.274l.004-.007Zm-1.376-5.116a.75.75 0 0 1-1.025.274l-.006-.003a.75.75 0 0 1-.275-1.025l.004-.007a.75.75 0 0 1 1.025-.274l.006.004a.75.75 0 0 1 .275 1.024l-.004.007Zm-1.15 2.248a.75.75 0 0 0 .75-.75v-.007a.75.75 0 0 0-.75-.75h-.008a.75.75 0 0 0-.75.75v.007c0 .415.336.75.75.75h.008ZM17.25 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm1.5 6a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z"
    />
  {:else if name === "plectrum"}
    <path
      fill="currentColor"
      d="M12 21.8C11 21.8 10 20.7 8.6 18C6.8 14.5 5 10.6 5 7.8C5 5.1 7.9 3.2 12 3.2C16.1 3.2 19 5.1 19 7.8C19 10.6 17.2 14.5 15.4 18C14 20.7 13 21.8 12 21.8Z"
    />
  {:else if name === "person"}
    <path
      fill="currentColor"
      d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"
    />
  {:else if name === "album"}
    <path
      fill="currentColor"
      d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"
    />
  {:else if name === "music"}
    <path fill="currentColor" d="M12 3v10.55A4 4 0 1 0 14 15.5V7h4V3h-6z" />
  {:else if name === "more"}
    <circle cx="12" cy="6" r="1.8" fill="currentColor" />
    <circle cx="12" cy="12" r="1.8" fill="currentColor" />
    <circle cx="12" cy="18" r="1.8" fill="currentColor" />
  {:else if name === "close"}
    <path
      fill="currentColor"
      d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
    />
  {:else if name === "note"}
    <path
      fill="currentColor"
      d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm1 13H9v-2h6v2zm0-4H9V9h6v2zm-2-5V3.5L18.5 9H13z"
    />
  {:else if name === "edit"}
    <path
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
    />
  {:else if name === "image"}
    <path
      fill="currentColor"
      d="M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"
    />
  {:else if name === "sparkle"}
    <path
      fill="currentColor"
      d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"
    />
  {:else if name === "exclude"}
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
    <path
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      d="M5.5 5.5l13 13"
    />
  {:else if name === "add"}
    <path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
  {:else if name === "history"}
    <path
      fill="currentColor"
      d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9m-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8z"
    />
  {:else if name === "date"}
    <path
      fill="currentColor"
      d="M9 11H7v2h2zm4 0h-2v2h2zm4 0h-2v2h2zm2-7h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2m0 16H5V9h14z"
    />
  {:else if name === "sortByAlpha"}
    <path
      fill="currentColor"
      d="M14.94 4.66h-4.72l2.36-2.36zm-4.69 14.71h4.66l-2.33 2.33zM6.1 6.27 1.6 17.73h1.84l.92-2.45h5.11l.92 2.45h1.84L7.74 6.27zm-1.13 7.37 1.94-5.18 1.94 5.18zm10.76 2.5h6.12v1.59h-8.53v-1.29l5.92-8.56h-5.88v-1.6h8.3v1.26z"
    />
  {:else if name === "chart"}
    <path fill="currentColor" d="M4 9h4v11H4zm12 4h4v7h-4zm-6-9h4v16h-4z" />
  {:else if name === "trophy"}
    <path
      fill="currentColor"
      d="M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94.63 1.5 1.98 2.63 3.61 2.96V19H7v2h10v-2h-2v-3.1c1.63-.33 2.98-1.46 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2M5 8V7h2v3.82C5.84 10.4 5 9.3 5 8m14 0c0 1.3-.84 2.4-2 2.82V7h2z"
    />
  {:else if name === "style"}
    <path
      fill="currentColor"
      d="m2.53 19.65 1.34.56v-9.03l-2.43 5.86c-.41 1.02.08 2.19 1.09 2.61m19.5-3.7L17.07 3.98c-.31-.75-1.04-1.21-1.81-1.23-.26 0-.53.04-.79.15L7.1 5.95c-.75.31-1.21 1.03-1.23 1.8-.01.27.04.54.15.8l4.96 11.97c.31.76 1.05 1.22 1.83 1.23.26 0 .52-.05.77-.15l7.36-3.05c1.02-.42 1.51-1.59 1.09-2.6M7.88 8.75c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1m-2 11c0 1.1.9 2 2 2h1.45l-3.45-8.34z"
    />
  {:else if name === "palette"}
    <path
      fill="currentColor"
      d="M12 3C7.03 3 3 7.03 3 12s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zM6.5 12c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9s1.5.67 1.5 1.5S7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 11 17.5 11s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"
    />
  {:else if name === "download"}
    <path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
  {:else if name === "build"}
    <path
      fill="currentColor"
      d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"
    />
  {:else if name === "dragHandle"}
    <circle cx="9" cy="6" r="1.6" fill="currentColor" />
    <circle cx="15" cy="6" r="1.6" fill="currentColor" />
    <circle cx="9" cy="12" r="1.6" fill="currentColor" />
    <circle cx="15" cy="12" r="1.6" fill="currentColor" />
    <circle cx="9" cy="18" r="1.6" fill="currentColor" />
    <circle cx="15" cy="18" r="1.6" fill="currentColor" />
  {:else if name === "headphones"}
    <path
      fill="currentColor"
      d="M12 1a9 9 0 00-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7a9 9 0 00-9-9z"
    />
  {/if}
</svg>

<style>
  .ui-ic {
    width: var(--ui-ic-size, 1.25rem);
    height: var(--ui-ic-size, 1.25rem);
    display: block;
    flex-shrink: 0;
  }
</style>
