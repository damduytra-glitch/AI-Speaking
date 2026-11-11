import { getAuthHeaders } from './auth';
import { getSupabaseClient } from './supabase';

export const ENROLLMENT_SENTENCES = [
  'Hello, how are you today?',
  'I am learning English right now.',
  'Good morning to everyone.',
  'Thank you very much.',
  'Goodbye and see you later.',
];

export async function uploadVoiceSample(
  userId: string,
  audioBlob: Blob,
  filename = 'voice_sample.webm',
): Promise<string> {
  const client = getSupabaseClient();
  const path = `voice_samples/${userId}/${filename}`;
  const { error: uploadError } = await client.storage
    .from('speakai-audio')
    .upload(path, audioBlob, { upsert: true, contentType: audioBlob.type || 'audio/webm' });
  if (uploadError) throw uploadError;

  const { data: urlData } = client.storage.from('speakai-audio').getPublicUrl(path);
  return urlData.publicUrl;
}

export async function saveVoiceEmbeddings(
  userId: string,
  voiceEmbeddings: number[],
  voiceUrl: string | null = null,
): Promise<void> {
  const client = getSupabaseClient();
  const payload: Record<string, unknown> = {
    voice_embeddings: voiceEmbeddings,
    voice_enrolled: true,
  };
  if (voiceUrl) {
    payload.voice_sample_url = voiceUrl;
  }
  const { error } = await client.from('profiles').update(payload).eq('id', userId);
  if (error) throw error;
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function computeMeanNormalizedEmbedding(vectors: number[][]): number[] {
  if (!vectors.length) return [];
  const dim = vectors[0].length;
  const meanEmb = new Array<number>(dim).fill(0);
  for (const vec of vectors) {
    for (let d = 0; d < dim; d++) {
      meanEmb[d] += vec[d] || 0;
    }
  }
  let norm = 0;
  for (let d = 0; d < dim; d++) {
    meanEmb[d] /= vectors.length;
    norm += meanEmb[d] * meanEmb[d];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < dim; d++) {
      meanEmb[d] /= norm;
    }
  }
  return meanEmb;
}

export async function fetchEmbeddingFromBackend(audioBlob: Blob, gpuUrl: string): Promise<number[]> {
  const backendUrl = gpuUrl.trim().replace(/\/+$/, '');
  if (!backendUrl) {
    throw new Error(
      'Chưa cấu hình API Backend! Vui lòng khởi chạy server Kaggle / Cloudflare Tunnel và cập nhật GPU URL.',
    );
  }

  const formData = new FormData();
  formData.append('audio', audioBlob, 'voice_sample.wav');
  const authHeaders = await getAuthHeaders();

  const response = await fetch(`${backendUrl}/extract_embedding`, {
    method: 'POST',
    headers: authHeaders,
    body: formData,
  });

  if (!response.ok) {
    const errData = (await response.json().catch(() => ({}))) as { detail?: string; error?: string };
    throw new Error(
      errData.detail || errData.error || `Lỗi API Backend (${response.status}): Không thể trích xuất embedding`,
    );
  }

  const data = (await response.json()) as { success?: boolean; embedding?: number[]; error?: string };
  if (!data.success || !Array.isArray(data.embedding)) {
    throw new Error(data.error || 'Lỗi trích xuất embedding từ mô hình');
  }

  return data.embedding;
}

