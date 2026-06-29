import { UiShuffle } from "./RekordUiIcons";

type Props = {
  label: string;
  disabled?: boolean;
  onClick: () => void;
};

export function PlayCollectionButton({ label, disabled = false, onClick }: Props) {
  return (
    <button
      type="button"
      className="primary-btn play-collection-btn"
      disabled={disabled}
      onClick={onClick}
    >
      <UiShuffle className="play-collection-btn__ic" aria-hidden />
      {label}
    </button>
  );
}
