import { leaderboard } from "@/lib/quality";

export async function GET(): Promise<Response> {
  return Response.json(leaderboard());
}
