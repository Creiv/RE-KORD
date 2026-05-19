type Props = {
  label: string;
  disabled?: boolean;
  onClick: () => void;
};

export function PlayCollectionButton({ label, disabled = false, onClick }: Props) {
  return (
    <button
      type="button"
      className="primary-btn primary-btn--sm"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
