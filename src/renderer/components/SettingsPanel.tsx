import { useEffect, useRef, useState } from 'react';
import { cancelSpeech, enqueue } from '../lib/speech';
import { setVoicePrefs, useVoicePrefs, type ToggleKey } from '../lib/voicePrefs';
import { ENROL_CLIPS, clearPrint, startEnrol, useVoiceprint } from '../lib/voiceprint';
import { popModal, pushModal } from '../lib/modalState';

interface Props {
  open: boolean;
  onClose: () => void;
}

const VOICES: Array<{ id: string; label: string }> = [
  { id: 'en-GB-RyanNeural', label: 'Ryan: British, calm (closest to JARVIS)' },
  { id: 'en-GB-ThomasNeural', label: 'Thomas: British, warm' },
  { id: 'en-US-AndrewNeural', label: 'Andrew: American, smooth' },
  { id: 'en-US-GuyNeural', label: 'Guy: American, deep' },
  { id: 'en-US-BrianNeural', label: 'Brian: American, casual' },
  { id: 'en-AU-WilliamNeural', label: 'William: Australian' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia: British, female' },
  { id: 'en-US-AriaNeural', label: 'Aria: American, female' },
  { id: 'system', label: 'Windows system voice (offline)' },
];

const TOGGLES: Array<{ key: ToggleKey; label: string }> = [
  { key: 'interrupt', label: 'Interrupt by voice' },
  { key: 'greeting', label: 'Boot greeting' },
  { key: 'voiceLock', label: 'Voice lock (only respond to my voice)' },
];

const field =
  'w-full border-b border-line bg-transparent py-2 font-mono text-sm text-hot outline-none placeholder:text-steel/60 focus:border-accent';

export default function SettingsPanel({ open, onClose }: Props) {
  const [baseUrl, setBaseUrl] = useState('');
  const [keySet, setKeySet] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [groqSet, setGroqSet] = useState(false);
  const [groqKey, setGroqKey] = useState('');
  const [tinyfishSet, setTinyfishSet] = useState(false);
  const [tinyfishKey, setTinyfishKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [fallback, setFallback] = useState('');
  const [voice, setVoice] = useState('en-GB-RyanNeural');
  const [awareness, setAwareness] = useState(true);
  const [saveError, setSaveError] = useState('');
  const prefs = useVoicePrefs();
  const vp = useVoiceprint();
  // JarvisWindow re-creates `onClose` on every telemetry tick (2 s); keying the effect on it
  // used to wipe whatever the user was typing into the key fields twice a minute.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    pushModal();
    setSaveError('');
    setApiKey('');
    setGroqKey('');
    setTinyfishKey('');
    void window.electronAPI.settings.get().then((s) => {
      setBaseUrl(s.baseUrl);
      setKeySet(s.apiKeySet);
      setGroqSet(s.groqKeySet);
      setTinyfishSet(s.tinyfishKeySet);
      setModel(s.model);
      setFallback((s.fallbackModels ?? []).join(', '));
      setVoice(s.voice);
      setAwareness(s.awareness !== false);
    });
    void window.electronAPI.ai.models().then(setModels);

    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    window.addEventListener('keydown', onKey);
    return () => {
      popModal();
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;

  const save = async () => {
    setSaveError('');
    try {
      await window.electronAPI.settings.set({
        model,
        voice,
        // Always sent: clearing the field must also clear the saved chain.
        fallbackModels: fallback.split(',').map((t) => t.trim()).filter(Boolean),
        ...(apiKey ? { apiKey } : {}),
        ...(groqKey ? { groqKey } : {}),
        ...(tinyfishKey ? { tinyfishKey } : {}),
      });
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Saving failed.');
    }
  };

  const preview = async () => {
    try {
      await window.electronAPI.settings.set({ voice });
      cancelSpeech();
      enqueue({
        text: 'Good evening. All systems are online.',
        onStart: () => {},
        onBoundary: () => {},
        onEnd: () => {},
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save the voice.');
    }
  };

  const clearKey = async () => {
    try {
      await window.electronAPI.settings.set({ apiKey: '' });
      setKeySet(false);
      setApiKey('');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not remove the key.');
    }
  };

  const clearGroq = async () => {
    try {
      await window.electronAPI.settings.set({ groqKey: '' });
      setGroqSet(false);
      setGroqKey('');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not remove the key.');
    }
  };

  const clearTinyfish = async () => {
    try {
      await window.electronAPI.settings.set({ tinyfishKey: '' });
      setTinyfishSet(false);
      setTinyfishKey('');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not remove the key.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 overflow-y-auto overscroll-contain bg-[rgb(var(--void)/0.75)] backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className="rail m-auto max-h-[86vh] w-[28rem] max-w-[90vw] overflow-y-auto bg-[rgb(var(--void)/0.95)] p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 className="rail-title">Provider</h2>

        <label className="block text-sm text-steel">Endpoint</label>
        <p className="mb-5 mt-1 font-mono text-sm text-hot">{baseUrl}</p>

        <label htmlFor="api-key" className="block text-sm text-steel">
          API key
        </label>
        <div className="mb-5 flex items-center gap-3">
          <input
            id="api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={keySet ? '•••••••• saved. Type to replace' : 'sk-…'}
            autoComplete="off"
            className={field}
          />
          {keySet && (
            <button type="button" onClick={() => void clearKey()} className="text-sm text-steel hover:text-hot">
              Remove
            </button>
          )}
        </div>

        <label htmlFor="groq-key" className="block text-sm text-steel">
          Groq key (optional: free cloud Whisper, local fallback)
        </label>
        <div className="mb-5 flex items-center gap-3">
          <input
            id="groq-key"
            type="password"
            value={groqKey}
            onChange={(e) => setGroqKey(e.target.value)}
            placeholder={groqSet ? '•••••••• saved. Type to replace' : 'gsk_…'}
            autoComplete="off"
            className={field}
          />
          {groqSet && (
            <button type="button" onClick={() => void clearGroq()} className="text-sm text-steel hover:text-hot">
              Remove
            </button>
          )}
        </div>

        <label htmlFor="tinyfish-key" className="block text-sm text-steel">
          TinyFish key (optional: fast web search and page reading)
        </label>
        <div className="mb-5 flex items-center gap-3">
          <input
            id="tinyfish-key"
            type="password"
            value={tinyfishKey}
            onChange={(e) => setTinyfishKey(e.target.value)}
            placeholder={tinyfishSet ? '•••••••• saved. Type to replace' : 'Paste key from agent.tinyfish.ai'}
            autoComplete="off"
            className={field}
          />
          {tinyfishSet && (
            <button type="button" onClick={() => void clearTinyfish()} className="text-sm text-steel hover:text-hot">
              Remove
            </button>
          )}
        </div>

        <label htmlFor="model" className="block text-sm text-steel">
          Model
        </label>
        <input
          id="model"
          list="model-list"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="model id"
          autoComplete="off"
          className={`${field} mb-5`}
        />
        <datalist id="model-list">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        <label htmlFor="fallback-models" className="block text-sm text-steel">
          Fallback models (optional, comma-separated — tried in order when the main model is retired or unavailable)
        </label>
        <input
          id="fallback-models"
          value={fallback}
          onChange={(e) => setFallback(e.target.value)}
          placeholder="e.g. gemini-2.5-flash, gpt-4o-mini"
          autoComplete="off"
          className={`${field} mb-5`}
        />

        <label htmlFor="voice" className="block text-sm text-steel">
          Voice
        </label>
        <div className="mb-8 flex items-center gap-3">
          <select id="voice" value={voice} onChange={(e) => setVoice(e.target.value)} className={field}>
            {VOICES.map((v) => (
              <option key={v.id} value={v.id} className="bg-[#04101a]">
                {v.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void preview()} className="text-sm text-accent hover:text-hot">
            Preview
          </button>
        </div>

        <h2 className="rail-title">Awareness</h2>
        <div className="mb-8 space-y-3">
          <label className="flex cursor-pointer items-center justify-between text-sm text-steel">
            Know which app and window I'm using (kept in memory only)
            <input
              type="checkbox"
              checked={awareness}
              onChange={(e) => {
                setAwareness(e.target.checked);
                void window.electronAPI.settings.set({ awareness: e.target.checked });
              }}
              className="h-4 w-4 accent-[#ffffff]"
            />
          </label>
        </div>

        <h2 className="rail-title">Voice</h2>
        <div className="mb-8 space-y-3">
          {TOGGLES.map((t) => (
            <label key={t.key} className="flex cursor-pointer items-center justify-between text-sm text-steel">
              {t.label}
              <input
                type="checkbox"
                checked={prefs[t.key]}
                onChange={(e) => setVoicePrefs({ [t.key]: e.target.checked })}
                className="h-4 w-4 accent-[#ffffff]"
              />
            </label>
          ))}
          <div className="flex items-center justify-between text-sm text-steel">
            <span>
              {vp.clips !== null ? `Enrolling… ${vp.clips}/${ENROL_CLIPS} (speak near the mic)` : vp.enrolled ? 'Voice profile saved' : 'No voice profile'}
            </span>
            <span className="flex gap-4">
              <button type="button" onClick={startEnrol} className="text-accent hover:text-hot">
                {vp.enrolled ? 'Re-enrol' : 'Enrol voice'}
              </button>
              {vp.enrolled && (
                <button type="button" onClick={clearPrint} className="hover:text-hot">
                  Remove
                </button>
              )}
            </span>
          </div>
          <label className="flex items-center justify-between gap-4 text-sm text-steel">
            Lock strictness (strict ← → loose)
            <input
              type="range"
              min={1.5}
              max={4}
              step={0.1}
              value={prefs.lockStrictness}
              onChange={(e) => setVoicePrefs({ lockStrictness: Number(e.target.value) })}
              className="w-32 accent-[#ffffff]"
            />
          </label>
        </div>

        {saveError && <p className="mb-3 text-sm text-red-300">{saveError}</p>}
        <div className="flex justify-end gap-6">
          <button type="button" onClick={onClose} className="text-sm text-steel hover:text-hot">
            Cancel
          </button>
          <button type="submit" className="text-sm font-semibold tracking-widest text-accent hover:text-hot">
            SAVE
          </button>
        </div>
      </form>
    </div>
  );
}
