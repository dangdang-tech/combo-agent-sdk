import { AgentSdkConfigError } from 'combo-agent-sdk';
import { getComboRuntime } from '../../../lib/combo-runtime';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  try {
    getComboRuntime();
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof AgentSdkConfigError) {
      return Response.json({ ok: false, error: 'configuration_invalid' }, { status: 503 });
    }
    throw error;
  }
}
