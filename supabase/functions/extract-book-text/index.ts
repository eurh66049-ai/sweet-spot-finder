import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

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

    const { bookId, imageUrls, bookTable = 'approved_books' } = await req.json();

    if (!bookId) {
      throw new Error('bookId is required');
    }

    // Update status to processing
    await supabase
      .from('book_extracted_text')
      .upsert({
        book_id: bookId,
        extraction_status: 'processing',
        extracted_text: null,
        extraction_error: null,
        text_length: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'book_id' });

    // Get book data
    const { data: book, error: bookError } = await supabase
      .from(bookTable)
      .select('book_file_url, cover_image_url, title')
      .eq('id', bookId)
      .single();

    if (bookError || !book) {
      throw new Error(`Book not found: ${bookError?.message || 'Unknown error'}`);
    }

    let allText = '';
    let processedPages = 0;
    const errors: string[] = [];

    // Prefer the book file (PDF) for OCR; fallback to images
    const documentUrl = book.book_file_url;
    const fallbackImages: string[] = imageUrls || [];

    if (documentUrl) {
      console.log(`📄 Running Mistral OCR on document: ${documentUrl.substring(0, 100)}...`);

      try {
        const ocrResponse = await fetch('https://api.mistral.ai/v1/ocr', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${MISTRAL_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'mistral-ocr-latest',
            document: {
              type: 'document_url',
              document_url: documentUrl,
            },
            include_image_base64: false,
            image_limit: 0,
          }),
        });

        if (!ocrResponse.ok) {
          const errorText = await ocrResponse.text();
          console.error('Mistral OCR error:', ocrResponse.status, errorText);
          errors.push(`Mistral OCR error: ${ocrResponse.status} - ${errorText.substring(0, 200)}`);
        } else {
          const ocrData = await ocrResponse.json();
          const pages = ocrData.pages || [];

          for (const page of pages) {
            const pageText = page.markdown || page.text || '';
            if (pageText.trim()) {
              processedPages++;
              allText += `\n--- صفحة ${processedPages} ---\n${pageText}\n`;
            }
          }

          console.log(`✅ Mistral OCR: extracted ${processedPages} pages, ${allText.length} chars`);
        }
      } catch (ocrError) {
        console.error('OCR request failed:', ocrError);
        errors.push(`OCR request failed: ${ocrError instanceof Error ? ocrError.message : 'Unknown'}`);
      }
    }

    // Fallback: OCR on images if document OCR didn't produce text
    if (!allText.trim() && (fallbackImages.length > 0 || book.cover_image_url)) {
      const imagesToProcess = fallbackImages.length > 0 ? fallbackImages : [book.cover_image_url].filter(Boolean) as string[];

      console.log(`🖼️ Fallback: running Mistral OCR on ${imagesToProcess.length} image(s)`);

      for (const imageUrl of imagesToProcess) {
        try {
          const ocrResponse = await fetch('https://api.mistral.ai/v1/ocr', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${MISTRAL_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'mistral-ocr-latest',
              document: {
                type: 'image_url',
                image_url: imageUrl,
              },
              include_image_base64: false,
            }),
          });

          if (!ocrResponse.ok) {
            const errorText = await ocrResponse.text();
            errors.push(`Image OCR error: ${ocrResponse.status}`);
            console.error('Mistral OCR image error:', errorText);
            continue;
          }

          const ocrData = await ocrResponse.json();
          const pages = ocrData.pages || [];
          for (const page of pages) {
            const pageText = page.markdown || page.text || '';
            if (pageText.trim()) {
              processedPages++;
              allText += `\n--- صفحة ${processedPages} ---\n${pageText}\n`;
            }
          }
        } catch (imgError) {
          errors.push(`Image OCR failed: ${imgError instanceof Error ? imgError.message : 'Unknown'}`);
        }
      }
    }

    const finalStatus = allText.trim() ? 'completed' : 'failed';
    const finalError = errors.length > 0 ? errors.join('; ') : null;

    await supabase
      .from('book_extracted_text')
      .upsert({
        book_id: bookId,
        extracted_text: allText.trim() || null,
        extraction_status: finalStatus,
        extraction_error: finalError,
        text_length: allText.trim().length,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'book_id' });

    return new Response(
      JSON.stringify({
        success: true,
        bookId,
        processedPages,
        textLength: allText.trim().length,
        status: finalStatus,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Extract text error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
