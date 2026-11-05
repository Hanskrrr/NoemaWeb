// Which model answers, and with which key. The key can be entered in the app
// (saved to data/settings.json, readable only by this user) or come from
// .env. A key saved in the app wins. The key is never written to the
// database, so exports and backups never contain it.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelSettingsView, UpdateModelSettingsRequest } from '@noema/core';
import { z } from 'zod';
import type { Logger } from '../log.ts';
import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { type ModelProvider, ProviderError } from './provider.ts';

const Saved = z.object({
  version: z.literal(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().min(1),
});
type Saved = z.infer<typeof Saved>;

export interface ProviderSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** What the rest of the server needs: the provider to use for the next answer. */
export interface ModelSource {
  current(): ModelProvider;
}

export interface ModelSettingsOptions {
  env: { provider: 'fake' | 'openai-compatible' } & ProviderSettings;
  /** Where saved settings live. Null keeps them in memory (tests). */
  filePath: string | null;
  /** The test provider, used only when env.provider is 'fake' and nothing is saved. */
  fake: () => ModelProvider;
  /** How to build a real provider (tests inject a fetch). */
  create?: (s: ProviderSettings) => OpenAICompatibleProvider;
  log: Logger;
}

export function keyHint(key: string): string {
  return key.length < 12 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export class ModelSettings implements ModelSource {
  private readonly o: ModelSettingsOptions;
  private readonly create: (s: ProviderSettings) => OpenAICompatibleProvider;
  private saved: Saved | null;
  private provider: ModelProvider;

  constructor(options: ModelSettingsOptions) {
    this.o = options;
    this.create = options.create ?? ((s) => new OpenAICompatibleProvider(s));
    this.saved = this.load();
    this.provider = this.build();
  }

  current(): ModelProvider {
    return this.provider;
  }

  view(): ModelSettingsView {
    if (this.saved) {
      const { baseUrl, model, apiKey } = this.saved;
      return {
        provider: 'openai-compatible',
        baseUrl,
        model,
        hasKey: true,
        keyHint: keyHint(apiKey),
        source: 'saved',
        configured: true,
      };
    }
    const env = this.o.env;
    if (env.provider === 'fake') {
      const fake = this.provider;
      return {
        provider: 'fake',
        baseUrl: '',
        model: fake.model,
        hasKey: false,
        keyHint: null,
        source: 'environment',
        configured: true,
      };
    }
    const hasKey = env.apiKey.length > 0;
    return {
      provider: 'openai-compatible',
      baseUrl: env.baseUrl,
      model: env.model,
      hasKey,
      keyHint: hasKey ? keyHint(env.apiKey) : null,
      source: 'environment',
      configured: hasKey,
    };
  }

  /**
   * Check the settings against the provider, then save them. Nothing is saved
   * if the check fails; the ProviderError says why.
   */
  async update(
    req: UpdateModelSettingsRequest,
    signal?: AbortSignal,
  ): Promise<{ view: ModelSettingsView; available: string[] }> {
    const envKey = this.o.env.provider === 'openai-compatible' ? this.o.env.apiKey : '';
    const apiKey = req.apiKey ?? this.saved?.apiKey ?? envKey;
    if (!apiKey) throw new ProviderError('not_configured', 'enter an API key');
    const next: Saved = { version: 1, baseUrl: req.baseUrl.replace(/\/+$/, ''), model: req.model, apiKey };
    const candidate = this.create(next);
    const { models } = await candidate.check(signal);
    this.write(next);
    this.saved = next;
    this.provider = candidate;
    this.o.log.info('model settings saved', { host: new URL(next.baseUrl).host, model: next.model });
    return { view: this.view(), available: models.slice(0, 100) };
  }

  /** Forget the saved settings and fall back to .env. */
  forget(): ModelSettingsView {
    if (this.o.filePath) rmSync(this.o.filePath, { force: true });
    this.saved = null;
    this.provider = this.build();
    this.o.log.info('model settings removed');
    return this.view();
  }

  private build(): ModelProvider {
    if (this.saved) return this.create(this.saved);
    const env = this.o.env;
    if (env.provider === 'fake') return this.o.fake();
    return this.create({ baseUrl: env.baseUrl, model: env.model, apiKey: env.apiKey });
  }

  private load(): Saved | null {
    const file = this.o.filePath;
    if (!file) return null;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        this.o.log.warn('cannot read model settings', { file, err });
      return null;
    }
    try {
      return Saved.parse(JSON.parse(raw));
    } catch {
      this.o.log.warn('ignoring malformed model settings; save them again in the app', { file });
      return null;
    }
  }

  private write(s: Saved): void {
    const file = this.o.filePath;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  }
}
