import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders,
      ...(init.headers ?? {}),
    },
  });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

async function sendEmail(opts: { to: string; subject: string; html: string }) {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("NOTIFICATION_FROM_EMAIL") || "Apex CRM <notifications@example.com>";
  if (!key) return { ok: false, skipped: true, reason: "RESEND_API_KEY not set" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [opts.to], subject: opts.subject, html: opts.html }),
  });
  if (!res.ok) {
    const txt = await res.text();
    return { ok: false, error: txt };
  }
  return { ok: true };
}

async function upsertNotification(
  supabase: ReturnType<typeof createClient>,
  row: Record<string, unknown>,
) {
  const { error } = await supabase.from("notifications").upsert(row, { onConflict: "user_id,dedupe_key" });
  if (error) throw error;
}

async function processUser(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  prefs: { email_notifications: boolean; task_reminders: boolean; weekly_summary: boolean },
  profile: { email: string | null; full_name: string | null },
) {
  const today = todayKey();
  const now = new Date();
  const in24h = addDays(now, 1).toISOString();
  const in30m = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const reviewHorizon = addDays(now, 7).toISOString().slice(0, 10);
  const created: string[] = [];
  const emailLines: string[] = [];

  if (prefs.task_reminders) {
    const { data: overdue } = await supabase
      .from("tasks")
      .select("id, title, due_date, client_id")
      .eq("assigned_to", userId)
      .neq("status", "done")
      .lt("due_date", today)
      .not("due_date", "is", null);

    for (const t of overdue || []) {
      const dedupe = `task.overdue:${t.id}:${today}`;
      await upsertNotification(supabase, {
        user_id: userId,
        kind: "task.overdue",
        title: "Overdue task",
        body: t.title,
        href: "/tasks",
        ref_type: "task",
        ref_id: t.id,
        dedupe_key: dedupe,
      });
      created.push(dedupe);
      emailLines.push(`• Overdue: ${t.title} (due ${t.due_date})`);
    }

    const { data: dueToday } = await supabase
      .from("tasks")
      .select("id, title, due_date")
      .eq("assigned_to", userId)
      .neq("status", "done")
      .eq("due_date", today);

    for (const t of dueToday || []) {
      const dedupe = `task.due_today:${t.id}:${today}`;
      await upsertNotification(supabase, {
        user_id: userId,
        kind: "task.due_today",
        title: "Task due today",
        body: t.title,
        href: "/tasks",
        ref_type: "task",
        ref_id: t.id,
        dedupe_key: dedupe,
      });
      created.push(dedupe);
      emailLines.push(`• Due today: ${t.title}`);
    }
  }

  const { data: reviews } = await supabase
    .from("clients")
    .select("id, first_name, last_name, next_review_date")
    .eq("advisor_id", userId)
    .not("next_review_date", "is", null)
    .lte("next_review_date", reviewHorizon);

  for (const c of reviews || []) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "Client";
    const dedupe = `client.review:${c.id}:${today}`;
    const overdue = c.next_review_date < today;
    await upsertNotification(supabase, {
      user_id: userId,
      kind: "client.review_due",
      title: overdue ? "Review overdue" : "Review coming up",
      body: `${name} — ${c.next_review_date}`,
      href: `/clients/${c.id}`,
      ref_type: "client",
      ref_id: c.id,
      dedupe_key: dedupe,
    });
    created.push(dedupe);
    if (prefs.email_notifications) {
      emailLines.push(`• ${overdue ? "Review overdue" : "Review due"}: ${name} (${c.next_review_date})`);
    }
  }

  const { data: meetingsSoon } = await supabase
    .from("meetings")
    .select("id, title, start_time")
    .eq("advisor_id", userId)
    .neq("status", "canceled")
    .gte("start_time", now.toISOString())
    .lte("start_time", in30m);

  for (const m of meetingsSoon || []) {
    const dedupe = `meeting.soon:${m.id}:${today}`;
    await upsertNotification(supabase, {
      user_id: userId,
      kind: "meeting.reminder",
      title: "Meeting starting soon",
      body: `${m.title || "Meeting"} at ${new Date(m.start_time).toLocaleString()}`,
      href: "/calendar",
      ref_type: "meeting",
      ref_id: m.id,
      dedupe_key: dedupe,
    });
    created.push(dedupe);
    if (prefs.email_notifications) {
      emailLines.push(`• Meeting soon: ${m.title || "Meeting"}`);
    }
  }

  const { data: meetingsDay } = await supabase
    .from("meetings")
    .select("id, title, start_time")
    .eq("advisor_id", userId)
    .neq("status", "canceled")
    .gt("start_time", in30m)
    .lte("start_time", in24h);

  for (const m of meetingsDay || []) {
    const dedupe = `meeting.today:${m.id}:${today}`;
    await upsertNotification(supabase, {
      user_id: userId,
      kind: "meeting.upcoming",
      title: "Upcoming meeting",
      body: `${m.title || "Meeting"} — ${new Date(m.start_time).toLocaleString()}`,
      href: "/calendar",
      ref_type: "meeting",
      ref_id: m.id,
      dedupe_key: dedupe,
    });
    created.push(dedupe);
  }

  if (prefs.email_notifications && profile.email && emailLines.length) {
    const dedupe = `email.digest:${today}`;
    const { data: existing } = await supabase
      .from("notifications")
      .select("id, emailed_at")
      .eq("user_id", userId)
      .eq("dedupe_key", dedupe)
      .maybeSingle();

    if (!existing?.emailed_at) {
      const html = `<p>Hi ${profile.full_name || "there"},</p><p>Here are your Apex CRM reminders:</p><ul>${emailLines.map((l) => `<li>${l.replace(/^•\s*/, "")}</li>`).join("")}</ul><p><a href="${Deno.env.get("APP_URL") || "https://example.com"}/dashboard">Open Apex CRM</a></p>`;
      const result = await sendEmail({
        to: profile.email,
        subject: `Apex CRM reminders — ${today}`,
        html,
      });
      if (result.ok) {
        await upsertNotification(supabase, {
          user_id: userId,
          kind: "email.digest",
          title: "Daily reminder email sent",
          body: `${emailLines.length} item(s)`,
          href: "/dashboard",
          dedupe_key: dedupe,
          emailed_at: new Date().toISOString(),
        });
      }
    }
  }

  return { userId, created: created.length };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const CRON_SECRET = Deno.env.get("CRON_SECRET");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Missing Supabase env" }, { status: 500 });

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const cronHeader = req.headers.get("x-cron-secret") || "";
  const isCron = CRON_SECRET && cronHeader === CRON_SECRET;

  let targetUserIds: string[] = [];

  if (isCron) {
    const { data: profiles, error } = await supabaseAdmin.from("profiles").select("id").eq("is_active", true);
    if (error) return json({ error: error.message }, { status: 500 });
    targetUserIds = (profiles || []).map((p) => p.id);
  } else {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Unauthorized" }, { status: 401 });
    const { data: userData, error: authErr } = await supabaseAdmin.auth.getUser(token);
    if (authErr || !userData.user) return json({ error: "Unauthorized" }, { status: 401 });
    targetUserIds = [userData.user.id];
  }

  const results = [];
  for (const userId of targetUserIds) {
    const [{ data: profile }, { data: prefsRow }] = await Promise.all([
      supabaseAdmin.from("profiles").select("email, full_name").eq("id", userId).maybeSingle(),
      supabaseAdmin.from("user_preferences").select("email_notifications, task_reminders, weekly_summary").eq("user_id", userId).maybeSingle(),
    ]);
    const prefs = {
      email_notifications: prefsRow?.email_notifications ?? true,
      task_reminders: prefsRow?.task_reminders ?? true,
      weekly_summary: prefsRow?.weekly_summary ?? false,
    };
    try {
      const r = await processUser(supabaseAdmin, userId, prefs, profile || { email: null, full_name: null });
      results.push(r);
    } catch (e) {
      results.push({ userId, error: String(e) });
    }
  }

  return json({ ok: true, processed: results.length, results });
});
