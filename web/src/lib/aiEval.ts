import { getAccessToken, getPublicRuntimeConfig } from './auth';
import { APP_CONFIG } from './supabase';
import type { AiEvalResult, DialogueTurn, PronunciationScores } from './types';

export const DEFAULT_GEMINI_ENDPOINT = APP_CONFIG.DEFAULT_GEMINI_ENDPOINT;
export const DEFAULT_GEMINI_MODEL = APP_CONFIG.DEFAULT_GEMINI_MODEL;

let cachedRuntimeUrls: { apiUrl: string; geminiApiUrl: string; geminiModel: string } = {
  apiUrl: APP_CONFIG.SPEAKAI_API_URL || '',
  geminiApiUrl: DEFAULT_GEMINI_ENDPOINT,
  geminiModel: DEFAULT_GEMINI_MODEL,
};

let runtimePromise: Promise<void> | null = null;

export async function syncGeminiConfigFromSupabase(force = false): Promise<{
  apiUrl: string;
  geminiApiUrl: string;
  geminiModel: string;
}> {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('speakai_gemini_key');
  }
  if (!force && cachedRuntimeUrls.geminiApiUrl && cachedRuntimeUrls.geminiModel && !runtimePromise) {
    if (cachedRuntimeUrls.apiUrl) return cachedRuntimeUrls;
  }
  if (!runtimePromise || force) {
    runtimePromise = (async () => {
      try {
        const data = await getPublicRuntimeConfig();
        if (data) {
          cachedRuntimeUrls = {
            apiUrl: (data.api_url || cachedRuntimeUrls.apiUrl || '').trim().replace(/\/+$/, ''),
            geminiApiUrl: (data.gemini_api_url || cachedRuntimeUrls.geminiApiUrl || DEFAULT_GEMINI_ENDPOINT).trim(),
            geminiModel: (data.gemini_model || cachedRuntimeUrls.geminiModel || DEFAULT_GEMINI_MODEL).trim(),
          };
        }
      } catch (err) {
        console.warn('Lỗi lấy cấu hình AI Evaluator từ Supabase:', err);
      } finally {
        runtimePromise = null;
      }
    })();
  }
  await runtimePromise;
  return cachedRuntimeUrls;
}

export function setRuntimeGpuUrl(apiUrl: string) {
  cachedRuntimeUrls = {
    ...cachedRuntimeUrls,
    apiUrl: apiUrl.trim().replace(/\/+$/, ''),
  };
}

interface CallAiProxyParams {
  action: 'eval_answer' | 'eval_conversation';
  messages: Array<{ role: 'system' | 'user'; content: unknown }>;
  temperature?: number;
  gpuUrlFallback?: string;
}

async function callAiProxy({ action, messages, temperature = 0.2, gpuUrlFallback }: CallAiProxyParams) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('Chưa đăng nhập hoặc phiên làm việc đã hết hạn.');
  }

  const runtime = await syncGeminiConfigFromSupabase();
  const gpuBase = (gpuUrlFallback || runtime.apiUrl || '').trim().replace(/\/+$/, '');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  const bodyJson = JSON.stringify({ action, messages, temperature });

  let res: Response | null = null;
  let shouldFallback = false;

  try {
    res = await fetch('/api/ai-eval', {
      method: 'POST',
      headers,
      body: bodyJson,
    });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (
      res.status === 404 ||
      res.status === 405 ||
      res.status === 501 ||
      res.status === 503 ||
      (!contentType.includes('application/json') && res.status >= 400)
    ) {
      shouldFallback = true;
    }
  } catch (networkErr) {
    if (!gpuBase) throw networkErr;
    shouldFallback = true;
  }

  if (shouldFallback && gpuBase) {
    const gpuRes = await fetch(`${gpuBase}/ai_eval`, {
      method: 'POST',
      headers,
      body: bodyJson,
    });
    res = gpuRes;
  }

  if (!res) {
    throw new Error('Không thể kết nối tới dịch vụ chấm điểm AI.');
  }

  const payload = (await res.json().catch(() => null)) as {
    success?: boolean;
    content?: string;
    model?: string;
    error?: string;
    detail?: string;
  } | null;

  if (!res.ok || !payload?.success) {
    throw new Error(
      payload?.error || payload?.detail || 'Dịch vụ AI tạm thời không phản hồi. Vui lòng thử lại.',
    );
  }

  return payload;
}

function buildExaminerSystemPrompt(): string {
  return `Bạn là Giám khảo Khảo thí Speaking Quốc tế (Chuẩn IELTS / Cambridge). Đánh giá bài nói của học viên khách quan, công bằng theo đúng 4 TRỤ CỘT IELTS (PR: 25%, FC: 25%, LR: 25%, GRA: 25%) trên thang band 1.0 - 9.0 (bước nhảy 0.5) và trả về DUY NHẤT 1 JSON.

QUY TẮC CHẤM ĐIỂM THEO 4 TRỤ CỘT IELTS (THANG 1.0 - 9.0, BƯỚC NHẢY 0.5):
1. PR - Pronunciation (score_pronunciation 1.0-9.0 - 25%): Đã được đo lường bằng mô hình âm học WavLM-Large + SpeechOcean762. BẮT BUỘC giữ nguyên điểm PR hệ thống cung cấp, KHÔNG tự ý thay đổi.
2. FC - Fluency & Coherence / Mạch lạc & Ngữ cảnh (score_fluency_coherence 1.0-9.0 - 25%):
   - Trả lời rõ ràng, trực diện, đúng trọng tâm câu hỏi, không ngắt quãng: 7.0.
   - Phát triển ý mở rộng, mạch lạc, có ví dụ hoặc giải thích tự nhiên: 7.5 - 8.5.
   - Ngập ngừng nhẹ, câu hơi ngắn hoặc tự sửa lỗi nhỏ: 6.5.
   - Cụm từ cụt 1-2 từ thiếu động từ, ngắt quãng/lặp từ nhiều: 5.5 - 6.0.
   - Lạc đề hoàn toàn hoặc vô nghĩa: <= 3.0 (relevance_level = "irrelevant").
3. LR - Lexical Resource / Vốn từ vựng (score_lexical 1.0-9.0 - 25%):
   - Từ vựng giao tiếp hằng ngày đúng chủ đề câu hỏi (hoặc đánh vần chuẩn): 7.0.
   - Từ vựng chính xác, chọn lọc, có collocations hoặc từ ít phổ biến (B2-C1): 7.5 - 8.5.
   - Từ vựng tối giản, lặp từ hoặc dùng từ chưa chính xác: 6.0 - 6.5.
4. GRA - Grammatical Range & Accuracy / Ngữ pháp (score_grammar 1.0-9.0 - 25%):
   - Câu phức/câu ghép/so sánh/mệnh đề phụ chính xác không lỗi: 8.5.
   - Câu đơn hoàn chỉnh đúng ngữ pháp (hoặc đánh vần chuẩn): 8.0.
   - Cụm danh từ liệt kê hợp ngữ cảnh, hoặc lấn cấn nhỏ về diễn đạt/số ít-nhiều: 7.0 - 7.5.
   - Có 1 lỗi ngữ pháp rõ ràng (thiếu mạo từ trước danh từ đếm được số ít, dùng tính từ làm tân ngữ động từ, câu chưa trọn ý): 6.5.
   - Lỗi cấu trúc nặng hoặc nhiều lỗi (bất đồng chủ-vị, lệch số ít/nhiều đại từ, thiếu danh từ chính, cụm cụt 1-2 từ không động từ): 5.5 - 6.0.
   - Liệt kê tất cả lỗi ngữ pháp tìm được vào "grammar_errors".
5. Overall Band (score_total 1.0-9.0): Trung bình cộng tự nhiên 4 trụ cột làm tròn 1 chữ số thập phân:
   Overall = (PR + FC + LR + GRA) / 4.

OUTPUT JSON FORMAT:
{
  "score_total": <float 1.0-9.0>,
  "score_pronunciation": <float 1.0-9.0>,
  "score_fluency_coherence": <float 1.0-9.0>,
  "score_lexical": <float 1.0-9.0>,
  "score_grammar": <float 1.0-9.0>,
  "score_context": <float 1.0-9.0>,
  "relevance_level": "too_short" | "irrelevant" | "partially_relevant" | "relevant" | "excellent",
  "grammar_errors": [{"error_text": "...", "fix": "...", "explanation": "..."}],
  "feedback_summary": "<Nhận xét sư phạm 1-2 câu tiếng Việt>",
  "better_expression": "<1 câu nói mẫu tự nhiên, nâng cao>"
}`;
}

export function getTaskSpecificRubric(taskType = ''): string {
  const normType = (taskType || '').trim().toLowerCase();

  switch (normType) {
    case 'read_aloud':
      return `- Dạng Đọc to (Read Aloud): Đề bài đã cho sẵn văn bản chuẩn.
- Ngữ pháp & Ngữ cảnh: HOÀN TOÀN KHÔNG ÁP DỤNG (score_grammar = null, score_context = null). Dạng bài này 100% chỉ đánh giá Phát âm và Ngữ điệu âm học, TUYỆT ĐỐI KHÔNG chấm hay đưa ngữ pháp và ngữ cảnh vào tính điểm.
- Điểm tổng (score_total): Giữ nguyên 100% điểm phát âm âm học (Avg).
- Nhận xét: Nhận xét ngắn gọn về ngắt nghỉ đúng cụm nghĩa (pausing), ngữ điệu (intonation), trọng âm từ và nối âm.`;
    case 'picture_description':
      return `- Dạng Miêu tả tranh (Picture Description - PHÂN TÍCH THỊ GIÁC TRỰC TIẾP TỪ ẢNH THẬT):
- Bức ảnh thật của đề thi được đính kèm trực tiếp. AI là chuyên gia thị giác (Vision AI), hãy QUAN SÁT TRỰC TIẾP bức ảnh thật này (TUYỆT ĐỐI KHÔNG dùng hay đòi hỏi mô tả văn bản thủ công từ giáo viên).
- Ngữ cảnh (score_context): Đối chiếu từng chi tiết trong lời nói học viên với các yếu tố THỰC TẾ trong ảnh:
  + Đúng người, hành động, bối cảnh không gian, trang phục, đồ vật, vị trí có thật trong ảnh -> Cho điểm ngữ cảnh cao (8.0 - 10.0).
  + Tả sai sự thật có trong ảnh (nhầm người, bịa đặt đồ vật, nói sai hành động/màu sắc/bối cảnh) -> Trừ điểm score_context và chỉ rõ chi tiết học viên nói sai so với ảnh trong feedback_summary.
- Ngữ pháp (score_grammar): Đánh giá việc sử dụng thì Hiện tại tiếp diễn (is/are + V-ing) khi tả hành động, cụm từ chỉ vị trí không gian (in the foreground/background, on the left/right, next to...) và cấu trúc "There is/are".`;
    case 'short_qa':
      return `- Dạng Trả lời ngắn (Short Q&A):
- Ngữ cảnh: Trả lời trực diện vào câu hỏi cá nhân, sở thích, thói quen (Wh-questions). TUYỆT ĐỐI KHÔNG chỉ trả lời cộc lốc 1-2 từ (Yes/No); yêu cầu mở rộng thêm 1-2 câu giải thích lý do hoặc ví dụ.
- Ngữ pháp: Sử dụng đúng thì Hiện tại đơn, trạng từ chỉ tần suất (always, often, rarely...) và liên từ cơ bản.`;
    case 'information_qa':
      return `- Dạng Trả lời dựa trên thông tin (Information-based Q&A - BẮT BUỘC FACT-CHECKING):
- Ngữ cảnh: ĐỐI CHIẾU TRỰC TIẾP với dữ liệu/lịch trình đã cho. Nếu thí sinh nói sai thời gian, ngày tháng, địa điểm, tên người hoặc chi phí -> BẮT BUỘC trừ nặng score_context <= 4.0.
- Ngữ pháp: Sử dụng chuẩn xác giới từ thời gian/nơi chốn (at, on, in), thì hiện tại hoặc tương lai (will take place, is scheduled at...).`;
    case 'description':
      return `- Dạng Miêu tả chi tiết (Description - Person, Place, Object, Event):
- Ngữ cảnh: Miêu tả sinh động, cụ thể, giàu chi tiết về đối tượng được yêu cầu. Tránh liệt kê khô khan.
- Ngữ pháp: Sử dụng đa dạng tính từ mô tả, mệnh đề quan hệ (who, which, where) và chia thì nhất quán (Hiện tại đơn nếu tả thói quen/đặc điểm, Quá khứ đơn nếu tả sự kiện đã diễn ra).`;
    case 'experience_future':
      return `- Dạng Trải nghiệm / Tương lai (Experience / Future):
- Ngữ pháp: Kiểm soát chính xác thì Quá khứ (Past Simple/Continuous, Present Perfect) khi kể lại trải nghiệm; và thì Tương lai/cấu trúc dự đoán (will, be going to, plan to, would like to) khi nói về kế hoạch.
- Ngữ cảnh: Trình tự thời gian (timeline) rõ ràng, nêu bật cảm xúc, bài học hoặc mục tiêu cá nhân.`;
    case 'opinion':
      return `- Dạng Bày tỏ quan điểm (Opinion):
- Ngữ cảnh: Nêu rõ lập trường/quan điểm dứt khoát ngay từ đầu (I strongly agree/disagree, In my view...). Đưa ra ít nhất 1-2 luận cứ xác đáng kèm ví dụ thực tế minh họa.
- Ngữ pháp: Sử dụng từ nối lập luận và chuyển tiếp (Firstly, Furthermore, In addition, For instance, Therefore...), cấu trúc câu phức logic.`;
    case 'problem_solution':
      return `- Dạng Tình huống & Giải pháp (Problem / Solution):
- Ngữ cảnh: Xác định rõ bản chất vấn đề, đề xuất ít nhất 2 giải pháp khả thi, so sánh ưu/nhược điểm và chọn ra giải pháp tối ưu nhất.
- Ngữ pháp: Sử dụng cấu trúc câu điều kiện (If... then...), động từ khuyết thiếu (should, ought to, must, could), cấu trúc đề xuất giải pháp (I propose, A viable solution would be...).`;
    case 'long_turn':
      return `- Dạng Nói dài / Cue Card (Long Turn):
- Ngữ cảnh: BẮT BUỘC bao quát đầy đủ các gợi ý trong Cue Card (You should say...). Bài nói có cấu trúc 3 phần rõ ràng: Mở bài dẫn dắt - Thân bài phát triển các gợi ý - Kết bài tóm lược. Dung lượng nói đầy đặn, không ngắt quãng quá sớm.
- Ngữ pháp & Từ vựng: Đa dạng cấu trúc câu (phức, ghép, bị động), sử dụng linh hoạt discourse markers (To begin with, Moving on to, Speaking of which, All in all...).`;
    case 'discussion':
      return `- Dạng Thảo luận chuyên sâu (Discussion):
- Ngữ cảnh: Thảo luận vấn đề ở góc nhìn vĩ mô (xã hội, văn hóa, công nghệ, tương lai). Tư duy phản biện đa chiều (nêu cả mặt tích cực và tiêu cực), tránh chỉ nói về bản thân một cách hạn hẹp.
- Ngữ pháp & Từ vựng: Dùng từ vựng học thuật cao cấp (B2/C1), cấu trúc bị động khách quan (It is believed that...), cấu trúc giả định hoặc suy đoán.`;
    default:
      return '';
  }
}

function clampScore(val: unknown, min = 0, max = 10): number {
  const num = Number(val);
  if (Number.isNaN(num)) return 5.0;
  return Math.round(Math.max(min, Math.min(max, num)) * 10) / 10;
}

function roundToHalf(val: unknown, min = 1.0, max = 9.0): number {
  const num = Number(val);
  if (Number.isNaN(num)) return 7.0;
  const clamped = Math.max(min, Math.min(max, num));
  return Math.round(clamped * 2) / 2;
}

export function calibrateTotalScoreWithContext(
  rawTotal: number,
  contextScore: number | null,
  grammarScore: number | null,
  lexicalScore: number | null = null,
  relevanceLevel = '',
  taskType = '',
): number {
  let total = Number(rawTotal);
  if (Number.isNaN(total)) total = 5.0;
  const ctx = Number(contextScore) || 0;
  void grammarScore;
  void lexicalScore;

  if (taskType === 'read_aloud') {
    return clampScore(total, 1.0, 9.0);
  }

  // Only cap overall score when the answer is genuinely off-topic / irrelevant (< 3.0)
  if (relevanceLevel === 'irrelevant' || (contextScore != null && ctx < 3.0)) {
    const ceiling = Math.min(3.5, Math.max(1.0, ctx + 0.8));
    if (total > ceiling) total = ceiling;
  }

  return clampScore(total, 1.0, 9.0);
}

function fallbackHeuristicEval({
  transcript,
  pronunciationScores,
  taskType = '',
}: {
  transcript: string;
  pronunciationScores: Partial<PronunciationScores>;
  taskType?: string;
}): AiEvalResult {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const rawPron = roundToHalf(
    pronunciationScores.p ??
    pronunciationScores.score_pronunciation ??
    pronunciationScores.accuracy ??
    pronunciationScores.total ??
    6.5,
  );

  if (taskType === 'read_aloud') {
    return {
      score_total: rawPron,
      score_pronunciation: rawPron,
      score_fluency_coherence: null,
      score_lexical: null,
      score_grammar: null,
      score_context: null,
      relevance_level: 'relevant',
      grammar_errors: [],
      feedback_summary: 'Đã hoàn thành đánh giá phát âm đọc to.',
      better_expression: '',
      is_fallback: true,
    };
  }

  // Prefer calibrated 4-pillar scores already computed by the Python backend (WavLM + Local NLP + DeepSeek)
  const hasBackend4Pillars =
    pronunciationScores.fc != null &&
    pronunciationScores.lr != null &&
    pronunciationScores.gra != null;

  const scoreContext = hasBackend4Pillars
    ? roundToHalf(pronunciationScores.fc)
    : roundToHalf(pronunciationScores.fluency ?? (wordCount <= 2 ? 6.0 : 7.0));
  const scoreLexical = hasBackend4Pillars
    ? roundToHalf(pronunciationScores.lr)
    : roundToHalf(wordCount <= 2 ? 6.5 : 7.0);
  const scoreGrammar = hasBackend4Pillars
    ? roundToHalf(pronunciationScores.gra)
    : roundToHalf(wordCount <= 2 ? 6.5 : 7.0);

  const scoreTotal = clampScore((rawPron + scoreContext + scoreLexical + scoreGrammar) / 4, 1.0, 9.0);
  const relevance = wordCount <= 2 ? 'partially_relevant' : 'relevant';
  const summary =
    wordCount <= 2
      ? 'Câu trả lời còn ngắn, bạn nên mở rộng thành câu hoàn chỉnh.'
      : 'Đã đánh giá theo 4 tiêu chuẩn khảo thí IELTS (Phát âm, Mạch lạc, Từ vựng, Ngữ pháp).';

  return {
    score_total: scoreTotal,
    score_pronunciation: rawPron,
    score_fluency_coherence: scoreContext,
    score_lexical: scoreLexical,
    score_grammar: scoreGrammar,
    score_context: scoreContext,
    relevance_level: relevance,
    grammar_errors: [],
    feedback_summary: summary,
    better_expression: '',
    is_fallback: true,
  };
}

export async function evaluateAnswerWithGemini({
  questionText,
  partTitle = '',
  examType = 'general',
  taskType = '',
  referenceText = '',
  imageUrl = null,
  transcript = '',
  pronunciationScores = {},
  gpuUrlFallback = '',
}: {
  questionText: string;
  partTitle?: string;
  examType?: string;
  taskType?: string;
  referenceText?: string;
  imageUrl?: string | null;
  transcript?: string;
  pronunciationScores?: Partial<PronunciationScores>;
  gpuUrlFallback?: string;
}): Promise<AiEvalResult> {
  const runtime = await syncGeminiConfigFromSupabase();
  const cleanTranscript = (transcript || '').trim();
  const acc = Number(pronunciationScores.p ?? pronunciationScores.score_pronunciation ?? pronunciationScores.accuracy) || 0;
  const flu = Number(pronunciationScores.fc ?? pronunciationScores.fluency) || 0;
  const pro = Number(pronunciationScores.prosodic) || acc;
  const rawPronTotal = roundToHalf(
    pronunciationScores.p ??
    pronunciationScores.score_pronunciation ??
    pronunciationScores.accuracy ??
    pronunciationScores.total ??
    0,
  );

  if (!cleanTranscript) {
    return {
      score_total: 1.0,
      score_grammar: 1.0,
      score_context: 1.0,
      relevance_level: 'too_short',
      grammar_errors: [],
      feedback_summary: 'Không phát hiện thấy âm thanh câu trả lời hoặc giọng nói quá nhỏ.',
      better_expression: '',
      is_fallback: false,
    };
  }

  const isPictureTask = taskType === 'picture_description' && Boolean(imageUrl);
  const taskTag = taskType ? ` [Dạng bài: ${taskType}]` : '';
  const refTag = referenceText ? `\nDữ liệu tham khảo / Văn bản gốc / Cue Card gợi ý:\n"""\n${referenceText}\n"""` : '';
  const taskRubric = getTaskSpecificRubric(taskType);
  const rubricTag = taskRubric ? `\nTIÊU CHÍ KHẢO THÍ DÀNH RIÊNG CHO DẠNG BÀI NÀY:\n${taskRubric}\n` : '';

  const imagePromptNotice = isPictureTask
    ? `\nLƯU Ý THỊ GIÁC: Bức ảnh thật của đề thi được đính kèm ở trên. AI hãy trực tiếp quan sát bức ảnh thật này để đối chiếu chi tiết bài nói của học viên ("${cleanTranscript}") xem có đúng với các đối tượng, hành động, sự vật, bối cảnh thực tế trong tranh hay không.`
    : '';

  const userContentText = `Đề: "${questionText || 'N/A'}"${partTitle ? ` [${partTitle}]` : ''}${taskTag} [${examType.toUpperCase()}]${refTag}${rubricTag}${imagePromptNotice}
Bài nói học viên: "${cleanTranscript}"
Phát âm âm học (SpeechOcean - PR): ${rawPronTotal.toFixed(1)}/9.0 [Chi tiết: PR=${acc.toFixed(1)}, FC=${flu.toFixed(1)}, Prosody=${pro.toFixed(1)}]
Đánh giá ngữ pháp, ngữ cảnh theo đúng yêu cầu dạng bài; kết hợp Điểm tổng phát âm với Ngữ pháp & Ngữ cảnh để chốt score_total (KHÔNG tự tính lại điểm âm học); tận dụng các chỉ số Acc, Flu, Pro để nhận xét sư phạm sắc bén trong feedback_summary. Trả về đúng JSON.`;

  const userMessageContent = isPictureTask
    ? [
      { type: 'text', text: userContentText },
      { type: 'image_url', image_url: { url: imageUrl } },
    ]
    : userContentText;

  try {
    const data = await callAiProxy({
      action: 'eval_answer',
      messages: [
        { role: 'system', content: buildExaminerSystemPrompt() },
        { role: 'user', content: userMessageContent },
      ],
      temperature: 0.2,
      gpuUrlFallback,
    });

    const rawContent = data.content || '';
    const usedModel = data.model || runtime.geminiModel;

    let parsed: Record<string, unknown> | null = null;
    try {
      const cleanJson = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleanJson) as Record<string, unknown>;
    } catch {
      const match = rawContent.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]) as Record<string, unknown>;
      } else {
        throw new Error('Phản hồi từ AI không có cấu trúc JSON hợp lệ.');
      }
    }

    const llmGrammar = taskType === 'read_aloud' ? null : roundToHalf(parsed.score_grammar, 1.0, 9.0);
    const llmContext =
      taskType === 'read_aloud'
        ? null
        : roundToHalf(parsed.score_context ?? parsed.score_fluency_coherence, 1.0, 9.0);
    const llmLexical =
      taskType === 'read_aloud' ? null : roundToHalf(parsed.score_lexical ?? parsed.score_grammar, 1.0, 9.0);

    // Unify with Python backend's calibrated 4-pillar pipeline (WavLM + SpeechOcean762 + Local NLP + DeepSeek):
    // - Preserve acoustic fluency contribution on FC (65% LLM coherence + 35% backend acoustic fluency)
    // - Keep 0.5 band steps on all 4 criteria, pure arithmetic mean rounded to 1 decimal for Overall
    const backendFc =
      pronunciationScores.fc != null && !Number.isNaN(Number(pronunciationScores.fc))
        ? Number(pronunciationScores.fc)
        : flu > 0
          ? flu
          : null;

    const scoreGrammar = llmGrammar;
    const scoreContext =
      taskType === 'read_aloud' || llmContext == null
        ? null
        : !isPictureTask && backendFc != null && backendFc >= 1.0
          ? roundToHalf(0.65 * llmContext + 0.35 * backendFc, 1.0, 9.0)
          : llmContext;
    const scoreLexical = llmLexical;
    const relevanceLevel =
      taskType === 'read_aloud'
        ? 'relevant'
        : String(parsed.relevance_level || ((scoreContext ?? 0) < 3.0 ? 'irrelevant' : 'relevant'));

    let scoreTotal: number;
    if (taskType === 'read_aloud') {
      scoreTotal = rawPronTotal;
    } else {
      const rawWeightedTotal =
        rawPronTotal * 0.25 +
        (scoreContext ?? 0) * 0.25 +
        (scoreLexical ?? 0) * 0.25 +
        (scoreGrammar ?? 0) * 0.25;
      scoreTotal = calibrateTotalScoreWithContext(
        rawWeightedTotal,
        scoreContext,
        scoreGrammar,
        scoreLexical,
        relevanceLevel,
        taskType,
      );
    }

    return {
      score_total: scoreTotal,
      score_pronunciation: rawPronTotal,
      score_fluency_coherence: scoreContext,
      score_lexical: scoreLexical,
      score_grammar: scoreGrammar,
      score_context: scoreContext,
      relevance_level: relevanceLevel,
      grammar_errors:
        taskType === 'read_aloud' || !Array.isArray(parsed.grammar_errors)
          ? []
          : (parsed.grammar_errors as AiEvalResult['grammar_errors']),
      feedback_summary: String(parsed.feedback_summary || 'Đã hoàn thành phân tích câu trả lời.'),
      better_expression: String(parsed.better_expression || ''),
      is_fallback: false,
      model_used: usedModel,
    };
  } catch (err) {
    const fb = fallbackHeuristicEval({
      transcript: cleanTranscript,
      pronunciationScores: { ...pronunciationScores, accuracy: acc, fluency: flu, prosodic: pro, total: rawPronTotal },
      taskType,
    });
    fb.is_fallback = true;
    fb.fallback_reason = err instanceof Error ? err.message : String(err);
    return fb;
  }
}

function buildDialogueExaminerSystemPrompt(): string {
  return `Bạn là Giám khảo Khảo thí Speaking Quốc tế (Chuẩn IELTS Speaking Band 1.0 - 9.0). Phân tích đoạn hội thoại giữa Giáo viên và Học viên theo đúng 4 TRỤ CỘT IELTS (PR: 25%, FC: 25%, LR: 25%, GRA: 25%) trên thang Band 1.0 - 9.0 (bước nhảy 0.5) và trả về DUY NHẤT 1 JSON.

QUY TẮC ĐÁNH GIÁ THEO 4 TIÊU CHÍ IELTS SPEAKING (BAND 1.0 - 9.0):
1. PR - Pronunciation / Phát âm (score_pronunciation 1.0-9.0): Đã được đo lường bằng mô hình âm học WavLM-Large + SpeechOcean762. BẮT BUỘC giữ nguyên điểm PR hệ thống cung cấp.
2. FC - Fluency & Coherence / Độ trôi chảy & Mạch lạc (score_fluency_coherence 1.0-9.0): Đánh giá khả năng phản xạ tự nhiên, độ trôi chảy, liên kết ý và mức độ mở rộng câu trả lời đúng trọng tâm câu hỏi.
3. LR - Lexical Resource / Từ vựng (score_lexical 1.0-9.0): Đánh giá độ chính xác, tự nhiên và đa dạng của vốn từ theo ngữ cảnh giao tiếp.
4. GRA - Grammatical Range & Accuracy / Ngữ pháp (score_grammar 1.0-9.0): Đánh giá độ chính xác và đa dạng cấu trúc câu; liệt kê các lỗi ngữ pháp cụ thể của Học viên vào "grammar_errors".
5. Overall Band (score_total 1.0-9.0): Trung bình cộng tự nhiên 4 tiêu chí làm tròn 1 chữ số thập phân: Overall = (PR + FC + LR + GRA) / 4.
6. Phạm vi đánh giá: Toàn bộ điểm số, nhận xét và lỗi CHỈ dành riêng cho Học viên (Student). TUYỆT ĐỐI KHÔNG bắt lỗi Giáo viên.

OUTPUT JSON FORMAT:
{
  "score_total": <float 1.0-9.0>,
  "score_pronunciation": <float 1.0-9.0>,
  "score_fluency_coherence": <float 1.0-9.0>,
  "score_lexical": <float 1.0-9.0>,
  "score_grammar": <float 1.0-9.0>,
  "score_context": <float 1.0-9.0>,
  "conversation_summary": "<Nhận xét sư phạm chi tiết 2-3 câu tiếng Việt dành riêng cho Học viên theo 4 tiêu chí IELTS>",
  "grammar_errors": [{"turn_index": <int>, "error_text": "...", "fix": "...", "explanation": "..."}],
  "communication_tips": ["<lời khuyên 1>", "<lời khuyên 2>"],
  "better_dialogue_expressions": ["<1 câu mẫu nâng cao>"]
}`;
}

function fallbackConversationHeuristic({
  studentTurns,
  studentFullText,
  pronunciationScores,
}: {
  studentTurns: DialogueTurn[];
  studentFullText: string;
  pronunciationScores: Partial<PronunciationScores>;
}): AiEvalResult {
  void studentTurns;
  const rawPron = clampScore(
    pronunciationScores.p ?? pronunciationScores.accuracy ?? pronunciationScores.total ?? 7.0,
    1.0,
    9.0,
  );
  const fc = clampScore(pronunciationScores.fc ?? pronunciationScores.fluency ?? rawPron, 1.0, 9.0);
  const lr = clampScore(pronunciationScores.lr ?? pronunciationScores.lexical ?? rawPron, 1.0, 9.0);
  const gra = clampScore(pronunciationScores.gra ?? pronunciationScores.grammar ?? rawPron, 1.0, 9.0);

  const total =
    pronunciationScores.total != null &&
    pronunciationScores.fc != null &&
    pronunciationScores.lr != null &&
    pronunciationScores.gra != null
      ? clampScore(pronunciationScores.total, 1.0, 9.0)
      : clampScore((rawPron + fc + lr + gra) / 4.0, 1.0, 9.0);
  const summary = 'Học viên tương tác tự nhiên, phát âm rõ ràng và phản xạ tích cực với giáo viên trong toàn bộ buổi học.';

  const fallbackGrammarErrors: AiEvalResult['grammar_errors'] = [];
  const lowerText = studentFullText.toLowerCase();
  if (/\bi is\b/.test(lowerText)) {
    fallbackGrammarErrors.push({
      error_text: 'I is',
      fix: 'I am',
      explanation: "Đại từ 'I' đi với động từ to be ở hiện tại là 'am', không dùng 'is'.",
    });
  }
  if (/\bi are\b/.test(lowerText)) {
    fallbackGrammarErrors.push({
      error_text: 'I are',
      fix: 'I am',
      explanation: "Đại từ 'I' đi với động từ to be ở hiện tại là 'am', không dùng 'are'.",
    });
  }
  if (/\b(he|she|it) don't\b/.test(lowerText)) {
    fallbackGrammarErrors.push({
      error_text: "don't (với He/She/It)",
      fix: "doesn't",
      explanation: "Chủ ngữ ngôi thứ 3 số ít đi với trợ động từ phủ định 'doesn't'.",
    });
  }
  if (/\bmany people is\b/.test(lowerText)) {
    fallbackGrammarErrors.push({
      error_text: 'many people is',
      fix: 'many people are',
      explanation: "'People' là danh từ số nhiều, đi với động từ to be 'are'.",
    });
  }

  return {
    score_total: total,
    score_pronunciation: rawPron,
    score_fluency_coherence: fc,
    score_lexical: lr,
    score_grammar: gra,
    score_context: fc,
    conversation_summary: summary,
    grammar_errors: fallbackGrammarErrors,
    communication_tips: [
      'Nên mở rộng câu trả lời bằng cách thêm lý do (Because...) hoặc nêu thêm ví dụ cụ thể.',
      'Tiếp tục duy trì phản xạ giao tiếp tự tin và phát huy ngữ điệu tự nhiên.',
    ],
    better_dialogue_expressions: [],
    is_fallback: true,
  };
}

export async function evaluateConversationWithAi({
  dialogueTurns = [],
  pronunciationScores = {},
  gpuUrlFallback = '',
}: {
  dialogueTurns?: DialogueTurn[];
  pronunciationScores?: Partial<PronunciationScores>;
  gpuUrlFallback?: string;
}): Promise<AiEvalResult> {
  const runtime = await syncGeminiConfigFromSupabase();
  const hasBeIelts4 =
    pronunciationScores.p != null &&
    pronunciationScores.fc != null &&
    pronunciationScores.lr != null &&
    pronunciationScores.gra != null;
  const rawPronTotal = clampScore(
    pronunciationScores.p ?? pronunciationScores.accuracy ?? pronunciationScores.total ?? 0,
    1.0,
    9.0,
  );
  const beFc = pronunciationScores.fc != null ? clampScore(pronunciationScores.fc, 1.0, 9.0) : null;
  const beLr = pronunciationScores.lr != null ? clampScore(pronunciationScores.lr, 1.0, 9.0) : null;
  const beGra = pronunciationScores.gra != null ? clampScore(pronunciationScores.gra, 1.0, 9.0) : null;
  const beTotal = pronunciationScores.total != null ? clampScore(pronunciationScores.total, 1.0, 9.0) : null;

  const studentTurns = dialogueTurns.filter((t) => t.role === 'student' || t.speaker === 'Student');
  const studentFullText = studentTurns.map((t) => t.transcript || '').join(' ').trim();

  if (!studentFullText) {
    return {
      score_total: 1.0,
      score_pronunciation: 1.0,
      score_fluency_coherence: 1.0,
      score_lexical: 1.0,
      score_grammar: 1.0,
      score_context: 1.0,
      conversation_summary: 'Không phát hiện thấy lượt nói nào của học viên trong đoạn hội thoại.',
      grammar_errors: [],
      communication_tips: ['Cần tích cực tương tác và phản hồi giáo viên trong suốt cuộc hội thoại.'],
      better_dialogue_expressions: [],
      is_fallback: false,
    };
  }

  const conversationTranscript = dialogueTurns
    .map((t, idx) => {
      const roleName = t.role === 'teacher' || t.speaker === 'Teacher' ? 'Teacher' : 'Student';
      return `[Lượt ${idx + 1}] ${roleName}: "${(t.transcript || '').trim()}"`;
    })
    .join('\n');

  const scoreContextLine = hasBeIelts4
    ? `ĐIỂM 4 TIÊU CHÍ IELTS TỪ HỆ THỐNG (trung bình các lượt nói học viên, thang 1.0-9.0): PR=${rawPronTotal.toFixed(1)}, FC=${beFc!.toFixed(1)}, LR=${beLr!.toFixed(1)}, GRA=${beGra!.toFixed(1)}, Overall=${(beTotal ?? (rawPronTotal + beFc! + beLr! + beGra!) / 4).toFixed(1)}`
    : `ĐIỂM PHÁT ÂM HỌC VIÊN (SpeechOcean - PR): ${rawPronTotal.toFixed(1)}/9.0`;

  const userPrompt = `HỘI THOẠI:
${conversationTranscript}

${scoreContextLine}
Hãy đánh giá toàn diện hội thoại của Học viên (Student) theo 4 tiêu chí IELTS (PR, FC, LR, GRA trên thang Band 1.0-9.0), chỉ rõ lỗi ngữ pháp vào grammar_errors, viết nhận xét sư phạm (conversation_summary) và gợi ý cải thiện (communication_tips, better_dialogue_expressions). Trả về đúng JSON.`;

  try {
    const data = await callAiProxy({
      action: 'eval_conversation',
      messages: [
        { role: 'system', content: buildDialogueExaminerSystemPrompt() },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      gpuUrlFallback,
    });

    const rawContent = data.content || '';
    const usedModel = data.model || runtime.geminiModel;

    let parsed: Record<string, unknown> | null = null;
    try {
      const cleanJson = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleanJson) as Record<string, unknown>;
    } catch {
      const match = rawContent.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]) as Record<string, unknown>;
      } else {
        throw new Error('Phản hồi từ AI không có cấu trúc JSON hợp lệ.');
      }
    }

    const studentGrammarErrors = Array.isArray(parsed.grammar_errors)
      ? (parsed.grammar_errors as AiEvalResult['grammar_errors'])
      : [];

    // Preserve calibrated per-turn IELTS 4-pillar averages from Backend when available
    const finalPr = rawPronTotal;
    const finalFc = hasBeIelts4
      ? beFc!
      : roundToHalf(parsed.score_fluency_coherence ?? parsed.score_context, 1.0, 9.0);
    const finalLr = hasBeIelts4
      ? beLr!
      : roundToHalf(parsed.score_lexical ?? parsed.score_grammar, 1.0, 9.0);
    const finalGra = hasBeIelts4
      ? beGra!
      : roundToHalf(parsed.score_grammar, 1.0, 9.0);
    const finalTotal = hasBeIelts4
      ? (beTotal ?? clampScore((finalPr + finalFc + finalLr + finalGra) / 4.0, 1.0, 9.0))
      : clampScore((finalPr + finalFc + finalLr + finalGra) / 4.0, 1.0, 9.0);

    return {
      score_total: finalTotal,
      score_pronunciation: finalPr,
      score_fluency_coherence: finalFc,
      score_lexical: finalLr,
      score_grammar: finalGra,
      score_context: finalFc,
      conversation_summary: String(parsed.conversation_summary || 'Đã hoàn thành đánh giá hội thoại.'),
      grammar_errors: studentGrammarErrors,
      communication_tips: Array.isArray(parsed.communication_tips)
        ? (parsed.communication_tips as string[])
        : [],
      better_dialogue_expressions: Array.isArray(parsed.better_dialogue_expressions)
        ? (parsed.better_dialogue_expressions as string[])
        : [],
      is_fallback: false,
      model_used: usedModel,
    };
  } catch (err) {
    const fb = fallbackConversationHeuristic({
      studentTurns,
      studentFullText,
      pronunciationScores,
    });
    fb.is_fallback = true;
    fb.fallback_reason = err instanceof Error ? err.message : String(err);
    return fb;
  }
}

