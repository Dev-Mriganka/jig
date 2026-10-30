import { fetchPasskeys, fetchSettings, registerPasskey, removePasskey, updateReviewSettings } from "@web/api.js";
import { Button } from "@web/components/ui/index.js";
import { describePasskeyError, supportsPasskeys } from "@web/passkeys.js";
import type { PasskeyListPayload, ReviewSettings } from "@web/types.js";
import type { FC } from "react";
import { useCallback, useEffect, useState } from "react";

/**
 * Review settings, and the passkeys that can approve a review: each with its SHA-256 fingerprint, and a button to remove it.
 * Registering and removing a passkey are each confirmed in Pi, so this page only asks.
 */
export const SettingsPage: FC = () => {
  const [settings, setSettings] = useState<ReviewSettings>();
  const [passkeys, setPasskeys] = useState<PasskeyListPayload>();
  const [notice, setNotice] = useState<string>();
  const [isBusy, setIsBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setSettings(await fetchSettings());
      setPasskeys(await fetchPasskeys());
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Unable to load settings.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (next: Partial<ReviewSettings>): Promise<void> => {
    await updateReviewSettings(next);
    setSettings((current) => (current === undefined ? current : { ...current, ...next }));
  };

  const act = async (action: () => Promise<string | undefined>): Promise<void> => {
    setIsBusy(true);
    setNotice(undefined);

    try {
      setNotice(await action());
      await load();
    } catch (cause) {
      setNotice(describePasskeyError(cause));
    } finally {
      setIsBusy(false);
    }
  };

  if (settings === undefined || passkeys === undefined) {
    return <div className="mx-auto max-w-3xl p-8">{notice ?? "Loading settings…"}</div>;
  }

  return (
    <main className="min-h-screen bg-slate-100 p-6 text-slate-950">
      <div className="mx-auto max-w-3xl space-y-5">
        <header className="rounded-xl bg-white p-6 shadow">
          <a className="text-sm font-medium text-blue-700 hover:underline" href="/reviews">
            Reviews
          </a>
          <h1 className="mt-1 text-2xl font-semibold">Settings</h1>
        </header>
        <section className="space-y-3 rounded-xl bg-white p-6 shadow">
          <h2 className="text-lg font-semibold">Review</h2>
          <label className="flex items-center gap-3 text-sm">
            <input
              checked={settings.autoAskReview}
              onChange={(event) => {
                void change({ autoAskReview: event.target.checked });
              }}
              type="checkbox"
            />
            Start a review after the agent changes files, without asking
          </label>
          <label className="flex items-center gap-3 text-sm">
            <input
              checked={settings.autoOpenBrowser}
              onChange={(event) => {
                void change({ autoOpenBrowser: event.target.checked });
              }}
              type="checkbox"
            />
            Open the browser automatically
          </label>
          <label className="flex items-center gap-3 text-sm">
            Diff view
            <select
              className="rounded-md border border-slate-300 px-2 py-1"
              onChange={(event) => {
                void change({ diffView: event.target.value === "unified" ? "unified" : "split" });
              }}
              value={settings.diffView}
            >
              <option value="split">Split</option>
              <option value="unified">Unified</option>
            </select>
          </label>
        </section>
        <section className="rounded-xl bg-white p-6 shadow">
          <h2 className="text-lg font-semibold">Passkeys</h2>
          <p className="mt-1 text-sm text-slate-600">
            A passkey approves a review here without a question in Pi. A key is stored only after you confirm its fingerprint in Pi, and
            removing one is confirmed in Pi too.
          </p>
          {passkeys.problem === undefined ? undefined : (
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {passkeys.problem}. No passkey is used until it is fixed or deleted.
            </p>
          )}
          {passkeys.problems.map((problem) => (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950" key={problem}>
              {problem}
            </p>
          ))}
          {passkeys.passkeys.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">No passkey is registered.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200">
              {passkeys.passkeys.map((key) => (
                <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={key.fingerprint}>
                  <div className="min-w-0">
                    <div className="break-all font-mono text-xs">{formatFingerprint(key.fingerprint)}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {key.algorithm} · registered {formatDateTime(key.createdAt)}
                      {key.lastUsedAt === undefined ? "" : ` · last used ${formatDateTime(key.lastUsedAt)}`}
                    </div>
                  </div>
                  <Button
                    className="px-3 py-1 text-sm"
                    disabled={isBusy}
                    onClick={() => {
                      void act(async () => {
                        setNotice("Waiting for your answer in Pi.");
                        const outcome = await removePasskey(key.fingerprint);

                        return outcome.ok ? "Passkey removed." : outcome.message;
                      });
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex items-center gap-3">
            <Button
              className="px-4 py-2"
              disabled={isBusy || passkeys.problem !== undefined || !supportsPasskeys()}
              onClick={() => {
                void act(async () => {
                  setNotice("Create the passkey in the prompt, then confirm its fingerprint in Pi.");
                  await registerPasskey();

                  return "Passkey registered.";
                });
              }}
              variant="primary"
            >
              Register a passkey
            </Button>
            {supportsPasskeys() ? undefined : <span className="text-sm text-red-800">This browser has no passkey support.</span>}
          </div>
          {notice === undefined ? undefined : (
            <p className="mt-3 text-sm text-slate-700" role="status">
              {notice}
            </p>
          )}
        </section>
      </div>
    </main>
  );
};

/** The fingerprint in groups of eight digits, as Pi shows it, so the two can be compared by eye. */
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{1,8}/g) ?? []).join(" ");
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
