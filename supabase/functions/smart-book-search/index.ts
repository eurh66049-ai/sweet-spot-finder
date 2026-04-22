import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface SearchLocation {
  page: number;
  sentence: string;
}

/**
 * Extract page number from page markers like "--- صفحة 5 ---"
 */
function extractPageFromMarkers(text: string, position: number): number {
  const pageMarkerRegex = /---\s*صفحة\s*(\d+)\s*---/g;
  let currentPage = 1;
  let match;
  
  while ((match = pageMarkerRegex.exec(text)) !== null) {
    if (match.index <= position) {
      currentPage = parseInt(match[1], 10);
    } else {
      break;
    }
  }
  
  return currentPage;
}

/**
 * Extract the sentence surrounding a match position
 */
function extractSentence(text: string, matchStart: number, matchEnd: number): string {
  // Find sentence boundaries (., !, ?, newline, or page markers)
  const sentenceBreakers = /[.!?؟\n]|---\s*صفحة/;
  
  let sentenceStart = matchStart;
  for (let i = matchStart - 1; i >= Math.max(0, matchStart - 200); i--) {
    if (sentenceBreakers.test(text[i]) || text.substring(i, i + 10).match(/---\s*صفحة/)) {
      sentenceStart = i + 1;
      break;
    }
    sentenceStart = i;
  }
  
  let sentenceEnd = matchEnd;
  for (let i = matchEnd; i < Math.min(text.length, matchEnd + 200); i++) {
    if (sentenceBreakers.test(text[i]) || text.substring(i, i + 10).match(/---\s*صفحة/)) {
      sentenceEnd = i;
      break;
    }
    sentenceEnd = i + 1;
  }
  
  return text.substring(sentenceStart, sentenceEnd).trim();
}

/**
 * Direct string search - fast and 100% accurate
 */
function directSearch(bookText: string, query: string): SearchLocation[] {
  const locations: SearchLocation[] = [];
  const normalizedText = bookText;
  const normalizedQuery = query.trim();
  
  // Search for exact match
  let searchPos = 0;
  while (true) {
    const idx = normalizedText.indexOf(normalizedQuery, searchPos);
    if (idx === -1) break;
    
    const page = extractPageFromMarkers(normalizedText, idx);
    const sentence = extractSentence(normalizedText, idx, idx + normalizedQuery.length);
    
    // Avoid duplicate pages with same sentence
    const isDuplicate = locations.some(l => l.page === page && l.sentence === sentence);
    if (!isDuplicate) {
      locations.push({ page, sentence });
    }
    
    searchPos = idx + 1;
  }
  
  // Also try without diacritics (tashkeel)
  if (locations.length === 0) {
    const stripDiacritics = (s: string) => s.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g, '');
    const cleanText = stripDiacritics(normalizedText);
    const cleanQuery = stripDiacritics(normalizedQuery);
    
    searchPos = 0;
    while (true) {
      const idx = cleanText.indexOf(cleanQuery, searchPos);
      if (idx === -1) break;
      
      const page = extractPageFromMarkers(normalizedText, idx);
      const sentence = extractSentence(normalizedText, idx, idx + cleanQuery.length);
      
      const isDuplicate = locations.some(l => l.page === page && l.sentence === sentence);
      if (!isDuplicate) {
        locations.push({ page, sentence });
      }
      
      searchPos = idx + 1;
    }
  }
  
  // Try with/without ال التعريف
  if (locations.length === 0) {
    const variants = [
      normalizedQuery.startsWith('ال') ? normalizedQuery.substring(2) : 'ال' + normalizedQuery,
    ];
    
    for (const variant of variants) {
      searchPos = 0;
      while (true) {
        const idx = normalizedText.indexOf(variant, searchPos);
        if (idx === -1) break;
        
        const page = extractPageFromMarkers(normalizedText, idx);
        const sentence = extractSentence(normalizedText, idx, idx + variant.length);
        
        const isDuplicate = locations.some(l => l.page === page && l.sentence === sentence);
        if (!isDuplicate) {
          locations.push({ page, sentence });
        }
        
        searchPos = idx + 1;
      }
      if (locations.length > 0) break;
    }
  }
  
  return locations;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { query, bookText, bookTitle, bookAuthor } = await req.json();

    if (!query || !bookText) {
      return new Response(JSON.stringify({ error: 'query and bookText are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 1: Direct string search (instant, 100% accurate)
    const directResults = directSearch(bookText, query.trim());
    
    if (directResults.length > 0) {
      const result = {
        found: true,
        answer: `تم العثور على "${query}" في ${directResults.length} موضع`,
        quotes: directResults.map(loc => loc.sentence),
        pages: [...new Set(directResults.map(loc => loc.page))],
        confidence: 1.0,
      };

      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 2: If direct search fails, use AI for fuzzy/semantic search
    const MISTRAL_API_KEY = Deno.env.get('MISTRAL_API_KEY');
    if (!MISTRAL_API_KEY) {
      return new Response(JSON.stringify({
        found: false,
        answer: 'لم يتم العثور على النص المطلوب',
        quotes: [],
        pages: [],
        confidence: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Use a much larger context window with the strongest Mistral model
    const maxChars = 60000;
    const textForAI = bookText.length > maxChars ? bookText.substring(0, maxChars) : bookText;

    const systemPrompt = `أنت أداة بحث نصي ذكية فائقة الدقة. مهمتك إيجاد كلمة أو عبارة في نص الكتاب حتى لو كانت بصيغ مختلفة.
الكتاب: "${bookTitle || ''}" - "${bookAuthor || ''}"

تعليمات:
1. ابحث عن تطابق حرفي أو أشكال مشابهة للكلمة (مع/بدون التشكيل، مع/بدون "ال" التعريف، صيغ الجمع والمفرد، الاشتقاقات).
2. حدد رقم الصفحة من علامات "--- صفحة X ---" قبل الموضع.
3. اقتبس الجملة الكاملة التي تحتوي على الكلمة.
4. أعد كل المواضع التي تجدها (وليس واحداً فقط).
5. إذا لم تجد شيئاً قل found: false.

أجب بJSON فقط:
{"found": true/false, "locations": [{"page": رقم, "sentence": "الجملة"}], "total": عدد}`;

    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `النص:\n${textForAI}\n\nابحث عن: "${query}"` }
        ],
        max_tokens: 4000,
        temperature: 0.0,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      return new Response(JSON.stringify({
        found: false,
        answer: 'لم يتم العثور على النص المطلوب',
        quotes: [],
        pages: [],
        confidence: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    
    try {
      const parsed = JSON.parse(content);
      if (parsed?.found && parsed.locations?.length > 0) {
        const validLocations = parsed.locations.filter((l: any) => l.page && l.sentence);
        return new Response(JSON.stringify({
          found: validLocations.length > 0,
          answer: validLocations.length > 0
            ? `تم العثور على "${query}" في ${validLocations.length} موضع`
            : 'لم يتم العثور على النص المطلوب',
          quotes: validLocations.map((l: any) => l.sentence),
          pages: [...new Set(validLocations.map((l: any) => l.page))],
          confidence: 0.8,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    } catch {
      // JSON parse failed
    }

    return new Response(JSON.stringify({
      found: false,
      answer: 'لم يتم العثور على النص المطلوب في هذا الكتاب',
      quotes: [],
      pages: [],
      confidence: 0,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('smart-book-search error:', error);
    return new Response(JSON.stringify({ error: 'حدث خطأ في البحث' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
