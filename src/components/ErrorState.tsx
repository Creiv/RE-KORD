import { useI18n } from "../i18n/useI18n";

type Props = {
  title?: string;
  message?: string;
  onRetry?: () => void;
};

export function ErrorState({ title, message, onRetry }: Props) {
  const { t } = useI18n();
  return (
    <div className="rekord-state rekord-state--error" role="alert">
      <p className="rekord-state__title">{title ?? t("state.error")}</p>
      {message ? <p className="rekord-state__message">{message}</p> : null}
      {onRetry ? (
        <button type="button" className="rekord-state__retry" onClick={onRetry}>
          {t("state.retry")}
        </button>
      ) : null}
    </div>
  );
}
