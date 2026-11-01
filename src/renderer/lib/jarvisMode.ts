export type JarvisMode = 'idle' | 'listening' | 'thinking' | 'speaking';

export const MODE_LABEL: Record<JarvisMode, string> = {
  idle: 'Standing by',
  listening: 'Listening',
  thinking: 'Processing',
  speaking: 'Responding',
};

export interface LogEntry {
  id: number;
  at: Date;
  text: string;
  reply?: string;
}
