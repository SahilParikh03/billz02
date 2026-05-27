/**
 * GET /api/models
 *
 * Returns all models available from active providers, tagged with their provider id.
 */

import { getConfig } from "@/lib/config";
import { listModels } from "@/providers/index";

export async function GET(): Promise<Response> {
  return Response.json(listModels(getConfig()));
}
