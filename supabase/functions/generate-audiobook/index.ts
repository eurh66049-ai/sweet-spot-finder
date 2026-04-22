import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  AVAILABLE_EMOTIONS,
  cleanTextForSpeech,
  decodeBase64Audio,
  DEFAULT_TTS_MODEL,
  detectLanguage,
  fetchAvailableVoices,
  type MistralEmotion,
  resolveVoiceId,
  splitTextIntoChunks,
} from "../_shared/audiobook-helpers.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function respond(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function appendError(existing: string | null | undefined, next: string) {
  const values = [existing, next]
    .filter(Boolean)
    .flatMap((value) => String(value).split('; '))
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(values)).slice(-8).join('; ');
}

async function callMistralTtsWithRetry(
  apiKey: string,
  body: Record<string, unknown>,
  maxRetries = 4,
): Promise<{ ok: true; audioBase64: string } | { ok: false; error: string; status?: number }> {
  const delays = [1000, 2500, 5000, 10000];

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch('https://api.mistral.ai/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const json = await response.json();
        const audioBase64 = json?.audio_data;
        if (!audioBase64) {
          return { ok: false, error: 'استجابة Mistral لا تحتوي على audio_data', status: response.status };
        }
        return { ok: true, audioBase64 };
      }

      const errorText = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRetries) {
        return {
          ok: false,
          status: response.status,
          error: `Mistral TTS error ${response.status}: ${errorText.slice(0, 250)}`,
        };
      }

      const retryAfter = response.headers.get('retry-after');
      const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : delays[attempt] || 10000;
      console.log(`⏳ Retrying TTS after ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(waitMs);
    } catch (error) {
      if (attempt === maxRetries) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown network error',
        };
      }
      await sleep(delays[attempt] || 10000);
    }
  }

  return { ok: false, error: 'Max retries exhausted' };
}

async function getBookText(supabase: ReturnType<typeof createClient>, bookId: string) {
  const { data, error } = await supabase
    .from('book_extracted_text')
    .select('extracted_text, text_length')
    .eq('book_id', bookId)
    .single();

  if (error || !data?.extracted_text?.trim()) {
    throw new Error('لا يوجد نص مستخرج لهذا الكتاب. قم باستخراج النص أولاً باستخدام OCR.');
  }

  return data;
}

async function getBookTitle(supabase: ReturnType<typeof createClient>, bookId: string) {
  const { data } = await supabase
    .from('approved_books')
    .select('title')
    .eq('id', bookId)
    .single();

  return data?.title || 'كتاب';
}

async function getLatestJob(supabase: ReturnType<typeof createClient>, bookId: string) {
  const { data, error } = await supabase
    .from('audiobook_jobs')
    .select('*')
    .eq('book_id', bookId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`تعذر جلب حالة التحويل: ${error.message}`);
  }

  return data;
}

async function finalizeJob(
  supabase: ReturnType<typeof createClient>,
  jobId: string,
  processedPages: number,
  totalPages: number,
  errorMessage?: string | null,
) {
  const { count } = await supabase
    .from('audiobook_text')
    .select('*', { count: 'exact', head: true })
    .eq('tts_status', 'completed')
    .eq('book_id', jobId);

  const hasSuccess = Boolean((count || 0) > 0);
  const finalStatus = hasSuccess
    ? (errorMessage ? 'completed_with_errors' : 'completed')
    : 'failed';

  await supabase
    .from('audiobook_jobs')
    .update({
      status: finalStatus,
      current_step: 'done',
      processed_pages: processedPages,
      total_pages: totalPages,
      error_message: errorMessage || null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  return finalStatus;
}

async function processSingleChunk(params: {
  supabase: ReturnType<typeof createClient>;
  apiKey: string;
  bookId: string;
  jobId: string;
  pageNum: number;
  totalPages: number;
  chunk: string;
  voiceId: string;
  selectedEmotion?: MistralEmotion;
}) {
  const { supabase, apiKey, bookId, jobId, pageNum, totalPages, chunk, voiceId, selectedEmotion } = params;

  const preparedChunk = cleanTextForSpeech(chunk);
  await supabase
    .from('audiobook_jobs')
    .update({
      status: 'processing',
      current_step: `converting_page_${pageNum}_of_${totalPages}`,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  await supabase
    .from('audiobook_text')
    .upsert({
      book_id: bookId,
      page_number: pageNum,
      cleaned_text: chunk,
      cleanup_status: 'completed',
      tts_status: 'processing',
      error_message: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'book_id,page_number' });

  if (!preparedChunk) {
    const errorMessage = 'النص المستخرج فارغ بعد التنظيف';
    await supabase
      .from('audiobook_text')
      .update({
        tts_status: 'failed',
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq('book_id', bookId)
      .eq('page_number', pageNum);

    return { ok: false as const, errorMessage };
  }

  const styledInput = selectedEmotion
    ? `اقرأ النص التالي بنبرة ${selectedEmotion}: ${preparedChunk}`
    : preparedChunk;

  const ttsResult = await callMistralTtsWithRetry(apiKey, {
    model: DEFAULT_TTS_MODEL,
    input: styledInput,
    voice_id: voiceId,
    response_format: 'mp3',
  });

  if (!ttsResult.ok) {
    const errorMessage = ttsResult.status === 404
      ? `الصوت المحدد غير موجود في Mistral أو غير متاح لهذا الحساب (voice_id: ${voiceId})`
      : ttsResult.status === 410
        ? 'إعدادات TTS هذه متوقفة أو قديمة في Mistral'
        : ttsResult.status === 400
          ? 'طلب TTS غير صالح - تم رفضه من Mistral'
          : ttsResult.error;

    await supabase
      .from('audiobook_text')
      .update({
        tts_status: 'failed',
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      })
      .eq('book_id', bookId)
      .eq('page_number', pageNum);

    return { ok: false as const, errorMessage };
  }

  const audioBuffer = decodeBase64Audio(ttsResult.audioBase64);
  const audioFileName = `${bookId}/page_${String(pageNum).padStart(4, '0')}.mp3`;

  const { error: uploadError } = await supabase.storage
    .from('audio-files')
    .upload(audioFileName, audioBuffer, {
      contentType: 'audio/mpeg',
      upsert: true,
    });

  if (uploadError) {
    await supabase
      .from('audiobook_text')
      .update({
        tts_status: 'failed',
        error_message: uploadError.message,
        updated_at: new Date().toISOString(),
      })
      .eq('book_id', bookId)
      .eq('page_number', pageNum);

    return { ok: false as const, errorMessage: uploadError.message };
  }

  const { data: urlData } = supabase.storage
    .from('audio-files')
    .getPublicUrl(audioFileName);

  await supabase
    .from('audiobook_text')
    .update({
      audio_file_url: urlData.publicUrl,
      tts_status: 'completed',
      updated_at: new Date().toISOString(),
    })
    .eq('book_id', bookId)
    .eq('page_number', pageNum);

  return { ok: true as const, audioUrl: urlData.publicUrl };
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

    if (action === 'voices') {
      const voices = await fetchAvailableVoices(MISTRAL_API_KEY);
      return respond({
        success: true,
        voices,
        emotions: AVAILABLE_EMOTIONS.map((item) => ({ id: item, name: item.charAt(0).toUpperCase() + item.slice(1) })),
      });
    }

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
          error: 'لا توجد أصوات TTS متاحة في حساب Mistral. أنشئ صوتاً أولاً من لوحة Mistral.',
        });
      }

      const voiceId = resolveVoiceId(availableVoices, language, voice);
      if (!voiceId) {
        return respond({
          success: false,
          ok: false,
          stage: 'voice_resolve',
          error: 'تعذر اختيار voice_id صالح.',
          availableVoiceIds: availableVoices.map((item) => item.id),
        });
      }

      const selectedEmotion = emotion && AVAILABLE_EMOTIONS.includes(emotion) ? emotion : undefined;
      const styledInput = selectedEmotion ? `اقرأ النص التالي بنبرة ${selectedEmotion}: ${cleaned}` : cleaned;
      const ttsResult = await callMistralTtsWithRetry(MISTRAL_API_KEY, {
        model: DEFAULT_TTS_MODEL,
        input: styledInput,
        voice_id: voiceId,
        response_format: 'mp3',
      });

      if (!ttsResult.ok) {
        return respond({
          success: false,
          ok: false,
          stage: 'tts',
          status: ttsResult.status,
          voiceId,
          model: DEFAULT_TTS_MODEL,
          error: ttsResult.error,
        });
      }

      const audioBuffer = decodeBase64Audio(ttsResult.audioBase64);
      const fileName = `_tests/test_${Date.now()}.mp3`;
      const { error: uploadError } = await supabase.storage
        .from('audio-files')
        .upload(fileName, audioBuffer, { contentType: 'audio/mpeg', upsert: true });

      if (uploadError) {
        return respond({
          success: true,
          ok: true,
          stage: 'data_url',
          voiceId,
          language,
          audioDataUrl: `data:audio/mpeg;base64,${ttsResult.audioBase64}`,
          uploadError: uploadError.message,
        });
      }

      const { data: urlData } = supabase.storage.from('audio-files').getPublicUrl(fileName);
      return respond({
        success: true,
        ok: true,
        stage: 'done',
        voiceId,
        language,
        audioUrl: urlData.publicUrl,
        audioDataUrl: `data:audio/mpeg;base64,${ttsResult.audioBase64}`,
      });
    }

    if (!bookId) {
      throw new Error('bookId is required');
    }

    if (action === 'status') {
      const job = await getLatestJob(supabase, bookId);
      return respond({ success: true, ok: true, job });
    }

    const textData = await getBookText(supabase, bookId);
    const fullText = textData.extracted_text.trim();
    const chunks = splitTextIntoChunks(fullText);
    const totalPages = chunks.length;

    if (totalPages === 0) {
      throw new Error('النص المستخرج فارغ ولا يمكن تحويله إلى صوت.');
    }

    const language = detectLanguage(fullText);
    const bookTitle = await getBookTitle(supabase, bookId);
    const availableVoices = await fetchAvailableVoices(MISTRAL_API_KEY);

    if (availableVoices.length === 0) {
      throw new Error('لا توجد أصوات TTS متاحة في Mistral لهذا الحساب حالياً.');
    }

    const voiceId = resolveVoiceId(availableVoices, language, voice);
    if (!voiceId) {
      throw new Error('تعذر اختيار voice_id صالح من Mistral لهذا الكتاب الصوتي.');
    }

    const selectedEmotion = emotion && AVAILABLE_EMOTIONS.includes(emotion) ? emotion : undefined;

    if (action === 'start') {
      await supabase.from('audiobook_text').delete().eq('book_id', bookId);

      const { data: job, error: jobError } = await supabase
        .from('audiobook_jobs')
        .upsert({
          book_id: bookId,
          book_title: bookTitle,
          status: 'processing',
          current_step: `queued_0_of_${totalPages}`,
          total_pages: totalPages,
          processed_pages: 0,
          error_message: null,
          completed_at: null,
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'book_id' })
        .select()
        .single();

      if (jobError) {
        throw new Error(`Failed to create job: ${jobError.message}`);
      }

      return respond({
        success: true,
        ok: true,
        jobId: job.id,
        status: 'processing',
        totalPages,
        language,
        voiceId,
        currentStep: `queued_0_of_${totalPages}`,
        message: 'تم تجهيز التحويل الصوتي وسيبدأ على دفعات قصيرة لتفادي التوقف.',
      });
    }

    if (action !== 'process-next') {
      throw new Error('Unsupported action');
    }

    const job = await getLatestJob(supabase, bookId);
    if (!job) {
      throw new Error('لا توجد مهمة تحويل لهذا الكتاب. ابدأ التحويل أولاً.');
    }

    if (job.status === 'completed' || job.status === 'completed_with_errors' || job.status === 'failed') {
      return respond({
        success: true,
        ok: true,
        status: job.status,
        processedPages: job.processed_pages || 0,
        totalPages: job.total_pages || totalPages,
        currentStep: job.current_step,
        error: job.error_message,
      });
    }

    const processedPages = Number(job.processed_pages || 0);
    const nextIndex = processedPages;

    if (nextIndex >= totalPages) {
      const finalStatus = await finalizeJob(supabase, job.id, processedPages, totalPages, job.error_message);
      return respond({
        success: true,
        ok: true,
        status: finalStatus,
        processedPages,
        totalPages,
        currentStep: 'done',
        error: job.error_message,
      });
    }

    const pageNum = nextIndex + 1;
    console.log(`🔊 Processing chunk ${pageNum}/${totalPages} (${chunks[nextIndex].length} chars)...`);

    const chunkResult = await processSingleChunk({
      supabase,
      apiKey: MISTRAL_API_KEY,
      bookId,
      jobId: job.id,
      pageNum,
      totalPages,
      chunk: chunks[nextIndex],
      voiceId,
      selectedEmotion,
    });

    const nextProcessedPages = pageNum;
    const nextErrorMessage = chunkResult.ok
      ? (job.error_message || null)
      : appendError(job.error_message, `Chunk ${pageNum}: ${chunkResult.errorMessage}`);

    const isLastChunk = nextProcessedPages >= totalPages;
    const nextStep = isLastChunk ? 'done' : `queued_${nextProcessedPages}_of_${totalPages}`;

    let nextStatus = 'processing';
    if (isLastChunk) {
      nextStatus = await finalizeJob(supabase, job.id, nextProcessedPages, totalPages, nextErrorMessage);
    } else {
      await supabase
        .from('audiobook_jobs')
        .update({
          status: 'processing',
          current_step: nextStep,
          processed_pages: nextProcessedPages,
          total_pages: totalPages,
          error_message: nextErrorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    }

    return respond({
      success: true,
      ok: true,
      status: nextStatus,
      processedPages: nextProcessedPages,
      totalPages,
      currentStep: isLastChunk ? 'done' : nextStep,
      error: nextErrorMessage,
      pageProcessed: pageNum,
      voiceId,
    });
  } catch (error) {
    console.error('Generate audiobook error:', error);
    return respond({
      ok: false,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});
