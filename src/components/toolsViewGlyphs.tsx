/**
 * Glifi SVG dello Studio download (cartella destinazione, su di un livello).
 * Estratti da ToolsView.tsx (Fase 6).
 */
export function DlDestFolderGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      aria-hidden
    >
      <path
        d="M4.25 5.5h5.1l1.1 1.1h8.3c.6 0 1.1.45 1.1 1v9.15c0 .6-.5 1.1-1.1 1.1H4.25c-.6 0-1.1-.5-1.1-1.1V6.6c0-.6.5-1.1 1.1-1.1Z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  );
}

export function DlDestUpIcon() {
  return (
    <svg
      className="tools-dl-dest__up-ic"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 5.5L6.5 11H10v5.5h4V11h3.4L12 5.5z" />
    </svg>
  );
}

