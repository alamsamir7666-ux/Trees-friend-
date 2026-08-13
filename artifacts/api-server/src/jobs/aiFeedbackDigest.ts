/**
 * Weekly TreeBot feedback digest email (v2.5).
 *
 * Runs via cron (Mondays 9 AM — see routes/cron.ts). Queries all 👎
 * feedback from the past 7 days, formats a summary email, and sends it
 * to ADMIN_EMAIL via Resend.
 *
 * The email includes:
 *   - Headline stats (total 👎, total 👍, refusal rate for the week)
 *   - Top 5 👎-rated AI responses with the user's question that
 *     triggered them + a link to view the full conversation in the
 *     admin panel
 *
 * Purpose: gives the admin a weekly pulse-check on TreeBot quality
 * without having to actively monitor the admin dashboard.
 *
 * If RESEND_API_KEY is not configured, the job is a no-op (logs a warning).
 * If ADMIN_EMAIL is not set, logs a warning and exits.
 */
import { pool } from "@workspace/db";
import { Resend } from "resend";
import { logger } from "../lib/logger";

const APP_URL = process.env.APP_URL ?? "https://treefriend.com";
const FROM = process.env.EMAIL_FROM ?? "Tree Friend <onboarding@resend.dev>";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? process.env.ADMIN_EMAILS?.split(",")[0]?.trim() ?? "";

let _resend: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

interface FeedbackRow {
  feedback_id: number;
  rating: string;
  feedback_at: Date;
  message_id: number;
  assistant_content: string;
  message_at: Date;
  session_id: number;
  user_id: string | null;
  user_question: string | null;
}

export async function runAiFeedbackDigest(): Promise<{ sent: boolean; count: number }> {
  const resend = getResend();
  if (!resend) {
    logger.warn("AI feedback digest: RESEND_API_KEY not set — skipping email");
    return { sent: false, count: 0 };
  }
  if (!ADMIN_EMAIL) {
    logger.warn("AI feedback digest: ADMIN_EMAIL not set — skipping email");
    return { sent: false, count: 0 };
  }

  try {
    // Query 👎 feedback from the past 7 days
    const feedbackResult = await pool.query<FeedbackRow>(
      `SELECT
         f.id AS feedback_id,
         f.rating,
         f.created_at AS feedback_at,
         m.id AS message_id,
         m.content AS assistant_content,
         m.created_at AS message_at,
         m.session_id,
         s.user_id,
         (
           SELECT content FROM ai_chat_messages prev
           WHERE prev.session_id = m.session_id
             AND prev.created_at < m.created_at
             AND prev.role = 'user'
           ORDER BY prev.created_at DESC
           LIMIT 1
         ) AS user_question
       FROM ai_chat_feedback f
       JOIN ai_chat_messages m ON m.id = f.message_id
       JOIN ai_chat_sessions s ON s.id = f.session_id
       WHERE f.rating = 'down'
         AND f.created_at >= NOW() - INTERVAL '7 days'
       ORDER BY f.created_at DESC
       LIMIT 20`,
    );

    // Also get weekly stats
    const statsResult = await pool.query<{
      total_feedback: number;
      positive: number;
      negative: number;
      total_messages: number;
      refusals: number;
    }>(
      `SELECT
         COUNT(*)::int AS total_feedback,
         COUNT(*) FILTER (WHERE rating = 'up')::int AS positive,
         COUNT(*) FILTER (WHERE rating = 'down')::int AS negative,
         (SELECT COUNT(*) FROM ai_chat_messages WHERE created_at >= NOW() - INTERVAL '7 days')::int AS total_messages,
         (SELECT COUNT(*) FROM ai_chat_messages WHERE role = 'user' AND off_topic = TRUE AND created_at >= NOW() - INTERVAL '7 days')::int AS refusals
       FROM ai_chat_feedback
       WHERE created_at >= NOW() - INTERVAL '7 days'`,
    );

    const stats = statsResult.rows[0];
    const negativeCount = feedbackResult.rows.length;

    // Format the email
    const feedbackHtml = feedbackResult.rows
      .slice(0, 5)
      .map((f, i) => {
        const date = f.feedback_at instanceof Date
          ? f.feedback_at.toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : String(f.feedback_at).slice(0, 10);
        const question = f.user_question
          ? f.user_question.slice(0, 100) + (f.user_question.length > 100 ? "…" : "")
          : "(no question recorded)";
        const response = f.assistant_content
          ? f.assistant_content.slice(0, 200) + (f.assistant_content.length > 200 ? "…" : "")
          : "(empty response)";
        return `
        <div style="padding:14px 0;border-bottom:1px solid #f3f4f6;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="font-size:11px;color:#ef4444;font-weight:600;">👎 #${i + 1}</span>
            <span style="font-size:11px;color:#9ca3af;">${date}</span>
          </div>
          <p style="font-size:12px;color:#6b7280;margin:0 0 6px;font-family:sans-serif;">
            <strong>User asked:</strong> "${escapeHtml(question)}"
          </p>
          <p style="font-size:12px;color:#374151;margin:0;font-family:sans-serif;line-height:1.5;">
            <strong>AI said:</strong> ${escapeHtml(response)}
          </p>
        </div>`;
      })
      .join("");

    const positiveRate = stats.total_feedback > 0
      ? Math.round((stats.positive / stats.total_feedback) * 100)
      : 0;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="font-family:Georgia,serif;background:#f9fafb;margin:0;padding:40px 20px;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 20px rgba(0,0,0,0.06);">
    <div style="background:linear-gradient(135deg,#10b981,#059669);padding:32px 40px;text-align:center;">
      <h1 style="color:#fff;font-size:22px;margin:0;letter-spacing:0.04em;">🌱 TreeBot Weekly Digest</h1>
      <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:13px;font-family:sans-serif;">
        ${negativeCount} negative feedback ${negativeCount === 1 ? "item" : "items"} this week
      </p>
    </div>
    <div style="padding:32px 40px;">
      <h2 style="font-size:16px;color:#111827;margin:0 0 16px;font-family:Georgia,serif;">📊 This Week's Stats</h2>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:28px;font-family:sans-serif;">
        <div style="background:#f0fdf4;border-radius:10px;padding:14px;">
          <div style="font-size:11px;color:#16a34a;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">👍 Positive</div>
          <div style="font-size:24px;font-weight:bold;color:#15803d;">${stats.positive}</div>
        </div>
        <div style="background:#fef2f2;border-radius:10px;padding:14px;">
          <div style="font-size:11px;color:#dc2626;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">👎 Negative</div>
          <div style="font-size:24px;font-weight:bold;color:#b91c1c;">${stats.negative}</div>
        </div>
        <div style="background:#eff6ff;border-radius:10px;padding:14px;">
          <div style="font-size:11px;color:#2563eb;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Total Messages</div>
          <div style="font-size:24px;font-weight:bold;color:#1d4ed8;">${stats.total_messages}</div>
        </div>
        <div style="background:#fffbeb;border-radius:10px;padding:14px;">
          <div style="font-size:11px;color:#d97706;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Off-topic Refusals</div>
          <div style="font-size:24px;font-weight:bold;color:#b45309;">${stats.refusals}</div>
        </div>
      </div>

      ${negativeCount > 0 ? `
      <h2 style="font-size:16px;color:#111827;margin:0 0 12px;font-family:Georgia,serif;">👎 Top Negative Feedback</h2>
      ${feedbackHtml}
      ` : `
      <div style="background:#f0fdf4;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px;">
        <p style="font-size:14px;color:#15803d;margin:0;font-family:sans-serif;">
          🎉 No negative feedback this week! TreeBot is doing great.
        </p>
      </div>
      `}

      <div style="text-align:center;margin-top:28px;">
        <a href="${APP_URL}/admin" style="display:inline-block;background:#10b981;color:#fff;padding:12px 32px;border-radius:50px;font-size:14px;font-weight:600;text-decoration:none;font-family:sans-serif;">
          View Full Insights →
        </a>
      </div>
    </div>
    <div style="background:#f0fdf4;padding:16px 40px;text-align:center;">
      <p style="font-size:11px;color:#9ca3af;margin:0;font-family:sans-serif;">
        © 2026 Tree Friend · Weekly automated digest · Sent every Monday at 9 AM
      </p>
    </div>
  </div>
</body></html>`;

    const subject =
      negativeCount > 0
        ? `🌱 TreeBot Weekly Digest — ${negativeCount} negative feedback ${negativeCount === 1 ? "item" : "items"}`
        : "🌱 TreeBot Weekly Digest — all good this week!";

    await resend.emails.send({
      from: FROM,
      to: [ADMIN_EMAIL],
      subject,
      html,
    });

    logger.info(
      { sent: true, negativeCount, positive: stats.positive },
      "AI feedback digest: email sent",
    );
    return { sent: true, count: negativeCount };
  } catch (err) {
    logger.error({ err }, "AI feedback digest: failed to send email");
    return { sent: false, count: 0 };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
