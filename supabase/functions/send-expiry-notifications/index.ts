import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import webpush from 'npm:web-push@3.6.7';

const milestones = [10, 5, 1, 0];

function dateAfter(days: number) {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = Deno.env.get('STOCKALERT_CRON_SECRET');
  if (!secret || request.headers.get('x-stockalert-cron') !== secret) return new Response('Unauthorized', { status: 401 });

  const url = Deno.env.get('SUPABASE_URL') || '';
  const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}') as Record<string, string>;
  const serviceKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') || '';
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') || '';
  const subject = Deno.env.get('VAPID_SUBJECT') || '';
  if (!url || !serviceKey || !publicKey || !privateKey || !subject) return new Response('Notification service is not configured', { status: 503 });

  webpush.setVapidDetails(subject, publicKey, privateKey);
  const admin = createClient(url, serviceKey);
  let sent = 0;

  for (const days of milestones) {
    const { data: products, error: productsError } = await admin.from('products').select('id,owner_id,name').eq('status', 'active').eq('expiration_date', dateAfter(days));
    if (productsError) throw productsError;
    for (const product of products ?? []) {
      const { data: seen, error: seenError } = await admin.from('notification_log').select('id').eq('product_id', product.id).eq('milestone_days', days).maybeSingle();
      if (seenError) throw seenError;
      if (seen) continue;
      const { data: subscriptions, error: subscriptionsError } = await admin.from('web_push_subscriptions').select('id,endpoint,p256dh,auth').eq('owner_id', product.owner_id);
      if (subscriptionsError) throw subscriptionsError;
      const label = days === 0 ? 'caduca hoy' : `caduca en ${days} día${days === 1 ? '' : 's'}`;
      for (const subscription of subscriptions ?? []) {
        try {
          await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify({ title: 'StockAlert', body: `${product.name} ${label}.`, url: '/' }));
          sent++;
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) await admin.from('web_push_subscriptions').delete().eq('id', subscription.id);
          else console.error('Push delivery failed', statusCode || 'unknown');
        }
      }
      const { error: logError } = await admin.from('notification_log').insert({ owner_id: product.owner_id, product_id: product.id, milestone_days: days });
      if (logError && logError.code !== '23505') throw logError;
    }
  }
  return Response.json({ ok: true, sent });
});
