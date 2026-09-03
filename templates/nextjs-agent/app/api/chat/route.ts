import { handleNewOperation } from '../../../lib/operation-handler';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return handleNewOperation(request);
}
