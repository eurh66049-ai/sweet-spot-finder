export const DEFAULT_TTS_MODEL = 'voxtral-mini-tts-2603';

export type VoiceOption = {
  id: string;
  name?: string | null;
  slug?: string | null;
  languages?: string[] | null;
  user_id?: string | null;
};

export const AVAILABLE_EMOTIONS = ['neutral', 'sad', 'excited', 'curious', 'confident', 'cheerful', 'angry'] as const;
export type MistralEmotion = typeof AVAILABLE_EMOTIONS[number];

export function splitTextIntoChunks(text: string, maxChars = 3500): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!؟。\n])\s*/);
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += `${current ? ' ' : ''}${sentence}`;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

export function detectLanguage(text: string): 'ar' | 'en' {
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
  return arabicChars > latinChars ? 'ar' : 'en';
}

export function cleanTextForSpeech(text: string): string {
  return text
    .replace(/---\s*صفحة\s*\d+\s*---/g, ' ')
    .replace(/[#*_`>|\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function voiceMatches(voice: VoiceOption, requestedVoice?: string): boolean {
  if (!requestedVoice) return false;
  const normalized = requestedVoice.trim().toLowerCase();
  return [voice.id, voice.name, voice.slug]
    .filter(Boolean)
    .some((value) => String(value).trim().toLowerCase() === normalized);
}

export async function fetchAvailableVoices(apiKey: string): Promise<VoiceOption[]> {
  const response = await fetch('https://api.mistral.ai/v1/audio/voices?limit=100', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`تعذر جلب الأصوات من Mistral (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const data = await response.json();
  return Array.isArray(data?.items)
    ? data.items.filter((item: VoiceOption | undefined) => item?.id)
    : [];
}

export function resolveVoiceId(availableVoices: VoiceOption[], language: 'ar' | 'en', requestedVoice?: string): string | null {
  const directMatch = availableVoices.find((voice) => voiceMatches(voice, requestedVoice));
  if (directMatch) return directMatch.id;

  const envKey = language === 'ar' ? 'MISTRAL_TTS_VOICE_AR' : 'MISTRAL_TTS_VOICE_EN';
  const envVoice = Deno.env.get(envKey);
  const envMatch = availableVoices.find((voice) => voiceMatches(voice, envVoice));
  if (envMatch) return envMatch.id;

  const languageHints = language === 'ar' ? ['ar', 'arabic', 'عرب'] : ['en', 'english'];
  const hintedVoice = availableVoices.find((voice) => {
    const searchable = [voice.name, voice.slug, ...(voice.languages || [])]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    return searchable.some((value) => languageHints.some((hint) => value.includes(hint)));
  });

  return hintedVoice?.id || availableVoices[0]?.id || null;
}

export function decodeBase64Audio(audioBase64: string): Uint8Array {
  const binaryString = atob(audioBase64);
  const audioBuffer = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index += 1) {
    audioBuffer[index] = binaryString.charCodeAt(index);
  }

  return audioBuffer;
}