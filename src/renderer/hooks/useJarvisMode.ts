import { useEffect, useState } from 'react';
import { isSpeaking } from '../lib/speech';
import type { JarvisMode } from '../lib/jarvisMode';

/** Speech playback takes over the mode (except while the mic is listening). */
export function useJarvisMode(input: JarvisMode): JarvisMode {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setSpeaking(isSpeaking()), 120);
    return () => clearInterval(id);
  }, []);

  return speaking && input !== 'listening' ? 'speaking' : input;
}
