import { handleResumeOperation } from '../../../../../lib/operation-handler';

export const runtime = 'nodejs';

/** Host 到账后使用当前用户的新断言调用；不保存或复用第一次请求的短期断言。 */
export async function POST(
  request: Request,
  context: { params: Promise<{ operationId: string }> },
): Promise<Response> {
  const { operationId } = await context.params;
  return handleResumeOperation(request, operationId);
}
