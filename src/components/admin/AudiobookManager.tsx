import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Headphones, Search, CheckCircle, XCircle, RefreshCw, Play, AlertCircle, Mic, FlaskConical } from 'lucide-react';
import { supabase, supabaseFunctions } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Progress } from '@/components/ui/progress';

interface VoiceOption {
  id: string;
  name?: string | null;
  slug?: string | null;
  languages?: string[] | null;
}

const EMOTIONS = [
  { id: 'neutral', name: 'محايد', emoji: '😐' },
  { id: 'sad', name: 'حزين', emoji: '😢' },
  { id: 'excited', name: 'متحمس', emoji: '🤩' },
  { id: 'curious', name: 'فضولي', emoji: '🤔' },
  { id: 'confident', name: 'واثق', emoji: '😎' },
  { id: 'cheerful', name: 'مبتهج', emoji: '😊' },
  { id: 'angry', name: 'غاضب', emoji: '😡' },
];

interface BookForAudiobook {
  id: string;
  title: string;
  author: string;
  cover_image_url: string | null;
  has_extracted_text: boolean;
  text_length: number | null;
  audiobook_status: string | null;
  audiobook_progress: number;
  audiobook_total: number;
  audiobook_error: string | null;
}

const AudiobookManager: React.FC = () => {
  const [books, setBooks] = useState<BookForAudiobook[]>([]);
  const [loading, setLoading] = useState(true);
  const [voicesLoading, setVoicesLoading] = useState(true);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [processingBookId, setProcessingBookId] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState('');
  const [selectedEmotion, setSelectedEmotion] = useState('neutral');

  // اختبار سريع
  const [testText, setTestText] = useState('مرحباً، هذا اختبار لتحويل النص إلى صوت باستخدام Mistral TTS.');
  const [testing, setTesting] = useState(false);
  const [testAudioUrl, setTestAudioUrl] = useState<string | null>(null);
  const [testDiagnostics, setTestDiagnostics] = useState<any>(null);

  const { toast } = useToast();

  const runTtsTest = async () => {
    if (!testText.trim()) {
      toast({ title: 'أدخل جملة للاختبار', variant: 'destructive' });
      return;
    }
    setTesting(true);
    setTestAudioUrl(null);
    setTestDiagnostics(null);
    try {
      const { data, error } = await supabaseFunctions.functions.invoke('generate-audiobook', {
        body: {
          action: 'test',
          text: testText,
          voice: selectedVoice || undefined,
          emotion: selectedEmotion || undefined,
        },
      });

      if (error) throw error;
      setTestDiagnostics(data);

      if (data?.success) {
        const url = data.audioUrl || data.audioDataUrl;
        setTestAudioUrl(url);
        toast({
          title: 'نجح اختبار TTS ✅',
          description: `Voice: ${data.voiceId} • Lang: ${data.language}`,
        });
      } else {
        toast({
          title: `فشل الاختبار (${data?.stage || 'unknown'})`,
          description: data?.error || 'خطأ غير معروف',
          variant: 'destructive',
        });
      }
    } catch (err) {
      console.error('TTS test error:', err);
      toast({
        title: 'خطأ في الاختبار',
        description: err instanceof Error ? err.message : 'خطأ غير متوقع',
        variant: 'destructive',
      });
    } finally {
      setTesting(false);
    }
  };

  const fetchVoices = async () => {
    setVoicesLoading(true);
    try {
      const { data, error } = await supabaseFunctions.functions.invoke('generate-audiobook', {
        body: { action: 'voices' },
      });

      if (error) throw error;

      const nextVoices = Array.isArray(data?.voices) ? data.voices : [];
      setVoices(nextVoices);
      setSelectedVoice((current) => current || nextVoices[0]?.id || '');
    } catch (err) {
      console.error('Error fetching TTS voices:', err);
      toast({
        title: 'تعذر جلب الأصوات',
        description: 'تحقق من إعداد أصوات Mistral في الخادم',
        variant: 'destructive',
      });
    } finally {
      setVoicesLoading(false);
    }
  };

  const fetchBooks = async () => {
    setLoading(true);
    try {
      const { data: approvedBooks, error } = await supabase
        .from('approved_books' as any)
        .select('id, title, author, cover_image_url')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      const bookIds = (approvedBooks as any[])?.map((b: any) => b.id) || [];

      // جلب حالة استخراج النص
      const { data: extractions } = await supabase
        .from('book_extracted_text')
        .select('book_id, extraction_status, text_length')
        .in('book_id', bookIds);

      const extractionMap = new Map(
        (extractions || []).map(e => [e.book_id, e])
      );

      // جلب حالة الكتب الصوتية
      const { data: jobs } = await supabase
        .from('audiobook_jobs')
        .select('book_id, status, processed_pages, total_pages, error_message')
        .in('book_id', bookIds)
        .order('created_at', { ascending: false });

      const jobMap = new Map<string, any>();
      (jobs || []).forEach(j => {
        if (!jobMap.has(j.book_id)) jobMap.set(j.book_id, j);
      });

      const result: BookForAudiobook[] = ((approvedBooks as any[]) || []).map((book: any) => {
        const ext = extractionMap.get(book.id);
        const job = jobMap.get(book.id);
        return {
          ...book,
          has_extracted_text: ext?.extraction_status === 'completed',
          text_length: ext?.text_length || null,
          audiobook_status: job?.status || null,
          audiobook_progress: job?.processed_pages || 0,
          audiobook_total: job?.total_pages || 0,
          audiobook_error: job?.error_message || null,
        };
      });

      setBooks(result);
    } catch (err) {
      console.error('Error fetching books:', err);
      toast({ title: 'خطأ في جلب الكتب', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBooks();
    fetchVoices();
  }, []);

  // 🔄 Polling تلقائي لتحديث تقدم الكتب قيد المعالجة كل 3 ثوانٍ
  useEffect(() => {
    const hasProcessing = books.some(b => b.audiobook_status === 'processing');
    if (!hasProcessing) return;

    const interval = setInterval(async () => {
      const processingIds = books
        .filter(b => b.audiobook_status === 'processing')
        .map(b => b.id);

      if (processingIds.length === 0) return;

      const { data: jobs } = await supabase
        .from('audiobook_jobs')
        .select('book_id, status, processed_pages, total_pages, error_message')
        .in('book_id', processingIds);

      if (!jobs) return;

      const jobMap = new Map(jobs.map(j => [j.book_id, j]));

      setBooks(prev => prev.map(b => {
        const job = jobMap.get(b.id);
        if (!job) return b;
        const wasProcessing = b.audiobook_status === 'processing';
        const nowDone = job.status === 'completed' || job.status === 'completed_with_errors';
        if (wasProcessing && nowDone) {
          toast({
            title: 'اكتمل تحويل الكتاب الصوتي ✅',
            description: `${job.processed_pages}/${job.total_pages} جزء`,
          });
        }
        return {
          ...b,
          audiobook_status: job.status,
          audiobook_progress: job.processed_pages || 0,
          audiobook_total: job.total_pages || 0,
          audiobook_error: job.error_message || null,
        };
      }));
    }, 3000);

    return () => clearInterval(interval);
  }, [books, toast]);

  const generateAudiobook = async (bookId: string) => {
    setProcessingBookId(bookId);
    try {
      const { data, error } = await supabaseFunctions.functions.invoke('generate-audiobook', {
        body: { bookId, action: 'start', voice: selectedVoice, emotion: selectedEmotion },
      });

      if (error) throw error;

      if (data?.success) {
        // ✅ المهمة تعمل في الخلفية - نُحدّث الحالة محلياً ليبدأ polling
        setBooks(prev => prev.map(b =>
          b.id === bookId
            ? { ...b, audiobook_status: 'processing', audiobook_progress: 0, audiobook_total: data.totalPages || 0, audiobook_error: null }
            : b
        ));
        toast({
          title: 'بدأ التحويل في الخلفية ⏳',
          description: `${data.totalPages} جزء — تتبع التقدم في الشريط أدناه`,
        });
      } else {
        throw new Error(data?.error || 'فشل في بدء التحويل');
      }
    } catch (err) {
      console.error('Audiobook generation error:', err);
      toast({
        title: 'خطأ في إنشاء الكتاب الصوتي',
        description: err instanceof Error ? err.message : 'خطأ غير متوقع',
        variant: 'destructive',
      });
    } finally {
      setProcessingBookId(null);
    }
  };

  const filteredBooks = books.filter(b =>
    b.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    b.author.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getStatusBadge = (status: string | null, hasText: boolean) => {
    if (!hasText) {
      return <Badge variant="outline" className="text-xs"><AlertCircle className="h-3 w-3 ml-1" />بحاجة لـ OCR</Badge>;
    }
    switch (status) {
      case 'completed':
        return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 text-xs"><CheckCircle className="h-3 w-3 ml-1" />مكتمل</Badge>;
      case 'completed_with_errors':
        return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300 text-xs"><AlertCircle className="h-3 w-3 ml-1" />مكتمل جزئياً</Badge>;
      case 'processing':
        return <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 text-xs"><Loader2 className="h-3 w-3 ml-1 animate-spin" />قيد التحويل</Badge>;
      case 'failed':
        return <Badge className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 text-xs"><XCircle className="h-3 w-3 ml-1" />فشل</Badge>;
      default:
        return <Badge variant="secondary" className="text-xs"><Headphones className="h-3 w-3 ml-1" />جاهز للتحويل</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="mr-3 text-muted-foreground">جاري تحميل الكتب...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* اختيار الصوت والمشاعر */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Mic className="h-5 w-5 text-primary" />
            <h3 className="font-semibold text-sm">إعدادات الصوت</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">اختر صوتاً</label>
              <Select value={selectedVoice} onValueChange={setSelectedVoice} disabled={voicesLoading || voices.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder={voicesLoading ? 'جاري تحميل الأصوات...' : 'اختر صوتاً'} />
                </SelectTrigger>
                <SelectContent>
                  {voices.map(v => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name || v.slug || v.id}
                      {v.languages?.length ? ` — ${v.languages.join(', ')}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">اختر المشاعر</label>
              <Select value={selectedEmotion} onValueChange={setSelectedEmotion}>
                <SelectTrigger>
                  <SelectValue placeholder="اختر المشاعر" />
                </SelectTrigger>
                <SelectContent>
                  {EMOTIONS.map(e => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.emoji} {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* بطاقة اختبار سريع */}
      <Card className="border-primary/30">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-primary" />
            <h3 className="font-semibold text-sm">اختبار سريع لتحويل النص إلى صوت</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            اكتب جملة قصيرة هنا واضغط "اختبر التحويل" للتأكد من أن Mistral TTS يعمل قبل تحويل كتاب كامل.
          </p>
          <Textarea
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder="اكتب جملة للاختبار..."
            rows={3}
            className="text-sm"
            dir="auto"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={runTtsTest} disabled={testing || voicesLoading} size="sm">
              {testing ? <Loader2 className="h-4 w-4 animate-spin ml-1" /> : <Play className="h-4 w-4 ml-1" />}
              اختبر التحويل
            </Button>
            {selectedVoice && (
              <Badge variant="secondary" className="text-xs">صوت: {selectedVoice}</Badge>
            )}
            <Badge variant="outline" className="text-xs">شعور: {selectedEmotion}</Badge>
          </div>

          {testAudioUrl && (
            <div className="pt-2">
              <audio controls src={testAudioUrl} className="w-full" />
            </div>
          )}

          {testDiagnostics && (
            <details className="text-xs bg-muted/50 rounded p-2">
              <summary className="cursor-pointer font-medium">تفاصيل التشخيص</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-[10px] leading-relaxed">
{JSON.stringify(testDiagnostics, null, 2)}
              </pre>
            </details>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="ابحث عن كتاب..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="max-w-sm"
          />
        </div>
        <Button onClick={fetchBooks} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 ml-1" />
          تحديث
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {filteredBooks.map((book) => (
          <Card key={book.id} className="overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-start gap-4">
                <div className="w-16 h-20 flex-shrink-0 rounded overflow-hidden bg-muted">
                  {book.cover_image_url ? (
                    <img src={book.cover_image_url} alt={book.title} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Headphones className="h-6 w-6 text-muted-foreground" />
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-sm truncate">{book.title}</h3>
                  <p className="text-xs text-muted-foreground">{book.author}</p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {getStatusBadge(book.audiobook_status, book.has_extracted_text)}
                    {book.text_length && (
                      <span className="text-xs text-muted-foreground">
                        {book.text_length.toLocaleString()} حرف
                      </span>
                    )}
                  </div>
                  {book.audiobook_status === 'processing' && book.audiobook_total > 0 && (
                    <div className="mt-2">
                      <Progress value={(book.audiobook_progress / book.audiobook_total) * 100} className="h-2" />
                      <span className="text-xs text-muted-foreground">
                        {book.audiobook_progress}/{book.audiobook_total} أجزاء
                      </span>
                    </div>
                  )}
                  {book.audiobook_error && (
                    <p className="text-xs text-destructive mt-1 truncate">{book.audiobook_error}</p>
                  )}
                </div>

                <div className="flex flex-col gap-2 flex-shrink-0">
                  <Button
                    size="sm"
                    onClick={() => generateAudiobook(book.id)}
                    disabled={!book.has_extracted_text || processingBookId === book.id || voicesLoading || !selectedVoice}
                    title={!book.has_extracted_text ? 'يجب استخراج النص أولاً (OCR)' : 'تحويل إلى كتاب صوتي'}
                  >
                    {processingBookId === book.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 ml-1" />
                    )}
                    تحويل لصوت
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {filteredBooks.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          لا توجد كتب مطابقة للبحث
        </div>
      )}
    </div>
  );
};

export default AudiobookManager;
