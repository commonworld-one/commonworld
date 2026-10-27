import { handoffTemplate } from '../handoff';
import { json } from '../http';

export async function getHandoffTemplate(): Promise<Response> {
  return json(200, handoffTemplate());
}
