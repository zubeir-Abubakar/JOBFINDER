import { all } from "./db";

export function chatHistory(userId: string, limit = 60) {
  const rows = all<{ id: number; role: string; content: string; created_at: string; meta: string | null }>(
    "SELECT id, role, content, created_at, meta FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    [userId, limit],
  );
  return rows.reverse();
}

export function assistantSuggestions(): string[] {
  return [
    "Hello",
    "Which agents are currently working?",
    "Explain the latest workflow",
    "Summarise today's recruitment activity",
    "What should I do next?",
    "Find 20 Senior QA Engineer vacancies in Switzerland",
    "Show me all jobs with a match score above 80%",
    "Review application packages",
    "Show recruiter messages",
  ];
}
