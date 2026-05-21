import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import { Resend } from 'resend';

const EXPORT_HEADERS = ['日期', '序号', '店号', '金额', '类型', '汇款公司', '汇款方式', '备注', '创建时间', '修改时间', '操作人'];

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Europe/Budapest' });
}

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

function assertSupabaseEnv() {
  assertRequiredEnv([
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
}

function assertBackupEnv() {
  assertRequiredEnv([
    'RESEND_API_KEY',
    'BACKUP_EMAIL_TO',
    'BACKUP_EMAIL_FROM',
  ]);
}

async function createWorkbookBuffer(transactions, storeMap) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('账目明细');

  worksheet.columns = EXPORT_HEADERS.map((header, index) => ({
    header,
    key: header,
    width: [12, 22, 14, 12, 10, 18, 12, 28, 20, 20, 20][index],
  }));

  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).alignment = { vertical: 'middle' };

  for (const item of transactions) {
    worksheet.addRow([
      item.transaction_date,
      item.serial_no,
      storeMap.get(item.store_id) || '',
      Number(Number(item.amount || 0).toFixed(2)),
      item.transaction_type,
      item.remittance_company || '',
      item.remittance_method || '',
      item.remark || '',
      formatDateTime(item.created_at),
      formatDateTime(item.updated_at),
      item.operator || '',
    ]);
  }

  worksheet.getColumn('金额').numFmt = '0.00';
  return workbook.xlsx.writeBuffer();
}

async function loadBackupData(supabase) {
  const [{ data: stores, error: storesError }, { data: transactions, error: transactionsError }] = await Promise.all([
    supabase.from('stores').select('id, store_no'),
    supabase
      .from('transactions')
      .select('*')
      .eq('is_deleted', false)
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false }),
  ]);

  if (storesError) throw storesError;
  if (transactionsError) throw transactionsError;

  return {
    transactions: transactions || [],
    storeMap: new Map((stores || []).map((store) => [store.id, store.store_no])),
  };
}

async function updateLog(supabase, logId, payload) {
  if (!logId) return;

  await supabase
    .from('backup_logs')
    .update({
      ...payload,
      finished_at: new Date().toISOString(),
    })
    .eq('id', logId);
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

  let supabase;
  let logId;
  const fileName = `账目备份_${todayString()}.xlsx`;
  const sentTo = process.env.BACKUP_EMAIL_TO || '';

  try {
    assertSupabaseEnv();

    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: runningLog, error: logError } = await supabase
      .from('backup_logs')
      .insert({
        backup_type: 'weekly_email',
        status: 'running',
        file_name: fileName,
        sent_to: sentTo,
      })
      .select('id')
      .single();

    if (logError) throw logError;
    logId = runningLog.id;

    assertBackupEnv();

    const { transactions, storeMap } = await loadBackupData(supabase);
    const excelBuffer = await createWorkbookBuffer(transactions, storeMap);
    const backupTime = formatDateTime(new Date().toISOString());
    const systemName = process.env.BACKUP_SYSTEM_NAME || '记账系统';

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.BACKUP_EMAIL_FROM,
      to: sentTo,
      subject: `记账系统每周备份 ${todayString()}`,
      text: [
        `系统名称：${systemName}`,
        `备份时间：${backupTime}`,
        `记录数量：${transactions.length}`,
      ].join('\n'),
      attachments: [
        {
          filename: fileName,
          content: Buffer.from(excelBuffer),
        },
      ],
    });

    await updateLog(supabase, logId, {
      status: 'success',
      record_count: transactions.length,
      error_message: null,
    });

    return res.status(200).json({
      status: 'success',
      fileName,
      recordCount: transactions.length,
      sentTo,
    });
  } catch (error) {
    if (supabase && logId) {
      await updateLog(supabase, logId, {
        status: 'failed',
        error_message: error.message || String(error),
      });
    }

    return res.status(500).json({
      status: 'failed',
      error: error.message || String(error),
    });
  }
}
