import { titleForNumericLevel } from "../../lib/achievements";
import type { AccountSectionProps } from "./types";

export default function AccountSection({
  t,
  accountErr,
  accounts,
  selectedAccount,
  accountBusy,
  libLocked,
  newAccountName,
  setNewAccountName,
  createNewAccount,
  selectSessionAccount,
  removeAccount,
  accountLevelFor,
}: AccountSectionProps) {
  return (
    <section className="surface-card settings-account-section">
      <div className="section-head section-head--page-toolbar">
        <div>
          <p className="eyebrow">{t("accounts.eyebrow")}</p>
          <h2>{t("accounts.heading")}</h2>
        </div>
      </div>
      {accountErr ? <p className="subtle sm warnline">{accountErr}</p> : null}
      {accounts ? (
        <div className="account-list">
          {accounts.accounts.map((account) => {
            const selected = account.id === selectedAccount?.id;
            const level = accountLevelFor(account.id);
            return (
              <div
                key={account.id}
                className={`account-row${selected ? " is-selected" : ""}`}
              >
                <button
                  type="button"
                  className="account-row__main"
                  disabled={accountBusy || selected}
                  onClick={() => selectSessionAccount(account.id)}
                >
                  <span className="account-row__avatar" aria-hidden>
                    {(account.name.trim()[0] || "?").toUpperCase()}
                  </span>
                  <span className="account-row__text">
                    <span className="account-row__name">{account.name}</span>
                    {level != null ? (
                      <span
                        className="account-row__level-pill"
                        title={titleForNumericLevel(level)}
                      >
                        {t("achievements.levelBadge", { n: level })}
                      </span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  title={
                    account.id === accounts.defaultAccountId
                      ? t("accounts.removeDisabledDefault")
                      : undefined
                  }
                  disabled={
                    accountBusy || account.id === accounts.defaultAccountId
                  }
                  onClick={() => removeAccount(account.id)}
                >
                  {t("accounts.remove")}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {!libLocked ? (
        <div className="settings-merge-block settings-account-create">
          <p className="eyebrow">{t("accounts.createEyebrow")}</p>
          <h3 className="settings-subsection-title">
            {t("accounts.createHeading")}
          </h3>
          <div className="settings-inline-form">
            <label className="settings-inline-form__field">
              <span className="sr-only">{t("accounts.newNameAria")}</span>
              <input
                type="text"
                className="ghost-input w-full"
                value={newAccountName}
                onChange={(event) => setNewAccountName(event.target.value)}
                placeholder={t("accounts.newNamePh")}
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              className="primary-btn settings-inline-form__action"
              disabled={accountBusy || !newAccountName.trim()}
              onClick={createNewAccount}
            >
              {accountBusy ? t("settings.saving") : t("accounts.create")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
