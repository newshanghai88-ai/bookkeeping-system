import { createClient } from '@supabase/supabase-js';

function getSecretFromRequest(req) {
  const headerSecret = req.headers['x-cron-secret'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return headerSecret || req.query?.secret;
}

function assertRequiredEnv(required) {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const requestSecret = getSecretFromRequest(req);
  if (!process.env.CRON_SECRET || requestSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    assertRequiredEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { error } = await supabase
      .from('stores')
      .select('id')
      .limit(1);

    if (error) throw error;

    return res.status(200).json({
      status: 'ok',
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      status: 'failed',
      error: error.message || String(error),
      checkedAt: new Date().toISOString(),
    });
  }
}
