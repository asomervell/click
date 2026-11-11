import { ClickError, PRODUCTION_ORIGIN } from "./types";

/** One verification message. The code is only ever held in memory and in the mail itself. */
export type VerificationMail = {
  to: string;
  code: string;
  expiresAt: number;
  clickName: string | null;
};

export interface EmailSender {
  readonly kind: "cloudflare" | "test";
  sendVerification(mail: VerificationMail): Promise<void>;
}

export type SignupMode =
  | { verify: true; sender: EmailSender }
  | { verify: false; reason: "unverified_flag" };

const DEFAULT_FROM = "verify@clickmcp.com";

/** Test-only outbox. Used only when the TEST_EMAIL_OUTBOX binding is "1", which wrangler.jsonc never sets. */
export const testOutbox: VerificationMail[] = [];
/** Test-only: the next N test sends throw, to exercise the failed-send path. */
export const testSendFailures = { remaining: 0 };

function setting(env: Env, name: string): unknown {
  return (env as unknown as Record<string, unknown>)[name];
}

function cloudflareSender(binding: SendEmail, from: string): EmailSender {
  return {
    kind: "cloudflare",
    async sendVerification(mail) {
      const { subject, text, html } = verificationEmail(mail);
      await binding.send({
        from: { email: from, name: "Click" },
        to: mail.to,
        subject,
        text,
        html,
      });
    },
  };
}

/** Subject and bodies of the verification email. */
export function verificationEmail(mail: Pick<VerificationMail, "code" | "clickName">): { subject: string; text: string; html: string } {
  const name = mail.clickName?.trim() || "your click";
  const outro = "If this was not you, ignore this email. No click is created without the code.";
  return {
    subject: `Click code ${mail.code}`,
    text: [`The verification code for ${name} is`, "", mail.code, "", outro].join("\n"),
    html: verificationHtml(escape(name), escape(mail.code), outro),
  };
}

// Email clients ignore stylesheets and web fonts, so the brand is inlined: black ground, white
// IBM Plex Mono text with a monospace fallback, the code in magenta, and the magenta lockup as a PNG.
const MAIL_FONT = "'IBM Plex Mono',Menlo,Consolas,'Courier New',monospace";
const MAIL_DISPLAY = "'Press Start 2P','IBM Plex Mono',Menlo,Consolas,monospace";

function verificationHtml(name: string, code: string, outro: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>Click code ${code}</title></head>`
    + `<body style="margin:0;padding:0;background:#000000;color:#ffffff">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#000000"><tr><td align="left" style="padding:32px 24px">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;border:2px solid #ffffff;background:#000000"><tr><td style="padding:24px">`
    + `<img src="${PRODUCTION_ORIGIN}/brand/lockup-magenta.png" width="104" height="32" alt="Click" style="display:block;border:0;image-rendering:pixelated;margin:0 0 24px">`
    + `<p style="margin:0 0 16px;font:400 15px/24px ${MAIL_FONT};color:#ffffff">The verification code for ${name} is</p>`
    + `<p style="margin:0 0 24px;font:400 28px/40px ${MAIL_DISPLAY};letter-spacing:4px;color:#ff55ff">${code}</p>`
    + `<p style="margin:0;font:400 13px/20px ${MAIL_FONT};color:#aaaaaa">${outro}</p>`
    + `</td></tr></table></td></tr></table></body></html>`;
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The sender that is live for this deployment, or null when none is configured. */
export function emailSender(env: Env): EmailSender | null {
  if (setting(env, "TEST_EMAIL_OUTBOX") === "1") {
    return {
      kind: "test",
      async sendVerification(mail) {
        if (testSendFailures.remaining > 0) {
          testSendFailures.remaining -= 1;
          throw new Error("test send failure");
        }
        testOutbox.push(mail);
      },
    };
  }
  const binding = setting(env, "EMAIL") as SendEmail | undefined;
  if (binding && typeof binding.send === "function") {
    const from = String(setting(env, "EMAIL_FROM") ?? "").trim() || DEFAULT_FROM;
    return cloudflareSender(binding, from);
  }
  return null;
}

/**
 * Verification is required whenever a sender is live. Without one, only the
 * ALLOW_UNVERIFIED_SIGNUP="true" flag keeps the old immediate-key behavior.
 */
export function signupMode(env: Env): SignupMode {
  const sender = emailSender(env);
  if (sender) return { verify: true, sender };
  if (setting(env, "ALLOW_UNVERIFIED_SIGNUP") === "true") return { verify: false, reason: "unverified_flag" };
  throw new ClickError("Creating clicks is paused: email verification is not configured on this server.");
}
