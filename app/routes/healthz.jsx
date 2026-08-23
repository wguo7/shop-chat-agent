// Keep-warm target: returns 200 without touching the database.
//
// The old keep-warm ping hit /chat?history=true, which runs a Prisma query.
// On Neon's free plan, compute scales to zero after 5 minutes of inactivity
// (not configurable), so a DB query every 5 minutes kept the compute awake
// 24/7 (~182 CU-hours/month) and exhausted the 100 CU-hour monthly budget
// around day 17, suspending the database.
//
// This route warms only the Vercel lambda (cold ~2.6s vs warm ~1s), which is
// the latency that matters for shoppers. Neon now sleeps between real chat
// sessions; the first query after an idle gap pays a ~0.5s resume, hidden
// behind the history fetch on the storefront.
//
// IMPORTANT: do not import db.server.js (or anything that does) from here.
// A resource route runs no parent loaders, so this stays DB-free.
export async function loader() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
