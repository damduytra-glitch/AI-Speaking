import { createAiEvalOptionsResponse, handleAiEvalRequest } from '@/lib/server/aiEvalHandler';

export const runtime = 'nodejs';

export async function OPTIONS(): Promise<Response> {
  return createAiEvalOptionsResponse();
}

export async function POST(req: Request): Promise<Response> {
  return handleAiEvalRequest(req);
}

