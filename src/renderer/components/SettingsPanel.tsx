import { useEffect, useRef, useState } from 'react';
import { cancelSpeech, enqueue } from '../lib/speech';
import { setVoicePrefs, useVoicePrefs, type ToggleKey } from '../lib/voicePrefs';
import { ENROL_CLIPS, clearPrint, startEnrol, useVoiceprint } from '../lib/voiceprint';
import { popModal, pushModal } from '../lib/modalState';
import { CommandLog } from './HudPanels';
import { SettingsActivitySection } from './ActivityFeed';
import DevicesSection from './DevicesSection';
import type { LogEntry } from '../lib/jarvisMode';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The in-session transcript (Settings → Transcript). Owned by App, rendered here. */
  log?: LogEntry[];
  /** Which section to show when the panel opens (Round 23 navigation). */
  initialSection?: SettingsSection;
}

/** Round 23: Settings is organised into three sections — the provider/voice form this
 *  panel always had, plus the relocated Activity and Transcript interfaces. */
export type SettingsSection = 'provider' | 'devices' | 'activity' | 'transcript';

const SECTIONS: Array<{ id: SettingsSection; label: string; title: string }> = [
  { id: 'provider', label: 'Provider', title: 'Provider' },
  { id: 'devices', label: 'Devices', title: 'Devices' },
  { id: 'activity', label: 'Activity', title: 'Activity' },
  { id: 'transcript', label: 'Transcript', title: 'Transcript' },
];

const VOICES: Array<{ id: string; label: string }> = [
  { id: 'en-GB-RyanNeural', label: 'Ryan: British, calm (default)' },
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
  'w-full rounded-[10px] border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink outline-none transition-colors placeholder:text-faint focus:border-sand focus:bg-surface';

export default function SettingsPanel({ open, onClose, log = [], initialSection = 'provider' }: Props) {
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
  const [section, setSection] = useState<SettingsSection>(initialSection);
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
    setSection(initialSection); // deep links (header → “Full history”) land on their section
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
  }, [open, initialSection]);

  if (!open) return null;

  const save = async () => {
    setSaveError('');
    try {
      await window.electronAPI.settings.set({
        baseUrl,
        model,
        voice,
        // FULL AUTONOMY, single mode: there is no selector and nothing to send. The
        // hard floors (no deletion, no OS modification) are code-enforced in the
        // permission service and are not a user-facing setting.
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
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto overscroll-contain bg-[rgba(52,38,24,0.22)] p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="holo-panel max-h-[86vh] w-[34rem] max-w-[92vw] overflow-y-auto p-7"
        role="dialog"
        aria-label="Settings"
      >
        {/* Round 23 navigation: three sections, existing conventions (uppercase, tracked,
            accent when active). Switching sections never resets provider form state —
            only which section is rendered. */}
        <div className="mb-5 flex items-center justify-between">
          <h2 className="holo-title">Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings" className="holo-close grid h-8 w-8 place-items-center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <nav className="mb-7 flex gap-1 rounded-[11px] bg-surface-2 p-1" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              aria-current={section === s.id}
              className={`no-drag flex-1 rounded-[8px] py-1.5 text-[12.5px] font-medium transition-colors ${section === s.id ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(60,42,20,0.08)]' : 'text-muted hover:text-ink'}`}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {section === 'activity' && <SettingsActivitySection />}
        {section === 'devices' && <DevicesSection />}

        {section === 'transcript' && (
          <div className="space-y-4">
            <h2 className="rail-title">Transcript</h2>
            <p className="text-sm text-steel">Everything you asked and JINI answered in this session. The durable full-fidelity history of every past session lives in Conversations (the speech-bubble button, top right).</p>
            <div className="max-h-[52vh] overflow-y-auto pr-1">
              <CommandLog log={log} />
            </div>
          </div>
        )}

        {section === 'provider' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
        <h2 className="rail-title">Provider</h2>

        <label htmlFor="base-url" className="block text-sm text-steel">
          API base URL (any OpenAI-compatible endpoint)
        </label>
        <input
          id="base-url"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
          autoComplete="off"
          spellCheck={false}
          className={`${field} mb-5 mt-1 font-mono`}
        />

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
              <option key={v.id} value={v.id} className="bg-[#FFFDF9]">
                {v.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void preview()} className="text-sm text-accent hover:text-hot">
            Preview
          </button>
        </div>

        <h2 className="rail-title">Autonomy</h2>
        <div className="mb-8 space-y-2">
          <p className="block text-sm text-steel">
            <span className="text-accent">Autonomous — always on.</span> JINI acts on his own, no approval
            cards, no permission modes. The only hard blocks are deletion and modification of operating-system
            resources, enforced in code on every route; everything else runs automatically.
          </p>
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
              className="h-4 w-4 accent-[#FFFDF9]"
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
                className="h-4 w-4 accent-[#FFFDF9]"
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
              className="w-32 accent-[#FFFDF9]"
            />
          </label>
        </div>

        {saveError && <p className="mb-3 text-sm text-red-300">{saveError}</p>}
        <div className="flex justify-end gap-6">
          <button type="button" onClick={onClose} className="text-sm text-steel hover:text-hot">
            Cancel
          </button>
          <button type="submit" className="text-sm font-semibold text-accent hover:text-hot">
            SAVE
          </button>
        </div>
        </form>
        )}
      </div>
    </div>
  );
}
