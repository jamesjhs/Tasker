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
  const portNum = Number(getSetting('smtp_port') || 587);
  return {
    host,
    port:   isNaN(portNum) ? 587 : portNum,
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
  await sendEmailTo(cfg.to, subject, text, cfg);
}

export async function sendEmailTo(to: string, subject: string, text: string, cfg?: SmtpConfig): Promise<void> {
  const config = cfg || getSmtpConfig();
  if (!config) throw new Error('SMTP not configured. Please configure SMTP in the admin panel.');
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });
  await transporter.sendMail({
    from: config.from || config.user,
    to,
    subject,
    text,
  });
}
