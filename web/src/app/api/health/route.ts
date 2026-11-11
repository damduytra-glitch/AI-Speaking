export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return Response.json(
    {
      status: 'ok',
      service: 'speakai-web',
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  );
}

