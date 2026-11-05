// Connecting a model: the first-run screen and the Model settings dialog.
// The key is sent to the local server once, checked against the provider,
// and saved on this computer. It never comes back to the browser.

import type { ModelSettingsView } from '@noema/core';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiFailure, api } from './api.ts';

const DEEPSEEK = {
  baseUrl: 'https://api.deepseek.com',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  keysPage: 'https://platform.deepseek.com/api_keys',
};

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the provider';
  }
}

function message(err: unknown): string {
  return err instanceof ApiFailure ? err.message : 'Something went wrong. Try again.';
}

/** Loads the current settings, then shows the form. */
export function ModelForm({
  onSaved,
  onCancel,
}: {
  onSaved: (view: ModelSettingsView) => void;
  onCancel?: () => void;
}) {
  const [view, setView] = useState<ModelSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .modelSettings()
      .then((v) => !cancelled && setView(v))
      .catch((err: unknown) => !cancelled && setError(message(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="form-error">{error}</p>;
  if (!view) return <p className="form-note">Loading…</p>;
  return <Fields view={view} onSaved={onSaved} onCancel={onCancel} />;
}

function Fields({
  view,
  onSaved,
  onCancel,
}: {
  view: ModelSettingsView;
  onSaved: (view: ModelSettingsView) => void;
  onCancel?: (() => void) | undefined;
}) {
  const real = view.provider === 'openai-compatible';
  const startsOnDeepSeek = !real || !view.baseUrl || sameUrl(view.baseUrl, DEEPSEEK.baseUrl);
  const [kind, setKind] = useState<'deepseek' | 'other'>(startsOnDeepSeek ? 'deepseek' : 'other');
  const [baseUrl, setBaseUrl] = useState(startsOnDeepSeek ? '' : view.baseUrl);
  const [model, setModel] = useState(real && view.model ? view.model : (DEEPSEEK.models[0] as string));
  const [apiKey, setApiKey] = useState('');
  const [available, setAvailable] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const keySaved = real && view.hasKey;
  const url = kind === 'deepseek' ? DEEPSEEK.baseUrl : baseUrl.trim();
  const suggestions = available.length > 0 ? available : kind === 'deepseek' ? DEEPSEEK.models : [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = apiKey.trim();
      const r = await api.saveModelSettings({ baseUrl: url, model: model.trim(), ...(key ? { apiKey: key } : {}) });
      setApiKey('');
      setAvailable(r.available);
      onSaved(r.settings);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved((await api.forgetModelSettings()).settings);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="model-form" onSubmit={submit}>
      <label>
        <span>Provider</span>
        <select
          value={kind}
          onChange={(e) => {
            const next = e.target.value as 'deepseek' | 'other';
            setKind(next);
            setAvailable([]);
            if (next === 'deepseek') setModel(DEEPSEEK.models[0] as string);
            else if (DEEPSEEK.models.includes(model)) setModel('');
          }}
          data-testid="model-provider"
        >
          <option value="deepseek">DeepSeek</option>
          <option value="other">Another OpenAI-compatible provider</option>
        </select>
      </label>

      {kind === 'other' && (
        <label>
          <span>Base URL</span>
          <input
            type="url"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            data-testid="model-base-url"
          />
        </label>
      )}

      <label>
        <span>Model</span>
        <input
          required
          value={model}
          onChange={(e) => setModel(e.target.value)}
          list={`${ids}-models`}
          spellCheck={false}
          autoComplete="off"
          data-testid="model-name"
        />
        <datalist id={`${ids}-models`}>
          {suggestions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>

      <label>
        <span>API key</span>
        <input
          type="password"
          required={!keySaved}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={keySaved ? `Saved (${view.keyHint}). Leave empty to keep it.` : 'sk-…'}
          autoComplete="off"
          spellCheck={false}
          data-testid="model-key"
        />
      </label>

      <p className="form-note">
        {kind === 'deepseek' && (
          <>
            Get a key at{' '}
            <a href={DEEPSEEK.keysPage} target="_blank" rel="noreferrer noopener">
              platform.deepseek.com
            </a>
            .{' '}
          </>
        )}
        The key is saved on this computer only and sent only to {hostOf(url)}.
      </p>

      {error && (
        <p className="form-error" role="alert" data-testid="model-error">
          {error}
        </p>
      )}

      <div className="form-actions">
        <button type="submit" disabled={busy} data-testid="model-save">
          {busy ? 'Checking…' : 'Save and connect'}
        </button>
        {onCancel && (
          <button type="button" className="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        {view.source === 'saved' && (
          <button type="button" className="quiet danger" onClick={remove} disabled={busy} data-testid="model-remove">
            Remove saved key
          </button>
        )}
      </div>
    </form>
  );
}

/** Shown instead of the notebook until a model is connected. */
export function ConnectScreen({ onConnected }: { onConnected: () => void }) {
  return (
    <main className="connect">
      <div className="connect-card">
        <span className="wordmark">Noema</span>
        <h1>Connect a model</h1>
        <p className="connect-lead">
          Noema answers with your own API key. Any OpenAI-compatible provider works; DeepSeek is set up for you.
        </p>
        <ModelForm onSaved={(v) => v.configured && onConnected()} />
      </div>
    </main>
  );
}

/** Model settings, opened from the header. */
export function ModelDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (view: ModelSettingsView) => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog ref={ref} className="model-dialog" onClose={onClose} aria-labelledby="model-dialog-title">
      <h2 id="model-dialog-title">Model settings</h2>
      <ModelForm
        onCancel={() => ref.current?.close()}
        onSaved={(v) => {
          onSaved(v);
          ref.current?.close();
        }}
      />
    </dialog>
  );
}
