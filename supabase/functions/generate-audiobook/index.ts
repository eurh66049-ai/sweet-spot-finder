import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function respond(payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// تقسيم النص إلى أجزاء مناسبة (حد Groq ~4096 حرف لكل طلب)
function splitTextIntoChunks(text: string, maxChars = 3500): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!؟。\n])\s*/);
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// كشف لغة النص
function detectLanguage(text: string): 'ar' | 'en' {
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
  return arabicChars > latinChars ? 'ar' : 'en';
}

const DEFAULT_TTS_MODEL = 'voxtral-mini-tts-2603';

type VoiceOption = {
  id: string;
  name?: string | null;
  slug?: string | null;
  languages?: string[] | null;
  user_id?: string | null;
};

// المشاعر المتاحة
const AVAILABLE_EMOTIONS = ['neutral', 'sad', 'excited', 'curious', 'confident', 'cheerful', 'angry'] as const;
type MistralEmotion = typeof AVAILABLE_EMOTIONS[number];

function cleanTextForSpeech(text: string): string {
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

async function fetchAvailableVoices(apiKey: string): Promise<VoiceOption[]> {
  const response = await fetch('https://api.mistral.ai/v1/audio/voices?limit=100', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
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

function resolveVoiceId(availableVoices: VoiceOption[], language: 'ar' | 'en', requestedVoice?: string): string | null {
  const directMatch = availableVoices.find((voice) => voiceMatches(voice, requestedVoice));
  if (directMatch) return directMatch.id;

  const envKey = language === 'ar' ? 'MISTRAL_TTS_VOICE_AR' : 'MISTRAL_TTS_VOICE_EN';
  const envVoice = Deno.env.get(envKey);
  const envMatch = availableVoices.find((voice) => voiceMatches(voice, envVoice));
  if (envMatch) return envMatch.id;

  const languageHints = language === 'ar'
    ? ['ar', 'arabic', 'عرب']
    : ['en', 'english'];

  const hintedVoice = availableVoices.find((voice) => {
    const searchable = [voice.name, voice.slug, ...(voice.languages || [])]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    return searchable.some((value) => languageHints.some((hint) => value.includes(hint)));
  });

  return hintedVoice?.id || availableVoices[0]?.id || null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const MISTRAL_API_KEY = Deno.env.get('MISTRAL_API_KEY');
    if (!MISTRAL_API_KEY) {
      throw new Error('MISTRAL_API_KEY is not configured');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { bookId, action = 'start', voice, emotion, text } = await req.json();

    // إرجاع قائمة الأصوات المتاحة
    if (action === 'voices') {
      const voices = await fetchAvailableVoices(MISTRAL_API_KEY);
      return respond({
        success: true,
        voices,
        emotions: AVAILABLE_EMOTIONS.map(e => ({ id: e, name: e.charAt(0).toUpperCase() + e.slice(1) })),
      });
    }

    // === اختبار سريع: تحويل جملة واحدة وإرجاع الصوت ===
    if (action === 'test') {
      const sampleText = (typeof text === 'string' && text.trim()) ? text.trim() : 'مرحباً، هذا اختبار لتحويل النص إلى صوت.';
      const language = detectLanguage(sampleText);
      const cleaned = cleanTextForSpeech(sampleText) || sampleText;

      const availableVoices = await fetchAvailableVoices(MISTRAL_API_KEY);
      if (availableVoices.length === 0) {
        return respond({
          success: false,
          ok: false,
          stage: 'voices',
          error: 'لا توجد أصوات TTS متاحة في حساب Mistral. أنشئ صوتاً (Voice cloning) أولاً من لوحة Mistral.',
        });
      }

      const voiceId = resolveVoiceId(availableVoices, language, voice);
      if (!voiceId) {
        return respond({
          success: false,
          ok: false,
          stage: 'voice_resolve',
          error: 'تعذر اختيار voice_id صالح.',
          availableVoiceIds: availableVoices.map(v => v.id),
        });
      }

      const selectedEmotion = emotion && AVAILABLE_EMOTIONS.includes(emotion) ? emotion : undefined;
      const styledInput = selectedEmotion ? `اقرأ النص التالي بنبرة ${selectedEmotion}: ${cleaned}` : cleaned;

      const ttsBody: Record<string, unknown> = {
        model: DEFAULT_TTS_MODEL,
        input: styledInput,
        voice_id: voiceId,
        response_format: 'mp3',
      };

      console.log(`🧪 TEST TTS — voice=${voiceId}, lang=${language}, len=${cleaned.length}`);

      const ttsResponse = await fetch('https://api.mistral.ai/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MISTRAL_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(ttsBody),
      });

      const rawBody = await ttsResponse.text();

      if (!ttsResponse.ok) {
        console.error('TEST TTS failed:', ttsResponse.status, rawBody);
        return respond({
          success: false,
          ok: false,
          stage: 'tts',
          status: ttsResponse.status,
          voiceId,
          model: DEFAULT_TTS_MODEL,
          mistralError: rawBody.slice(0, 1000),
          error: `Mistral رفض الطلب (${ttsResponse.status})`,
        });
      }

      let audioBase64: string | undefined;
      try {
        const json = JSON.parse(rawBody);
        audioBase64 = json?.audio_data;
      } catch (_e) {
        return respond({
          success: false,
          ok: false,
          stage: 'parse',
          error: 'استجابة Mistral ليست JSON صالحاً',
          preview: rawBody.slice(0, 300),
        });
      }

      if (!audioBase64) {
        return respond({
          success: false,
          ok: false,
          stage: 'audio_data',
          error: 'لم يتم إرجاع audio_data من Mistral',
        });
      }

      // رفع الملف للتجربة
      const binaryString = atob(audioBase64);
      const audioBuffer = new Uint8Array(binaryString.length);
      for (let j = 0; j < binaryString.length; j++) {
        audioBuffer[j] = binaryString.charCodeAt(j);
      }

      const fileName = `audiobooks/_tests/test_${Date.now()}.mp3`;
      const { error: uploadError } = await supabase.storage
        .from('book-files')
        .upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: true });

      if (uploadError) {
        // حتى لو فشل الرفع، نرجع الصوت كـ data URL مباشرة
        return respond({
          success: true,
          ok: true,
          stage: 'data_url',
          voiceId,
          language,
          audioDataUrl: `data:audio/mpeg;base64,${audioBase64}`,
          uploadError: uploadError.message,
        });
      }

      const { data: urlData } = supabase.storage.from('book-files').getPublicUrl(fileName);

      return respond({
        success: true,
        ok: true,
        stage: 'done',
        voiceId,
        language,
        audioUrl: urlData.publicUrl,
        audioDataUrl: `data:audio/mpeg;base64,${audioBase64}`,
      });
    }

    if (!bookId) throw new Error('bookId is required');

    // === الحصول على حالة المهمة ===
    if (action === 'status') {
      const { data: job } = await supabase
        .from('audiobook_jobs')
        .select('*')
        .eq('book_id', bookId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      return respond({ success: true, ok: true, job });
    }

    // === بدء عملية التحويل ===

    // 1. جلب النص المستخرج من الكتاب
    const { data: textData, error: textError } = await supabase
      .from('book_extracted_text')
      .select('extracted_text, text_length')
      .eq('book_id', bookId)
      .single();

    if (textError || !textData?.extracted_text) {
      throw new Error('لا يوجد نص مستخرج لهذا الكتاب. قم باستخراج النص أولاً باستخدام OCR.');
    }

    // 2. جلب معلومات الكتاب
    const { data: book } = await supabase
      .from('book_submissions')
      .select('title')
      .eq('id', bookId)
      .eq('status', 'approved')
      .single();

    const bookTitle = book?.title || 'كتاب';

    // 3. تقسيم النص إلى أجزاء
    const fullText = textData.extracted_text;
    const chunks = splitTextIntoChunks(fullText);
    const language = detectLanguage(fullText);
    const totalPages = chunks.length;

    console.log(`📖 Starting audiobook generation for "${bookTitle}" - ${totalPages} chunks, language: ${language}`);

    // 4. إنشاء/تحديث سجل المهمة (upsert لتجنب خطأ duplicate key عند إعادة المحاولة)
    const { data: job, error: jobError } = await supabase
      .from('audiobook_jobs')
      .upsert({
        book_id: bookId,
        book_title: bookTitle,
        status: 'processing',
        current_step: 'converting_text_to_speech',
        total_pages: totalPages,
        processed_pages: 0,
        error_message: null,
        completed_at: null,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'book_id' })
      .select()
      .single();

    if (jobError) throw new Error(`Failed to create job: ${jobError.message}`);

    // 5. اختيار صوت صالح من Mistral فعلياً
    const availableVoices = await fetchAvailableVoices(MISTRAL_API_KEY);
    if (availableVoices.length === 0) {
      throw new Error('لا توجد أصوات TTS متاحة في Mistral لهذا الحساب حالياً. أضف صوتاً أو فعّل صوتاً محفوظاً أولاً.');
    }

    const voiceId = resolveVoiceId(availableVoices, language, voice);
    if (!voiceId) {
      throw new Error('تعذر اختيار voice_id صالح من Mistral لهذا الكتاب الصوتي.');
    }

    const selectedEmotion = emotion && AVAILABLE_EMOTIONS.includes(emotion) ? emotion : undefined;

    console.log(`🎙️ Using voice: ${voiceId}, emotion: ${selectedEmotion || 'default'}, available voices: ${availableVoices.length}`);

    // 6. معالجة كل جزء
    let processedCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const pageNum = i + 1;

      try {
        console.log(`🔊 Processing chunk ${pageNum}/${totalPages} (${chunk.length} chars)...`);

        // حفظ النص المنظف
        await supabase
          .from('audiobook_text')
          .upsert({
            book_id: bookId,
            page_number: pageNum,
            cleaned_text: chunk,
            cleanup_status: 'completed',
            tts_status: 'processing',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'book_id,page_number' });

        // استدعاء Mistral TTS API
        // المرجع: https://docs.mistral.ai/api/endpoint/audio/speech
        const preparedChunk = cleanTextForSpeech(chunk);
        if (!preparedChunk) {
          errors.push(`Chunk ${pageNum}: نص فارغ بعد التنظيف`);
          await supabase
            .from('audiobook_text')
            .update({
              tts_status: 'failed',
              error_message: 'النص المستخرج فارغ بعد التنظيف',
              updated_at: new Date().toISOString(),
            })
            .eq('book_id', bookId)
            .eq('page_number', pageNum);
          continue;
        }

        const styledInput = selectedEmotion
          ? `اقرأ النص التالي بنبرة ${selectedEmotion}: ${preparedChunk}`
          : preparedChunk;

        const ttsBody: Record<string, unknown> = {
          model: DEFAULT_TTS_MODEL,
          input: styledInput,
          voice_id: voiceId,
          response_format: 'mp3',
        };

        const ttsResponse = await fetch('https://api.mistral.ai/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${MISTRAL_API_KEY}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(ttsBody),
        });

        if (!ttsResponse.ok) {
          const errText = await ttsResponse.text();
          console.error(`Mistral TTS error for chunk ${pageNum}:`, ttsResponse.status, errText);
          const friendlyError = ttsResponse.status === 404
            ? `الصوت المحدد غير موجود في Mistral أو غير متاح لهذا الحساب (voice_id: ${voiceId})`
            : ttsResponse.status === 410
              ? 'إعدادات TTS هذه متوقفة أو قديمة في Mistral'
              : ttsResponse.status === 400
                ? 'طلب TTS غير صالح - تم رفضه من Mistral'
                : `TTS error: ${ttsResponse.status}`;
          errors.push(`Chunk ${pageNum}: ${ttsResponse.status} (${voiceId})`);

          await supabase
            .from('audiobook_text')
            .update({
              tts_status: 'failed',
              error_message: friendlyError,
              updated_at: new Date().toISOString(),
            })
            .eq('book_id', bookId)
            .eq('page_number', pageNum);

          continue;
        }

        // استجابة Mistral TTS هي JSON تحتوي على audio_data بتشفير base64
        const ttsJson = await ttsResponse.json();
        const audioBase64: string | undefined = ttsJson?.audio_data;

        if (!audioBase64) {
          console.error(`Mistral TTS: missing audio_data for chunk ${pageNum}`, ttsJson);
          errors.push(`Chunk ${pageNum}: استجابة بدون بيانات صوتية`);
          await supabase
            .from('audiobook_text')
            .update({
              tts_status: 'failed',
              error_message: 'استجابة بدون audio_data',
              updated_at: new Date().toISOString(),
            })
            .eq('book_id', bookId)
            .eq('page_number', pageNum);
          continue;
        }

        // فك تشفير base64 إلى Uint8Array (آمن للملفات الكبيرة)
        const binaryString = atob(audioBase64);
        const audioBuffer = new Uint8Array(binaryString.length);
        for (let j = 0; j < binaryString.length; j++) {
          audioBuffer[j] = binaryString.charCodeAt(j);
        }

        const audioFileName = `audiobooks/${bookId}/page_${String(pageNum).padStart(4, '0')}.mp3`;

        const { error: uploadError } = await supabase.storage
          .from('book-files')
          .upload(audioFileName, audioBuffer, {
            contentType: 'audio/mpeg',
            upsert: true,
          });

        if (uploadError) {
          console.error(`Storage upload error for chunk ${pageNum}:`, uploadError);
          errors.push(`Upload chunk ${pageNum}: ${uploadError.message}`);
          continue;
        }

        // الحصول على رابط الملف
        const { data: urlData } = supabase.storage
          .from('book-files')
          .getPublicUrl(audioFileName);

        // تحديث سجل الصفحة
        await supabase
          .from('audiobook_text')
          .update({
            audio_file_url: urlData.publicUrl,
            tts_status: 'completed',
            updated_at: new Date().toISOString(),
          })
          .eq('book_id', bookId)
          .eq('page_number', pageNum);

        processedCount++;

        // تحديث تقدم المهمة
        await supabase
          .from('audiobook_jobs')
          .update({
            processed_pages: processedCount,
            current_step: `converting_page_${pageNum}_of_${totalPages}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id);

      } catch (chunkError) {
        console.error(`Error processing chunk ${pageNum}:`, chunkError);
        errors.push(`Chunk ${pageNum}: ${chunkError instanceof Error ? chunkError.message : 'Unknown'}`);
      }
    }

    // 7. تحديث حالة المهمة النهائية
    const finalStatus = processedCount > 0 ? (errors.length > 0 ? 'completed_with_errors' : 'completed') : 'failed';

    await supabase
      .from('audiobook_jobs')
      .update({
        status: finalStatus,
        current_step: 'done',
        processed_pages: processedCount,
        completed_at: new Date().toISOString(),
        error_message: errors.length > 0 ? errors.join('; ') : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id);

    console.log(`✅ Audiobook generation ${finalStatus}: ${processedCount}/${totalPages} chunks processed`);

    return respond({
      success: true,
      ok: true,
      jobId: job.id,
      status: finalStatus,
      processedPages: processedCount,
      totalPages,
      language,
      voiceId,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (error) {
    console.error('Generate audiobook error:', error);
    return respond({
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
