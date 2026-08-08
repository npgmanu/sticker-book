export type EmailEnv = {
  EMAIL_PROVIDER?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  SUPPORT_EMAIL?: string;
  APP_URL?: string;
};

type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function configuredEmail(env: EmailEnv) {
  const provider = (env.EMAIL_PROVIDER ?? "resend").trim().toLowerCase();
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  const supportEmail = env.SUPPORT_EMAIL?.trim().toLowerCase();
  if (provider !== "resend") throw new Error("Unsupported email provider");
  if (!apiKey || !from || !supportEmail) throw new Error("Transactional email is not configured");
  if (!/^\S+@\S+\.\S+$/.test(supportEmail)) throw new Error("Support email is not configured correctly");
  return { apiKey, from, supportEmail };
}

export function productionAppUrl(env: EmailEnv) {
  const raw = env.APP_URL?.trim();
  if (!raw) throw new Error("Production app URL is not configured");
  const appUrl = new URL(raw);
  if (appUrl.protocol !== "https:") throw new Error("Production app URL must use HTTPS");
  appUrl.search = "";
  appUrl.hash = "";
  appUrl.pathname = appUrl.pathname.replace(/\/+$/, "") || "/";
  return appUrl;
}

function accountEmailTemplate({
  title,
  message,
  actionLabel,
  actionUrl,
  footer,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  actionUrl?: string;
  footer: string;
}) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeFooter = escapeHtml(footer);
  const action = actionLabel && actionUrl
    ? `<a href="${escapeHtml(actionUrl)}" style="display:inline-block;margin:22px 0 18px;padding:13px 22px;border-radius:8px;background:#1846dc;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-size:15px;font-weight:700">${escapeHtml(actionLabel)}</a>`
    : "";
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f2f0eb;color:#10142c">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f0eb">
      <tr><td align="center" style="padding:28px 16px">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#fffdfa;border:1px solid #dad9d4;border-radius:12px;overflow:hidden">
          <tr><td style="padding:18px 24px;background:#0b123b;color:#ffffff;font-family:Arial,sans-serif;font-weight:800;letter-spacing:.08em">STICKER BOOK</td></tr>
          <tr><td style="padding:30px 24px;font-family:Arial,sans-serif">
            <h1 style="margin:0 0 14px;font-size:26px;line-height:1.2">${safeTitle}</h1>
            <p style="margin:0;color:#4f566b;font-size:15px;line-height:1.55">${safeMessage}</p>
            ${action}
            <p style="margin:12px 0 0;color:#6a7080;font-size:13px;line-height:1.5">${safeFooter}</p>
          </td></tr>
          <tr><td style="padding:16px 24px;border-top:1px solid #e7e5df;color:#7b7f8c;font-family:Arial,sans-serif;font-size:12px;line-height:1.45">This is a transactional account email. You were not added to a marketing list.</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

async function sendEmail(env: EmailEnv, message: EmailMessage) {
  const { apiKey, from, supportEmail } = configuredEmail(env);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": message.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      reply_to: supportEmail,
      subject: message.subject,
      html: message.html,
      text: message.text,
      tags: [{ name: "category", value: "account-security" }],
    }),
  });
  if (!response.ok) throw new Error("Transactional email could not be sent");
}

export async function sendVerificationEmail(env: EmailEnv, to: string, rawToken: string, tokenHash: string) {
  const appUrl = productionAppUrl(env);
  const verifyUrl = new URL("/", appUrl);
  verifyUrl.searchParams.set("verify", rawToken);
  const footer = "This link expires in 24 hours and can be used only once. If you did not create this account, you can ignore this email.";
  await sendEmail(env, {
    to,
    subject: "Verify your Sticker Book email",
    html: accountEmailTemplate({ title: "Verify your email", message: "Confirm this email address to finish setting up your Sticker Book account.", actionLabel: "Verify Email", actionUrl: verifyUrl.toString(), footer }),
    text: `Verify your Sticker Book email\n\nConfirm this email address to finish setting up your account:\n${verifyUrl.toString()}\n\n${footer}`,
    idempotencyKey: `verify-${tokenHash}`,
  });
}

export async function sendPasswordResetEmail(env: EmailEnv, to: string, rawToken: string, tokenHash: string) {
  const appUrl = productionAppUrl(env);
  const resetUrl = new URL("/", appUrl);
  resetUrl.searchParams.set("reset", rawToken);
  const footer = "This link expires in 60 minutes and can be used only once. If you did not request a reset, you can ignore this email.";
  await sendEmail(env, {
    to,
    subject: "Reset your Sticker Book password",
    html: accountEmailTemplate({ title: "Reset your password", message: "Use the button below to choose a new password for your Sticker Book account.", actionLabel: "Reset Password", actionUrl: resetUrl.toString(), footer }),
    text: `Reset your Sticker Book password\n\nChoose a new password:\n${resetUrl.toString()}\n\n${footer}`,
    idempotencyKey: `reset-${tokenHash}`,
  });
}

export async function sendPasswordChangedEmail(env: EmailEnv, to: string, eventId: string) {
  const { supportEmail } = configuredEmail(env);
  const footer = `If you made this change, no action is needed. If you did not make this change, contact us at ${supportEmail}.`;
  await sendEmail(env, {
    to,
    subject: "Your Sticker Book password was changed",
    html: accountEmailTemplate({ title: "Password changed", message: "Your Sticker Book password was changed.", footer }),
    text: `Your Sticker Book password was changed.\n\n${footer}`,
    idempotencyKey: `password-changed-${eventId}`,
  });
}

export function publicEmailConfig(env: EmailEnv) {
  const supportEmail = env.SUPPORT_EMAIL?.trim().toLowerCase() ?? "";
  return /^\S+@\S+\.\S+$/.test(supportEmail) ? { supportEmail } : { supportEmail: "" };
}
