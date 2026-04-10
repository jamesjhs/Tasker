import nodemailer from 'nodemailer';
import { getSetting } from './db';
import { decryptField } from './encrypt';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

export function getSmtpConfig(): SmtpConfig | null {
  const host = getSetting('smtp_host');
  const to   = getSetting('smtp_to');
  if (!host || !to) return null;
  return {
    host,
    port:   Number(getSetting('smtp_port') || 587),
    secure: getSetting('smtp_secure') === 'true',
    user:   getSetting('smtp_user')  || '',
    pass:   decryptField(getSetting('smtp_pass') || '') || '',
    from:   getSetting('smtp_from') || getSetting('smtp_user') || '',
    to,
  };
}

export async function sendEmail(subject: string, text: string): Promise<void> {
  const cfg = getSmtpConfig();
  if (!cfg) throw new Error('SMTP not configured. Please configure SMTP in the admin panel.');
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  await transporter.sendMail({
    from: cfg.from || cfg.user,
    to:   cfg.to,
    subject,
    text,
  });
}
