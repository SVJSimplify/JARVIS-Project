import { useState } from 'react';
import { getState, setState } from '../lib/store';
import { testProvider } from '../lib/provider';

/** Provider for standalone phone chat: any OpenAI-compatible base URL + API key + model. */
export default function ProviderForm({ onSaved }: { onSaved?: () => void }) {
  const cur = getState().provider;
  const [baseUrl, setBaseUrl] = useState(cur.baseUrl);
  const [apiKey, setApiKey] = useState(cur.apiKey);
  const [model, setModel] = useState(cur.model);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = /^https?:\/\/\S+$/i.test(baseUrl.trim()) && model.trim().length > 0;

  const save = async (test: boolean) => {
    setState({ provider: { baseUrl: baseUrl.trim().replace(/\/+$/, ''), apiKey: apiKey.trim(), model: model.trim() } });
    if (!test) {
      onSaved?.();
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await testProvider();
      setMsg({ ok: true, text: `Connected. The model replied “${r}”.` });
      onSaved?.();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col">
      <Field label="API base URL" hint="Any OpenAI-compatible endpoint — OpenAI, OpenRouter, Ollama’s /v1, Gemini’s OpenAI endpoint.">
        <input className="field font-mono text-[14px]" inputMode="url" autoCapitalize="off" spellCheck={false} placeholder="https://api.openai.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label="API key" hint="Stored only in this app’s private storage. Leave empty for a local Ollama.">
        <input className="field font-mono text-[14px]" type="password" autoCapitalize="off" placeholder="sk-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      <Field label="Model">
        <input className="field font-mono text-[14px]" autoCapitalize="off" spellCheck={false} placeholder="gpt-4o-mini" value={model} onChange={(e) => setModel(e.target.value)} />
      </Field>
      <div className="mt-5 flex gap-2">
        <button className="btn-secondary" disabled={!valid || busy} onClick={() => void save(false)}>
          Save
        </button>
        <button className="btn-primary flex-1" disabled={!valid || busy} onClick={() => void save(true)}>
          {busy ? 'Testing…' : 'Save and test'}
        </button>
      </div>
      {msg && (
        <p role="status" className={`mt-3 text-meta ${msg.ok ? 'text-ok' : 'text-danger'}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mt-4 block first:mt-0">
      <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-meta text-faint">{hint}</span>}
    </label>
  );
}
